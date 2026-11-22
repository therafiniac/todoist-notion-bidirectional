import { requestJson } from './http.js';

const BASE_URL = 'https://api.todoist.com/api/v1';
const PAGE_LIMIT = 200; // API maximum
const COMPLETED_WINDOW_DAYS = 30; // endpoint allows up to 3 months
const DAY_MS = 24 * 60 * 60 * 1000;

// Normalize response — list endpoints return { results: [] } (completed: { items: [] })
function extractArray(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.results)) return data.results;
  if (data && Array.isArray(data.items)) return data.items;
  return [];
}

function pageQuery(cursor) {
  return `limit=${PAGE_LIMIT}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
}

// "2026-11-22T10:00:00Z" — the API's documented format, without milliseconds
function toApiDate(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

async function collectPages(fetchPage) {
  const all = [];
  let cursor = null;
  do {
    const data = await fetchPage(cursor);
    all.push(...extractArray(data));
    cursor = data?.next_cursor || null;
  } while (cursor);
  return all;
}

export function createTodoistClient({ token, budget }) {
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  const call = (method, path, body) =>
    requestJson(
      budget,
      `${BASE_URL}${path}`,
      { method, headers, body: body ? JSON.stringify(body) : undefined },
      'Todoist',
    );

  return {
    // Fetch all active (non-completed) tasks, following pagination
    async getAllTasks() {
      return collectPages((cursor) => call('GET', `/tasks?${pageQuery(cursor)}`));
    },

    // Tasks completed within the last COMPLETED_WINDOW_DAYS.
    // Returns null if the endpoint is unavailable, so callers can tell
    // "not completed" apart from "unknown" and avoid treating completions as deletions.
    async getRecentlyCompletedTasks(now = new Date()) {
      const until = new Date(now.getTime() + 60 * 1000);
      const since = new Date(now.getTime() - COMPLETED_WINDOW_DAYS * DAY_MS);
      const range = `since=${toApiDate(since)}&until=${toApiDate(until)}`;
      try {
        return await collectPages((cursor) =>
          call('GET', `/tasks/completed/by_completion_date?${range}&${pageQuery(cursor)}`),
        );
      } catch (err) {
        console.error('  ⚠️  Could not fetch completed Todoist tasks:', err.message);
        return null;
      }
    },

    // All active projects (id, name, inbox_project), following pagination
    async getProjects() {
      return collectPages((cursor) => call('GET', `/projects?${pageQuery(cursor)}`));
    },

    // Moving between projects needs its own endpoint; update can't change project_id
    async moveTask(taskId, projectId) {
      await call('POST', `/tasks/${taskId}/move`, { project_id: projectId });
    },

    createTask(payload) {
      return call('POST', '/tasks', payload);
    },

    async updateTask(taskId, payload) {
      return (await call('POST', `/tasks/${taskId}`, payload)) || {};
    },

    async closeTask(taskId) {
      await call('POST', `/tasks/${taskId}/close`, {});
    },

    async reopenTask(taskId) {
      await call('POST', `/tasks/${taskId}/reopen`, {});
    },

    async deleteTask(taskId) {
      await call('DELETE', `/tasks/${taskId}`);
    },
  };
}
