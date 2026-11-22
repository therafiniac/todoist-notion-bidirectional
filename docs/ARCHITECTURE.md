# Architecture

## Overview

```
                 Cloudflare Workers (free plan)
 ┌──────────────────────────────────────────────────────────┐
 │  Cron Trigger "* * * * *"                                │
 │        │                                                 │
 │        ▼                                                 │
 │  index.js scheduled()                                    │
 │    ├─ acquire D1 lock ──────────────┐                    │
 │    ├─ load state ─────────────────┐ │                    │
 │    ├─ syncEngine.runSync()        │ │                    │
 │    │    ├─ notionClient ──────────┼─┼──► Notion API      │
 │    │    └─ todoistClient ─────────┼─┼──► Todoist API v1  │
 │    └─ release lock                ▼ ▼                    │
 │                              D1: sync_state, sync_lock   │
 └──────────────────────────────────────────────────────────┘
```

- **Trigger:** Cron Trigger every minute (minimum interval).
- **State:** Cloudflare D1, a single JSON row. D1 is strongly consistent, so a run always sees the previous run's writes. KV was rejected because its up-to-60s propagation delay could let a run read stale state and create duplicates.
- **APIs:** plain `fetch`, no SDKs. Notion uses `Notion-Version: 2022-06-28`; Todoist uses `/api/v1`.
- **Secrets:** `NOTION_TOKEN`, `NOTION_DATABASE_ID`, `TODOIST_API_TOKEN` (Worker secrets).

## Components

| File | Responsibility |
|---|---|
| `src/index.js` | Worker entry. `scheduled()` validates secrets, takes the lock, runs the sync. `fetch()` serves `GET /health` only. |
| `src/syncEngine.js` | The sync cycle: fetch, create, update, delete/complete. |
| `src/fieldMapper.js` | Converts Notion pages and Todoist tasks to a common shape and back. All mapping values live here. |
| `src/notionClient.js` | Notion REST calls: query database, create/update/archive page. |
| `src/todoistClient.js` | Todoist calls: tasks (paginated), completed tasks, projects, create/update/move/close/reopen/delete. |
| `src/stateManager.js` | D1 state row read/write and the run lock. |
| `src/budget.js` | Counts outbound requests against the free-plan limit. |
| `src/http.js` | Shared request helper: JSON parsing and error messages. |

## Sync Cycle

1. **Fetch** (4 requests minimum): Notion database pages, Todoist active tasks, Todoist tasks completed in the last 30 days, Todoist projects.
2. **Relink:** a Notion page not in state whose `Todoist ID` matches an unlinked Todoist task (active or completed) is linked instead of duplicated. This covers a fresh deploy without imported state, or lost state. Where the two differ, the Notion value is kept and pushed to Todoist.
3. **Todoist → Notion create:** each Todoist task not in state becomes a Notion page (with `Todoist ID` set).
4. **Notion → Todoist create:** each Notion page not in state becomes a Todoist task in the project for its Type. A page that already has a `Todoist ID` but could not be relinked (its task was deleted, completed more than 30 days ago, or is linked to another page) is not recreated. A page that is already `Done` is not sent to Todoist; it is created if it is reopened later.
5. **Update:** for each linked pair, merge both sides field by field against the last known snapshot, then push to each side only what differs.
6. **Deletions & completions:** handle tasks missing on either side.
7. **Save state** and record `lastSyncedAt`.

State is written once at the end of a run (also if a step throws), plus right after each create so a failure cannot cause a duplicate. At most 25 creates run per run; the rest continue in the next run. Updates and deletions are safe to repeat: if a run dies before saving, the next run's merge finds both sides already equal.

## Field Mapping

Normalized task shape (used for comparison):

```js
{ title, taskDate, priority, status, type, description, tags }
```

### Title

| Notion | Todoist |
|---|---|
| `Tasks` (Title) | `content` |

### Date

| Notion | Todoist |
|---|---|
| `Task Date` → `date.start` | `due.date` (read) / `due_date` (write) |
| empty | no due date (cleared with `due_string: "no date"`) |

Dates sync as calendar days (`YYYY-MM-DD`): a time on either side is ignored when comparing, and kept unless the date itself changes. When the date changes, the other side receives the day without a time. Todoist tasks with a fixed timezone report their date in UTC, so their day can differ by one near midnight.

Updates send Todoist only the fields that changed, so editing a title never re-sends the due date and a recurring due date is kept.

### Priority

| Notion `Priority` (Select) | Todoist `priority` | Todoist app label |
|---|---|---|
| `P1` | `4` | p1 (urgent) |
| `P2` | `3` | p2 |
| `P3` | `2` | p3 |
| `P4` | `1` | p4 (normal) |
| empty | `1` | p4 |

### Status

| Notion `Status` (Status) | Todoist |
|---|---|
| `TO DO` | active (`checked: false`) |
| `DOING` | active (`checked: false`); Notion-only, kept when Todoist is active |
| `Done` | completed (`checked: true`) |

- Todoist completed → Notion `Done`.
- Todoist reopened → Notion `TO DO`.
- Todoist active task changed → Notion keeps `DOING` if it was `DOING`.
- Notion `Done` → Todoist task closed; Notion leaves `Done` → Todoist task reopened.
- Todoist can't represent `DOING`, so the Todoist side is compared with `DOING` read as `TO DO`. Changing only `TO DO` ↔ `DOING` in Notion makes no Todoist call.

### Type ↔ Project

| Notion `Type` (Select) | Todoist project |
|---|---|
| `Personal` | project named `Personal` |
| `Professional` | project named `Professional` |
| empty | Inbox (when created from Notion) |
| empty | any other project (when the task is in one) |

