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

// ─── Notion → Normalized ─────────────────────────────────────────────────────
export function fromNotion(page) {
  const props = page.properties;

  const title = props['Tasks']?.title?.[0]?.plain_text?.trim() || '';

  const taskDate = props['Task Date']?.date?.start || null;

  const priority = props['Priority']?.select?.name || 'P4';

  const status = props['Status']?.status?.name || 'TO DO';

  const type = props['Type']?.select?.name || null;

  return { title, taskDate, priority, status, type };
}

// ─── Todoist → Normalized ────────────────────────────────────────────────────
// projectNames: Map of Todoist project ID → project name
export function fromTodoist(task, projectNames = new Map()) {
  const title = task.content || '';
  const taskDate = task.due?.date || null;
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

const SNAPSHOT_FIELDS = ['title', 'taskDate', 'priority', 'status', 'type'];

export function snapshotsAreEqual(a, b) {
  return SNAPSHOT_FIELDS.every((field) => (a?.[field] ?? null) === (b?.[field] ?? null));
}
