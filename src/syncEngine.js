import * as fieldMapper from './fieldMapper.js';
import { todoistIdProperty } from './notionClient.js';
import { COMPLETED_WINDOW_DAYS } from './todoistClient.js';
import { saveState, findByNotionId, findByTodoistId } from './stateManager.js';

// D1 Free allows 50 queries per invocation. State is written once at the end
// of a run, plus once per create (so a crash can't cause a duplicate create).
// Capping creates keeps a run at ~30 queries: lock, load, creates, save, unlock.
const MAX_CREATES_PER_RUN = 25;

// Worst-case subrequests each operation needs. An operation only starts if the
// budget can cover it; otherwise it is deferred to the next run.
const COST = {
  createInNotion: 1,
  createInTodoist: 2, // create + write Todoist ID to Notion
  updateNotion: 1,
  updateTodoist: 3, // update + move project (Type) + close/reopen
  delete: 1,
};

// ─── Main Sync Cycle ─────────────────────────────────────────────────────────
// ctx: { notion, todoist, db, budget, state }
export async function runSync(ctx) {
  console.log(`[${new Date().toISOString()}] 🔄 Starting sync cycle...`);

  const { state } = ctx;
  ctx.deferred = 0;
  ctx.creates = 0;

  // 1. Fetch current data from both sides
  const [notionPages, todoistActiveTasks, todoistCompletedTasks, projects] =
    await Promise.all([
      ctx.notion.getAllPages(),
      ctx.todoist.getAllTasks(),
      ctx.todoist.getRecentlyCompletedTasks(),
      ctx.todoist.getProjects(),
    ]);
  ctx.projects = buildProjectIndex(projects);

  // Build lookup maps
  const activeNotionMap = new Map(
    notionPages.filter((p) => !p.archived).map((p) => [p.id, p]),
  );

  const activeTodoistMap = new Map(
    todoistActiveTasks.map((t) => [String(t.id), t]),
  );

  // Combined todoist map: active + recently completed
  const allTodoistMap = new Map(
    todoistActiveTasks.map((t) => [String(t.id), t]),
  );
  // null = completed list unavailable this run; deletions are then not inferred
  const completedKnown = todoistCompletedTasks !== null;
  for (const t of todoistCompletedTasks || []) {
    if (!activeTodoistMap.has(String(t.id))) allTodoistMap.set(String(t.id), t);
  }

  // Track IDs created this cycle to skip in deletion check
  const createdThisCycle = new Set();

  // State changes are written once, at the end (or if a step throws), to stay
  // within D1's per-invocation query limit.
  let completed = false;
  try {
    // 2. RELINK: pages whose stored Todoist ID matches an unlinked Todoist task
    //    (fresh deploy without imported state, or lost state) — prevents duplicates
    await relinkByTodoistId(ctx, notionPages, allTodoistMap);

    // 3. CREATE: Todoist → Notion (new tasks not yet in state)
    await syncTodoistToNotion(ctx, todoistActiveTasks, createdThisCycle);

    // 4. CREATE: Notion → Todoist (new pages not yet in state)
    await syncNotionToTodoist(ctx, notionPages, createdThisCycle);

    // 5. UPDATE: tasks already linked in state, check for changes
    await handleUpdates(ctx, allTodoistMap, activeNotionMap);

    // 6. DELETIONS & COMPLETIONS
    await handleDeletionsAndCompletions(
      ctx,
      activeNotionMap,
      activeTodoistMap,
      allTodoistMap,
      createdThisCycle,
      completedKnown,
    );
    completed = true;
  } finally {
    // 7. Save final state
    if (completed) state.lastSyncedAt = new Date().toISOString();
    await saveState(ctx.db, state);
  }

  const deferredNote = ctx.deferred
    ? ` (${ctx.deferred} operation(s) deferred to next run: per-run limits)`
    : '';
  console.log(
    `[${new Date().toISOString()}] ✅ Sync cycle complete. Subrequests used: ${ctx.budget.used}${deferredNote}`,
  );
}

// Type ↔ project lookup: project names by ID, project IDs by Type, and the Inbox.
function buildProjectIndex(projects) {
  const names = new Map(projects.map((p) => [String(p.id), p.name]));
  const idByType = {};
  for (const type of fieldMapper.TYPE_VALUES) {
    const project = projects.find((p) => p.name === type);
    if (project) idByType[type] = String(project.id);
    else console.error(`  ⚠️  Todoist project "${type}" not found; tasks with this Type are skipped.`);
  }
  const inbox = projects.find((p) => p.inbox_project);
  return { names, idByType, inboxId: inbox ? String(inbox.id) : null };
}

