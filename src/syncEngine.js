const notionClient = require('./notionClient');
const todoistClient = require('./todoistClient');
const fieldMapper = require('./fieldMapper');
const {
  loadState,
  saveState,
  findByNotionId,
  findByTodoistId,
} = require('./stateManager');

// ─── Main Sync Cycle ─────────────────────────────────────────────────────────
async function runSync() {
  console.log(`\n[${new Date().toISOString()}] 🔄 Starting sync cycle...`);

  let state = loadState();

  // 1. Fetch current data from both sides
  const [notionPages, todoistActiveTasks, todoistCompletedTasks] =
    await Promise.all([
      notionClient.getAllPages(),
      todoistClient.getAllTasks(),
      todoistClient.getRecentlyCompletedTasks(),
    ]);

  // Build lookup maps
  const activeNotionMap = new Map(
    notionPages.filter((p) => !p.archived).map((p) => [p.id, p]),
  );

  // Combined todoist map: active + recently completed
  const allTodoistMap = new Map(
    todoistActiveTasks.map((t) => [String(t.id), t]),
  );
  for (const t of todoistCompletedTasks) {
    allTodoistMap.set(String(t.id), t);
  }
  const activeTodoistMap = new Map(
    todoistActiveTasks.map((t) => [String(t.id), t]),
  );

  // Track IDs created this cycle to skip in deletion check
  const createdThisCycle = new Set();

  // 2. CREATE: Todoist → Notion (new tasks not yet in state)
  await syncTodoistToNotion(state, todoistActiveTasks, createdThisCycle);

  // 3. CREATE: Notion → Todoist (new pages not yet in state)
  await syncNotionToTodoist(
    state,
    notionPages,
    activeTodoistMap,
    createdThisCycle,
  );

  // 4. UPDATE: tasks already linked in state, check for changes
  await handleUpdates(state, allTodoistMap, activeNotionMap);

  // 5. DELETIONS & COMPLETIONS
  await handleDeletionsAndCompletions(
    state,
    activeNotionMap,
    activeTodoistMap,
    allTodoistMap,
    createdThisCycle,
  );

  // 6. Save final state
  state.lastSyncedAt = new Date().toISOString();
  saveState(state);

  console.log(`[${new Date().toISOString()}] ✅ Sync cycle complete.\n`);
}

