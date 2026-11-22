# Notion ↔ Todoist Bi-Directional Sync

Keeps a Notion task database and Todoist in sync in both directions. Runs on **Cloudflare Workers (free plan)** once a minute, with sync state stored in **Cloudflare D1**.

- **Deploy it:** [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md), a step-by-step guide.
- **How it works:** [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), with the sync rules and every field mapping value.

## Features

- **Two-way sync** of title, date, priority, status and Type.
  - **Status:** `TO DO` / `DOING` / `Done` ↔ open / completed. `DOING` is Notion-only and is preserved.
  - **Priority:** `P1`–`P4` ↔ Todoist `4`–`1`.
  - **Dates:** synced as calendar days; times are kept unless the day changes.
  - **Type ↔ Project:** `Personal` / `Professional` ↔ the Todoist project with the same name. Other projects sync with an empty Type; an empty Type goes to the Inbox.
- **Conflict resolution:** field-level merge. Edits to different fields are both kept; if the same field changed on both sides, the later edit wins (tie → Todoist).
- **Deletions both ways:** deleting a Notion page deletes the Todoist task; deleting a Todoist task archives the Notion page. Completing in Todoist marks the page `Done`.
- **No duplicates:** existing pairs are relinked through the `Todoist ID` stored on each Notion page.
- **Free-plan safe:** outbound requests, D1 queries and creates are capped per run, and work that doesn't fit continues in the next run. A D1 lock prevents overlapping runs.

## Notion database schema

| Property | Type | Values |
|---|---|---|
| `Tasks` | Title | Task name |
| `Task Date` | Date | Due date |
| `Priority` | Select | `P1`, `P2`, `P3`, `P4` |
| `Status` | Status | `TO DO`, `DOING`, `Done` |
| `Type` | Select | `Personal`, `Professional` |
| `Todoist ID` | Text | Filled in by the sync |

Todoist needs projects named exactly `Personal` and `Professional`.

## Quick start (local)

Requires Node.js 22+.

```bash
npm install
npm test                # unit tests, no network
```

To run the Worker locally against your real Notion and Todoist accounts, create `.dev.vars` (gitignored):

```env
NOTION_TOKEN=secret_xxx
NOTION_DATABASE_ID=xxx
TODOIST_API_TOKEN=xxx
```

Then:

```bash
npx wrangler d1 migrations apply notion-todoist-sync --local
npm run dev
# in another terminal, trigger one sync run:
curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"
```

Local runs change your real tasks. Don't run locally while the deployed Worker is active, since two syncs at once can duplicate tasks; the lock only covers runs that share the same database.

## Deploy (summary)

```bash
npx wrangler login
npx wrangler d1 create notion-todoist-sync     # put database_id in wrangler.toml
npm run db:migrate
npx wrangler secret put NOTION_TOKEN
npx wrangler secret put NOTION_DATABASE_ID
npx wrangler secret put TODOIST_API_TOKEN
npm run deploy
npx wrangler tail                              # watch it run
```

The full walkthrough, with Notion and Todoist setup, verification and troubleshooting, is in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Scripts

| Command | Purpose |
|---|---|
| `npm test` | Unit tests (`node --test`) |
| `npm run check` | Bundle the Worker without deploying |
| `npm run dev` | Local Worker with scheduled-trigger testing |
| `npm run deploy` | Deploy to Cloudflare |
| `npm run db:migrate` | Apply D1 migrations to the deployed database |

## Project structure

```
├─ src/
│  ├─ index.js            # Worker entry: scheduled sync + GET /health
│  ├─ syncEngine.js       # Sync cycle: relink, create, merge, delete
│  ├─ fieldMapper.js      # Field mapping, snapshots, field-level merge
│  ├─ notionClient.js     # Notion REST API (Notion-Version 2022-06-28)
│  ├─ todoistClient.js    # Todoist API v1
│  ├─ stateManager.js     # D1 state row + run lock
│  ├─ budget.js           # Outbound request cap (free plan)
│  └─ http.js             # Request helper with 429 retry
├─ migrations/            # D1 schema
├─ scripts/import-state.js  # Optional import of the old sync-state.json
├─ test/                  # Unit tests with fake clients
├─ docs/                  # ARCHITECTURE.md, DEPLOYMENT.md
└─ wrangler.toml          # Worker, cron and D1 configuration
```
