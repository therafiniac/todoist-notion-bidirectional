import { SubrequestBudget } from '../src/budget.js';

// In-memory stand-in for the D1 binding, supporting the statements stateManager uses.
export function createFakeDb() {
  const db = {
    stateRow: null,
    lockedUntil: 0,
    queries: 0,
    prepare(sql) {
      db.queries += 1;
      let args = [];
      const stmt = {
        bind(...values) {
          args = values;
          return stmt;
        },
        async first() {
          return sql.startsWith('SELECT data') ? db.stateRow : null;
        },
        async run() {
          if (sql.startsWith('INSERT INTO sync_state')) {
            db.stateRow = { data: args[0] };
            return { meta: { changes: 1 } };
          }
          if (sql.includes('locked_until = ?1')) {
            const [until, now] = args;
            if (db.lockedUntil < now) {
              db.lockedUntil = until;
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          }
          if (sql.includes('locked_until = 0')) {
            db.lockedUntil = 0;
            return { meta: { changes: 1 } };
          }
          throw new Error(`Unexpected SQL in fake: ${sql}`);
        },
      };
      return stmt;
    },
  };
  return db;
}

export function notionPage({ id, title, date = null, priority = 'P4', status = 'TO DO', type = null, todoistId = null, archived = false }) {
  return {
    id,
    archived,
    properties: {
      Tasks: { title: [{ plain_text: title }] },
      'Task Date': { date: date ? { start: date } : null },
      Priority: { select: { name: priority } },
      Status: { status: { name: status } },
      Type: { select: type ? { name: type } : null },
      'Todoist ID': { rich_text: todoistId ? [{ plain_text: todoistId }] : [] },
    },
  };
}

// Fake API clients that record every write and charge the shared budget per call,
// mirroring the real clients.
export const PROJECTS = [
  { id: 'inbox', name: 'Inbox', inbox_project: true },
  { id: 'proj-personal', name: 'Personal' },
  { id: 'proj-professional', name: 'Professional' },
  { id: 'proj-shopping', name: 'Shopping' },
];

export function createFakes({ notionPages = [], todoistTasks = [], completedTasks = [], projects = PROJECTS, limit = 45 } = {}) {
  const budget = new SubrequestBudget(limit, async () => {
    throw new Error('real fetch must not be called in tests');
  });
  const calls = [];
  const spend = (name, args) => {
    if (!budget.has(1)) throw new Error('Subrequest budget exhausted');
    budget.used += 1;
    calls.push({ name, args });
  };
  let nextTaskId = 1000;
  let nextPageId = 1;

  const notion = {
    async getAllPages() {
      spend('notion.getAllPages', []);
      return notionPages;
    },
    async createPage(properties) {
      spend('notion.createPage', [properties]);
      return { id: `page-new-${nextPageId++}` };
    },
    async updatePage(id, properties) {
      spend('notion.updatePage', [id, properties]);
    },
    async deletePage(id) {
      spend('notion.deletePage', [id]);
    },
    async setTodoistId(pageId, taskId) {
      spend('notion.setTodoistId', [pageId, taskId]);
    },
  };

  const todoist = {
    async getAllTasks() {
      spend('todoist.getAllTasks', []);
      return todoistTasks;
    },
    async getRecentlyCompletedTasks() {
      spend('todoist.getRecentlyCompletedTasks', []);
      return completedTasks;
    },
    async getProjects() {
      spend('todoist.getProjects', []);
      return projects;
    },
    async moveTask(id, projectId) {
      spend('todoist.moveTask', [id, projectId]);
    },
    async createTask(payload) {
      spend('todoist.createTask', [payload]);
      return { id: String(nextTaskId++), ...payload };
    },
    async updateTask(id, payload) {
      spend('todoist.updateTask', [id, payload]);
      return {};
    },
    async closeTask(id) {
      spend('todoist.closeTask', [id]);
    },
    async reopenTask(id) {
      spend('todoist.reopenTask', [id]);
    },
    async deleteTask(id) {
      spend('todoist.deleteTask', [id]);
    },
  };

  const names = () => calls.map((c) => c.name);
  return { budget, notion, todoist, calls, names };
}
