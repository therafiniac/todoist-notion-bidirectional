import { SubrequestBudget } from './budget.js';
import { createNotionClient } from './notionClient.js';
import { createTodoistClient } from './todoistClient.js';
import {
  loadState,
  acquireLock,
  releaseLock,
} from './stateManager.js';
import { runSync } from './syncEngine.js';

const REQUIRED_ENV = ['NOTION_TOKEN', 'NOTION_DATABASE_ID', 'TODOIST_API_TOKEN'];

async function runScheduledSync(env) {
  const missing = REQUIRED_ENV.filter((key) => !env[key]);
  if (missing.length > 0) {
    console.error(`❌ Missing required secrets: ${missing.join(', ')}`);
    return;
  }

  if (!(await acquireLock(env.DB))) {
    console.log('⏭️  Previous sync still running, skipping this run.');
    return;
  }

  try {
    const budget = new SubrequestBudget();
    await runSync({
      db: env.DB,
      budget,
      state: await loadState(env.DB),
      notion: createNotionClient({
        token: env.NOTION_TOKEN,
        databaseId: env.NOTION_DATABASE_ID,
        budget,
      }),
      todoist: createTodoistClient({ token: env.TODOIST_API_TOKEN, budget }),
    });
  } catch (err) {
    console.error('❌ Sync cycle failed:', err.message);
  } finally {
    await releaseLock(env.DB);
  }
}

export default {
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(runScheduledSync(env));
  },

  // Minimal health check; exposes only the last sync time.
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (request.method !== 'GET' || pathname !== '/health') {
      return new Response('Not found', { status: 404 });
    }
    const state = await loadState(env.DB);
    return Response.json({ ok: true, lastSyncedAt: state.lastSyncedAt });
  },
};
