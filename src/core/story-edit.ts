import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parseWorkItem } from './backlog-reader';
import {
  backlogTimestamp,
  joinFrontMatter,
  removeKey,
  setLabels,
  setScalar,
  singleQuoted,
  splitFrontMatter,
  yamlScalar,
} from './front-matter-edit';
import { addStoryToCellText, expectPlacement, expectRemoval, removeStoryFromMapText, verifyMapEdit } from './map-edit';
import { parseStoryMap } from './story-map-reader';
import { NONE } from './story-query';
import type { StoryMap, WorkItem } from './types';
import { normalizeId } from './work-item-index';
import type { Workspace } from './workspace';

/**
 * Editing several stories at once — the one write path behind bulk edit and
 * Kanban moves.
 *
 * It runs in two phases so nothing is written that has not been checked:
 *
 *   plan    read every affected file fresh, validate the request, compute each
 *           edit as a minimal line change, re-parse the result and confirm it
 *           reads back as intended. Pure: touches nothing on disk.
 *   commit  confirm no planned file changed since the plan read it, stage every
 *           new file beside its target, then rename them into place. A failed
 *           rename restores the files already replaced.
 *
 * A request is all-or-nothing: one invalid story fails the whole plan, and the
 * report says which story and why. A filesystem cannot make several renames one
 * transaction, so when a rollback itself fails the result names the files left
 * changed instead of claiming a clean failure.
 *
 * Fields and where they live:
 *
 *   status                  front matter `status`, from backlog.config.yml's list
 *   milestone               front matter `milestone`, a declared milestone id
 *   wstatus area owner      the `<field>:<value>` label
 *   priority wtype
 *   map                     the story's placement in the map YAML files — the
 *                           work item itself is not touched
 */

export const EDIT_FIELDS = ['status', 'wstatus', 'area', 'owner', 'priority', 'wtype', 'map', 'milestone'] as const;
export type EditField = (typeof EDIT_FIELDS)[number];

const LABEL_FIELDS = ['wstatus', 'area', 'owner', 'priority', 'wtype'] as const;
type LabelField = (typeof LABEL_FIELDS)[number];

export interface MapTarget {
  map: string;
  activity: string;
  step: string;
  slice: string;
}

/**
 * A field absent from the object is left alone. `null` clears it deliberately —
 * never the same thing as "no change".
 */
export interface StoryChanges {
  status?: string;
  wstatus?: string | null;
  area?: string | null;
  owner?: string | null;
  priority?: string | null;
  wtype?: string | null;
  milestone?: string | null;
  /** Place as primary in this cell, out of every other primary cell; `null` removes the story from every map. */
  map?: MapTarget | null;
}

export interface FieldChange {
  field: EditField;
  from?: string;
  to?: string;
}

export interface ItemPlan {
  id: string;
  sourcePath?: string;
  changes: FieldChange[];
  changed: boolean;
  warnings: string[];
  error?: string;
}

export interface FileWrite {
  /** Absolute path. */
  path: string;
  sourcePath: string;
  before: string;
  after: string;
}

export interface EditPlan {
  ok: boolean;
  ids: string[];
  changes: StoryChanges;
  fieldErrors: { field: EditField | 'ids' | 'changes'; message: string }[];
  items: ItemPlan[];
  writes: FileWrite[];
  /** Fingerprint of the request and every file it read; a commit refuses a stale plan. */
  token: string;
  changedCount: number;
}

export interface EditContext {
  /** Statuses from backlog.config.yml. When empty, any single-line status is accepted. */
  statuses?: readonly string[];
  now?: Date;
}

// ------------------------------------------------------------------- request