- Matching is by exact, case-sensitive project name.
- Changing Type in Notion moves the Todoist task (`POST /tasks/{id}/move`). Clearing it moves the task to the Inbox.
- Moving a task between Todoist projects updates Type (empty for projects other than the two above).
- If the `Personal` or `Professional` project doesn't exist, tasks needing it are skipped and a warning is logged.

### Description

| Notion | Todoist |
|---|---|
| `Description` (Text) | `description` |
| empty | empty |

- Plain text only; formatting isn't carried over. Long text is split into Notion's 2,000-character segments.

### Tags ↔ Labels

| Notion | Todoist |
|---|---|
| `Tags` (Multi-select) option | label with the same name |
| no options | no labels |

- Matched by exact name. A tag or label that exists on only one side is created on the other when assigned.
- Notion option names can't contain commas, so a Todoist label with a comma stays Todoist-only and is kept when the sync updates that task's labels.
- Merged per tag (see Sync Rules).

### Link

| Notion | Todoist |
|---|---|
| `Todoist ID` (Text) | task `id` |

## Sync Rules

### Updates (linked pairs): field-level merge

Each field (`title`, `taskDate`, `priority`, `status`, `type`, `description`) is merged on its own against the last known snapshot:

| Field changed in Notion | Field changed in Todoist | Result |
|---|---|---|
| no | no | unchanged |
| yes | no | Notion value |
| no | yes | Todoist value |
| yes, same value | yes, same value | that value (no conflict) |
| yes | yes, different value | **conflict: later edit wins** |

- Edit times: Notion page `last_edited_time` vs Todoist task `updated_at`. A tie or a missing time falls back to Todoist.
- Notion rounds `last_edited_time` down to the minute, so a Notion edit and a Todoist edit in the same minute can resolve in Todoist's favour.
- Example: title changed in Notion and priority changed in Todoist → both kept, and each side receives only the other's change.
- **Tags merge per tag:** each side's additions and removals since the last run are applied, so adding `urgent` in Notion while removing `home` in Todoist keeps both changes. Tags never conflict.
- After merging, Todoist calls are made only as needed: update (title/date/priority), move (Type), close/reopen (status).

### Deletions & completions

Deleting on either side removes the task on the other side. Todoist has no task archive, so a Notion deletion deletes the Todoist task; a Todoist deletion archives the Notion page.

| Notion page | Todoist task | Action |
|---|---|---|
| exists | completed | set Notion `Done` |
| deleted/archived | active or completed | delete Todoist task |
| exists (not `Done`) | absent from active and completed lists | archive Notion page |
| exists (`Done`) | absent, and its completion was seen less than 29 days ago | archive Notion page |
| exists (`Done`) | absent, completion older or never seen | leave as is (it may have aged out of the 30-day completed list) |
| deleted/archived | absent | remove from state |

- If the completed-tasks request fails, the run does not infer Todoist deletions, so a completion is never mistaken for a deletion.
- `todoistCompletedAt` is stored per task whenever the task appears in the completed list, and cleared when it is reopened.

## State

D1 table `sync_state`, row `id = 1`, column `data`:

```json
{
  "lastSyncedAt": "2026-11-22T10:00:00.000Z",
  "tasks": {
    "<todoistTaskId>": {
      "notionPageId": "<notionPageId>",
      "lastKnownState": {
        "title": "Pay rent",
        "taskDate": "2026-11-30",
        "priority": "P2",
        "status": "TO DO",
        "type": "Personal",
        "description": "Bring the signed lease",
        "tags": ["home", "urgent"]
      },
      "todoistCompletedAt": "2026-11-20T08:00:00Z"
    }
  }
}
```

State from before Type sync has no `type`. On the first run the Notion value is kept and the Todoist task is moved to match.

State from before Description/Tags sync has no `description` or `tags`. Those Notion properties start empty, so the baseline is Notion's value: existing Todoist descriptions and labels are copied into Notion rather than cleared. The relink step uses the same rule for these two fields.

D1 table `sync_lock` (row `id = 1`, `locked_until` epoch ms) ensures only one run at a time. A run that crashes frees the lock after 5 minutes.

## Free-Plan Limits

| Limit | Free | How it's handled |
|---|---|---|
| Subrequests per run | 50 | `budget.js` caps at 45 |
| CPU time per run | 10 ms | Network waits don't count; the run is mostly I/O |
| Requests per day | 100,000 | 1,440 cron runs/day |
| D1 queries per run | 50 | ≤ ~30: lock, load, ≤ 25 creates, save, unlock |
| D1 rows written per day | 100,000 | ~3 per run (lock, save, unlock) + 1 per create ≈ 4,500/day |
| D1 rows read per day | 5 million | a few per run (a few thousand / day) |
| D1 storage | 500 MB per database | a few KB |

A request rate-limited with `429` is retried once after its `Retry-After` delay (capped at 5 s), only if the budget still allows it. If it fails again, that operation waits for the next run.

Worst-case requests per operation (an operation starts only if the budget covers it; otherwise it waits for the next run):

| Operation | Requests |
|---|---|
| Create in Notion | 1 |
| Create in Todoist | 2 (create, write Todoist ID) |
| Update Notion | 1 |
| Update Todoist | 3 (update, move project, close/reopen) |
| Update both (merge) | 4 |
| Delete/archive | 1 |

## Future: Webhooks

The cron design can later get webhook-triggered runs for near-instant sync. Todoist webhooks and Notion API webhook subscriptions are both free. The plan:
- Add a `fetch()` route that verifies signatures (`X-Todoist-Hmac-SHA256`, `X-Notion-Signature`) and runs `runSync()`.
- Keep a slower cron (e.g. every 30 minutes) as a fallback for missed events.
- The existing D1 lock already stops overlapping runs.
