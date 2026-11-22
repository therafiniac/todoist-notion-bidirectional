import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSync } from '../src/syncEngine.js';
import { loadState, acquireLock, releaseLock } from '../src/stateManager.js';
import { createFakeDb, createFakes, notionPage } from './helpers.js';

const quiet = () => {
  const { log, error } = console;
  console.log = () => {};
  console.error = () => {};
  return () => Object.assign(console, { log, error });
};

async function sync(fakes, db, state = { lastSyncedAt: null, tasks: {} }) {
  const restore = quiet();
  try {
    await runSync({ ...fakes, db, state });
  } finally {
    restore();
  }
  return state;
}

test('creates a Notion page for a new Todoist task, including the Todoist ID', async () => {
  const db = createFakeDb();
  const fakes = createFakes({
    todoistTasks: [{ id: '42', content: 'Buy milk', priority: 4, due: { date: '2026-11-23' } }],
  });

  const state = await sync(fakes, db);

  const create = fakes.calls.find((c) => c.name === 'notion.createPage');
  assert.equal(create.args[0]['Todoist ID'].rich_text[0].text.content, '42');
  assert.equal(create.args[0].Priority.select.name, 'P1');
  assert.ok(state.tasks['42']);
  assert.equal((await loadState(db)).tasks['42'].notionPageId, 'page-new-1');
});

test('creates a Todoist task for a new Notion page and records the link', async () => {
  const db = createFakeDb();
  const fakes = createFakes({
    notionPages: [notionPage({ id: 'p1', title: 'Write report', priority: 'P2' })],
  });

  const state = await sync(fakes, db);

  assert.deepEqual(fakes.names().filter((n) => !n.includes('getAll') && !n.includes('Completed')), [
    'todoist.createTask',
    'notion.setTodoistId',
  ]);
  assert.equal(state.tasks['1000'].notionPageId, 'p1');
});

test('Notion change is pushed to Todoist; conflict lets Todoist win', async () => {
  const snapshot = { title: 'A', taskDate: null, priority: 'P4', status: 'TO DO' };
  const state = {
    lastSyncedAt: null,
    tasks: {
      1: { notionPageId: 'p1', lastKnownState: { ...snapshot } },
      2: { notionPageId: 'p2', lastKnownState: { ...snapshot, title: 'B' } },
    },
  };
  const fakes = createFakes({
    notionPages: [
      notionPage({ id: 'p1', title: 'A renamed' }),
      notionPage({ id: 'p2', title: 'B notion edit' }),
    ],
    todoistTasks: [
      { id: '1', content: 'A', priority: 1 },
      { id: '2', content: 'B todoist edit', priority: 1 },
    ],
  });

  await sync(fakes, createFakeDb(), state);

  const update = fakes.calls.find((c) => c.name === 'todoist.updateTask');
  assert.equal(update.args[1].content, 'A renamed');
  const notionUpdate = fakes.calls.find((c) => c.name === 'notion.updatePage');
  assert.equal(notionUpdate.args[1].Tasks.title[0].text.content, 'B todoist edit');
});

test('defers work beyond the subrequest budget instead of failing', async () => {
  const pages = Array.from({ length: 30 }, (_, i) => notionPage({ id: `p${i}`, title: `T${i}` }));
  const fakes = createFakes({ notionPages: pages, limit: 20 });

  const state = await sync(fakes, createFakeDb());

  assert.ok(fakes.budget.used <= 20);
  // 3 fetches; each create reserves 3 but spends 2 (no close) → 8 fit in 20
  assert.equal(Object.keys(state.tasks).length, 8);
});

test('lock prevents overlapping runs and is released', async () => {
  const db = createFakeDb();
  assert.equal(await acquireLock(db, 1000), true);
  assert.equal(await acquireLock(db, 2000), false);
  await releaseLock(db);
  assert.equal(await acquireLock(db, 3000), true);
});
