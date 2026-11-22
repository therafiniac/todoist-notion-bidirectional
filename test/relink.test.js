import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSync } from '../src/syncEngine.js';
import { createFakeDb, createFakes, notionPage } from './helpers.js';

async function sync(fakes, state = { lastSyncedAt: null, tasks: {} }) {
  const { log, error } = console;
  console.log = () => {};
  console.error = () => {};
  try {
    await runSync({ ...fakes, db: createFakeDb(), state });
  } finally {
    Object.assign(console, { log, error });
  }
  return state;
}

const creates = (fakes) =>
  fakes.names().filter((n) => n === 'notion.createPage' || n === 'todoist.createTask');

test('fresh state: pages with a matching Todoist ID are linked, not duplicated', async () => {
  const fakes = createFakes({
    notionPages: [notionPage({ id: 'p1', title: 'Gym', type: 'Personal', todoistId: '11' })],
    todoistTasks: [{ id: '11', content: 'Gym', priority: 1, project_id: 'proj-personal' }],
  });
  const state = await sync(fakes);

  assert.deepEqual(creates(fakes), []);
  assert.equal(state.tasks['11'].notionPageId, 'p1');
  assert.ok(!fakes.names().some((n) => n.endsWith('updatePage') || n.endsWith('updateTask')));
});

test('relinked pair with differences keeps the Notion value', async () => {
  const fakes = createFakes({
    notionPages: [notionPage({ id: 'p1', title: 'Gym (Notion)', todoistId: '11' })],
    todoistTasks: [{ id: '11', content: 'Gym', priority: 1, project_id: 'proj-shopping' }],
  });
  await sync(fakes);
  const update = fakes.calls.find((c) => c.name === 'todoist.updateTask');
  assert.deepEqual(update.args[1], { content: 'Gym (Notion)' });
});

test('relinks completed Todoist tasks too', async () => {
  const fakes = createFakes({
    notionPages: [notionPage({ id: 'p1', title: 'Old', status: 'Done', todoistId: '12' })],
    completedTasks: [{ id: '12', content: 'Old', priority: 1, checked: true, completed_at: '2026-11-20T08:00:00Z' }],
  });
  const state = await sync(fakes);
  assert.deepEqual(creates(fakes), []);
  assert.equal(state.tasks['12'].notionPageId, 'p1');
});

test('page whose Todoist task no longer exists is not recreated', async () => {
  const fakes = createFakes({
    notionPages: [notionPage({ id: 'p1', title: 'Gone', todoistId: '99' })],
  });
  const state = await sync(fakes);
  assert.deepEqual(creates(fakes), []);
  assert.deepEqual(state.tasks, {});
});

test('two pages with the same Todoist ID: only the first is linked', async () => {
  const fakes = createFakes({
    notionPages: [
      notionPage({ id: 'p1', title: 'Gym', todoistId: '11' }),
      notionPage({ id: 'p2', title: 'Gym copy', todoistId: '11' }),
    ],
    todoistTasks: [{ id: '11', content: 'Gym', priority: 1, project_id: 'proj-shopping' }],
  });
  const state = await sync(fakes);
  assert.equal(state.tasks['11'].notionPageId, 'p1');
  assert.deepEqual(creates(fakes), []);
});
