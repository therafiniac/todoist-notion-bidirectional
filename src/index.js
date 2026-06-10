// Force unbuffered stdout so logs write immediately to file
if (process.stdout._handle) process.stdout._handle.setBlocking(true);
if (process.stderr._handle) process.stderr._handle.setBlocking(true);

require('dotenv').config();
const cron = require('node-cron');
const notionClient = require('./notionClient');
const { runSync } = require('./syncEngine');

// ─── Validate environment variables ──────────────────────────────────────────
const REQUIRED_ENV = [
  'NOTION_TOKEN',
  'NOTION_DATABASE_ID',
  'TODOIST_API_TOKEN',
];
const missing = REQUIRED_ENV.filter((key) => !process.env[key]);

if (missing.length > 0) {
  console.error(
    `❌ Missing required environment variables: ${missing.join(', ')}`,
  );
  console.error(`   Copy .env.example to .env and fill in your credentials.`);
  process.exit(1);
}

// ─── Init Notion client ───────────────────────────────────────────────────────
notionClient.init();

// ─── Polling interval ─────────────────────────────────────────────────────────
const POLL_SECONDS = parseInt(process.env.POLL_INTERVAL_SECONDS || '30', 10);

console.log('🚀 Notion ↔ Todoist Sync Engine started');
console.log(`   Polling every ${POLL_SECONDS} seconds`);
console.log(`   Database ID: ${process.env.NOTION_DATABASE_ID}`);
console.log('─'.repeat(50));

// ─── Run immediately on start, then on schedule ───────────────────────────────
runSync().catch(console.error);

// node-cron needs a cron expression. We convert seconds to a cron expression.
// For intervals < 60s, we use setInterval instead since cron only supports minutes+.
if (POLL_SECONDS < 60) {
  setInterval(() => {
    runSync().catch(console.error);
  }, POLL_SECONDS * 1000);
} else {
  const minutes = Math.floor(POLL_SECONDS / 60);
  cron.schedule(`*/${minutes} * * * *`, () => {
    runSync().catch(console.error);
  });
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────
process.on('SIGINT', () => {
  console.log('\n👋 Sync engine stopped.');
  process.exit(0);
});
