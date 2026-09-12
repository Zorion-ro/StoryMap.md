import type { WorkItem } from '../core';
import type { ErrorCode } from './errors';

/**
 * The story resource, described once.
 *
 * Validation, `/meta` and the OpenAPI document all read this table, so what an
 * agent is told about a field and what the server enforces cannot drift apart.
 * It is a v1 contract: add fields, never rename one or change what it means.
 */

export type FieldType = 'string' | 'string[]' | 'object' | 'object[]';

/**
 * - `closed`: only the listed values are accepted.
 * - `open`: known values are listed; a new one needs `allowNewValues: true`.
 * - `reference`: must name something that exists (a milestone, a story).
 */
export type Vocabulary = 'closed' | 'open' | 'reference';

export interface FieldSpec {
  type: FieldType;
  description: string;
  nullable: boolean;
  /** Settable with PATCH and in bulk-update `changes`. */
  writable: boolean;
  /** Settable when creating a story. */
  creatable: boolean;
  required?: boolean;
  /** Supports `{ "add": [...], "remove": [...] }` as well as a whole array. */
  setOperations?: boolean;
  /** Query parameter that filters on it; `<param>_not` excludes. */
  filter?: string;
  sortable?: boolean;
  vocabulary?: Vocabulary;
  /** Label namespace when the value lives in `labels` as `<ns>:<value>`. */
  labelNamespace?: string;
  /** Error code for a value outside the vocabulary. */
  invalidCode?: ErrorCode;
  /** Where the value is persisted, for people reading the metadata. */
  storage: string;
  example?: unknown;
}

const labelField = (ns: string, description: string, invalidCode: ErrorCode, example: string, filter: string): FieldSpec => ({
  type: 'string',
  description,
  nullable: true,
  writable: true,
  creatable: true,
  filter,
  sortable: true,
  vocabulary: 'open',
  labelNamespace: ns,
  invalidCode,
  storage: `label \`${ns}:<value>\` in front matter \`labels\``,
  example,
});

