/**
 * A project's workflow, resolved from its own status vocabulary.
 *
 * Backlog.md statuses are project configuration: `backlog.config.yml` declares
 * them, in order, and a project is free to use `To Do / In Progress / Done` or
 * `Backlog / Ready / In Progress / Review / Done - Local / Done - Production`.
 * Nothing in this package may compare a status against a string literal —
 * a project whose words differ would be silently misclassified. Every question
 * the views ask about a status ("is it done?", "is it under way?", "which lane,
 * in which order?") is answered here, from the configured list.
 *
 * When a project declares nothing, the vocabulary is Backlog.md's own default,
 * which is the vocabulary Backlog.md itself uses in that case.
 */

/** Backlog.md's statuses for a project whose `backlog.config.yml` declares none. */
export const BACKLOG_MD_DEFAULT_STATUSES: readonly string[] = ['To Do', 'In Progress', 'Done'];

/**
 * Where a status sits in the workflow.
 *
 * - `done`    — the work is implemented; the status is one of the done levels.
 * - `active`  — the work is under way.
 * - `planned` — not started, and prepared.
 * - `later`   — not started: the default status, when the project has another
 *               not-started status to distinguish it from.
 */
export type StatusStage = 'done' | 'active' | 'planned' | 'later';

/** The settings a workflow is resolved from. Every field is optional. */
export interface WorkflowInput {
  /** The configured statuses, in declaration order. Default: Backlog.md's. */
  statuses?: readonly string[];
  /** The status a new item gets. Default: the first status. */
  defaultStatus?: string;
  /**
   * Workflow lane order, top to bottom: every configured status exactly once.
   * Default: the unfinished statuses most-advanced first, then the done
   * statuses in declaration order — so the most-shipped lane is always last.
   */
  laneOrder?: readonly string[];
  /** Statuses at which the work counts as done. Default: the last status. */
  doneStatuses?: readonly string[];
  /**
   * Statuses at which the work is under way. Default: the status declared
   * immediately before the first done status.
   */
  activeStatuses?: readonly string[];
  /**
   * Terminal statuses (`backlog.completedStatuses`). Used only to decide which
   * done lane is drawn as delivered; default: the last done status.
   */
  completedStatuses?: readonly string[];
}

/** A workflow setting that cannot be honoured. The message names the field. */
export class WorkflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowError';
  }
}

export interface Workflow {
  /** Configured statuses, in declaration order. */
  readonly statuses: readonly string[];
  readonly defaultStatus: string;
  /** Lane order, top to bottom. */
  readonly laneOrder: readonly string[];
  readonly doneStatuses: readonly string[];
  readonly activeStatuses: readonly string[];
  /** Done statuses drawn as delivered rather than built. */
  readonly deliveredStatuses: readonly string[];
  /** The configured spelling of `status`, matched case-insensitively; undefined when not configured. */
  canonical(status: string | undefined): string | undefined;
  /** Undefined for a status the project does not declare. */
  stageOf(status: string | undefined): StatusStage | undefined;
  isDone(status: string | undefined): boolean;
  isActive(status: string | undefined): boolean;
}

const key = (s: string) => s.trim().toLowerCase();

function uniqueList(values: readonly string[], field: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    if (typeof raw !== 'string' || !raw.trim()) {
      throw new WorkflowError(`\`${field}\` must list status names, got ${JSON.stringify(raw)}`);
    }
    const v = raw.trim();
    if (seen.has(key(v))) throw new WorkflowError(`\`${field}\` names "${v}" more than once`);
    seen.add(key(v));
    out.push(v);
  }
  return out;
}

