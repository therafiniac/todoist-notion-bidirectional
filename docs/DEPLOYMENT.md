# Deployment Guide

A step-by-step guide to running the sync on Cloudflare's free plan. Plan on about 20 minutes. Everything here is free; no paid plan is needed on Cloudflare, Notion or Todoist.

## What you need

| Item | Where |
|---|---|
| Node.js 22 or newer | `node -v` to check |
| A Cloudflare account (free) | https://dash.cloudflare.com/sign-up |
| A Notion integration token | https://www.notion.so/my-integrations |
| A Todoist API token | Todoist → Settings → Integrations → Developer |

## 1. Prepare Notion

1. **Create an integration:** go to https://www.notion.so/my-integrations → **New integration**.
   - Type: **Internal**.
   - Capabilities: **Read content**, **Update content**, **Insert content**.
   - Copy the **Internal Integration Secret**. This is `NOTION_TOKEN`.
2. **Give it access to the database:** open the task database in Notion → **•••** (top right) → **Connections** → add your integration.
3. **Get the database ID:** open the database as a full page. The URL looks like
   `https://www.notion.so/<workspace>/<32-character-id>?v=...`
   The 32-character part is `NOTION_DATABASE_ID`.
4. **Check the properties.** Names and types must match exactly:

   | Property | Type | Values |
   |---|---|---|
   | `Tasks` | Title | |
   | `Task Date` | Date | |
   | `Priority` | Select | `P1`, `P2`, `P3`, `P4` |
   | `Status` | Status | `TO DO`, `DOING`, `Done` |
   | `Type` | Select | `Personal`, `Professional` |
   | `Todoist ID` | Text | leave empty; the sync fills it |

## 2. Prepare Todoist

1. Copy your API token: **Settings → Integrations → Developer → API token**. This is `TODOIST_API_TOKEN`.
2. Make sure two projects exist, named exactly **`Personal`** and **`Professional`** (case-sensitive).

## 3. Stop the old Windows sync

If the old Windows setup is still running, stop it before deploying, so two syncs never run at the same time:

- Task Scheduler → disable or delete the **Notion Todoist Sync** task.
- Task Manager → end any `node.exe` running the sync.
- Optional: copy its `sync-state.json` to this machine (see step 7).

## 4. Install and log in to Cloudflare

```bash
git clone <this-repo> && cd todoist-notion-bidirectional
git switch dev            # or main once merged
npm install
npx wrangler login        # opens a browser to authorize Wrangler
```

## 5. Create the database

```bash
npx wrangler d1 create notion-todoist-sync
```

The output includes a `database_id`. Open `wrangler.toml` and replace `REPLACE_WITH_D1_DATABASE_ID` with it. The ID is not a secret, so you can commit it.

Create the tables:

```bash
npm run db:migrate
```

## 6. Store the secrets

Each command prompts for the value; paste it and press Enter.

```bash
npx wrangler secret put NOTION_TOKEN
npx wrangler secret put NOTION_DATABASE_ID
npx wrangler secret put TODOIST_API_TOKEN
```

Secrets are encrypted on Cloudflare and never stored in the repo.

## 7. (Optional) Import the old state

You can skip this. Without it, the first run links existing tasks through each Notion page's `Todoist ID`, so nothing is duplicated.

Importing keeps the old setup's exact last-known values:

```bash
node scripts/import-state.js path/to/sync-state.json > /tmp/state-import.sql
npx wrangler d1 execute notion-todoist-sync --remote --file=/tmp/state-import.sql
```

## 8. Deploy

```bash
npm run deploy
```

On your first deploy, Wrangler may ask you to choose a `workers.dev` subdomain. Any name works.

The output shows the Worker URL and the schedule `* * * * *`. The sync now runs every minute.

## 9. Verify

1. **Watch the logs:**
   ```bash
   npx wrangler tail
   ```
   Within a minute you should see `🔄 Starting sync cycle...` followed by `✅ Sync cycle complete`. The first run may also show `🔗 Relinked N existing pair(s)`.
2. **Health check:** open `https://notion-todoist-sync.<your-subdomain>.workers.dev/health`. `lastSyncedAt` should update every minute.
3. **Dashboard:** Cloudflare → **Workers & Pages → notion-todoist-sync → Logs** shows past runs.

### First-run checklist

These behaviours rely on Todoist API details that aren't fully documented, so check them once:

- [ ] **Completion:** complete a task in Todoist. Within a minute the Notion page should become `Done`, not archived.
- [ ] **Deletion:** delete a test task in Todoist. The Notion page should be archived.
- [ ] **Date clearing:** remove the date from a Notion page. The Todoist task should lose its due date.
- [ ] **Type:** change a page's `Type` in Notion. The Todoist task should move to that project.

If the log shows `⚠️ Could not fetch completed Todoist tasks`, the completed-tasks endpoint isn't available on your plan. Completions still sync, but deletions made in Todoist won't reach Notion.

## Updating

After pulling new changes:

```bash
npm install
npm test
npm run db:migrate     # only applies new migrations; safe to run every time
npm run deploy
```

## Rolling back or stopping

- List versions: `npx wrangler deployments list`
- Roll back to the previous version: `npx wrangler rollback`
- Pause syncing: remove the `crons` line from `wrangler.toml` and run `npm run deploy`, or delete the Worker with `npx wrangler delete`.

## Troubleshooting

| Log message | Cause | Fix |
|---|---|---|
| `Missing required secrets` | A secret isn't set | Repeat step 6 |
| `Notion POST /databases/.../query failed: 404` | Integration has no access, or wrong database ID | Repeat step 1.2 and 1.3 |
| `Notion ... failed: 401` / `Todoist ... failed: 401` | Wrong or revoked token | `npx wrangler secret put ...` with a new token |
| `Todoist project "Personal" not found` | Project missing or named differently | Create or rename it exactly |
| `Previous sync still running, skipping this run.` | A run took more than a minute | Normal if occasional; the lock frees itself after 5 minutes |
| `... deferred to next run: per-run limits` | Many changes at once (e.g. the first run) | Normal; the rest syncs over the next minutes |
| `D1_ERROR: no such table` | Migrations not applied | `npm run db:migrate` |

## Free-tier usage

| Resource | Free limit | This project |
|---|---|---|
| Worker requests | 100,000 / day | 1,440 runs / day |
| Outbound requests per run | 50 | capped at 45 |
| CPU time per run | 10 ms | waiting on APIs doesn't count |
| D1 queries per run | 50 | about 30 at most |
| D1 rows written | 100,000 / day | about 4,500 / day |
| D1 rows read | 5 million / day | a few thousand / day |
| D1 storage | 500 MB per database, 5 GB total | a few KB |

D1 daily limits reset at 00:00 UTC. If one is reached, queries fail until the reset and the sync resumes by itself afterwards.
