import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toTodoistUpdatePayload } from '../src/fieldMapper.js';
import { runSync } from '../src/syncEngine.js';
import { createFakeDb, createFakes, notionPage } from './helpers.js';

const base = { title: 'Task', taskDate: '2026-11-30', priority: 'P4', status: 'TO DO', type: null, description: '', tags: [] };

test('clearing the date sends due_string "no date"', () => {
  assert.deepEqual(toTodoistUpdatePayload({ ...base, taskDate: null }, base), { due_string: 'no date' });
});

test('setting a date sends due_date only', () => {
  assert.deepEqual(toTodoistUpdatePayload({ ...base, taskDate: '2026-12-01' }, base), { due_date: '2026-12-01' });
});

test('a title change does not resend the due date (keeps recurrence)', () => {
  assert.deepEqual(toTodoistUpdatePayload({ ...base, title: 'New' }, base), { content: 'New' });
});

test('engine clears the Todoist date when the Notion date is removed', async () => {
  const state = { lastSyncedAt: null, tasks: { 5: { notionPageId: 'p5', lastKnownState: { ...base } } } };
  const fakes = createFakes({
    notionPages: [notionPage({ id: 'p5', title: 'Task' })],
    todoistTasks: [{ id: '5', content: 'Task', priority: 1, project_id: 'proj-shopping', due: { date: '2026-11-30' } }],
  });
  const { log, error } = console;
  console.log = () => {};
  console.error = () => {};
  try {
    await runSync({ ...fakes, db: createFakeDb(), state });
  } finally {
    Object.assign(console, { log, error });
  }
  const update = fakes.calls.find((c) => c.name === 'todoist.updateTask');
  assert.deepEqual(update.args[1], { due_string: 'no date' });
  assert.equal(state.tasks['5'].lastKnownState.taskDate, null);
});
