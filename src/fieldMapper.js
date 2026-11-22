// ─── Priority Mapping ───────────────────────────────────────────────────────
// Notion: "P1", "P2", "P3", "P4"  (select property)
// Todoist: 4=urgent(P1), 3=high(P2), 2=medium(P3), 1=normal(P4)

const PRIORITY_NOTION_TO_TODOIST = {
  P1: 4,
  P2: 3,
  P3: 2,
  P4: 1,
};

const PRIORITY_TODOIST_TO_NOTION = {
  4: 'P1',
  3: 'P2',
  2: 'P3',
  1: 'P4',
};

// ─── Type Mapping ────────────────────────────────────────────────────────────
// Notion: "Type" select → Todoist project with exactly the same name.
// Tasks in any other Todoist project sync with an empty Type.
// A Notion page with an empty Type goes to the Todoist Inbox.

export const TYPE_VALUES = ['Personal', 'Professional'];

export function typeFromProjectName(projectName) {
  return TYPE_VALUES.includes(projectName) ? projectName : null;
}

// ─── Status Mapping ──────────────────────────────────────────────────────────
// Notion: "TO DO", "DOING", "Done"
// Todoist: checked = true/false
// Rule: DOING is Notion-only. Todoist complete=true → Done. complete=false → TO DO only if not DOING.

export function todoistStatusToNotion(isCompleted, currentNotionStatus) {
  if (isCompleted) return 'Done';
  if (currentNotionStatus === 'DOING') return 'DOING';
  return 'TO DO';
}

export function notionStatusToTodoist(notionStatus) {
  return notionStatus === 'Done';
}

// API v1 marks completion with `checked`; `completed_at` is set for completed tasks.
export function isTodoistTaskCompleted(task) {
  return task.checked === true || task.is_completed === true || Boolean(task.completed_at);
}

// Dates sync as calendar days (YYYY-MM-DD). Times can't round-trip between the
// two APIs' formats, so comparing full datetimes would report a change every run.
export function toDateOnly(value) {
  return value ? String(value).slice(0, 10) : null;
}

// ─── Notion → Normalized ─────────────────────────────────────────────────────
export function fromNotion(page) {
  const props = page.properties;

  // A title is split into segments at formatting, links and mentions; join them all
  const title = (props['Tasks']?.title || [])
    .map((segment) => segment.plain_text || '')
    .join('')
    .trim();

  const taskDate = toDateOnly(props['Task Date']?.date?.start);

  const priority = props['Priority']?.select?.name || 'P4';

  const status = props['Status']?.status?.name || 'TO DO';

  const type = props['Type']?.select?.name || null;

  return { title, taskDate, priority, status, type };
}

// ─── Todoist → Normalized ────────────────────────────────────────────────────
// projectNames: Map of Todoist project ID → project name
export function fromTodoist(task, projectNames = new Map()) {
  const title = task.content || '';
  const taskDate = toDateOnly(task.due?.date);
  const priority = PRIORITY_TODOIST_TO_NOTION[task.priority] || 'P4';
  const isCompleted = isTodoistTaskCompleted(task);
  // Normalize to a status string so snapshots are always comparable
  const status = isCompleted ? 'Done' : 'TO DO';
  const type = typeFromProjectName(projectNames.get(String(task.project_id)));

  return { title, taskDate, priority, isCompleted, status, type };
}

// ─── Normalized → Notion properties payload ──────────────────────────────────
export function toNotionProperties(normalized, currentNotionStatus = 'TO DO') {
  const status =
    normalized.isCompleted !== undefined
      ? todoistStatusToNotion(normalized.isCompleted, currentNotionStatus)
      : normalized.status;

  const properties = {
    Tasks: {
      title: [{ text: { content: normalized.title } }],
    },
    Priority: {
      select: { name: normalized.priority },
    },
    Status: {
      status: { name: status },
    },
    Type: {
      select: normalized.type ? { name: normalized.type } : null,
    },
  };

  if (normalized.taskDate) {
    properties['Task Date'] = { date: { start: normalized.taskDate } };
  } else {
    properties['Task Date'] = { date: null };
  }

  return properties;
}