const MAX_IDS = 5000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Checks the shape of a JSON request body; values are validated by {@link planStoryEdit}. */
export function parseEditRequest(body: unknown): { ids: string[]; changes: StoryChanges; errors: EditPlan['fieldErrors'] } {
  const errors: EditPlan['fieldErrors'] = [];
  const changes: StoryChanges = {};
  const ids: string[] = [];
  if (!isRecord(body)) return { ids, changes, errors: [{ field: 'changes', message: 'the request body must be a JSON object' }] };

  if (!Array.isArray(body.ids) || body.ids.some((id) => typeof id !== 'string')) {
    errors.push({ field: 'ids', message: '`ids` must be an array of story ids' });
  } else {
    for (const id of body.ids as string[]) if (id.trim() && !ids.some((x) => normalizeId(x) === normalizeId(id))) ids.push(id.trim());
    if (ids.length === 0) errors.push({ field: 'ids', message: 'select at least one story' });
    if (ids.length > MAX_IDS) errors.push({ field: 'ids', message: `at most ${MAX_IDS} stories per request` });
  }

  const raw = body.changes;
  if (!isRecord(raw)) {
    errors.push({ field: 'changes', message: '`changes` must be an object of field -> new value' });
    return { ids, changes, errors };
  }
  for (const key of Object.keys(raw)) {
    if (!(EDIT_FIELDS as readonly string[]).includes(key)) errors.push({ field: 'changes', message: `\`${key}\` is not an editable field` });
  }
  if ('status' in raw) {
    if (typeof raw.status === 'string') changes.status = raw.status;
    else errors.push({ field: 'status', message: 'status must be a string; it cannot be cleared' });
  }
  for (const f of [...LABEL_FIELDS, 'milestone'] as const) {
    if (!(f in raw)) continue;
    const v = raw[f];
    if (v === null || typeof v === 'string') changes[f] = v;
    else errors.push({ field: f, message: `${f} must be a string, or null to clear it` });
  }
  if ('map' in raw) {
    const v = raw.map;
    if (v === null) changes.map = null;
    else if (isRecord(v) && ['map', 'activity', 'step', 'slice'].every((k) => typeof v[k] === 'string' && (v[k] as string).trim())) {
      changes.map = { map: String(v.map), activity: String(v.activity), step: String(v.step), slice: String(v.slice) };
    } else errors.push({ field: 'map', message: 'map must be {map, activity, step, slice}, or null to remove the story from every map' });
  }
  if (errors.length === 0 && Object.keys(changes).length === 0) {
    errors.push({ field: 'changes', message: 'choose at least one field to change' });
  }
  return { ids, changes, errors };
}

// ---------------------------------------------------------------- validation

function labelValueProblem(value: string): string | undefined {
  if (!value.trim()) return 'cannot be empty — use Clear to remove it';
  if (value !== value.trim()) return 'cannot start or end with whitespace';
  if (value.length > 100) return 'is longer than 100 characters';
  if (/[\u0000-\u001f\u007f,]/.test(value)) return 'cannot contain a comma or a control character';
  if (value.toLowerCase() === NONE) return `"${NONE}" is reserved for "no value" in filters — use Clear`;
  return undefined;
}

/** An existing spelling of a label value, so `P1` does not start a second `p1` facet. */
function canonicalLabel(ws: Workspace, field: LabelField, value: string): string {
  const pick = (i: WorkItem) => (field === 'priority' ? i.priorityLabel : i[field]);
  const wanted = value.toLowerCase();
  for (const item of ws.index.items) {
    const v = pick(item);
    if (v && v.toLowerCase() === wanted) return v;
  }
  return value;
}

function validateChanges(ws: Workspace, changes: StoryChanges, ctx: EditContext): { normalized: StoryChanges; errors: EditPlan['fieldErrors'] } {
  const errors: EditPlan['fieldErrors'] = [];
  const normalized: StoryChanges = { ...changes };

  if (changes.status !== undefined) {
    const status = changes.status.trim();
    const allowed = ctx.statuses ?? [];
    if (!status) errors.push({ field: 'status', message: 'status cannot be empty' });
    else if (/[\r\n]/.test(status)) errors.push({ field: 'status', message: 'status must be a single line' });
    else if (allowed.length && !allowed.includes(status)) {
      errors.push({ field: 'status', message: `"${status}" is not a status in backlog.config.yml (${allowed.join(', ')})` });
    } else normalized.status = status;
  }

  for (const f of LABEL_FIELDS) {
    const v = changes[f];
    if (typeof v !== 'string') continue;
    const problem = labelValueProblem(v);
    if (problem) errors.push({ field: f, message: `${f} ${problem}` });
    else normalized[f] = canonicalLabel(ws, f, v);
  }

  if (typeof changes.milestone === 'string') {
    const id = changes.milestone.trim();
    if (!ws.milestones.some((m) => m.id === id)) {
      errors.push({ field: 'milestone', message: `"${id}" is not a milestone this backlog declares` });
    } else normalized.milestone = id;
  }

  if (changes.map) {
    const t = changes.map;
    const map = ws.maps.find((m) => m.id === t.map);
    const activity = map?.activities.find((a) => a.id === t.activity);
    const step = activity?.steps.find((s) => s.id === t.step);
    if (!map) errors.push({ field: 'map', message: `no story map has the id "${t.map}"` });
    else if (!step) errors.push({ field: 'map', message: `map "${t.map}" has no step "${t.activity}/${t.step}"` });
    else if (!map.releaseSlices.some((s) => s.id === t.slice)) errors.push({ field: 'map', message: `map "${t.map}" declares no release slice "${t.slice}"` });
  }
  return { normalized, errors };
}

