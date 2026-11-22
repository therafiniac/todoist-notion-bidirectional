import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromNotion } from '../src/fieldMapper.js';

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
