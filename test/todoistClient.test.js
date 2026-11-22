import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SubrequestBudget } from '../src/budget.js';
import { createTodoistClient } from '../src/todoistClient.js';

function jsonResponse(body) {
  return new Response(JSON.stringify(body), { status: 200 });
}

test('getAllTasks follows next_cursor across pages', async () => {
  const urls = [];
  const budget = new SubrequestBudget(10, async (url) => {
    urls.push(url);
    return url.includes('cursor=abc')
      ? jsonResponse({ results: [{ id: '2' }], next_cursor: null })
      : jsonResponse({ results: [{ id: '1' }], next_cursor: 'abc' });
  });
  const tasks = await createTodoistClient({ token: 't', budget }).getAllTasks();

  assert.deepEqual(tasks.map((t) => t.id), ['1', '2']);
  assert.ok(urls[0].includes('limit=200'));
  assert.equal(budget.used, 2);
});

test('getRecentlyCompletedTasks queries a date range and reads items', async () => {
  let requested;
  const budget = new SubrequestBudget(10, async (url) => {
    requested = new URL(url);
    return jsonResponse({ items: [{ id: '9', checked: true }], next_cursor: null });
  });
  const tasks = await createTodoistClient({ token: 't', budget }).getRecentlyCompletedTasks(
    new Date('2026-11-22T10:00:00.000Z'),
  );

  assert.equal(requested.pathname, '/api/v1/tasks/completed/by_completion_date');
  assert.equal(requested.searchParams.get('since'), '2026-10-23T10:00:00Z');
  assert.equal(requested.searchParams.get('until'), '2026-11-22T10:01:00Z');
  assert.deepEqual(tasks.map((t) => t.id), ['9']);
});

test('getRecentlyCompletedTasks returns null when the endpoint fails', async () => {
  const budget = new SubrequestBudget(10, async () => new Response('forbidden', { status: 403 }));
  const { error } = console;
  console.error = () => {};
  try {
    assert.equal(await createTodoistClient({ token: 't', budget }).getRecentlyCompletedTasks(), null);
  } finally {
    console.error = error;
  }
});
