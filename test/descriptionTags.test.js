import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fromNotion,
  fromTodoist,
  mergeSnapshots,
  toNotionProperties,
  toTodoistUpdatePayload,
} from '../src/fieldMapper.js';
import { runSync } from '../src/syncEngine.js';
import { createFakeDb, createFakes, notionPage } from './helpers.js';

const base = { title: 'Task', taskDate: null, priority: 'P4', status: 'TO DO', type: null, description: '', tags: [] };

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

const call = (fakes, name) => fakes.calls.find((c) => c.name === name);
const writes = (fakes) =>
  fakes.names().filter((n) => !n.startsWith('notion.getAll') && !n.startsWith('todoist.get'));
const linked = (snapshot) => ({ lastSyncedAt: null, tasks: { 5: { notionPageId: 'p5', lastKnownState: snapshot } } });

test('reads Description and Tags from Notion, description and labels from Todoist', () => {
  const page = notionPage({ id: 'p', title: 'T', description: ' Notes ', tags: ['work', 'home'] });
  assert.deepEqual(fromNotion(page).tags, ['home', 'work']);
  assert.equal(fromNotion(page).description, 'Notes');

  const task = fromTodoist({ content: 'T', description: 'Notes', labels: ['work', 'a,b', 'home'] });
  assert.deepEqual(task.tags, ['home', 'work']);
  assert.equal(task.description, 'Notes');
});

test('long descriptions are split into 2000-character Notion segments', () => {
  const properties = toNotionProperties({ ...base, description: 'x'.repeat(4500) });
  assert.deepEqual(properties.Description.rich_text.map((s) => s.text.content.length), [2000, 2000, 500]);
  assert.deepEqual(toNotionProperties(base).Description.rich_text, []);
});

test('tags merge per tag: adding on one side and removing on the other keeps both', () => {
  const { merged } = mergeSnapshots({
    old: { ...base, tags: ['home', 'work'] },
    notion: { ...base, tags: ['home', 'urgent', 'work'] },
    todoist: { ...base, tags: ['work'] },
  });
  assert.deepEqual(merged.tags, ['urgent', 'work']);
});

test('label update keeps Todoist-only labels that contain commas', () => {
  const payload = toTodoistUpdatePayload({ ...base, tags: ['work'] }, { ...base, tags: ['home', 'work'] }, ['home', 'work', 'a,b']);
  assert.deepEqual(payload, { labels: ['work', 'a,b'] });
});

test('Todoist label and description changes reach Notion', async () => {
  const fakes = createFakes({
    notionPages: [notionPage({ id: 'p5', title: 'Task' })],
    todoistTasks: [{ id: '5', content: 'Task', priority: 1, project_id: 'proj-shopping', description: 'Call first', labels: ['urgent'] }],
  });
  await sync(fakes, linked({ ...base }));
  const update = call(fakes, 'notion.updatePage');
  assert.deepEqual(update.args[1].Tags.multi_select, [{ name: 'urgent' }]);
  assert.equal(update.args[1].Description.rich_text[0].text.content, 'Call first');
  assert.ok(!call(fakes, 'todoist.updateTask'));
});

test('Notion tag and description changes reach Todoist', async () => {
  const fakes = createFakes({
    notionPages: [notionPage({ id: 'p5', title: 'Task', description: 'New notes', tags: ['home', 'urgent'] })],
    todoistTasks: [{ id: '5', content: 'Task', priority: 1, project_id: 'proj-shopping', labels: ['home'] }],
  });
  await sync(fakes, linked({ ...base, tags: ['home'] }));
  assert.deepEqual(call(fakes, 'todoist.updateTask').args[1], { description: 'New notes', labels: ['home', 'urgent'] });
});

test('existing state without Description/Tags fills Notion from Todoist, then stays stable', async () => {
  const { description, tags, ...oldState } = base;
  const state = linked(oldState);
  const todoistTasks = [{ id: '5', content: 'Task', priority: 1, project_id: 'proj-shopping', description: 'Old notes', labels: ['home'] }];

  const first = createFakes({ notionPages: [notionPage({ id: 'p5', title: 'Task' })], todoistTasks });
  await sync(first, state);
  assert.deepEqual(writes(first), ['notion.updatePage']);

  const second = createFakes({
    notionPages: [notionPage({ id: 'p5', title: 'Task', description: 'Old notes', tags: ['home'] })],
    todoistTasks,
  });
  await sync(second, state);
  assert.deepEqual(writes(second), []);
});

test('new tasks carry description and tags in both directions', async () => {
  const fakes = createFakes({
    notionPages: [notionPage({ id: 'p1', title: 'From Notion', description: 'N notes', tags: ['work'] })],
    todoistTasks: [{ id: '9', content: 'From Todoist', priority: 1, description: 'T notes', labels: ['home'] }],
  });
  await sync(fakes, { lastSyncedAt: null, tasks: {} });

  assert.deepEqual(call(fakes, 'todoist.createTask').args[0].labels, ['work']);
  assert.equal(call(fakes, 'todoist.createTask').args[0].description, 'N notes');
  const page = call(fakes, 'notion.createPage').args[0];
  assert.deepEqual(page.Tags.multi_select, [{ name: 'home' }]);
  assert.equal(page.Description.rich_text[0].text.content, 'T notes');
});
