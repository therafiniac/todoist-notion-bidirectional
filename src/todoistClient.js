const axios = require('axios');

const BASE_URL = 'https://api.todoist.com/api/v1';

function getHeaders() {
  return {
    Authorization: `Bearer ${process.env.TODOIST_API_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

// Normalize response — new API may return { results: [] } or plain array
function extractArray(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.results)) return data.results;
  if (data && Array.isArray(data.items)) return data.items;
  return [];
}

// Fetch all active (non-completed) tasks
async function getAllTasks() {
  const response = await axios.get(`${BASE_URL}/tasks`, {
    headers: getHeaders(),
  });
  return extractArray(response.data);
}

// Completed tasks not available on free plan via v1 API
async function getRecentlyCompletedTasks() {
  return [];
}

// Create a new Todoist task
async function createTask(payload) {
  const response = await axios.post(`${BASE_URL}/tasks`, payload, {
    headers: getHeaders(),
  });
  return response.data;
}

// Update an existing Todoist task
async function updateTask(taskId, payload) {
  const response = await axios.post(`${BASE_URL}/tasks/${taskId}`, payload, {
    headers: getHeaders(),
  });
  return response.data || {};
}

// Close (complete) a Todoist task
async function closeTask(taskId) {
  await axios.post(
    `${BASE_URL}/tasks/${taskId}/close`,
    {},
    { headers: getHeaders() },
  );
}

// Reopen a completed Todoist task
async function reopenTask(taskId) {
  await axios.post(
    `${BASE_URL}/tasks/${taskId}/reopen`,
    {},
    { headers: getHeaders() },
  );
}

// Delete a Todoist task permanently
async function deleteTask(taskId) {
  await axios.delete(`${BASE_URL}/tasks/${taskId}`, {
    headers: getHeaders(),
  });
}

module.exports = {
  getAllTasks,
  getRecentlyCompletedTasks,
  createTask,
  updateTask,
  closeTask,
  reopenTask,
  deleteTask,
};