// ─── Normalized → Todoist task payload ───────────────────────────────────────
export function toTodoistPayload(normalized) {
  const payload = {
    content: normalized.title,
    priority: PRIORITY_NOTION_TO_TODOIST[normalized.priority] || 1,
  };

  if (normalized.taskDate) {
    payload.due_date = normalized.taskDate;
  }

  return payload;
}

// Update payload with only the fields that changed. Unchanged fields are left out
// so Todoist keeps them as they are (e.g. a recurring due date isn't re-sent).
// Todoist v1 has no documented null for due dates; "no date" clears it (as in v2).
export function toTodoistUpdatePayload(merged, current) {
  const payload = {};
  if (merged.title !== current.title) payload.content = merged.title;
  if (merged.priority !== current.priority) {
    payload.priority = PRIORITY_NOTION_TO_TODOIST[merged.priority] || 1;
  }
  if ((merged.taskDate ?? null) !== (current.taskDate ?? null)) {
    if (merged.taskDate) payload.due_date = merged.taskDate;
    else payload.due_string = 'no date';
  }
  return payload;
}

// ─── Snapshot for state comparison ───────────────────────────────────────────
// Always uses status string (never isCompleted boolean) so both sides compare equally
export function toSnapshot(normalized) {
  return {
    title: normalized.title,
    taskDate: normalized.taskDate,
    priority: normalized.priority,
    status: normalized.status || (normalized.isCompleted ? 'Done' : 'TO DO'),
    type: normalized.type ?? null,
  };
}

// What Todoist can represent of a snapshot: DOING is Notion-only and reads as
// TO DO in Todoist. Compare Todoist's side against this, otherwise a DOING task
// looks changed on every run.
export function asTodoistSees(snapshot) {
  return snapshot?.status === 'DOING' ? { ...snapshot, status: 'TO DO' } : snapshot;
}

const SNAPSHOT_FIELDS = ['title', 'taskDate', 'priority', 'status', 'type'];

export function snapshotsAreEqual(a, b) {
  return SNAPSHOT_FIELDS.every((field) => (a?.[field] ?? null) === (b?.[field] ?? null));
}

// ─── Field-level merge ───────────────────────────────────────────────────────
// Merges both sides against the last known snapshot, one field at a time:
// - a field changed on one side only → that side's value
// - a field changed on both sides to different values → the later edit wins
//   (Notion last_edited_time vs Todoist updated_at; a tie or missing time → Todoist)
// Todoist's side is compared through asTodoistSees, since it can't show DOING.
export function mergeSnapshots({ old, notion, todoist, notionEditedAt, todoistEditedAt }) {
  const oldForTodoist = asTodoistSees(old);
  const notionForTodoist = asTodoistSees(notion);
  const todoistIsLater =
    !notionEditedAt ||
    !todoistEditedAt ||
    new Date(todoistEditedAt).getTime() >= new Date(notionEditedAt).getTime();

  const merged = {};
  const conflicts = [];

  for (const field of SNAPSHOT_FIELDS) {
    const notionValue = notion[field] ?? null;
    const todoistValue = todoist[field] ?? null;
    const notionChanged = (old?.[field] ?? null) !== notionValue;
    const todoistChanged = (oldForTodoist?.[field] ?? null) !== todoistValue;
    const sameResult = (notionForTodoist[field] ?? null) === todoistValue;

    let takeTodoist;
    if (notionChanged && todoistChanged && !sameResult) {
      conflicts.push(field);
      takeTodoist = todoistIsLater;
    } else {
      takeTodoist = todoistChanged && !notionChanged;
    }

    merged[field] = takeTodoist ? todoistValue : notionValue;
  }

  // Todoist "TO DO" means "not completed"; keep Notion's DOING in that case.
  if (merged.status === 'TO DO' && notion.status === 'DOING') {
    merged.status = 'DOING';
  }

  return { merged, conflicts };
}
