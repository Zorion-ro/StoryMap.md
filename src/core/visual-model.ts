import type { ResolvedStoryMap, StoryMap, WorkItem } from './types';
import { normalizeId } from './work-item-index';
import { DEFAULT_WORKFLOW, normalizeWstatus } from './workflow';
import type { Workflow } from './workflow';

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
  /** The Backlog.md status, in the project's own vocabulary. */
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
 * Workflow lanes: the planning view. One lane per configured status, in the
 * workflow's lane order, plus three lanes for what a status cannot say:
 *
 * - `blocked` — an unfinished story whose `wstatus` says it cannot proceed;
 * - `status-unknown` — a status the project does not declare. It is shown, by
 *   name, rather than guessed at: a guess is how finished work ends up in the
 *   least-finished lane;
 * - `closed` — closed without delivery, placed immediately above the done
 *   lanes, because it is neither unfinished nor done.
 *
 * The done lanes come last, in lane order, so the most-shipped lane is always
 * the bottom one.
 */
export const WORKFLOW_BLOCKED_LANE = 'blocked';
export const WORKFLOW_UNKNOWN_LANE = 'status-unknown';
export const WORKFLOW_CLOSED_LANE = 'closed';

/** The lane id of a configured status. Prefixed, so no status name can collide with a fixed lane. */
export function statusLaneId(status: string): string {
  return `status:${status}`;
}

export function workflowLanes(workflow: Workflow = DEFAULT_WORKFLOW): { id: string; title: string; tone: LaneTone }[] {
  const toneOf = (status: string): LaneTone => {
    if (workflow.deliveredStatuses.includes(status)) return 'delivered';
    switch (workflow.stageOf(status)) {
      case 'done':
        return 'built';
      case 'active':
        return 'progress';
      case 'later':
        return 'later';
      default:
        return 'next';
    }
  };
  const statusLanes = workflow.laneOrder.map((s) => ({ id: statusLaneId(s), title: s, tone: toneOf(s) }));
  const firstDone = workflow.laneOrder.findIndex((s) => workflow.isDone(s));
  const closed = { id: WORKFLOW_CLOSED_LANE, title: 'Closed without delivery', tone: 'closed' as LaneTone };
  const at = firstDone === -1 ? statusLanes.length : firstDone;
  return [
    { id: WORKFLOW_BLOCKED_LANE, title: 'Blocked / needs decision', tone: 'blocked' },
    { id: WORKFLOW_UNKNOWN_LANE, title: 'Unknown status', tone: 'neutral' },
    ...statusLanes.slice(0, at),
    closed,
    ...statusLanes.slice(at),
  ];
}

/** `wstatus` values that take an unfinished story out of its status lane. Compared normalised. */
const BLOCKED_WSTATUS = new Set(['blocked', 'needs_decision', 'blocked_needs_decision']);
/** Closed without delivery. Never "almost delivered". */
const CLOSED_WSTATUS = new Set(['cancelled', 'superseded']);

/**
 * Deterministic workflow lane for one story.
 *
 * **The status decides.** It is the project's own workflow position, read
 * against the project's own vocabulary. `wstatus` is consulted only for the
 * exceptions a status cannot express: closed without delivery, and blocked.
 * A done status outranks a blocked label — the work is finished — and a story
 * the directory marks completed is drawn in the most-shipped lane even when its
 * status was never advanced.
 *
 * A status the project does not declare lands in `status-unknown`: visible and
 * named, never silently in a finished or an unfinished lane.
 */
export function workflowLaneFor(item: WorkItem, workflow: Workflow = DEFAULT_WORKFLOW): string {
  const w = normalizeWstatus(item.wstatus);
  if (CLOSED_WSTATUS.has(w)) return WORKFLOW_CLOSED_LANE;
  const status = workflow.canonical(item.status);
  if (!status) return WORKFLOW_UNKNOWN_LANE;
  if (workflow.isDone(status)) return statusLaneId(status);
  if (item.completed) {
    const done = workflow.laneOrder.filter((s) => workflow.isDone(s));
    return statusLaneId(done[done.length - 1]);
  }
  if (BLOCKED_WSTATUS.has(w)) return WORKFLOW_BLOCKED_LANE;
  return statusLaneId(status);
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
/**
 * Deterministic: same story, same lane, every time.
 *
 * `Built, not deployed` exists because a project can keep a large population of
 * work that is done in code while still sitting in `tasks/`, waiting on a
 * release. Folding those into `Later` (as an earlier version did) put the
 * most-finished work in the least-finished lane. "Done" and "under way" are read
 * from the project's workflow, never from a status literal.
 */
export function deliveryLaneFor(item: WorkItem, workflow: Workflow = DEFAULT_WORKFLOW): string {
  if (item.completed) return 'delivered';
  const w = normalizeWstatus(item.wstatus);
  if (CLOSED_WSTATUS.has(w)) return 'later';
  if (workflow.isDone(item.status) || BUILT_WSTATUS.has(w)) return 'built';
  if (workflow.isActive(item.status) || PROGRESS_WSTATUS.has(w)) return 'in-progress';
  if (w === 'ready') return 'next';
  return 'later';
}

export function toneFor(item: WorkItem, workflow: Workflow = DEFAULT_WORKFLOW): CardTone {
  const w = normalizeWstatus(item.wstatus);
  const stage = workflow.stageOf(item.status);
  if (item.completed || stage === 'done') return 'done';
  if (w === 'blocked') return 'blocked';
  if (stage === 'active') return 'progress';
  if (stage === 'later' || w === 'backlog' || w === 'cancelled') return 'backlog';
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

function cardOf(item: WorkItem, supporting: boolean, workflow: Workflow): VisualCard {
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
    tone: toneFor(item, workflow),
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

export function buildVisualStoryMap(
  resolved: ResolvedStoryMap,
  filter: VisualFilter = {},
  workflow: Workflow = DEFAULT_WORKFLOW,
): VisualStoryMapModel {
  const laneMode: LaneMode =
    filter.laneMode === 'delivery' || filter.laneMode === 'workflow' ? filter.laneMode : 'slices';
  const hideCompleted = filter.hideCompleted === true;

  const lanes: VisualLane[] =
    laneMode === 'workflow'
      ? workflowLanes(workflow).map((l) => ({ ...l, count: 0 }))
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
  const unknownLaneId = laneMode === 'workflow' ? WORKFLOW_UNKNOWN_LANE : laneMode === 'delivery' ? 'later' : lanes[0]?.id ?? '';
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
            : cardOf(placement.item!, false, workflow);
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
              ? workflowLaneFor(placement.item, workflow)
              : laneMode === 'delivery'
                ? deliveryLaneFor(placement.item, workflow)
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
          : cardOf(placement.item!, true, workflow);
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