// Todoist project for a Notion Type: the matching project, or the Inbox when empty.
// Returns undefined if the target project can't be resolved.
function projectIdForType(ctx, type) {
  if (!type) return ctx.projects.inboxId ?? undefined;
  return ctx.projects.idByType[type];
}

const DAY_MS = 24 * 60 * 60 * 1000;

// A completed task we saw recently should still be in the completed list. If it
// is gone, it was deleted. Older completions may have aged out of the list, so
// they are left alone. One day of margin guards against the window boundary.
function completionStillInWindow(completedAt, now = Date.now()) {
  if (!completedAt) return false;
  const age = now - new Date(completedAt).getTime();
  return age < (COMPLETED_WINDOW_DAYS - 1) * DAY_MS;
}

function canCreate(ctx) {
  if (ctx.creates < MAX_CREATES_PER_RUN) return true;
  ctx.deferred += 1;
  return false;
}

function canAfford(ctx, cost) {
  if (ctx.budget.has(cost)) return true;
  ctx.deferred += 1;
  return false;
}

// ─── Relink by stored Todoist ID ─────────────────────────────────────────────
// Baseline is the Todoist snapshot, so where the two differ the Notion value
// reads as a change and is pushed to Todoist (same rule as the Type backfill).
async function relinkByTodoistId(ctx, notionPages, allTodoistMap) {
  const { state } = ctx;
  let linked = 0;
  for (const page of notionPages) {
    if (page.archived || findByNotionId(state, page.id)) continue;
    const todoistId = fieldMapper.todoistIdFromPage(page);
    const task = todoistId && allTodoistMap.get(todoistId);
    if (!task) continue;
    if (findByTodoistId(state, todoistId)) {
      console.error(
        `  ⚠️  Todoist ID ${todoistId} is already linked to another Notion page; "${fieldMapper.fromNotion(page).title}" not relinked`,
      );
      continue;
    }

    const notionSnapshot = fieldMapper.toSnapshot(fieldMapper.fromNotion(page));
    state.tasks[todoistId] = {
      notionPageId: page.id,
      lastKnownState: {
        ...fieldMapper.toSnapshot(fieldMapper.fromTodoist(task, ctx.projects.names)),
        // Description/Tags may be unfilled in Notion: let Todoist's values through
        description: notionSnapshot.description,
        tags: notionSnapshot.tags,
      },
    };
    linked += 1;
  }
  if (linked > 0) {
    console.log(`  🔗 Relinked ${linked} existing pair(s) by Todoist ID`);
  }
}

// ─── Todoist → Notion (CREATE only) ──────────────────────────────────────────
async function syncTodoistToNotion(ctx, todoistTasks, createdThisCycle) {
  const { state } = ctx;
  for (const task of todoistTasks) {
    const taskId = String(task.id);
    if (findByTodoistId(state, taskId)) continue;
    if (!canCreate(ctx) || !canAfford(ctx, COST.createInNotion)) continue;

    const normalized = fieldMapper.fromTodoist(task, ctx.projects.names);
    try {
      const properties = {
        ...fieldMapper.toNotionProperties(normalized),
        ...todoistIdProperty(taskId),
      };
      const page = await ctx.notion.createPage(properties);
      ctx.creates += 1;

      state.tasks[taskId] = {
        notionPageId: page.id,
        lastKnownState: fieldMapper.toSnapshot(normalized),
      };
      await saveState(ctx.db, state);
      createdThisCycle.add(taskId);
      console.log(`  ➕ Todoist→Notion CREATE: "${normalized.title}"`);
    } catch (err) {
      console.error(
        `  ❌ Failed to create Notion page for "${normalized.title}":`,
        err.message,
      );
    }
  }
}

