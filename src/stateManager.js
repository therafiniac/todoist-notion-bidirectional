const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, '../sync-state.json');

const DEFAULT_STATE = {
  lastSyncedAt: null,
  tasks: {},
};

function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    saveState(DEFAULT_STATE);
    return { ...DEFAULT_STATE, tasks: {} };
  }
  const raw = fs.readFileSync(STATE_FILE, 'utf-8');
  const parsed = JSON.parse(raw);
  // Ensure tasks always exists
  if (!parsed.tasks) parsed.tasks = {};
  return parsed;
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

// Find a state entry by Notion page ID
function findByNotionId(state, notionPageId) {
  if (!state.tasks) return null;
  return (
    Object.entries(state.tasks).find(
      ([, val]) => val.notionPageId === notionPageId,
    ) || null
  );
}

// Find a state entry by Todoist task ID (now supports string IDs)
function findByTodoistId(state, todoistId) {
  if (!state.tasks) return null;
  const key = String(todoistId);
  const entry = state.tasks[key];
  return entry ? [key, entry] : null;
}

module.exports = { loadState, saveState, findByNotionId, findByTodoistId };