export function resolveWorkflow(input: WorkflowInput = {}): Workflow {
  const statuses = uniqueList(
    input.statuses && input.statuses.length ? input.statuses : BACKLOG_MD_DEFAULT_STATUSES,
    'statuses',
  );
  const byKey = new Map(statuses.map((s) => [key(s), s]));
  const canonical = (s: string | undefined) => (typeof s === 'string' ? byKey.get(key(s)) : undefined);

  const declared = (values: readonly string[] | undefined, field: string): string[] | undefined => {
    if (values === undefined) return undefined;
    return uniqueList(values, field).map((v) => {
      const c = canonical(v);
      if (!c) {
        throw new WorkflowError(
          `\`${field}\` names "${v}", which is not a configured status (${statuses.join(', ')})`,
        );
      }
      return c;
    });
  };

  const defaultStatus = input.defaultStatus === undefined ? statuses[0] : canonical(input.defaultStatus);
  if (!defaultStatus) {
    throw new WorkflowError(
      `the default status "${input.defaultStatus}" is not a configured status (${statuses.join(', ')})`,
    );
  }

  const doneStatuses = declared(input.doneStatuses, 'workflow.doneStatuses') ?? [statuses[statuses.length - 1]];
  const done = new Set(doneStatuses);
  if (done.size === statuses.length) {
    throw new WorkflowError('`workflow.doneStatuses` names every configured status; at least one must be unfinished');
  }

  let activeStatuses = declared(input.activeStatuses, 'workflow.activeStatuses');
  if (activeStatuses) {
    const both = activeStatuses.find((s) => done.has(s));
    if (both) throw new WorkflowError(`"${both}" cannot be both an active and a done status`);
  } else {
    const firstDone = statuses.findIndex((s) => done.has(s));
    const before = firstDone > 0 ? statuses[firstDone - 1] : undefined;
    activeStatuses = before && !done.has(before) && before !== defaultStatus ? [before] : [];
  }
  const active = new Set(activeStatuses);

  const unfinished = statuses.filter((s) => !done.has(s));
  const laneOrder = declared(input.laneOrder, 'workflow.laneOrder') ?? [
    ...[...unfinished].reverse(),
    ...statuses.filter((s) => done.has(s)),
  ];
  const missing = statuses.filter((s) => !laneOrder.includes(s));
  if (missing.length) {
    throw new WorkflowError(
      `\`workflow.laneOrder\` must place every configured status; it leaves out ${missing.join(', ')}`,
    );
  }

  const completed = (declared(input.completedStatuses, 'backlog.completedStatuses') ?? []).filter((s) =>
    done.has(s),
  );
  const orderedDone = laneOrder.filter((s) => done.has(s));
  const deliveredStatuses = completed.length ? completed : [orderedDone[orderedDone.length - 1]];

  // The default status is "later" only when something else is merely "planned":
  // a project with one not-started status has nothing to rank it against.
  const notStarted = unfinished.filter((s) => !active.has(s));
  const stage = new Map<string, StatusStage>();
  for (const s of statuses) {
    if (done.has(s)) stage.set(s, 'done');
    else if (active.has(s)) stage.set(s, 'active');
    else if (s === defaultStatus && notStarted.length > 1) stage.set(s, 'later');
    else stage.set(s, 'planned');
  }

  const stageOf = (s: string | undefined) => {
    const c = canonical(s);
    return c ? stage.get(c) : undefined;
  };

  return {
    statuses,
    defaultStatus,
    laneOrder,
    doneStatuses: statuses.filter((s) => done.has(s)),
    activeStatuses: statuses.filter((s) => active.has(s)),
    deliveredStatuses,
    canonical,
    stageOf,
    isDone: (s) => stageOf(s) === 'done',
    isActive: (s) => stageOf(s) === 'active',
  };
}

/** Backlog.md's default vocabulary, for callers that have no project config. */
export const DEFAULT_WORKFLOW: Workflow = resolveWorkflow();

/**
 * One spelling for a `wstatus` value: lower case, words joined by `_`.
 * `implemented-not-deployed`, `Implemented not deployed` and
 * `implemented_not_deployed` are the same label.
 */
export function normalizeWstatus(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}