// ─── Todoist → Notion (CREATE only) ──────────────────────────────────────────
async function syncTodoistToNotion(state, todoistTasks, createdThisCycle) {
  for (const task of todoistTasks) {
    const taskId = String(task.id);
    if (findByTodoistId(state, taskId)) continue;

    const normalized = fieldMapper.fromTodoist(task);
    try {
      const properties = fieldMapper.toNotionProperties(normalized);
      const page = await notionClient.createPage(properties);
      await notionClient.setTodoistId(page.id, taskId);

      state.tasks[taskId] = {
        notionPageId: page.id,
        lastKnownState: fieldMapper.toSnapshot(normalized),
      };
      saveState(state);
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
async function syncNotionToTodoist(
  state,
  notionPages,
  activeTodoistMap,
  createdThisCycle,
) {
  for (const page of notionPages) {
    if (page.archived) continue;
    const pageId = page.id;
    if (findByNotionId(state, pageId)) continue;

    const normalized = fieldMapper.fromNotion(page);
    try {
      const payload = fieldMapper.toTodoistPayload(normalized);
      const task = await todoistClient.createTask(payload);
      const taskId = String(task.id);

      if (normalized.status === 'Done') {
        await todoistClient.closeTask(taskId);
      }

      await notionClient.setTodoistId(pageId, taskId);

      state.tasks[taskId] = {
        notionPageId: pageId,
        lastKnownState: fieldMapper.toSnapshot(normalized),
      };
      saveState(state);
      createdThisCycle.add(taskId);
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
async function handleUpdates(state, allTodoistMap, activeNotionMap) {
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

    if (todoistChanged && !notionChanged) {
      // Todoist changed → push to Notion
      try {
        const properties = fieldMapper.toNotionProperties(
          todoistNormalized,
          oldSnapshot.status,
        );
        await notionClient.updatePage(entry.notionPageId, properties);
        entry.lastKnownState = todoistSnapshot;
        saveState(state);
        console.log(
          `  ✏️  Todoist→Notion UPDATE: "${todoistNormalized.title}"`,
        );
      } catch (err) {
        console.error(
          `  ❌ Update Notion failed for "${todoistNormalized.title}":`,
          err.message,
        );
      }
    } else if (notionChanged && !todoistChanged) {
      // Notion changed → push to Todoist
      try {
        const payload = fieldMapper.toTodoistPayload(notionNormalized);
        await todoistClient.updateTask(todoistId, payload);

        const wasCompleted = oldSnapshot.status === 'Done';
        const isNowCompleted = notionNormalized.status === 'Done';
        if (!wasCompleted && isNowCompleted) {
          await todoistClient.closeTask(todoistId);
        } else if (wasCompleted && !isNowCompleted) {
          await todoistClient.reopenTask(todoistId);
        }

        entry.lastKnownState = notionSnapshot;
        saveState(state);
        console.log(`  ✏️  Notion→Todoist UPDATE: "${notionNormalized.title}"`);
      } catch (err) {
        console.error(
          `  ❌ Update Todoist failed for "${notionNormalized.title}":`,
          err.message,
        );
      }
    } else if (todoistChanged && notionChanged) {
      // Conflict → Todoist wins
      try {
        const properties = fieldMapper.toNotionProperties(
          todoistNormalized,
          oldSnapshot.status,
        );
        await notionClient.updatePage(entry.notionPageId, properties);
        entry.lastKnownState = todoistSnapshot;
        saveState(state);
        console.log(
          `  ⚠️  CONFLICT → Todoist wins: "${todoistNormalized.title}"`,
        );
      } catch (err) {
        console.error(
          `  ❌ Conflict resolution failed for "${todoistNormalized.title}":`,
          err.message,
        );
      }
    }
  }
}

// ─── Deletions & Completions ──────────────────────────────────────────────────
async function handleDeletionsAndCompletions(
  state,
  activeNotionMap,
  activeTodoistMap,
  allTodoistMap,
  createdThisCycle,
) {
  for (const [todoistId, entry] of Object.entries(state.tasks)) {
    if (createdThisCycle.has(todoistId)) continue;

    const notionExists = activeNotionMap.has(entry.notionPageId);
    const isActiveInTodoist = activeTodoistMap.has(todoistId);
    const isCompletedInTodoist =
      allTodoistMap.has(todoistId) && allTodoistMap.get(todoistId).is_completed;

    // ── Todoist task was COMPLETED (not deleted) → update Notion to DONE ──
    if (!isActiveInTodoist && isCompletedInTodoist && notionExists) {
      try {
        await notionClient.updatePage(entry.notionPageId, {
          Status: { status: { name: 'Done' } },
        });
        entry.lastKnownState = { ...entry.lastKnownState, status: 'Done' };
        saveState(state);
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
      try {
        await todoistClient.deleteTask(todoistId);
        delete state.tasks[todoistId];
        saveState(state);
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
    // Skip if last known status was already Done — it was completed intentionally
    if (
      !isActiveInTodoist &&
      !isCompletedInTodoist &&
      notionExists &&
      entry.lastKnownState?.status !== 'Done'
    ) {
      try {
        await notionClient.deletePage(entry.notionPageId);
        delete state.tasks[todoistId];
        saveState(state);
        console.log(`  🗑️  Todoist deleted → Notion page archived`);
      } catch (err) {
        console.error(`  ❌ Failed to archive Notion page:`, err.message);
      }
      continue;
    }

    // ── Both gone → clean up state ──
    if (!notionExists && !isActiveInTodoist && !isCompletedInTodoist) {
      delete state.tasks[todoistId];
      saveState(state);
    }
  }
}

module.exports = { runSync };
