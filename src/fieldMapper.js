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

// ─── Description & Tags ──────────────────────────────────────────────────────
// Notion `Description` (Text) ↔ Todoist `description` (plain text).
// Notion `Tags` (Multi-select) ↔ Todoist `labels`, matched by exact name.
// Notion option names can't contain commas, so such labels stay Todoist-only.

const NOTION_TEXT_CHUNK = 2000; // Notion's limit per rich-text segment

export function isSyncableTag(name) {
  return typeof name === 'string' && name.length > 0 && !name.includes(',');
}

export function normalizeTags(names) {
  return [...new Set((names || []).filter(isSyncableTag))].sort();
}

function joinRichText(segments) {
  return (segments || []).map((segment) => segment.plain_text || '').join('');
}

function toRichText(text) {
  const chunks = [];
  for (let i = 0; i < text.length; i += NOTION_TEXT_CHUNK) {
    chunks.push({ text: { content: text.slice(i, i + NOTION_TEXT_CHUNK) } });
  }
  return chunks;
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

  const description = joinRichText(props['Description']?.rich_text).trim();

  const tags = normalizeTags((props['Tags']?.multi_select || []).map((option) => option.name));

  return { title, taskDate, priority, status, type, description, tags };
}

// The Todoist task ID the sync stored on a Notion page, if any
export function todoistIdFromPage(page) {
  const segments = page.properties?.['Todoist ID']?.rich_text || [];
  const id = segments.map((segment) => segment.plain_text || '').join('').trim();
  return id || null;
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
  const description = (task.description || '').trim();
  const tags = normalizeTags(task.labels);

  return { title, taskDate, priority, isCompleted, status, type, description, tags };
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
    Description: {
      rich_text: toRichText(normalized.description || ''),
    },
    Tags: {
      multi_select: (normalized.tags || []).map((name) => ({ name })),
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
  if (normalized.description) payload.description = normalized.description;
  if (normalized.tags?.length) payload.labels = normalized.tags;

  return payload;
}

// Update payload with only the fields that changed. Unchanged fields are left out
// so Todoist keeps them as they are (e.g. a recurring due date isn't re-sent).
// Todoist v1 has no documented null for due dates; "no date" clears it (as in v2).
// `labels` replaces the whole list, so labels the sync can't represent (commas)
// are carried over from `currentLabels` (the task's raw labels).
export function toTodoistUpdatePayload(merged, current, currentLabels = []) {
  const payload = {};
  if (merged.title !== current.title) payload.content = merged.title;
  if (merged.priority !== current.priority) {
    payload.priority = PRIORITY_NOTION_TO_TODOIST[merged.priority] || 1;
  }
  if ((merged.taskDate ?? null) !== (current.taskDate ?? null)) {
    if (merged.taskDate) payload.due_date = merged.taskDate;
    else payload.due_string = 'no date';
  }
  if ((merged.description || '') !== (current.description || '')) {
    payload.description = merged.description || '';
  }
  if (!fieldEqual(merged.tags, current.tags)) {
    const kept = (currentLabels || []).filter((name) => !isSyncableTag(name));
    payload.labels = [...(merged.tags || []), ...kept];
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
    description: normalized.description ?? '',
    tags: normalizeTags(normalized.tags),
  };
}

// What Todoist can represent of a snapshot: DOING is Notion-only and reads as
// TO DO in Todoist. Compare Todoist's side against this, otherwise a DOING task
// looks changed on every run.
export function asTodoistSees(snapshot) {
  return snapshot?.status === 'DOING' ? { ...snapshot, status: 'TO DO' } : snapshot;
}

const SNAPSHOT_FIELDS = ['title', 'taskDate', 'priority', 'status', 'type', 'description', 'tags'];

function fieldEqual(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) {
    return JSON.stringify(normalizeTags(a)) === JSON.stringify(normalizeTags(b));
  }
  return (a ?? null) === (b ?? null);
}

export function snapshotsAreEqual(a, b) {
  return SNAPSHOT_FIELDS.every((field) => fieldEqual(a?.[field], b?.[field]));
}

// Per-tag merge: start from the last known tags and apply each side's additions
// and removals. Adding a tag on one side and removing another on the other keeps
// both changes; the two sides can never disagree about the same tag.
function mergeTags(old, notion, todoist) {
  const base = new Set(normalizeTags(old));
  const result = new Set(base);
  for (const side of [normalizeTags(notion), normalizeTags(todoist)]) {
    const current = new Set(side);
    for (const tag of current) if (!base.has(tag)) result.add(tag);
    for (const tag of base) if (!current.has(tag)) result.delete(tag);
  }
  return [...result].sort();
}

// ─── Field-level merge ───────────────────────────────────────────────────────
// Merges both sides against the last known snapshot, one field at a time:
// - a field changed on one side only → that side's value
// - a field changed on both sides to different values → the later edit wins
//   (Notion last_edited_time vs Todoist updated_at; a tie or missing time → Todoist)
// Todoist's side is compared through asTodoistSees, since it can't show DOING.
// Tags are merged per tag instead (see mergeTags).
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
    if (field === 'tags') {
      merged.tags = mergeTags(old?.tags, notion.tags, todoist.tags);
      continue;
    }
    const notionValue = notion[field] ?? null;
    const todoistValue = todoist[field] ?? null;
    const notionChanged = !fieldEqual(old?.[field], notionValue);
    const todoistChanged = !fieldEqual(oldForTodoist?.[field], todoistValue);
    const sameResult = fieldEqual(notionForTodoist[field], todoistValue);

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
