import type { WorkItem } from './types';
import type { FieldFilter } from './story-query';

/**
 * The Stories Kanban board, grouped the way the Backlog.md browser groups its
 * own board, so the two tools read the same estate the same way:
 *
 * - one column per status declared in `backlog.config.yml`, in declared order;
 * - optionally one swimlane per milestone (Backlog.md's "lane by milestone");
 * - inside a column, cards with an `ordinal` first by ordinal, then — in a
 *   column whose name says done or complete — most recently updated first,
 *   and elsewhere oldest created first.
 *
 * StoryMap.md adds one rule of its own: a story whose status the config does
 * not declare is not silently hidden. It gets a trailing column marked as
 * undeclared, which accepts no drops, because moving a story *into* an
 * undeclared status is exactly what validation refuses.
 */

/** Backlog.md's default statuses, used when a project declares none. */
export const DEFAULT_STATUSES = ['To Do', 'In Progress', 'Done'];

export type KanbanLaneMode = 'none' | 'milestone';

export interface KanbanColumn {
  status: string;
  /** False for a status the project config does not declare. */
  declared: boolean;
  items: WorkItem[];
}

export interface KanbanLane {
  /** `''` for the single lane when not laning, `none` for no milestone. */
  key: string;
  title: string;
  milestone?: string;
  columns: KanbanColumn[];
  count: number;
}

export interface KanbanBoard {
  laneMode: KanbanLaneMode;
  statuses: string[];
  lanes: KanbanLane[];
  total: number;
}

function isDoneColumn(status: string): boolean {
  const s = status.toLowerCase();
  return s.includes('done') || s.includes('complete');
}

function ordinalOf(item: WorkItem): number | undefined {
  const raw = item.frontmatter.ordinal;
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/** Backlog.md's in-column order. Ties fall back to id so the board is stable. */
export function sortColumn(items: readonly WorkItem[], status: string, tiebreak: (a: WorkItem, b: WorkItem) => number): WorkItem[] {
  const done = isDoneColumn(status);
  return [...items].sort((a, b) => {
    const oa = ordinalOf(a);
    const ob = ordinalOf(b);
    if (oa !== undefined && ob === undefined) return -1;
    if (oa === undefined && ob !== undefined) return 1;
    if (oa !== undefined && ob !== undefined && oa !== ob) return oa - ob;
    if (done) {
      const da = a.updatedDate ?? a.createdDate ?? '';
      const db = b.updatedDate ?? b.createdDate ?? '';
      if (da !== db) return db.localeCompare(da);
    } else {
      const ca = a.createdDate ?? '';
      const cb = b.createdDate ?? '';
      if (ca !== cb) return ca.localeCompare(cb);
    }
    return tiebreak(a, b);
  });
}

/**
 * Which columns a status filter leaves on the board. `status IS Backlog, Ready`
 * shows those two columns; `status IS NOT Done` hides the Done column rather
 * than drawing it empty.
 */
export function visibleStatuses(declared: readonly string[], statusFilter: FieldFilter | undefined): string[] {
  if (!statusFilter || statusFilter.values.length === 0) return [...declared];
  const named = new Set(statusFilter.values);
  return declared.filter((s) => (statusFilter.op === 'in' ? named.has(s) : !named.has(s)));
}

export function buildKanban(
  items: readonly WorkItem[],
  opts: {
    statuses?: readonly string[];
    statusFilter?: FieldFilter;
    laneMode?: KanbanLaneMode;
    milestones?: readonly { id: string; title: string }[];
    tiebreak?: (a: WorkItem, b: WorkItem) => number;
  } = {},
): KanbanBoard {
  const declared = opts.statuses && opts.statuses.length ? [...opts.statuses] : DEFAULT_STATUSES;
  const laneMode = opts.laneMode ?? 'none';
  const tiebreak = opts.tiebreak ?? ((a, b) => a.id.localeCompare(b.id));
  const shown = visibleStatuses(declared, opts.statusFilter);

  // Undeclared statuses that actually occur, in first-seen order.
  const undeclared: string[] = [];
  for (const item of items) {
    if (!declared.includes(item.status) && !undeclared.includes(item.status)) undeclared.push(item.status);
  }
  const statuses = [...shown, ...undeclared];

  const laneKeys: { key: string; title: string; milestone?: string }[] = [];
  if (laneMode === 'milestone') {
    const used = new Set(items.map((i) => i.milestone ?? ''));
    laneKeys.push({ key: 'none', title: 'No milestone' });
    for (const m of opts.milestones ?? []) {
      if (used.has(m.id)) laneKeys.push({ key: m.id, title: m.title, milestone: m.id });
    }
    // A milestone id no milestone file declares still gets its lane.
    for (const id of used) {
      if (id && !laneKeys.some((l) => l.milestone === id)) laneKeys.push({ key: id, title: id, milestone: id });
    }
  } else {
    laneKeys.push({ key: '', title: 'All stories' });
  }

  const lanes: KanbanLane[] = laneKeys.map((lane) => {
    const inLane =
      laneMode === 'milestone'
        ? items.filter((i) => (lane.milestone ? i.milestone === lane.milestone : !i.milestone))
        : [...items];
    const columns = statuses.map((status) => ({
      status,
      declared: declared.includes(status),
      items: sortColumn(inLane.filter((i) => i.status === status), status, tiebreak),
    }));
    return { ...lane, columns, count: inLane.length };
  });

  return {
    laneMode,
    statuses,
    // An empty milestone lane is noise; "no milestone" stays only when used.
    lanes: laneMode === 'milestone' ? lanes.filter((l) => l.count > 0) : lanes,
    total: items.length,
  };
}
