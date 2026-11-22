// One-time migration: converts the old local sync-state.json into a SQL file
// that seeds the D1 sync_state row.
//
// Usage:
//   node scripts/import-state.js path/to/sync-state.json > /tmp/state-import.sql
//   npx wrangler d1 execute notion-todoist-sync --remote --file=/tmp/state-import.sql
import { readFileSync } from 'node:fs';

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('Usage: node scripts/import-state.js <sync-state.json>');
  process.exit(1);
}

const state = JSON.parse(readFileSync(inputPath, 'utf-8'));
if (!state.tasks || typeof state.tasks !== 'object') {
  console.error('Invalid state file: missing "tasks" object');
  process.exit(1);
}

const json = JSON.stringify(state).replaceAll("'", "''");
const now = new Date().toISOString();

process.stdout.write(
  `INSERT INTO sync_state (id, data, updated_at) VALUES (1, '${json}', '${now}')\n` +
    `ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at;\n`,
);
console.error(`Prepared ${Object.keys(state.tasks).length} task mapping(s).`);
