import type { ResolvedStoryMap, StoryMap, WorkItem } from './types';
import { normalizeId } from './work-item-index';

/**
 * A UI-ready projection of a resolved story map.
 *
 * The renderer walks this and nothing else: every cell already knows its cards,
 * so drawing the grid never searches the story collection. Placement, lane
 * assignment, filtering and counting all happen here, once.
 *
 * This is a projection of the YAML and the Markdown. It is not a second data
 * model: nothing here is persisted, and rebuilding it from the files is the
 * only way it ever comes into existence.
 */

/** Visual state a card is drawn in. Text always accompanies the colour. */
export type CardTone = 'done' | 'progress' | 'todo' | 'blocked' | 'backlog' | 'missing';

export interface VisualCard {
  storyId: string;
  title: string;
  /** Coarse Backlog.md status: To Do | In Progress | Done. */
  status: string;
  /** Richer delivery state from a `wstatus:` label, kept separate from `status`. */
  wstatus?: string;
  /** Display-ready work classification from `wtype:`; undefined when absent. */
  workType?: string;
  /** Backlog.md milestone id, when the story is in one. */
  milestone?: string;
  priorityLabel?: string;
  area?: string;
  completed: boolean;
  tone: CardTone;
  /** True when the map names an id no work item claims. Drawn, never dropped. */
  missing: boolean;
  supporting: boolean;
}

export interface VisualStep {
  id: string;
  title: string;
  activityId: string;
  /** 1-based position within its activity, as the header shows it. */
  ordinal: number;
  cardCount: number;
}

export interface VisualActivity {
  id: string;
  title: string;
  steps: VisualStep[];
  cardCount: number;
}

export type LaneTone = 'delivered' | 'built' | 'progress' | 'next' | 'later' | 'blocked' | 'closed' | 'neutral';

export interface VisualLane {
  id: string;
  title: string;
  tone: LaneTone;
  count: number;
}

export type LaneMode = 'slices' | 'workflow' | 'delivery';

export interface VisualFilter {
  hideCompleted?: boolean;
  /** Restrict to one activity id. */
  activity?: string;
  /** Coarse status exact match. */
  status?: string;
  /** Richer delivery-state label exact match. */
  wstatus?: string;
  /** Milestone id, or the literal 'none' for stories in no milestone. */
  milestone?: string;
  laneMode?: LaneMode;
}

export interface VisualStoryMapModel {
  map: StoryMap;
  activities: VisualActivity[];
  /** Flattened step order, left to right. Column order for the grid. */
  steps: VisualStep[];
  lanes: VisualLane[];
  /** `laneId` -> `stepId` -> the cards in that cell, in map order. */
  cells: Map<string, Map<string, VisualCard[]>>;
  supporting: VisualCard[];
  laneMode: LaneMode;
  /** True when lanes were derived from delivery state rather than read from the file. */
  lanesDerived: boolean;
  totals: {
    shown: number;
    hiddenByFilter: number;
    completed: number;
    active: number;
    supporting: number;
    missing: number;
  };
}

/**
 * The four delivery lanes, used only when the caller explicitly asks for
 * `laneMode: 'delivery'`.
 *
 * These are derived from each story's own state, not from the map file, which
 * is why they are opt-in and labelled as derived wherever they are shown. The
 * map's declared `releaseSlices` remain the default and the canonical grouping.
 */
/**
 * Delivery lanes, most-actionable first and **delivered last**.
 *
 * Every lane set this module derives ends with the finished work. Unfinished
 * work is the planning surface; completed work is context, and context belongs
 * underneath. Slices authored in a map file are never reordered — those carry
 * the author's own intent.
 */
const DELIVERY_LANES: { id: string; title: string; tone: LaneTone }[] = [
  { id: 'in-progress', title: 'In progress', tone: 'progress' },
  { id: 'built', title: 'Built, not deployed', tone: 'built' },
  { id: 'next', title: 'Next', tone: 'next' },
  { id: 'later', title: 'Later', tone: 'later' },
  { id: 'delivered', title: 'Delivered', tone: 'delivered' },
];

/**
 * Workflow lanes: the planning view. Ordered by how much attention each state
 * wants, and **Done is last**, always.
 */
export type WorkflowLaneId = 'blocked' | 'in-progress' | 'todo' | 'backlog' | 'closed' | 'done';

const WORKFLOW_LANES: { id: WorkflowLaneId; title: string; tone: LaneTone }[] = [
  { id: 'blocked', title: 'Blocked / needs decision', tone: 'blocked' },
  { id: 'in-progress', title: 'In progress', tone: 'progress' },
  { id: 'todo', title: 'To do', tone: 'next' },
  { id: 'backlog', title: 'Backlog', tone: 'later' },
  { id: 'closed', title: 'Closed without delivery', tone: 'closed' },
  { id: 'done', title: 'Done', tone: 'delivered' },
];

