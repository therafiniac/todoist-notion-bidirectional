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

// ─── Status Mapping ──────────────────────────────────────────────────────────
// Notion: "TO DO", "DOING", "Done"
// Todoist: is_completed = true/false
// Rule: DOING is Notion-only. Todoist complete=true → Done. complete=false → TO DO only if not DOING.

function todoistStatusToNotion(isCompleted, currentNotionStatus) {
  if (isCompleted) return 'Done';
  if (currentNotionStatus === 'DOING') return 'DOING';
  return 'TO DO';
}

function notionStatusToTodoist(notionStatus) {
  return notionStatus === 'Done';
}

// ─── Notion → Normalized ─────────────────────────────────────────────────────
function fromNotion(page) {
  const props = page.properties;

  const title = props['Tasks']?.title?.[0]?.plain_text?.trim() || '';

  const taskDate = props['Task Date']?.date?.start || null;

  const priority = props['Priority']?.select?.name || 'P4';

  const status = props['Status']?.status?.name || 'TO DO';

  return { title, taskDate, priority, status };
}

// ─── Todoist → Normalized ────────────────────────────────────────────────────
function fromTodoist(task) {
  const title = task.content || '';
  const taskDate = task.due?.date || null;
  const priority = PRIORITY_TODOIST_TO_NOTION[task.priority] || 'P4';
  const isCompleted = task.is_completed || false;
  // Normalize to a status string so snapshots are always comparable
  const status = isCompleted ? 'Done' : 'TO DO';

  return { title, taskDate, priority, isCompleted, status };
}

// ─── Normalized → Notion properties payload ──────────────────────────────────
function toNotionProperties(normalized, currentNotionStatus = 'TO DO') {
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
  };

  if (normalized.taskDate) {
    properties['Task Date'] = { date: { start: normalized.taskDate } };
  } else {
    properties['Task Date'] = { date: null };
  }

  return properties;
}

// ─── Normalized → Todoist task payload ───────────────────────────────────────
function toTodoistPayload(normalized) {
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
function toSnapshot(normalized) {
  return {
    title: normalized.title,
    taskDate: normalized.taskDate,
    priority: normalized.priority,
    status: normalized.status || (normalized.isCompleted ? 'Done' : 'TO DO'),
  };
}

function snapshotsAreEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

module.exports = {
  fromNotion,
  fromTodoist,
  toNotionProperties,
  toTodoistPayload,
  toSnapshot,
  snapshotsAreEqual,
  notionStatusToTodoist,
};
