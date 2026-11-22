import * as fieldMapper from './fieldMapper.js';
import { todoistIdProperty } from './notionClient.js';
import { COMPLETED_WINDOW_DAYS } from './todoistClient.js';
import { saveState, findByNotionId, findByTodoistId } from './stateManager.js';

// Worst-case subrequests each operation needs. An operation only starts if the
// budget can cover it; otherwise it is deferred to the next run.
const COST = {
  createInNotion: 1,
  createInTodoist: 3, // create + close (if Done) + write Todoist ID to Notion
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

  // 2. CREATE: Todoist → Notion (new tasks not yet in state)
  await syncTodoistToNotion(ctx, todoistActiveTasks, createdThisCycle);

  // 3. CREATE: Notion → Todoist (new pages not yet in state)
  await syncNotionToTodoist(ctx, notionPages, createdThisCycle);

  // 4. UPDATE: tasks already linked in state, check for changes
  await handleUpdates(ctx, allTodoistMap, activeNotionMap);

  // 5. DELETIONS & COMPLETIONS
  await handleDeletionsAndCompletions(
    ctx,
    activeNotionMap,
    activeTodoistMap,
    allTodoistMap,
    createdThisCycle,
    completedKnown,
  );

  // 6. Save final state
  state.lastSyncedAt = new Date().toISOString();
  await saveState(ctx.db, state);

  const deferredNote = ctx.deferred
    ? ` (${ctx.deferred} operation(s) deferred to next run: subrequest budget)`
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

function canAfford(ctx, cost) {
  if (ctx.budget.has(cost)) return true;
  ctx.deferred += 1;
  return false;
}

// ─── Todoist → Notion (CREATE only) ──────────────────────────────────────────
async function syncTodoistToNotion(ctx, todoistTasks, createdThisCycle) {
  const { state } = ctx;
  for (const task of todoistTasks) {
    const taskId = String(task.id);
    if (findByTodoistId(state, taskId)) continue;
    if (!canAfford(ctx, COST.createInNotion)) continue;

    const normalized = fieldMapper.fromTodoist(task, ctx.projects.names);
    try {
      const properties = {
        ...fieldMapper.toNotionProperties(normalized),
        ...todoistIdProperty(taskId),
      };
      const page = await ctx.notion.createPage(properties);

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
    if (!canAfford(ctx, COST.createInTodoist)) continue;

    const normalized = fieldMapper.fromNotion(page);
    // Empty Type → no project_id → Todoist puts the task in the Inbox
    const projectId = normalized.type ? ctx.projects.idByType[normalized.type] : null;
    if (projectId === undefined) continue;
    try {
      const payload = {
        ...fieldMapper.toTodoistPayload(normalized),
        ...(projectId ? { project_id: projectId } : {}),
      };
      const task = await ctx.todoist.createTask(payload);
      const taskId = String(task.id);

      // Record the link immediately so a later failure can't cause a duplicate create.
      state.tasks[taskId] = {
        notionPageId: pageId,
        lastKnownState: fieldMapper.toSnapshot(normalized),
      };
      await saveState(ctx.db, state);
      createdThisCycle.add(taskId);

      if (normalized.status === 'Done') {
        await ctx.todoist.closeTask(taskId);
      }
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
async function handleUpdates(ctx, allTodoistMap, activeNotionMap) {
  const { state } = ctx;
  for (const [todoistId, entry] of Object.entries(state.tasks)) {
    const todoistTask = allTodoistMap.get(todoistId);
    const notionPage = activeNotionMap.get(entry.notionPageId);

    if (!todoistTask || !notionPage) continue;

    const todoistNormalized = fieldMapper.fromTodoist(
      todoistTask,
      ctx.projects.names,
    );
    const notionNormalized = fieldMapper.fromNotion(notionPage);
    const todoistSnapshot = fieldMapper.toSnapshot(todoistNormalized);
    const notionSnapshot = fieldMapper.toSnapshot(notionNormalized);
    const oldSnapshot = entry.lastKnownState;
    // State saved before Type was synced has no `type`. Use Todoist's value as
    // the baseline so a differing Notion Type reads as a Notion change: Notion's
    // existing Type is kept and the Todoist task is moved to match.
    if (!('type' in oldSnapshot)) oldSnapshot.type = todoistNormalized.type;

    const todoistChanged = !fieldMapper.snapshotsAreEqual(
      fieldMapper.asTodoistSees(oldSnapshot),
      todoistSnapshot,
    );
    const notionChanged = !fieldMapper.snapshotsAreEqual(
      oldSnapshot,
      notionSnapshot,
    );

    if (todoistChanged) {
      // Todoist changed (alone, or both changed → conflict, Todoist wins) → push to Notion
      if (!canAfford(ctx, COST.updateNotion)) continue;
      const label = notionChanged ? '⚠️  CONFLICT → Todoist wins' : '✏️  Todoist→Notion UPDATE';
      try {
        const properties = fieldMapper.toNotionProperties(
          todoistNormalized,
          oldSnapshot.status,
        );
        await ctx.notion.updatePage(entry.notionPageId, properties);
        // Record the status Notion actually has now (DOING is kept if Todoist is active)
        entry.lastKnownState = {
          ...todoistSnapshot,
          status: properties.Status.status.name,
        };
        await saveState(ctx.db, state);
        console.log(`  ${label}: "${todoistNormalized.title}"`);
      } catch (err) {
        console.error(
          `  ❌ Update Notion failed for "${todoistNormalized.title}":`,
          err.message,
        );
      }
    } else if (notionChanged) {
      // Only TO DO ↔ DOING changed: nothing Todoist can show, just record it
      if (
        fieldMapper.snapshotsAreEqual(
          fieldMapper.asTodoistSees(oldSnapshot),
          fieldMapper.asTodoistSees(notionSnapshot),
        )
      ) {
        entry.lastKnownState = notionSnapshot;
        await saveState(ctx.db, state);
        continue;
      }

      // Notion changed → push to Todoist
      if (!canAfford(ctx, COST.updateTodoist)) continue;
      try {
        const typeChanged = (oldSnapshot.type ?? null) !== notionNormalized.type;
        const targetProjectId = typeChanged
          ? projectIdForType(ctx, notionNormalized.type)
          : null;
        if (targetProjectId === undefined) {
          console.error(
            `  ⚠️  No Todoist project for Type "${notionNormalized.type ?? 'empty (Inbox)'}"; skipping "${notionNormalized.title}"`,
          );
          continue;
        }

        const payload = fieldMapper.toTodoistPayload(notionNormalized);
        await ctx.todoist.updateTask(todoistId, payload);
        if (targetProjectId) {
          await ctx.todoist.moveTask(todoistId, targetProjectId);
        }

        const wasCompleted = oldSnapshot.status === 'Done';
        const isNowCompleted = notionNormalized.status === 'Done';
        if (!wasCompleted && isNowCompleted) {
          await ctx.todoist.closeTask(todoistId);
        } else if (wasCompleted && !isNowCompleted) {
          await ctx.todoist.reopenTask(todoistId);
        }

        entry.lastKnownState = notionSnapshot;
        await saveState(ctx.db, state);
        console.log(`  ✏️  Notion→Todoist UPDATE: "${notionNormalized.title}"`);
      } catch (err) {
        console.error(
          `  ❌ Update Todoist failed for "${notionNormalized.title}":`,
          err.message,
        );
      }
    }
  }
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
      await saveState(ctx.db, state);
    } else if (isActiveInTodoist && entry.todoistCompletedAt) {
      delete entry.todoistCompletedAt;
      await saveState(ctx.db, state);
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
        await saveState(ctx.db, state);
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
        await saveState(ctx.db, state);
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
        await saveState(ctx.db, state);
        console.log(`  🗑️  Todoist deleted → Notion page archived`);
      } catch (err) {
        console.error(`  ❌ Failed to archive Notion page:`, err.message);
      }
      continue;
    }

    // ── Both gone → clean up state ──
    if (goneFromTodoist && !notionExists) {
      delete state.tasks[todoistId];
      await saveState(ctx.db, state);
    }
  }
}
