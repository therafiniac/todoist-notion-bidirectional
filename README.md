# Notion ↔ Todoist Bi-Directional Sync

A state-managed synchronization engine that keeps tasks in sync between a Notion database and Todoist. Runs on **Cloudflare Workers (free plan)** as a Cron Trigger once a minute, with sync state stored in **Cloudflare D1**.

## Core Features

- **Bi-Directional Sync:** Changes in Notion flow to Todoist, and changes in Todoist flow back to Notion.
- **State Tracking:** A single JSON state row in D1 tracks the ID mapping and last known snapshot of every task, preventing infinite loops and unnecessary API calls.
- **Smart Field Mapping:**
  - **Status:** Maps Notion's native `status` property (`TO DO`, `DOING`, `Done`) to Todoist's completion state. `DOING` is Notion-only and is preserved.
  - **Priority:** Maps Notion select labels (`P1`–`P4`) to Todoist priority levels (`4`–`1`).
  - **Dates:** Syncs task due dates between both platforms.
- **Conflict Resolution:** When both sides change between runs, Todoist is the source of truth.
- **Deletion Handling:**
  - Deleting a Notion page → deletes the corresponding Todoist task.
  - Deleting a Todoist task → archives the corresponding Notion page.
  - Completing a Todoist task → marks the Notion page as `Done`.
- **Free-plan safe:** Every API call is counted against the Workers Free limit of 50 subrequests per run; work that does not fit is deferred to the next run.
- **No overlapping runs:** A D1 lock row ensures only one sync runs at a time.

## Project Structure

```
notion-todoist-sync/
├─ src/
│  ├─ index.js            # Worker entry: scheduled() sync + GET /health
│  ├─ syncEngine.js       # Orchestrates the 5-step sync cycle
│  ├─ notionClient.js     # Notion REST API (fetch, Notion-Version 2022-06-28)
│  ├─ todoistClient.js    # Todoist API v1 (fetch)
│  ├─ stateManager.js     # D1 state row + run lock
│  ├─ fieldMapper.js      # Normalizes data between both APIs
│  ├─ budget.js           # Subrequest counter (free plan limit)
│  └─ http.js             # Shared fetch/JSON/error helper
├─ migrations/            # D1 schema
├─ scripts/
│  └─ import-state.js     # One-time import of an old sync-state.json
├─ test/                  # node:test unit tests with fake clients
├─ wrangler.toml          # Worker, cron and D1 configuration
└─ package.json
```

## Technical Architecture

Each run (every minute) follows five steps:

1. **Fetch** — Pull all tasks from both Notion and Todoist.
2. **Todoist → Notion CREATE** — For any Todoist task not yet in state, create a new Notion page.
3. **Notion → Todoist CREATE** — For any Notion page not yet in state, create a new Todoist task.
4. **UPDATE** — Compare current snapshots against last known state. Push changes to whichever side changed. If both changed, Todoist wins.
5. **DELETIONS & COMPLETIONS** — Handle task deletions and completions on either side.

State is saved to D1 immediately after every create, so a failure mid-run cannot cause duplicate creation.

## Notion Database Schema

Your Notion database must have these exact properties:

| Property | Type | Values |
|---|---|---|
| `Tasks` | Title | Task name |
| `Task Date` | Date | Due date |
| `Priority` | Select | `P1`, `P2`, `P3`, `P4` |
| `Status` | Status (native) | `TO DO`, `DOING`, `Done` |
| `Todoist ID` | Text | Filled in by the sync |

## Setup & Deployment

### 1. Prerequisites
- [Notion Integration Token](https://www.notion.so/my-integrations) with access to your database.
- [Todoist API Token](https://developer.todoist.com/app-console.html).
- A free Cloudflare account.
- Node.js 22+.

### 2. Install
```bash
npm install
npx wrangler login
```

### 3. Create the D1 database
```bash
npx wrangler d1 create notion-todoist-sync
```
Copy the printed `database_id` into `wrangler.toml`, then create the tables:
```bash
npm run db:migrate
```

### 4. Set secrets
```bash
npx wrangler secret put NOTION_TOKEN
npx wrangler secret put NOTION_DATABASE_ID
npx wrangler secret put TODOIST_API_TOKEN
```

### 5. (Optional) Import state from the old local setup
Skip this on a fresh start. If you have a `sync-state.json` from the previous Windows setup, import it so existing tasks are not duplicated:
```bash
node scripts/import-state.js path/to/sync-state.json > /tmp/state-import.sql
npx wrangler d1 execute notion-todoist-sync --remote --file=/tmp/state-import.sql
```

### 6. Deploy
```bash
npm run deploy
```

### Logs & health
- Live logs: `npx wrangler tail`, or **Workers & Pages → notion-todoist-sync → Logs** in the dashboard.
- Health: `GET https://<worker-subdomain>/health` returns the last sync time.

## Local Development

Create `.dev.vars` (gitignored) with the three secrets:
```env
NOTION_TOKEN=secret_xxx
NOTION_DATABASE_ID=xxx
TODOIST_API_TOKEN=xxx
```
Then:
```bash
npx wrangler d1 migrations apply notion-todoist-sync --local
npm run dev
curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"   # trigger one sync
```

Note: local runs call the real Notion and Todoist APIs.

## Scripts

| Command | Purpose |
|---|---|
| `npm test` | Unit tests (`node --test`) |
| `npm run check` | Bundle the Worker without deploying |
| `npm run dev` | Local Worker with scheduled-trigger testing |
| `npm run deploy` | Deploy to Cloudflare |
| `npm run db:migrate` | Apply D1 migrations remotely |

## Free Plan Limits (relevant)

| Limit | Free | Usage |
|---|---|---|
| Worker requests | 100k/day | 1,440 cron runs/day |
| Subrequests per run | 50 | capped at 45 by `budget.js` |
| CPU time per run | 10 ms | network waits do not count |
| D1 writes | 100k/day | ~1,500/day |

## Key Implementation Notes

- Todoist API endpoint: `/api/v1`.
- Notion `Status` is a native `status` type, not a `select`.
- `DOING` status only exists in Notion; Todoist tasks are always either active or completed.
- Todoist API v1 marks completion with `checked`. Completed tasks come from `GET /tasks/completed/by_completion_date` (last 30 days); if that call fails, the run skips inferring Todoist deletions so a completion is never mistaken for a deletion.
