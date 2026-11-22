// Sync state lives in D1 as a single JSON row (id = 1).
const DEFAULT_STATE = {
  lastSyncedAt: null,
  tasks: {},
};

const LOCK_TTL_MS = 5 * 60 * 1000;

export async function loadState(db) {
  const row = await db
    .prepare('SELECT data FROM sync_state WHERE id = 1')
    .first();
  if (!row) return { ...DEFAULT_STATE, tasks: {} };

  const parsed = JSON.parse(row.data);
  if (!parsed.tasks) parsed.tasks = {};
  return parsed;
}

export async function saveState(db, state) {
  await db
    .prepare(
      `INSERT INTO sync_state (id, data, updated_at) VALUES (1, ?1, ?2)
       ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
    )
    .bind(JSON.stringify(state), new Date().toISOString())
    .run();
}

// Atomically takes the run lock; returns false if another run holds it.
// The TTL frees the lock if a run dies without releasing it.
export async function acquireLock(db, now = Date.now()) {
  const result = await db
    .prepare(
      'UPDATE sync_lock SET locked_until = ?1 WHERE id = 1 AND locked_until < ?2',
    )
    .bind(now + LOCK_TTL_MS, now)
    .run();
  return result.meta.changes === 1;
}

export async function releaseLock(db) {
  await db.prepare('UPDATE sync_lock SET locked_until = 0 WHERE id = 1').run();
}

// Find a state entry by Notion page ID
export function findByNotionId(state, notionPageId) {
  if (!state.tasks) return null;
  return (
    Object.entries(state.tasks).find(
      ([, val]) => val.notionPageId === notionPageId,
    ) || null
  );
}

// Find a state entry by Todoist task ID
export function findByTodoistId(state, todoistId) {
  if (!state.tasks) return null;
  const key = String(todoistId);
  const entry = state.tasks[key];
  return entry ? [key, entry] : null;
}
