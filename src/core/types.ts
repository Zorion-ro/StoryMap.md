/**
 * Domain types for the story-map tool.
 *
 * The Backlog.md Markdown files are canonical. Everything here is a read model
 * built from them; nothing in this package writes a work-item file.
 */

/** A checkbox line inside a Backlog.md `AC:` or `DOD:` marker block. */
export interface AcceptanceCriterion {
  /** 1-based index as Backlog.md numbers them (`- [ ] #3 ...`). */
  index: number;
  text: string;
  checked: boolean;
}

/**
 * One Backlog.md work item, read from `<backlog>/tasks/` or `<backlog>/completed/`.
 *
 * `frontmatter` holds the parsed YAML verbatim, including keys this tool does
 * not understand, so a caller can never lose metadata by round-tripping through
 * this model.
 */
export interface WorkItem {
  id: string;
  title: string;
  status: string;
  type?: string;
  /** Backlog.md's native three-level priority: high | medium | low. */
  priority?: string;
  labels: string[];
  dependencies: string[];
  documentation: string[];
  /** Items from the native `<!-- AC:BEGIN -->` block. Optional; may be empty. */
  acceptanceCriteria: AcceptanceCriterion[];
  /**
   * Checkbox lines found under an "Acceptance criteria" heading inside the
   * description body. The 2026-08-22 migration left them there rather than
   * reflowing them into the native block, so for most stories this is the only
   * acceptance evidence that exists.
   */
  bodyAcceptanceCriteria: AcceptanceCriterion[];
  definitionOfDone: AcceptanceCriterion[];
  /** Content of the `SECTION:DESCRIPTION` block. */
  body: string;
  /** Other Backlog.md marker sections present on the item (PLAN, NOTES, DECISIONS). */
  sections: Record<string, string>;
  /** Parsed front matter, unknown keys included. */
  frontmatter: Record<string, unknown>;
  /** Backlog.md milestone id this story belongs to, e.g. `m-1`. */
  milestone?: string;
  /** Repo-relative path. Identity is `id`; this is for display and links only. */
  sourcePath: string;
  completed: boolean;
  createdDate?: string;
  updatedDate?: string;

  // ---- optional structured labels; every one of these may be absent ----
  /** `area:<x>` */
  area?: string;
  /** `owner:<x>` */
  owner?: string;
  /** `wtype:<x>` */
  wtype?: string;
  /** `wstatus:<x>` — richer delivery state, deliberately separate from `status`. */
  wstatus?: string;
  /** `priority:<x>` — a project's own priority scale, finer than `priority`. */
  priorityLabel?: string;
  /** `risk:<x>` */
  risk?: string;
  /** Labels outside the six known namespaces. */
  otherLabels: string[];
}

/** A problem found while reading a work-item file. Never thrown; always reported. */
export interface ReadProblem {
  sourcePath: string;
  kind:
    | 'no_front_matter'
    | 'unparseable_front_matter'
    | 'missing_id'
    | 'missing_title'
    | 'missing_status'
    | 'duplicate_id';
  detail: string;
}

export interface BacklogReadResult {
  items: WorkItem[];
  problems: ReadProblem[];
}

/**
 * A Backlog.md milestone, read from `<backlog>/milestones/`.
 *
 * Stories reference it by `id`; the `title` is what a reader should see.
 */
export interface Milestone {
  id: string;
  title: string;
  sourcePath: string;
  archived: boolean;
}

// ---------------------------------------------------------------- story maps

export const STORY_MAP_SCHEMA_VERSION = 1;

/** How a story sits in a map. */
export type PlacementKind = 'primary' | 'supporting';

export interface StoryMapSlice {
  id: string;
  title: string;
  order: number;
  /**
   * Optional: the delivery state this slice is meant to hold. When set, the
   * validator warns if a placed story no longer matches, so a map cannot
   * quietly rot as work ships.
   */
  expects?: 'completed' | 'active';
}

export interface StoryMapStep {
  id: string;
  title: string;
  /** slice id -> ordered story ids placed in that cell. */
  slices: Record<string, string[]>;
  /**
   * Story ids that support this step without being owned by it — a
   * cross-cutting capability referenced from a journey it enables.
   */
  supporting?: string[];
}

export interface StoryMapActivity {
  id: string;
  title: string;
  steps: StoryMapStep[];
}

export interface StoryMap {
  schemaVersion: number;
  id: string;
  title: string;
  /** `journey` maps a human's path through the product; `capability` maps technical work. */
  kind: 'journey' | 'capability';
  summary?: string;
  personas: string[];
  releaseSlices: StoryMapSlice[];
  activities: StoryMapActivity[];
  sourcePath: string;
}

// ---------------------------------------------------------------- resolution

export interface ResolvedPlacement {
  storyId: string;
  item?: WorkItem;
  /** True when the map references an id no work item claims. Surfaced, never dropped. */
  missing: boolean;
  kind: PlacementKind;
}

export interface ResolvedCell {
  sliceId: string;
  placements: ResolvedPlacement[];
}

export interface ResolvedStep {
  id: string;
  title: string;
  cells: ResolvedCell[];
  supporting: ResolvedPlacement[];
}

export interface ResolvedActivity {
  id: string;
  title: string;
  steps: ResolvedStep[];
}

export interface ResolvedStoryMap {
  map: StoryMap;
  activities: ResolvedActivity[];
  /** Every story id the map names, in document order, deduplicated. */
  referencedIds: string[];
  missingIds: string[];
  counts: {
    primary: number;
    supporting: number;
    active: number;
    completed: number;
    missing: number;
  };
}

// ---------------------------------------------------------------- validation

export type ValidationSeverity = 'error' | 'warning';

export interface ValidationIssue {
  severity: ValidationSeverity;
  code: string;
  message: string;
  /** Repo-relative file the issue belongs to, when there is one. */
  where?: string;
}

export interface ValidationReport {
  issues: ValidationIssue[];
  errorCount: number;
  warningCount: number;
  ok: boolean;
}
