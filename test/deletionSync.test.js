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
  return state;
}

const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

function linked(status, extra = {}) {
  return {
    lastSyncedAt: null,
    tasks: {
      5: {
        notionPageId: 'p5',
        lastKnownState: { title: 'Task', taskDate: null, priority: 'P4', status, type: null },
        ...extra,
      },
    },
  };
}

const page = (status) => notionPage({ id: 'p5', title: 'Task', status });
const has = (fakes, name) => fakes.names().includes(name);

test('Notion page deleted → active Todoist task deleted', async () => {
  const fakes = createFakes({ todoistTasks: [{ id: '5', content: 'Task', priority: 1 }] });
  const state = await sync(fakes, linked('TO DO'));
  assert.ok(has(fakes, 'todoist.deleteTask'));
  assert.equal(state.tasks['5'], undefined);
});

test('Notion page deleted → completed Todoist task deleted', async () => {
  const fakes = createFakes({
    completedTasks: [{ id: '5', content: 'Task', priority: 1, checked: true, completed_at: daysAgo(2) }],
  });
  const state = await sync(fakes, linked('Done'));
  assert.ok(has(fakes, 'todoist.deleteTask'));
  assert.equal(state.tasks['5'], undefined);
});

test('Todoist task deleted → Notion page archived', async () => {
  const fakes = createFakes({ notionPages: [page('TO DO')] });
  const state = await sync(fakes, linked('TO DO'));
  assert.ok(has(fakes, 'notion.deletePage'));
  assert.equal(state.tasks['5'], undefined);
});

test('recently completed Todoist task then deleted → Notion page archived', async () => {
  const fakes = createFakes({ notionPages: [page('Done')] });
  const state = await sync(fakes, linked('Done', { todoistCompletedAt: daysAgo(3) }));
  assert.ok(has(fakes, 'notion.deletePage'));
  assert.equal(state.tasks['5'], undefined);
});

test('old completion that aged out of the completed list is not archived', async () => {
  const fakes = createFakes({ notionPages: [page('Done')] });
  const state = await sync(fakes, linked('Done', { todoistCompletedAt: daysAgo(45) }));
  assert.ok(!has(fakes, 'notion.deletePage'));
  assert.ok(state.tasks['5']);
});

test('Done task with unknown completion time is not archived', async () => {
  const fakes = createFakes({ notionPages: [page('Done')] });
  await sync(fakes, linked('Done'));
  assert.ok(!has(fakes, 'notion.deletePage'));
});

test('completion time is recorded, and cleared when the task is reopened', async () => {
  const state = linked('Done');
  const completedAt = daysAgo(1);
  await sync(
    createFakes({
      notionPages: [page('Done')],
      completedTasks: [{ id: '5', content: 'Task', priority: 1, checked: true, completed_at: completedAt }],
    }),
    state,
  );
  assert.equal(state.tasks['5'].todoistCompletedAt, completedAt);

  await sync(
    createFakes({ notionPages: [page('Done')], todoistTasks: [{ id: '5', content: 'Task', priority: 1 }] }),
    state,
  );
  assert.equal(state.tasks['5'].todoistCompletedAt, undefined);
});
