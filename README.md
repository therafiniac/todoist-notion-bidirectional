# Notion ↔ Todoist Bi-Directional Sync

A robust, state-managed synchronization engine for keeping tasks in sync between Notion databases and Todoist projects. Runs silently in the background on Windows, polling every 30 seconds.

## Core Features

- **Bi-Directional Sync:** Changes in Notion flow to Todoist, and changes in Todoist flow back to Notion.
- **State Tracking:** Uses a local `sync-state.json` to monitor changes on both platforms, preventing infinite loops and unnecessary API calls.
- **Smart Field Mapping:**
  - **Status:** Maps Notion's native `status` property (`TO DO`, `DOING`, `Done`) to Todoist's completion state. `DOING` is Notion-only and is preserved.
  - **Priority:** Maps Notion select labels (`P1`–`P4`) to Todoist priority levels (`4`–`1`).
  - **Dates:** Syncs task due dates accurately between both platforms.
- **Conflict Resolution:** In the event of simultaneous changes on both sides, Todoist is treated as the source of truth.
- **Deletion Handling:**
  - Deleting a Notion page → deletes the corresponding Todoist task.
  - Deleting a Todoist task → archives the corresponding Notion page.
  - Completing a Todoist task → marks the Notion page as `Done`.

## Project Structure

```
notion-todoist-sync/
├─ logs/                  # Runtime log output (gitignored)
├─ src/
│  ├─ index.js            # Entry point, polling scheduler
│  ├─ syncEngine.js       # Orchestrates the 5-step sync cycle
│  ├─ notionClient.js     # Notion API wrapper
│  ├─ todoistClient.js    # Todoist API wrapper
│  ├─ stateManager.js     # Persists sync state to disk
│  └─ fieldMapper.js      # Normalizes data between both APIs
├─ .env                   # API credentials (gitignored)
├─ sync-state.json        # ID mapping state (gitignored)
├─ start.bat              # Launches the engine, redirects output to logs/
├─ start-silent.vbs       # Wraps start.bat to run with no visible window
├─ view-log.bat           # Opens a live log viewer in terminal
├─ package.json
└─ README.md
```

## Technical Architecture

The sync cycle runs every `POLL_INTERVAL_SECONDS` seconds and follows five steps:

1. **Fetch** — Pull all active tasks from both Notion and Todoist APIs simultaneously.
2. **Todoist → Notion CREATE** — For any Todoist task not yet in state, create a new Notion page.
3. **Notion → Todoist CREATE** — For any Notion page not yet in state, create a new Todoist task.
4. **UPDATE** — Compare current snapshots against last known state. Push changes to whichever side changed. If both changed, Todoist wins.
5. **DELETIONS & COMPLETIONS** — Handle task deletions and completions on either side.

State is saved to `sync-state.json` immediately after every create operation to prevent duplicate creation loops.

## Notion Database Schema

Your Notion database must have these exact properties:

| Property | Type | Values |
|---|---|---|
| `Tasks` | Title | Task name |
| `Task Date` | Date | Due date |
| `Priority` | Select | `P1`, `P2`, `P3`, `P4` |
| `Status` | Status (native) | `TO DO`, `DOING`, `Done` |

## Setup

### 1. Prerequisites
- [Notion Integration Token](https://www.notion.so/my-integrations) with access to your database.
- [Todoist API Token](https://developer.todoist.com/app-console.html).
- Node.js installed.

### 2. Environment Variables
Create a `.env` file in the root directory:

```env
NOTION_TOKEN=secret_xxx
NOTION_DATABASE_ID=xxx
TODOIST_API_TOKEN=xxx
POLL_INTERVAL_SECONDS=30
```

### 3. Installation
```bash
npm install
```

### 4. Running Manually
```bash
npm start
```

## Windows Background Deployment

The engine is designed to run silently on Windows startup with no visible window.

### Files involved
- **`start.bat`** — launches Node and pipes all output to `logs/app.log`. Clears the log on each restart.
- **`start-silent.vbs`** — runs `start.bat` invisibly using `WScript.Shell` with window style `0`.
- **`view-log.bat`** — opens a live log tail in a terminal using PowerShell's `Get-Content -Wait`.

### Task Scheduler Setup
1. Open **Task Scheduler** → **Create Task**
2. **General tab:**
   - Name: `Notion Todoist Sync`
   - Select **"Run only when user is logged on"**
   - Check **"Run with highest privileges"**
3. **Triggers tab:** New → At log on → Delay: `30 seconds`
4. **Actions tab:** New → Start a program
   - Program: `wscript.exe`
   - Arguments: `"C:\Users\Rafi\notion-todoist-sync\start-silent.vbs"`
5. **Conditions tab:** Uncheck **"Start only if on AC power"**
6. **Settings tab:** Uncheck **"Stop the task if it runs longer than"**

### Viewing Logs
Double-click `view-log.bat` from anywhere (desktop shortcut recommended) to open a live log viewer. Press `Ctrl+C` to close.

Log location: `logs/app.log`

### Verifying it's running
Open Task Manager → **Details** tab → look for `node.exe`.

## Key Implementation Notes

- Todoist API endpoint: `/api/v1` (migrated from `/rest/v2`)
- Notion `Status` is a native `status` type, not a `select` — requires different API handling
- `DOING` status only exists in Notion; Todoist tasks are always either active or completed
- Completed Todoist tasks are not available via the free plan API — completion is detected by absence from the active task list combined with the `is_completed` flag