// ─── Notion → Todoist (CREATE only) ──────────────────────────────────────────
async function syncNotionToTodoist(ctx, notionPages, createdThisCycle) {
  const { state } = ctx;
  for (const page of notionPages) {
    if (page.archived) continue;
    const pageId = page.id;
    if (findByNotionId(state, pageId)) continue;
    // Has a Todoist ID but wasn't relinked: its task is gone (deleted, or
    // completed long ago) or already linked elsewhere. Don't recreate it.
    if (fieldMapper.todoistIdFromPage(page)) continue;

    const normalized = fieldMapper.fromNotion(page);
    // Already-finished pages aren't sent to Todoist; if one is reopened in
    // Notion later, it is created then.
    if (normalized.status === 'Done') continue;
    // Empty Type → no project_id → Todoist puts the task in the Inbox
    const projectId = normalized.type ? ctx.projects.idByType[normalized.type] : null;
    if (projectId === undefined) continue;
    if (!canCreate(ctx) || !canAfford(ctx, COST.createInTodoist)) continue;
    try {
      const payload = {
        ...fieldMapper.toTodoistPayload(normalized),
        ...(projectId ? { project_id: projectId } : {}),
      };
      const task = await ctx.todoist.createTask(payload);
      ctx.creates += 1;
      const taskId = String(task.id);

      // Record the link immediately so a later failure can't cause a duplicate create.
      state.tasks[taskId] = {
        notionPageId: pageId,
        lastKnownState: fieldMapper.toSnapshot(normalized),
      };
      await saveState(ctx.db, state);
      createdThisCycle.add(taskId);

      await ctx.notion.setTodoistId(pageId, taskId);
      console.log(`  ➕ Notion→Todoist CREATE: "${normalized.title}"`);
    } catch (err) {
      console.error(
        `  ❌ Failed to create Todoist task for "${normalized.title}":`,
        err.message,
      );
    }
  }
}

// ─── Handle Updates ───────────────────────────────────────────────────────────
// Field-level merge of each linked pair, then push only what differs per side.
async function handleUpdates(ctx, allTodoistMap, activeNotionMap) {
  const { state } = ctx;
  for (const [todoistId, entry] of Object.entries(state.tasks)) {
    const todoistTask = allTodoistMap.get(todoistId);
    const notionPage = activeNotionMap.get(entry.notionPageId);

    if (!todoistTask || !notionPage) continue;

    const todoistSnapshot = fieldMapper.toSnapshot(
      fieldMapper.fromTodoist(todoistTask, ctx.projects.names),
    );
    const notionSnapshot = fieldMapper.toSnapshot(fieldMapper.fromNotion(notionPage));
    const oldSnapshot = entry.lastKnownState;
    // State saved before Type was synced has no `type`. Use Todoist's value as
    // the baseline so a differing Notion Type reads as a Notion change: Notion's
    // existing Type is kept and the Todoist task is moved to match.
    if (!('type' in oldSnapshot)) oldSnapshot.type = todoistSnapshot.type;
    // Description and Tags were added to Notion later and start empty there. Use
    // Notion's value as the baseline so existing Todoist descriptions and labels
    // flow into Notion instead of being cleared.
    if (!('description' in oldSnapshot)) oldSnapshot.description = notionSnapshot.description;
    if (!('tags' in oldSnapshot)) oldSnapshot.tags = notionSnapshot.tags;

    const { merged, conflicts } = fieldMapper.mergeSnapshots({
      old: oldSnapshot,
      notion: notionSnapshot,
      todoist: todoistSnapshot,
      notionEditedAt: notionPage.last_edited_time,
      todoistEditedAt: todoistTask.updated_at,
    });

    const notionNeedsUpdate = !fieldMapper.snapshotsAreEqual(merged, notionSnapshot);
    const todoistNeedsUpdate = !fieldMapper.snapshotsAreEqual(
      fieldMapper.asTodoistSees(merged),
      todoistSnapshot,
    );

    if (!notionNeedsUpdate && !todoistNeedsUpdate) {
      // e.g. only TO DO ↔ DOING changed in Notion: nothing to push, just record it
      if (!fieldMapper.snapshotsAreEqual(merged, oldSnapshot)) {
        entry.lastKnownState = merged;
      }
      continue;
    }

    const cost =
      (notionNeedsUpdate ? COST.updateNotion : 0) +
      (todoistNeedsUpdate ? COST.updateTodoist : 0);
    if (!canAfford(ctx, cost)) continue;

    const typeChanged = merged.type !== todoistSnapshot.type;
    const targetProjectId = typeChanged ? projectIdForType(ctx, merged.type) : null;
    if (todoistNeedsUpdate && targetProjectId === undefined) {
      console.error(
        `  ⚠️  No Todoist project for Type "${merged.type ?? 'empty (Inbox)'}"; skipping "${merged.title}"`,
      );
      continue;
    }

    try {
      if (todoistNeedsUpdate) {
        await pushToTodoist(
          ctx,
          todoistId,
          merged,
          todoistSnapshot,
          targetProjectId,
          todoistTask.labels,
        );
      }
      if (notionNeedsUpdate) {
        await ctx.notion.updatePage(
          entry.notionPageId,
          fieldMapper.toNotionProperties(merged),
        );
      }
      entry.lastKnownState = merged;

      const direction = [
        notionNeedsUpdate && 'Notion',
        todoistNeedsUpdate && 'Todoist',
      ].filter(Boolean).join(' + ');
      const conflictNote = conflicts.length
        ? ` (conflict on ${conflicts.join(', ')}: later edit kept)`
        : '';
      console.log(`  ✏️  UPDATE ${direction}: "${merged.title}"${conflictNote}`);
    } catch (err) {
      console.error(`  ❌ Update failed for "${merged.title}":`, err.message);
    }
  }
}

