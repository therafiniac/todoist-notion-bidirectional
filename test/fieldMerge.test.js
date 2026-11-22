import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeSnapshots } from '../src/fieldMapper.js';
import { runSync } from '../src/syncEngine.js';
import { createFakeDb, createFakes, notionPage } from './helpers.js';

const old = { title: 'Task', taskDate: null, priority: 'P4', status: 'TO DO', type: 'Personal' };

test('different fields changed on each side are both kept', () => {
  const { merged, conflicts } = mergeSnapshots({
    old,
    notion: { ...old, title: 'Renamed in Notion' },
    todoist: { ...old, priority: 'P1' },
  });
  assert.deepEqual(merged, { ...old, title: 'Renamed in Notion', priority: 'P1' });
  assert.deepEqual(conflicts, []);
});

test('same field changed on both sides: later edit wins', () => {
  const notion = { ...old, title: 'Notion title' };
  const todoist = { ...old, title: 'Todoist title' };

  const notionLater = mergeSnapshots({
    old, notion, todoist,
    notionEditedAt: '2026-11-22T10:05:00.000Z',
    todoistEditedAt: '2026-11-22T10:03:12Z',
  });
  assert.equal(notionLater.merged.title, 'Notion title');
  assert.deepEqual(notionLater.conflicts, ['title']);

  const todoistLater = mergeSnapshots({
    old, notion, todoist,
    notionEditedAt: '2026-11-22T10:05:00.000Z',
    todoistEditedAt: '2026-11-22T10:06:00Z',
  });
  assert.equal(todoistLater.merged.title, 'Todoist title');
});

test('tie or missing timestamps fall back to Todoist', () => {
  const args = { old, notion: { ...old, title: 'N' }, todoist: { ...old, title: 'T' } };
  assert.equal(mergeSnapshots(args).merged.title, 'T');
  assert.equal(
    mergeSnapshots({ ...args, notionEditedAt: '2026-11-22T10:05:00Z', todoistEditedAt: '2026-11-22T10:05:00Z' }).merged.title,
    'T',
  );
});

test('same new value on both sides is not a conflict', () => {
  const { merged, conflicts } = mergeSnapshots({
    old, notion: { ...old, title: 'Same' }, todoist: { ...old, title: 'Same' },
  });
  assert.equal(merged.title, 'Same');
  assert.deepEqual(conflicts, []);
});

test('DOING in Notion survives a Todoist edit to another field', () => {
  const { merged } = mergeSnapshots({
    old: { ...old, status: 'DOING' },
    notion: { ...old, status: 'DOING' },
    todoist: { ...old, title: 'New title' },
  });
  assert.equal(merged.status, 'DOING');
  assert.equal(merged.title, 'New title');
});

test('engine pushes each side only the other side\'s changes', async () => {
  const state = { lastSyncedAt: null, tasks: { 5: { notionPageId: 'p5', lastKnownState: { ...old } } } };
  const fakes = createFakes({
    notionPages: [notionPage({ id: 'p5', title: 'Renamed in Notion', type: 'Personal' })],
    todoistTasks: [{ id: '5', content: 'Task', priority: 4, project_id: 'proj-personal' }],
  });
  const { log, error } = console;
  console.log = () => {};
  console.error = () => {};
  try {
    await runSync({ ...fakes, db: createFakeDb(), state });
  } finally {
    Object.assign(console, { log, error });
  }

  const todoistUpdate = fakes.calls.find((c) => c.name === 'todoist.updateTask');
  assert.equal(todoistUpdate.args[1].content, 'Renamed in Notion');
  assert.equal(todoistUpdate.args[1].priority, 4);
  const notionUpdate = fakes.calls.find((c) => c.name === 'notion.updatePage');
  assert.equal(notionUpdate.args[1].Tasks.title[0].text.content, 'Renamed in Notion');
  assert.equal(notionUpdate.args[1].Priority.select.name, 'P1');
  assert.ok(!fakes.names().includes('todoist.moveTask'));
  assert.deepEqual(state.tasks['5'].lastKnownState, { ...old, title: 'Renamed in Notion', priority: 'P1' });
});