/**
 * `wstatus` decides; the coarse status is only the fallback.
 *
 * That single rule handles every contradiction the estate actually contains,
 * including the case that matters most: a story marked `status: Done` while its
 * `wstatus` says `implemented_not_deployed` is **not** done — five stories are
 * in exactly that state today, and calling them finished would hide the work
 * that is left.
 */
const WSTATUS_WORKFLOW_LANE: Record<string, WorkflowLaneId> = {
  blocked: 'blocked',
  'needs-decision': 'blocked',
  'blocked-needs-decision': 'blocked',
  cancelled: 'closed',
  superseded: 'closed',
  in_progress: 'in-progress',
  implemented_not_deployed: 'in-progress',
  implemented_pending_deploy: 'in-progress',
  deployed_partial: 'in-progress',
  ready: 'todo',
  todo: 'todo',
  backlog: 'backlog',
  done: 'done',
};

/**
 * Deterministic workflow lane for one story.
 *
 * An unrecognised `wstatus` falls back to the coarse status rather than being
 * guessed at, and an undecidable story lands in `backlog` — visible and
 * obviously unplanned — never silently in `done`.
 */
export function workflowLaneFor(item: WorkItem): WorkflowLaneId {
  const w = (item.wstatus ?? '').trim().toLowerCase();
  const mapped = WSTATUS_WORKFLOW_LANE[w];
  if (mapped) {
    // Reaching production outranks a stale planning label, but never outranks
    // a story that was closed without ever being delivered.
    if (item.completed && (mapped === 'backlog' || mapped === 'todo')) return 'done';
    return mapped;
  }
  // Unrecognised or absent: fall back to the coarse status.
  if (item.completed) return 'done';
  if (item.status === 'Done') return 'done';
  if (item.status === 'In Progress') return 'in-progress';
  return 'backlog';
}

/**
 * The story's work classification, from its own `wtype:` label.
 *
 * Never falls back to Backlog.md's native `type`: every story in this estate
 * carries `type: story`, so showing it would put the same meaningless word on
 * all 307 cards.
 */