// Sends only the Todoist calls needed to make the task match the merged snapshot.
async function pushToTodoist(ctx, todoistId, merged, current, targetProjectId, currentLabels) {
  const payload = fieldMapper.toTodoistUpdatePayload(merged, current, currentLabels);
  if (Object.keys(payload).length > 0) {
    await ctx.todoist.updateTask(todoistId, payload);
  }
  if (targetProjectId) {
    await ctx.todoist.moveTask(todoistId, targetProjectId);
  }
  const shouldBeDone = merged.status === 'Done';
  const isDone = current.status === 'Done';
  if (shouldBeDone && !isDone) await ctx.todoist.closeTask(todoistId);
  if (!shouldBeDone && isDone) await ctx.todoist.reopenTask(todoistId);
}

// ─── Deletions & Completions ──────────────────────────────────────────────────
async function handleDeletionsAndCompletions(
  ctx,
  activeNotionMap,
  activeTodoistMap,
  allTodoistMap,
  createdThisCycle,
  completedKnown,
) {
  const { state } = ctx;
  for (const [todoistId, entry] of Object.entries(state.tasks)) {
    if (createdThisCycle.has(todoistId)) continue;

    const notionExists = activeNotionMap.has(entry.notionPageId);
    const isActiveInTodoist = activeTodoistMap.has(todoistId);
    const isCompletedInTodoist =
      allTodoistMap.has(todoistId) &&
      fieldMapper.isTodoistTaskCompleted(allTodoistMap.get(todoistId));

    // Remember when the task was completed, to tell deletion from aging out later
    const completedAt = isCompletedInTodoist
      ? allTodoistMap.get(todoistId).completed_at || entry.todoistCompletedAt || new Date().toISOString()
      : null;
    if (isCompletedInTodoist && entry.todoistCompletedAt !== completedAt) {
      entry.todoistCompletedAt = completedAt;
    } else if (isActiveInTodoist && entry.todoistCompletedAt) {
      delete entry.todoistCompletedAt;
    }

    // ── Todoist task was COMPLETED (not deleted) → update Notion to DONE ──
    if (!isActiveInTodoist && isCompletedInTodoist && notionExists) {
      if (entry.lastKnownState?.status === 'Done') continue;
      if (!canAfford(ctx, COST.updateNotion)) continue;
      try {
        await ctx.notion.updatePage(entry.notionPageId, {
          Status: { status: { name: 'Done' } },
        });
        entry.lastKnownState = { ...entry.lastKnownState, status: 'Done' };
        console.log(
          `  ✅ Todoist completed → Notion DONE: "${entry.lastKnownState.title}"`,
        );
      } catch (err) {
        console.error(`  ❌ Failed to mark Notion DONE:`, err.message);
      }
      continue;
    }

    // ── Notion page deleted → delete Todoist task (active or completed) ──
    if (!notionExists && (isActiveInTodoist || isCompletedInTodoist)) {
      if (!canAfford(ctx, COST.delete)) continue;
      try {
        await ctx.todoist.deleteTask(todoistId);
        delete state.tasks[todoistId];
        console.log(`  🗑️  Notion deleted → Todoist task removed`);
      } catch (err) {
        console.error(
          `  ❌ Failed to delete Todoist task ${todoistId}:`,
          err.message,
        );
      }
      continue;
    }

    // ── Todoist task deleted → archive Notion page ──
    // Skip if the completed list could not be fetched — it may just be completed.
    // A Done task is only treated as deleted if its completion is recent enough
    // that it should still be in the completed list.
    const goneFromTodoist = completedKnown && !isActiveInTodoist && !isCompletedInTodoist;
    const deletedInTodoist =
      goneFromTodoist &&
      (entry.lastKnownState?.status !== 'Done' ||
        completionStillInWindow(entry.todoistCompletedAt));
    if (deletedInTodoist && notionExists) {
      if (!canAfford(ctx, COST.delete)) continue;
      try {
        await ctx.notion.deletePage(entry.notionPageId);
        delete state.tasks[todoistId];
        console.log(`  🗑️  Todoist deleted → Notion page archived`);
      } catch (err) {
        console.error(`  ❌ Failed to archive Notion page:`, err.message);
      }
      continue;
    }

    // ── Both gone → clean up state ──
    if (goneFromTodoist && !notionExists) {
      delete state.tasks[todoistId];
    }
  }
}
