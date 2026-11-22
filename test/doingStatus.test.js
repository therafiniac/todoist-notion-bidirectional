import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSync } from '../src/syncEngine.js';
import { createFakeDb, createFakes, notionPage } from './helpers.js';

async function sync(fakes, state) {
  const { log, error } = console;
  console.log = () => {};
  console.error = () => {};
  try {
    await runSync({ ...fakes, db: createFakeDb(), state });
  } finally {
    Object.assign(console, { log, error });
  }
}

const writes = (fakes) =>
  fakes.names().filter((n) => !n.startsWith('notion.getAll') && !n.startsWith('todoist.get'));

const base = { title: 'Report', taskDate: null, priority: 'P4', type: null };

test('a DOING task stays stable across runs (no update loop)', async () => {
  const state = { lastSyncedAt: null, tasks: { 5: { notionPageId: 'p5', lastKnownState: { ...base, status: 'TO DO' } } } };
  const pages = [notionPage({ id: 'p5', title: 'Report', status: 'DOING' })];
  const tasks = [{ id: '5', content: 'Report', priority: 1, project_id: 'proj-shopping' }];

  for (let run = 0; run < 3; run += 1) {
    const fakes = createFakes({ notionPages: pages, todoistTasks: tasks });
    await sync(fakes, state);
    assert.deepEqual(writes(fakes), [], `run ${run + 1} made API writes`);
    assert.equal(state.tasks['5'].lastKnownState.status, 'DOING');
  }
});

test('a Todoist edit on a DOING task updates Notion and keeps DOING', async () => {
  const state = { lastSyncedAt: null, tasks: { 5: { notionPageId: 'p5', lastKnownState: { ...base, status: 'DOING' } } } };
  const fakes = createFakes({
    notionPages: [notionPage({ id: 'p5', title: 'Report', status: 'DOING' })],
    todoistTasks: [{ id: '5', content: 'Report v2', priority: 1, project_id: 'proj-shopping' }],
  });
  await sync(fakes, state);

  const update = fakes.calls.find((c) => c.name === 'notion.updatePage');
  assert.equal(update.args[1].Status.status.name, 'DOING');
  assert.equal(state.tasks['5'].lastKnownState.status, 'DOING');

  const next = createFakes({
    notionPages: [notionPage({ id: 'p5', title: 'Report v2', status: 'DOING' })],
    todoistTasks: [{ id: '5', content: 'Report v2', priority: 1, project_id: 'proj-shopping' }],
  });
  await sync(next, state);
  assert.deepEqual(writes(next), []);
});

test('completing a DOING task in Todoist sets Notion Done', async () => {
  const state = { lastSyncedAt: null, tasks: { 5: { notionPageId: 'p5', lastKnownState: { ...base, status: 'DOING' } } } };
  const fakes = createFakes({
    notionPages: [notionPage({ id: 'p5', title: 'Report', status: 'DOING' })],
    completedTasks: [{ id: '5', content: 'Report', priority: 1, project_id: 'proj-shopping', checked: true }],
  });
  await sync(fakes, state);

  const update = fakes.calls.find((c) => c.name === 'notion.updatePage');
  assert.equal(update.args[1].Status.status.name, 'Done');
  assert.equal(state.tasks['5'].lastKnownState.status, 'Done');
});