export function workTypeFor(item: WorkItem): string | undefined {
  const raw = (item.wtype ?? '').trim();
  if (!raw) return undefined;
  return raw
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

/** Work under way, by either dimension. */
const PROGRESS_WSTATUS = new Set(['in_progress', 'deployed_partial']);
/** Finished in code, but not on a production host: the estate's own distinction. */
const BUILT_WSTATUS = new Set(['implemented_pending_deploy', 'implemented_not_deployed']);
/** Closed without delivery. Never "almost delivered". */
const CLOSED_WSTATUS = new Set(['cancelled', 'superseded']);

/**
 * Deterministic: same story, same lane, every time.
 *
 * `Built, not deployed` exists because this estate keeps a large population of
 * work that is `status: Done` while still sitting in `tasks/` — done in code,
 * waiting on a release. Folding those into `Later` (as an earlier version did)
 * put the most-finished work in the least-finished lane.
 */
export function deliveryLaneFor(item: WorkItem): string {
  if (item.completed) return 'delivered';
  const w = item.wstatus ?? '';
  if (CLOSED_WSTATUS.has(w)) return 'later';
  if (item.status === 'Done' || BUILT_WSTATUS.has(w)) return 'built';
  if (item.status === 'In Progress' || PROGRESS_WSTATUS.has(w)) return 'in-progress';
  if (w === 'ready') return 'next';
  return 'later';
}

export function toneFor(item: WorkItem): CardTone {
  if (item.completed || item.status === 'Done') return 'done';
  if (item.wstatus === 'blocked') return 'blocked';
  if (item.status === 'In Progress') return 'progress';
  if (item.wstatus === 'backlog' || item.wstatus === 'cancelled') return 'backlog';
  return 'todo';
}

function laneToneForSlice(sliceId: string, expects?: string): LaneTone {
  if (expects === 'completed') return 'delivered';
  const id = sliceId.toLowerCase();
  if (/deliver|done|shipped/.test(id)) return 'delivered';
  if (/progress|current|doing/.test(id)) return 'progress';
  if (/next|soon|alpha/.test(id)) return 'next';
  if (/later|future|backlog/.test(id)) return 'later';
  return 'neutral';
}

function cardOf(item: WorkItem, supporting: boolean): VisualCard {
  return {
    storyId: item.id,
    title: item.title,
    status: item.status,
    wstatus: item.wstatus,
    workType: workTypeFor(item),
    milestone: item.milestone,
    priorityLabel: item.priorityLabel,
    area: item.area,
    completed: item.completed,
    tone: toneFor(item),
    missing: false,
    supporting,
  };
}

function missingCard(storyId: string, supporting: boolean): VisualCard {
  return {
    storyId,
    title: 'unknown story — no active or completed work item claims this id',
    status: 'Unknown',
    completed: false,
    tone: 'missing',
    missing: true,
    supporting,
  };
}

export function buildVisualStoryMap(resolved: ResolvedStoryMap, filter: VisualFilter = {}): VisualStoryMapModel {
  const laneMode: LaneMode =
    filter.laneMode === 'delivery' || filter.laneMode === 'workflow' ? filter.laneMode : 'slices';
  const hideCompleted = filter.hideCompleted === true;

  const lanes: VisualLane[] =
    laneMode === 'workflow'
      ? WORKFLOW_LANES.map((l) => ({ ...l, count: 0 }))
      : laneMode === 'delivery'
        ? DELIVERY_LANES.map((l) => ({ ...l, count: 0 }))
        : resolved.map.releaseSlices.map((s) => ({
            id: s.id,
            title: s.title,
            tone: laneToneForSlice(s.id, s.expects),
            count: 0,
          }));

  const laneById = new Map(lanes.map((l) => [l.id, l]));
  /**
   * Where a placement goes when its declared lane does not exist in this mode —
   * an unresolvable id, say. Never the finished lane: we know nothing about it,
   * and "we do not know" is not "delivered".
   */
  const unknownLaneId = laneMode === 'workflow' ? 'backlog' : laneMode === 'delivery' ? 'later' : lanes[0]?.id ?? '';
  const cells = new Map<string, Map<string, VisualCard[]>>();
  for (const lane of lanes) cells.set(lane.id, new Map());

  const activities: VisualActivity[] = [];
  const steps: VisualStep[] = [];
  const supporting: VisualCard[] = [];
  let shown = 0;
  let hiddenByFilter = 0;
  let completed = 0;
  let active = 0;
  let missing = 0;

  const keep = (card: VisualCard, item?: WorkItem): boolean => {
    if (hideCompleted && card.completed) return false;
    if (filter.status && card.status !== filter.status) return false;
    if (filter.wstatus && (item?.wstatus ?? '') !== filter.wstatus) return false;
    if (filter.milestone) {
      const m = item?.milestone;
      if (filter.milestone === 'none' ? Boolean(m) : m !== filter.milestone) return false;
    }
    return true;
  };

  const activitySource = filter.activity
    ? resolved.activities.filter((a) => a.id === filter.activity)
    : resolved.activities;

  for (const activity of activitySource) {
    const visualSteps: VisualStep[] = [];
    let activityCards = 0;

    activity.steps.forEach((step, index) => {
      const visualStep: VisualStep = {
        id: step.id,
        title: step.title,
        activityId: activity.id,
        ordinal: index + 1,
        cardCount: 0,
      };

      for (const cell of step.cells) {
        for (const placement of cell.placements) {
          const card = placement.missing
            ? missingCard(placement.storyId, false)
            : cardOf(placement.item!, false);
          if (!keep(card, placement.item)) {
            hiddenByFilter += 1;
            continue;
          }
          // A missing story has no state to derive a delivery lane from, so it
          // keeps the lane the file gave it. If that lane does not exist in the
          // current mode, it lands in the last lane rather than disappearing:
          // a reference the map makes must always be drawn somewhere.
          const laneId = !placement.item
            ? cell.sliceId
            : laneMode === 'workflow'
              ? workflowLaneFor(placement.item)
              : laneMode === 'delivery'
                ? deliveryLaneFor(placement.item)
                : cell.sliceId;
          const lane = laneById.get(laneId) ?? laneById.get(unknownLaneId) ?? lanes[0];
          if (!lane) continue; // a map with no lanes at all; the validator rejects it
          const row = cells.get(lane.id)!;
          row.set(step.id, [...(row.get(step.id) ?? []), card]);
          lane.count += 1;
          visualStep.cardCount += 1;
          activityCards += 1;
          shown += 1;
          if (card.missing) missing += 1;
          else if (card.completed) completed += 1;
          else active += 1;
        }
      }

      for (const placement of step.supporting) {
        const card = placement.missing
          ? missingCard(placement.storyId, true)
          : cardOf(placement.item!, true);
        if (!keep(card, placement.item)) {
          hiddenByFilter += 1;
          continue;
        }
        if (!supporting.some((s) => normalizeId(s.storyId) === normalizeId(card.storyId))) {
          supporting.push(card);
        }
      }

      visualSteps.push(visualStep);
      steps.push(visualStep);
    });

    activities.push({ id: activity.id, title: activity.title, steps: visualSteps, cardCount: activityCards });
  }

  // A derived lane with nothing in it carries no authored intent, so it is
  // dropped rather than left as an empty band. A slice declared in the map file
  // does carry intent — an empty `Delivered` says "nothing here has shipped" —
  // so those are always shown.
  const derived = laneMode !== 'slices';
  const visibleLanes = derived ? lanes.filter((l) => l.count > 0) : lanes;

  return {
    map: resolved.map,
    activities,
    steps,
    lanes: visibleLanes,
    cells,
    supporting,
    laneMode,
    lanesDerived: derived,
    totals: {
      shown,
      hiddenByFilter,
      completed,
      active,
      supporting: supporting.length,
      missing,
    },
  };
}

/** Cards for one cell, or an empty array. Never searches; the model is indexed. */
export function cardsAt(model: VisualStoryMapModel, laneId: string, stepId: string): VisualCard[] {
  return model.cells.get(laneId)?.get(stepId) ?? [];
}
