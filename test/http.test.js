import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SubrequestBudget } from '../src/budget.js';
import { requestJson, timing } from '../src/http.js';

const waits = [];
timing.sleep = async (ms) => {
  waits.push(ms);
};

const url = 'https://api.example.com/v1/thing';

test('retries once after a 429, honouring Retry-After', async () => {
  waits.length = 0;
  const responses = [
    new Response('slow down', { status: 429, headers: { 'Retry-After': '2' } }),
    new Response(JSON.stringify({ ok: true }), { status: 200 }),
  ];
  const budget = new SubrequestBudget(10, async () => responses.shift());

  assert.deepEqual(await requestJson(budget, url, { method: 'GET' }, 'Test'), { ok: true });
  assert.deepEqual(waits, [2000]);
  assert.equal(budget.used, 2);
});

test('gives up after one retry', async () => {
  const budget = new SubrequestBudget(10, async () => new Response('slow down', { status: 429 }));
  await assert.rejects(requestJson(budget, url, { method: 'GET' }, 'Test'), /429/);
  assert.equal(budget.used, 2);
});

test('does not retry when the budget is spent', async () => {
  const budget = new SubrequestBudget(1, async () => new Response('slow down', { status: 429 }));
  await assert.rejects(requestJson(budget, url, { method: 'GET' }, 'Test'), /429/);
  assert.equal(budget.used, 1);
});

test('caps long Retry-After waits', async () => {
  waits.length = 0;
  const responses = [
    new Response('', { status: 429, headers: { 'Retry-After': '60' } }),
    new Response(null, { status: 204 }),
  ];
  const budget = new SubrequestBudget(10, async () => responses.shift());
  assert.equal(await requestJson(budget, url, { method: 'DELETE' }, 'Test'), null);
  assert.deepEqual(waits, [5000]);
});