export const STORY_FIELDS = {
  id: {
    type: 'string',
    description: 'Work item id. Allocated by the server on create; matched case- and zero-padding-insensitively.',
    nullable: false,
    writable: false,
    creatable: false,
    filter: 'id',
    sortable: true,
    storage: 'front matter `id`',
    example: 'FW-397',
  },
  title: {
    type: 'string',
    description: 'One-line title.',
    nullable: false,
    writable: true,
    creatable: true,
    required: true,
    sortable: true,
    storage: 'front matter `title`',
    example: 'The dev app compose has no parity gate',
  },
  body: {
    type: 'string',
    description: 'Markdown description. An empty string empties it.',
    nullable: false,
    writable: true,
    creatable: true,
    storage: 'the `SECTION:DESCRIPTION` block, or the Markdown after the front matter when a file has no marker blocks',
    example: 'Production asserts compose parity; Integrated Dev does not.',
  },
  state: {
    type: 'string',
    description: '`completed` when the file is in `completed/`, otherwise `active`. Derived; change `status` instead.',
    nullable: false,
    writable: false,
    creatable: false,
    filter: 'state',
    sortable: true,
    vocabulary: 'closed',
    storage: 'derived from the directory holding the file',
    example: 'active',
  },
  status: {
    type: 'string',
    description: 'Workflow status, one of the project’s statuses.',
    nullable: false,
    writable: true,
    creatable: true,
    filter: 'status',
    sortable: true,
    vocabulary: 'closed',
    invalidCode: 'INVALID_STATUS',
    storage: 'front matter `status`',
    example: 'In Progress',
  },
  type: {
    type: 'string',
    description: 'Backlog.md work item type.',
    nullable: true,
    writable: true,
    creatable: true,
    filter: 'type',
    sortable: true,
    vocabulary: 'closed',
    invalidCode: 'INVALID_TYPE',
    storage: 'front matter `type`',
    example: 'story',
  },
  backlogPriority: {
    type: 'string',
    description: 'Backlog.md’s native priority: high | medium | low, as Backlog.md itself validates it.',
    nullable: true,
    writable: true,
    creatable: true,
    filter: 'backlogPriority',
    sortable: true,
    vocabulary: 'closed',
    invalidCode: 'INVALID_BACKLOG_PRIORITY',
    storage: 'front matter `priority`',
    example: 'medium',
  },
  priority: labelField(
    'priority',
    'The project’s priority scale — what Storymap’s priority column and filter show. As a filter, high | medium | low also match `backlogPriority`, as the browser does.',
    'INVALID_PRIORITY',
    'p2',
    'priority',
  ),
  wstatus: labelField('wstatus', 'Delivery state, deliberately separate from `status`.', 'INVALID_WSTATUS', 'done', 'wstatus'),
  wtype: labelField('wtype', 'Kind of work.', 'INVALID_WTYPE', 'defect', 'wtype'),
  area: labelField('area', 'Product or system area.', 'INVALID_AREA', 'deployment', 'area'),
  owner: labelField('owner', 'Owning team.', 'INVALID_OWNER', 'platform', 'owner'),
  risk: labelField('risk', 'Risk level.', 'INVALID_RISK', 'medium', 'risk'),
  milestone: {
    type: 'string',
    description: 'Milestone id. `null` clears it.',
    nullable: true,
    writable: true,
    creatable: true,
    filter: 'milestone',
    sortable: true,
    vocabulary: 'reference',
    invalidCode: 'INVALID_MILESTONE',
    storage: 'front matter `milestone`',
    example: 'm-0',
  },
  labels: {
    type: 'string[]',
    description:
      'Every label, structured ones included. Set the whole array, or send `{ "add": [], "remove": [] }`; both operations are idempotent.',
    nullable: false,
    writable: true,
    creatable: true,
    setOperations: true,
    filter: 'label',
    storage: 'front matter `labels`',
    example: ['area:deployment', 'owner:platform', 'risk:medium'],
  },
  dependencies: {
    type: 'string[]',
    description: 'Ids this story depends on. Whole array, or `{ "add": [], "remove": [] }`. Each must exist.',
    nullable: false,
    writable: true,
    creatable: true,
    setOperations: true,
    filter: 'dependency',
    vocabulary: 'reference',
    invalidCode: 'INVALID_DEPENDENCY',
    storage: 'front matter `dependencies`',
    example: ['FW-393'],
  },
  dependents: {
    type: 'string[]',
    description: 'Ids of stories that depend on this one — what it blocks. Derived.',
    nullable: false,
    writable: false,
    creatable: false,
    storage: 'derived from other stories’ `dependencies`',
    example: ['FW-396'],
  },
  maps: {
    type: 'object[]',
    description: 'Story maps that place this story, with its role. Derived: placement is edited in the map YAML.',
    nullable: false,
    writable: false,
    creatable: false,
    filter: 'map',
    storage: 'derived from the story-map YAML files',
    example: [{ id: 'bidder-journey', role: 'primary' }],
  },
  documentation: {
    type: 'string[]',
    description: 'Documentation paths.',
    nullable: false,
    writable: false,
    creatable: false,
    storage: 'front matter `documentation`',
    example: ['docs/work/backlog/docs/doc-001 - Definition-of-Done.md'],
  },
  acceptanceCriteria: {
    type: 'object[]',
    description: 'Checkboxes from the native `AC` block.',
    nullable: false,
    writable: false,
    creatable: false,
    storage: 'the `AC:BEGIN`/`AC:END` block',
    example: [{ index: 1, text: 'A parity gate exists', checked: true }],
  },
  bodyAcceptanceCriteria: {
    type: 'object[]',
    description: 'Checkboxes under an "Acceptance criteria" heading inside the body.',
    nullable: false,
    writable: false,
    creatable: false,
    storage: 'the body',
    example: [],
  },
  definitionOfDone: {
    type: 'object[]',
    description: 'Checkboxes from the `DOD` block.',
    nullable: false,
    writable: false,
    creatable: false,
    storage: 'the `DOD:BEGIN`/`DOD:END` block',
    example: [{ index: 1, text: 'Meets the Definition of Done', checked: false }],
  },
  sections: {
    type: 'object',
    description: 'Other Backlog.md marker sections present (PLAN, NOTES, DECISIONS, FINAL_SUMMARY), keyed by name.',
    nullable: false,
    writable: false,
    creatable: false,
    storage: '`SECTION:<NAME>` blocks',
    example: {},
  },
  createdAt: {
    type: 'string',
    description: 'ISO 8601 creation time from `created_date` (UTC, as Backlog.md stamps it). `null` if absent or unparseable.',
    nullable: true,
    writable: false,
    creatable: false,
    sortable: true,
    storage: 'front matter `created_date`',
    example: '2026-08-27T08:14:00Z',
  },
  updatedAt: {
    type: 'string',
    description: 'ISO 8601 last-update time from `updated_date`; stamped on every change made through this API.',
    nullable: true,
    writable: false,
    creatable: false,
    sortable: true,
    storage: 'front matter `updated_date`',
    example: '2026-09-12T23:00:00Z',
  },
  sourcePath: {
    type: 'string',
    description: 'Repository-relative file path. Informational; identity is `id`.',
    nullable: false,
    writable: false,
    creatable: false,
    storage: 'the filesystem',
    example: 'docs/work/backlog/tasks/fw-397 - The-dev-app-compose.md',
  },
  revision: {
    type: 'string',
    description: 'Fingerprint of the file’s exact bytes. Send it back as `If-Match` or `expectedRevision` to refuse overwriting a newer edit.',
    nullable: false,
    writable: false,
    creatable: false,
    storage: 'sha-256 of the file, truncated',
    example: '3f1c9a0b7d2e4c6a8b10',
  },
} satisfies Record<string, FieldSpec>;

