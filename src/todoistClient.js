import { requestJson } from './http.js';

const BASE_URL = 'https://api.todoist.com/api/v1';

// Normalize response — API may return { results: [] } or plain array
function extractArray(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.results)) return data.results;
  if (data && Array.isArray(data.items)) return data.items;
  return [];
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
    // Fetch all active (non-completed) tasks
    async getAllTasks() {
      return extractArray(await call('GET', '/tasks'));
    },

    // Completed tasks not available on free plan via v1 API
    async getRecentlyCompletedTasks() {
      return [];
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
