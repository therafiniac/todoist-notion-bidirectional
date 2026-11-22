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

const call = (fakes, name) => fakes.calls.find((c) => c.name === name);

function linked(type, title = 'Task') {
  return {
    lastSyncedAt: null,
    tasks: {
      5: {
        notionPageId: 'p5',
        lastKnownState: { title, taskDate: null, priority: 'P4', status: 'TO DO', type },
      },
    },
  };
}

test('Notion Type creates the Todoist task in the matching project', async () => {
  const fakes = createFakes({
    notionPages: [notionPage({ id: 'p1', title: 'Deck', type: 'Professional' })],
  });
  await sync(fakes);
  assert.equal(call(fakes, 'todoist.createTask').args[0].project_id, 'proj-professional');
});

test('empty Notion Type creates the Todoist task in the Inbox (no project_id)', async () => {
  const fakes = createFakes({ notionPages: [notionPage({ id: 'p1', title: 'Misc' })] });
  await sync(fakes);
  assert.equal(call(fakes, 'todoist.createTask').args[0].project_id, undefined);
});

test('Todoist project sets Notion Type; other projects leave it empty', async () => {
  const fakes = createFakes({
    todoistTasks: [
      { id: '1', content: 'Gym', priority: 1, project_id: 'proj-personal' },
      { id: '2', content: 'Eggs', priority: 1, project_id: 'proj-shopping' },
    ],
  });
  await sync(fakes);
  const creates = fakes.calls.filter((c) => c.name === 'notion.createPage');
  assert.deepEqual(creates[0].args[0].Type, { select: { name: 'Personal' } });
  assert.deepEqual(creates[1].args[0].Type, { select: null });
});

test('changing Notion Type moves the Todoist task; clearing it moves to Inbox', async () => {
  const toPro = createFakes({
    notionPages: [notionPage({ id: 'p5', title: 'Task', type: 'Professional' })],
    todoistTasks: [{ id: '5', content: 'Task', priority: 1, project_id: 'proj-personal' }],
  });
  const state = await sync(toPro, linked('Personal'));
  assert.deepEqual(call(toPro, 'todoist.moveTask').args, ['5', 'proj-professional']);
  assert.equal(state.tasks['5'].lastKnownState.type, 'Professional');

  const toInbox = createFakes({
    notionPages: [notionPage({ id: 'p5', title: 'Task' })],
    todoistTasks: [{ id: '5', content: 'Task', priority: 1, project_id: 'proj-personal' }],
  });
  await sync(toInbox, linked('Personal'));
  assert.deepEqual(call(toInbox, 'todoist.moveTask').args, ['5', 'inbox']);
});

test('editing a Notion page without changing Type does not move the task', async () => {
  const fakes = createFakes({
    notionPages: [notionPage({ id: 'p5', title: 'Renamed' })],
    todoistTasks: [{ id: '5', content: 'Task', priority: 1, project_id: 'proj-shopping' }],
  });
  await sync(fakes, linked(null));
  assert.ok(call(fakes, 'todoist.updateTask'));
  assert.equal(call(fakes, 'todoist.moveTask'), undefined);
});

test('moving the task to another Todoist project updates Notion Type', async () => {
  const fakes = createFakes({
    notionPages: [notionPage({ id: 'p5', title: 'Task', type: 'Personal' })],
    todoistTasks: [{ id: '5', content: 'Task', priority: 1, project_id: 'proj-professional' }],
  });
  await sync(fakes, linked('Personal'));
  assert.deepEqual(call(fakes, 'notion.updatePage').args[1].Type, { select: { name: 'Professional' } });
});

test('old state without type keeps the Notion Type and moves the Todoist task', async () => {
  const state = linked('Personal');
  delete state.tasks['5'].lastKnownState.type;
  const fakes = createFakes({
    notionPages: [notionPage({ id: 'p5', title: 'Task', type: 'Professional' })],
    todoistTasks: [{ id: '5', content: 'Task', priority: 1, project_id: 'inbox' }],
  });
  await sync(fakes, state);
  assert.deepEqual(call(fakes, 'todoist.moveTask').args, ['5', 'proj-professional']);
  assert.ok(!fakes.calls.some((c) => c.name === 'notion.updatePage'));
});

test('skips creating when the Type project is missing in Todoist', async () => {
  const fakes = createFakes({
    notionPages: [notionPage({ id: 'p1', title: 'Deck', type: 'Professional' })],
    projects: [{ id: 'inbox', name: 'Inbox', inbox_project: true }],
  });
  const state = await sync(fakes);
  assert.equal(call(fakes, 'todoist.createTask'), undefined);
  assert.deepEqual(state.tasks, {});
});