export type StoryFieldName = keyof typeof STORY_FIELDS;

export const FIELD_NAMES = Object.keys(STORY_FIELDS) as StoryFieldName[];

export function fieldSpec(name: string): FieldSpec | undefined {
  return (STORY_FIELDS as Record<string, FieldSpec>)[name];
}

/** Fields stored as a `<namespace>:<value>` label. */
export const LABEL_FIELDS = FIELD_NAMES.filter((n) => fieldSpec(n)!.labelNamespace) as StoryFieldName[];

export const SORT_FIELDS = FIELD_NAMES.filter((n) => fieldSpec(n)!.sortable);

/** Request keys that control a mutation rather than name a field. */
export const CONTROL_KEYS = ['expectedRevision', 'allowNewValues', 'dryRun'] as const;

export const LIMITS = {
  defaultPageSize: 100,
  maxPageSize: 500,
  maxBulkIds: 200,
  maxTitleLength: 500,
  maxBodyBytes: 1024 * 1024,
  maxLabelLength: 200,
} as const;

/**
 * Stored `yyyy-mm-dd[ HH:MM[:SS]]` -> ISO 8601, or null. Backlog.md stamps these
 * in UTC, so a time carries `Z`; a bare date stays a date.
 */
export function isoDate(value: string | undefined): string | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(value.trim());
  if (!m) return null;
  return m[4] ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? '00'}Z` : `${m[1]}-${m[2]}-${m[3]}`;
}

/** A field's value on a work item, for the fields that map straight onto one. */
export function itemValue(item: WorkItem, field: string): unknown {
  const key = field === 'priority' ? 'priorityLabel' : field === 'backlogPriority' ? 'priority' : field;
  const value = item[key as keyof WorkItem];
  return value === undefined ? null : value;
}
