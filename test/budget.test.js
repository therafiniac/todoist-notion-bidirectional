import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SubrequestBudget } from '../src/budget.js';

test('default fetch is called unbound (Workers rejects a foreign `this`)', async () => {
  const original = globalThis.fetch;
  let receivedThis = 'not called';
  globalThis.fetch = function (url) {
    receivedThis = this;
    return Promise.resolve(new Response(url));
  };
  try {
    const budget = new SubrequestBudget(5);
    await budget.fetch('https://example.com/');
    assert.ok(receivedThis === undefined || receivedThis === globalThis, 'fetch got the budget as `this`');
    assert.equal(budget.used, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test('refuses to fetch past the limit', async () => {
  const budget = new SubrequestBudget(1, async () => new Response('ok'));
  await budget.fetch('https://example.com/');
  await assert.rejects(budget.fetch('https://example.com/'), /budget exhausted/);
});
