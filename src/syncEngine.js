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
  const [notionPages, todoistTasks] = await Promise.all([
    notionClient.getAllPages(),
    todoistClient.getAllTasks(),
  ]);

  // Build lookup maps
  const activeTodoistMap = new Map(todoistTasks.map((t) => [String(t.id), t]));
  const activeNotionMap = new Map(
    notionPages.filter((p) => !p.archived).map((p) => [p.id, p]),
  );

  // Track IDs created this cycle to skip them in deletion check
  const createdThisCycle = new Set();

  // 2. Todoist → Notion (new tasks in Todoist not yet in state)
  await syncTodoistToNotion(state, todoistTasks, createdThisCycle);

  // 3. Notion → Todoist (new pages in Notion not yet in state)
  await syncNotionToTodoist(
    state,
    notionPages,
    activeTodoistMap,
    createdThisCycle,
  );

  // 4. Handle updates (tasks already in state, check for changes)
  await handleUpdates(state, activeTodoistMap, activeNotionMap);

  // 5. Handle deletions (only tasks in state that are gone from BOTH fetch results)
  await handleDeletions(
    state,
    activeNotionMap,
    activeTodoistMap,
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

    // Skip if already tracked in state
    if (findByTodoistId(state, taskId)) continue;

    const normalized = fieldMapper.fromTodoist(task);

    try {
      const properties = fieldMapper.toNotionProperties(normalized);
      const page = await notionClient.createPage(properties);
      await notionClient.setTodoistId(page.id, taskId);

      // Save to state IMMEDIATELY after creation
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

    // Skip if already tracked in state
    if (findByNotionId(state, pageId)) continue;

    const normalized = fieldMapper.fromNotion(page);

    try {
      const payload = fieldMapper.toTodoistPayload(normalized);
      const task = await todoistClient.createTask(payload);
      const taskId = String(task.id);

      if (normalized.status === 'DONE') {
        await todoistClient.closeTask(taskId);
      }

      // Store Todoist ID back in Notion page
      await notionClient.setTodoistId(pageId, taskId);

      // Save to state IMMEDIATELY after creation
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

// ─── Handle Updates (tasks already linked in state) ───────────────────────────
async function handleUpdates(state, activeTodoistMap, activeNotionMap) {
  for (const [todoistId, entry] of Object.entries(state.tasks)) {
    const todoistTask = activeTodoistMap.get(todoistId);
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
          `  ❌ Failed to update Notion for "${todoistNormalized.title}":`,
          err.message,
        );
      }
    } else if (notionChanged && !todoistChanged) {
      // Notion changed → push to Todoist
      try {
        const payload = fieldMapper.toTodoistPayload(notionNormalized);
        await todoistClient.updateTask(todoistId, payload);

        // Handle completion status change
        const wasCompleted = oldSnapshot.status === 'DONE';
        const isNowCompleted = notionNormalized.status === 'DONE';
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
          `  ❌ Failed to update Todoist for "${notionNormalized.title}":`,
          err.message,
        );
      }
    } else if (todoistChanged && notionChanged) {
      // Conflict: both changed → Todoist wins
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

// ─── Deletion Handler ─────────────────────────────────────────────────────────
async function handleDeletions(
  state,
  activeNotionMap,
  activeTodoistMap,
  createdThisCycle,
) {
  for (const [todoistId, entry] of Object.entries(state.tasks)) {
    // Never delete something created this very cycle
    if (createdThisCycle.has(todoistId)) continue;

    const notionExists = activeNotionMap.has(entry.notionPageId);
    const todoistExists = activeTodoistMap.has(todoistId);

    if (!notionExists && todoistExists) {
      // Notion page was deleted → delete Todoist task
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
    } else if (todoistExists === false && notionExists) {
      // Todoist task was deleted → archive Notion page
      try {
        await notionClient.deletePage(entry.notionPageId);
        delete state.tasks[todoistId];
        saveState(state);
        console.log(`  🗑️  Todoist deleted → Notion page archived`);
      } catch (err) {
        console.error(
          `  ❌ Failed to archive Notion page ${entry.notionPageId}:`,
          err.message,
        );
      }
    } else if (!notionExists && !todoistExists) {
      // Both gone → clean up state only
      delete state.tasks[todoistId];
      saveState(state);
    }
  }
}

module.exports = { runSync };
