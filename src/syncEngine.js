import * as fieldMapper from './fieldMapper.js';
import { todoistIdProperty } from './notionClient.js';
import { saveState, findByNotionId, findByTodoistId } from './stateManager.js';

// Worst-case subrequests each operation needs. An operation only starts if the
// budget can cover it; otherwise it is deferred to the next run.
const COST = {
  createInNotion: 1,
  createInTodoist: 3, // create + close (if Done) + write Todoist ID to Notion
  updateNotion: 1,
  updateTodoist: 2, // update + close/reopen
  delete: 1,
};

// ─── Main Sync Cycle ─────────────────────────────────────────────────────────
// ctx: { notion, todoist, db, budget, state }
export async function runSync(ctx) {
  console.log(`[${new Date().toISOString()}] 🔄 Starting sync cycle...`);

  const { state } = ctx;
  ctx.deferred = 0;

  // 1. Fetch current data from both sides
  const [notionPages, todoistActiveTasks, todoistCompletedTasks] =
    await Promise.all([
      ctx.notion.getAllPages(),
      ctx.todoist.getAllTasks(),
      ctx.todoist.getRecentlyCompletedTasks(),
    ]);

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

    const normalized = fieldMapper.fromTodoist(task);
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
    try {
      const payload = fieldMapper.toTodoistPayload(normalized);
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

    const todoistNormalized = fieldMapper.fromTodoist(todoistTask);
    const notionNormalized = fieldMapper.fromNotion(notionPage);
    const todoistSnapshot = fieldMapper.toSnapshot(todoistNormalized);
    const notionSnapshot = fieldMapper.toSnapshot(notionNormalized);
    const oldSnapshot = entry.lastKnownState;

    const todoistChanged = !fieldMapper.snapshotsAreEqual(
      oldSnapshot,
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
        entry.lastKnownState = todoistSnapshot;
        await saveState(ctx.db, state);
        console.log(`  ${label}: "${todoistNormalized.title}"`);
      } catch (err) {
        console.error(
          `  ❌ Update Notion failed for "${todoistNormalized.title}":`,
          err.message,
        );
      }
    } else if (notionChanged) {
      // Notion changed → push to Todoist
      if (!canAfford(ctx, COST.updateTodoist)) continue;
      try {
        const payload = fieldMapper.toTodoistPayload(notionNormalized);
        await ctx.todoist.updateTask(todoistId, payload);

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

    // ── Notion page deleted → delete Todoist task ──
    if (!notionExists && isActiveInTodoist) {
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

    // ── Todoist task truly deleted (not completed) → archive Notion page ──
    // Skip if last known status was already Done — it was completed intentionally.
    // Skip if the completed list could not be fetched — it may just be completed.
    if (
      completedKnown &&
      !isActiveInTodoist &&
      !isCompletedInTodoist &&
      notionExists &&
      entry.lastKnownState?.status !== 'Done'
    ) {
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
    if (completedKnown && !notionExists && !isActiveInTodoist && !isCompletedInTodoist) {
      delete state.tasks[todoistId];
      await saveState(ctx.db, state);
    }
  }
}