// ----------------------------------------------------------------------- plan

const hash = (s: string) => createHash('sha256').update(s).digest('hex');

function labelValue(item: WorkItem, field: LabelField): string | undefined {
  return field === 'priority' ? item.priorityLabel : item[field];
}

function nextLabels(labels: readonly string[], ns: string, value: string | null): string[] {
  const prefix = `${ns}:`;
  const at = labels.findIndex((l) => l.startsWith(prefix));
  const rest = labels.filter((l) => !l.startsWith(prefix));
  if (value === null) return rest;
  const label = `${prefix}${value}`;
  if (at === -1) return [...rest, label];
  const out = [...rest];
  out.splice(labels.slice(0, at).filter((l) => !l.startsWith(prefix)).length, 0, label);
  return out;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Primary placements of a story in a parsed map, as `activity/step/slice` cells. */
function primaryCells(map: StoryMap, key: string): string[] {
  const out: string[] = [];
  for (const a of map.activities) {
    for (const s of a.steps) {
      for (const [slice, ids] of Object.entries(s.slices)) {
        for (const id of ids) if (normalizeId(id) === key) out.push(`${a.id}/${s.id}/${slice}`);
      }
    }
  }
  return out;
}

function referenced(map: StoryMap, key: string): boolean {
  return (
    primaryCells(map, key).length > 0 ||
    map.activities.some((a) => a.steps.some((s) => (s.supporting ?? []).some((id) => normalizeId(id) === key)))
  );
}

export function planStoryEdit(ws: Workspace, ids: readonly string[], changes: StoryChanges, ctx: EditContext = {}): EditPlan {
  const now = ctx.now ?? new Date();
  const { normalized, errors } = validateChanges(ws, changes, ctx);
  const fingerprint: string[] = [JSON.stringify({ ids, changes: normalized })];
  const items: ItemPlan[] = [];
  const writes: FileWrite[] = [];

  // Map files are shared by many stories; each is edited once, cumulatively.
  const mapFiles = new Map<string, { sourcePath: string; path: string; before: string; text: string; expected: StoryMap; touchedBy: Set<string> }>();
  const mapFile = (map: StoryMap) => {
    let entry = mapFiles.get(map.id);
    if (!entry) {
      const path = join(ws.repoRoot, map.sourcePath);
      const before = readFileSync(path, 'utf8');
      const parsed = parseStoryMap(before, map.sourcePath).map ?? map;
      entry = { sourcePath: map.sourcePath, path, before, text: before, expected: parsed, touchedBy: new Set() };
      mapFiles.set(map.id, entry);
      fingerprint.push(`${map.sourcePath}\n${before}`);
    }
    return entry;
  };
  if (normalized.map !== undefined) for (const map of ws.maps) mapFile(map);

  for (const requested of ids) {
    const indexed = ws.index.get(requested);
    const plan: ItemPlan = { id: indexed?.id ?? requested, changes: [], changed: false, warnings: [] };
    items.push(plan);
    if (!indexed) {
      plan.error = 'no work item claims this id';
      continue;
    }
    plan.sourcePath = indexed.sourcePath;
    const path = join(ws.repoRoot, indexed.sourcePath);

    let before: string;
    try {
      before = readFileSync(path, 'utf8');
    } catch (error) {
      plan.error = `could not read ${indexed.sourcePath}: ${(error as Error).message}`;
      continue;
    }
    fingerprint.push(`${indexed.sourcePath}\n${before}`);
    const current = parseWorkItem(before, indexed.sourcePath, indexed.completed).item;
    if (!current || normalizeId(current.id) !== normalizeId(indexed.id)) {
      plan.error = `${indexed.sourcePath} no longer holds ${indexed.id}; reload and try again`;
      continue;
    }

    // ---- the work item's own front matter
    const split = splitFrontMatter(before);
    if (!split) {
      plan.error = 'the file has no front matter this tool can edit';
      continue;
    }
    let labels = [...current.labels];
    let status = current.status;
    let milestone = current.milestone;

    if (normalized.status !== undefined && normalized.status !== current.status) {
      plan.changes.push({ field: 'status', from: current.status, to: normalized.status });
      status = normalized.status;
      setScalar(split, 'status', yamlScalar(status));
    }
    for (const f of LABEL_FIELDS) {
      const value = normalized[f];
      if (value === undefined) continue;
      const ns = f;
      const existing = labels.filter((l) => l.startsWith(`${ns}:`));
      const next = nextLabels(labels, ns, value);
      if (sameJson(next, labels)) continue;
      if (existing.length > 1) {
        plan.warnings.push(`replaces ${existing.length} ${ns} labels (${existing.map((l) => l.slice(ns.length + 1)).join(', ')})`);
      }
      plan.changes.push({ field: f, from: labelValue(current, f), to: value ?? undefined });
      labels = next;
    }
    if (!sameJson(labels, current.labels)) setLabels(split, current.labels, labels);
    if (normalized.milestone !== undefined && (normalized.milestone ?? undefined) !== current.milestone) {
      plan.changes.push({ field: 'milestone', from: current.milestone, to: normalized.milestone ?? undefined });
      milestone = normalized.milestone ?? undefined;
      if (milestone) setScalar(split, 'milestone', yamlScalar(milestone), ['labels', 'updated_date', 'created_date']);
      else removeKey(split, 'milestone');
    }

    if (plan.changes.length) {
      setScalar(split, 'updated_date', singleQuoted(backlogTimestamp(now)), ['created_date']);
      const after = joinFrontMatter(split);
      const problem = verifyWorkItemEdit(before, after, indexed, { status, milestone, labels });
      if (problem) {
        plan.error = problem;
        continue;
      }
      writes.push({ path, sourcePath: indexed.sourcePath, before, after });
    }

    // ---- placement, which lives in the map files
    if (normalized.map !== undefined) {
      const key = normalizeId(indexed.id);
      const target = normalized.map;
      const fromMaps = ws.maps.filter((m) => referenced(mapFile(m).expected, key)).map((m) => m.id);
      const cells = ws.maps.flatMap((m) => primaryCells(mapFile(m).expected, key).map((c) => `${m.id}/${c}`));
      const targetCell = target ? `${target.map}/${target.activity}/${target.step}/${target.slice}` : undefined;
      const alreadyThere = target ? cells.length === 1 && cells[0] === targetCell : fromMaps.length === 0;
      if (!alreadyThere) {
        plan.changes.push({ field: 'map', from: fromMaps.join(', ') || undefined, to: target ? targetCell : undefined });
        for (const map of ws.maps) {
          const entry = mapFile(map);
          const primary = primaryCells(entry.expected, key).length > 0;
          const any = referenced(entry.expected, key);
          if (target ? primary : any) {
            entry.text = removeStoryFromMapText(entry.text, indexed.id, { supporting: !target });
            entry.expected = expectRemoval(entry.expected, indexed.id, { supporting: !target });
            entry.touchedBy.add(plan.id);
          }
        }
        if (target) {
          const entry = mapFile(ws.maps.find((m) => m.id === target.map)!);
          try {
            entry.text = addStoryToCellText(entry.text, target, indexed.id);
            entry.expected = expectPlacement(entry.expected, target, indexed.id);
            entry.touchedBy.add(plan.id);
          } catch (error) {
            plan.error = (error as Error).message;
          }
        } else {
          const supportingOnly = fromMaps.filter((id) => !cells.some((c) => c.startsWith(`${id}/`)));
          if (supportingOnly.length) plan.warnings.push(`also removes supporting references (${supportingOnly.join(', ')})`);
        }
      }
    }
    plan.changed = plan.changes.length > 0;
  }

  for (const entry of mapFiles.values()) {
    // Verify every file a story meant to change, even if its text did not move:
    // an unchanged text there means the edit could not be expressed.
    if (entry.touchedBy.size === 0) continue;
    const problem = verifyMapEdit(entry.text, entry.sourcePath, entry.expected);
    if (problem) {
      for (const item of items) if (entry.touchedBy.has(item.id) && !item.error) item.error = `${entry.sourcePath}: ${problem}`;
      continue;
    }
    writes.push({ path: entry.path, sourcePath: entry.sourcePath, before: entry.before, after: entry.text });
  }

  const ok = errors.length === 0 && items.every((i) => !i.error);
  return {
    ok,
    ids: [...ids],
    changes: normalized,
    fieldErrors: errors,
    items,
    writes: ok ? writes : [],
    token: hash(fingerprint.join(' ')),
    changedCount: items.filter((i) => i.changed).length,
  };
}

/** Confirms an edited work item reads back with exactly the intended differences. */
function verifyWorkItemEdit(
  before: string,
  after: string,
  original: WorkItem,
  expected: { status: string; milestone?: string; labels: string[] },
): string | undefined {
  const a = parseWorkItem(before, original.sourcePath, original.completed).item!;
  const b = parseWorkItem(after, original.sourcePath, original.completed).item;
  if (!b) return 'the edited front matter would not parse; nothing was written';
  const changedKeys = new Set(['status', 'labels', 'milestone', 'updated_date']);
  const keys = new Set([...Object.keys(a.frontmatter), ...Object.keys(b.frontmatter)]);
  for (const k of keys) {
    if (changedKeys.has(k)) continue;
    if (!sameJson(a.frontmatter[k], b.frontmatter[k])) return `editing would disturb \`${k}\`; nothing was written`;
  }
  if (b.status !== expected.status || b.milestone !== expected.milestone || !sameJson(b.labels, expected.labels)) {
    return 'the edited front matter did not read back as intended; nothing was written';
  }
  if (b.body !== a.body || !sameJson(b.sections, a.sections)) return 'editing would disturb the story body; nothing was written';
  return undefined;
}

// --------------------------------------------------------------------- commit

export interface FsOps {
  readFile(path: string): string;
  writeFile(path: string, data: string, mode?: number): void;
  rename(from: string, to: string): void;
  unlink(path: string): void;
  mode(path: string): number | undefined;
}

export const nodeFs: FsOps = {
  readFile: (p) => readFileSync(p, 'utf8'),
  writeFile: (p, d, mode) => writeFileSync(p, d, mode === undefined ? 'utf8' : { encoding: 'utf8', mode }),
  rename: (a, b) => renameSync(a, b),
  unlink: (p) => unlinkSync(p),
  mode: (p) => {
    try {
      return statSync(p).mode & 0o777;
    } catch {
      return undefined;
    }
  },
};

export type CommitResult =
  | { ok: true; written: string[] }
  | { ok: false; reason: 'conflict'; message: string; written: [] }
  | { ok: false; reason: 'write_failed'; message: string; written: string[]; rolledBack: boolean; notRestored: string[] };

export function commitStoryEdit(plan: EditPlan, fs: FsOps = nodeFs): CommitResult {
  if (!plan.ok) throw new Error('refusing to commit a plan that did not validate');

  for (const w of plan.writes) {
    let current: string;
    try {
      current = fs.readFile(w.path);
    } catch {
      return { ok: false, reason: 'conflict', message: `${w.sourcePath} disappeared since it was read`, written: [] };
    }
    if (current !== w.before) {
      return { ok: false, reason: 'conflict', message: `${w.sourcePath} changed on disk since it was read`, written: [] };
    }
  }

  const tag = `${process.pid}-${randomBytes(4).toString('hex')}`;
  const staged: { w: FileWrite; temp: string }[] = [];
  const cleanup = () => {
    for (const s of staged) {
      try {
        fs.unlink(s.temp);
      } catch {
        /* already renamed or never written */
      }
    }
  };
  try {
    for (const w of plan.writes) {
      const temp = join(dirname(w.path), `.${basename(w.path)}.storymap-${tag}.tmp`);
      fs.writeFile(temp, w.after, fs.mode(w.path));
      staged.push({ w, temp });
    }
  } catch (error) {
    cleanup();
    return {
      ok: false,
      reason: 'write_failed',
      message: `could not stage the new files: ${(error as Error).message}`,
      written: [],
      rolledBack: true,
      notRestored: [],
    };
  }

  const replaced: FileWrite[] = [];
  for (const s of staged) {
    try {
      fs.rename(s.temp, s.w.path);
      replaced.push(s.w);
    } catch (error) {
      cleanup();
      const notRestored: string[] = [];
      for (const w of replaced) {
        try {
          fs.writeFile(w.path, w.before, fs.mode(w.path));
        } catch {
          notRestored.push(w.sourcePath);
        }
      }
      return {
        ok: false,
        reason: 'write_failed',
        message: `could not replace ${s.w.sourcePath}: ${(error as Error).message}`,
        written: notRestored,
        rolledBack: notRestored.length === 0,
        notRestored,
      };
    }
  }
  return { ok: true, written: plan.writes.map((w) => w.sourcePath) };
}
