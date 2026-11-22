import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromNotion, fromTodoist } from '../src/fieldMapper.js';
import { runSync } from '../src/syncEngine.js';
import { createFakeDb, createFakes, notionPage } from './helpers.js';

test('Notion title joins every rich-text segment', () => {
  const page = {
    properties: {
      Tasks: { title: [{ plain_text: 'Call ' }, { plain_text: 'Alex' }, { plain_text: ' about the deck' }] },
    },
  };
  assert.equal(fromNotion(page).title, 'Call Alex about the deck');
});

test('missing Notion title reads as empty', () => {
  assert.equal(fromNotion({ properties: {} }).title, '');
});

test('dates with times are compared as calendar days', () => {
  const page = { properties: { 'Task Date': { date: { start: '2026-11-22T10:00:00.000+05:30' } } } };
  assert.equal(fromNotion(page).taskDate, '2026-11-22');
  assert.equal(fromTodoist({ due: { date: '2026-11-22T10:00:00' } }).taskDate, '2026-11-22');
  assert.equal(fromTodoist({ due: null }).taskDate, null);
});

test('a timed task on both sides does not re-sync every run', async () => {
  const state = {
    lastSyncedAt: null,
    tasks: { 5: { notionPageId: 'p5', lastKnownState: { title: 'Call', taskDate: '2026-11-22', priority: 'P4', status: 'TO DO', type: null } } },
  };
  const fakes = createFakes({
    notionPages: [notionPage({ id: 'p5', title: 'Call', date: '2026-11-22T10:00:00.000+05:30' })],
    todoistTasks: [{ id: '5', content: 'Call', priority: 1, project_id: 'proj-shopping', due: { date: '2026-11-22T10:00:00' } }],
  });
  const { log, error } = console;
  console.log = () => {};
  console.error = () => {};
  try {
    await runSync({ ...fakes, db: createFakeDb(), state });
  } finally {
    Object.assign(console, { log, error });
  }
  assert.ok(!fakes.names().some((n) => n === 'notion.updatePage' || n === 'todoist.updateTask'));
});
