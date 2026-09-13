import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import {
  BACKLOG_MD_DEFAULT_STATUSES,
  BACKLOG_MD_PRIORITIES,
  ConventionsReader,
  WorkItemWriteError,
  WorkspaceHost,
  backlogTimestamp,
  buildMapMembership,
  contentRevision,
  createFileExclusive,
  editFrontMatter,
  normalizeId,
  parseWorkItem,
  renderNewWorkItem,
  replaceDescription,
  replaceFileAtomic,
  verifyFrontMatterEdit,
  withBacklogLock,
  workItemFileName,
} from '../core';
import type { BacklogConventions, FrontValue, WorkItem, Workspace } from '../core';
import type { Project } from '../project/config';
import { ApiError, ERROR_CODES, apiError, validationErrors } from './errors';
import type { ErrorCode, ErrorDetail } from './errors';
import {
  CONTROL_KEYS,
  FIELD_NAMES,
  LABEL_FIELDS,
  LIMITS,
  SORT_FIELDS,
  STORY_FIELDS,
  fieldSpec,
  isoDate,
  itemValue,
} from './fields';
import type { FieldSpec, StoryFieldName } from './fields';
import { NONE } from '../core';
import { FILTER_PARAMS, TEXT_PARAMS, compileApiFilter, parseApiFilter } from './story-filter';

/**
 * The story application service: one implementation of reading, validating and
 * changing work items, called by the HTTP API, the CLI and anything else that
 * needs to change a story. Nothing here keeps state of its own — every read
 * goes through the WorkspaceHost and every write lands in the Markdown file.
 */

export const API_VERSION = 'v1';

export interface ApiStory {
  id: string;
  title: string;
  body: string;
  state: 'active' | 'completed';
  status: string;
  type: string | null;
  backlogPriority: string | null;
  priority: string | null;
  wstatus: string | null;
  wtype: string | null;
  area: string | null;
  owner: string | null;
  risk: string | null;
  milestone: string | null;
  labels: string[];
  dependencies: string[];
  dependents: string[];
  maps: { id: string; role: 'primary' | 'supporting' }[];
  documentation: string[];
  acceptanceCriteria: { index: number; text: string; checked: boolean }[];
  bodyAcceptanceCriteria: { index: number; text: string; checked: boolean }[];
  definitionOfDone: { index: number; text: string; checked: boolean }[];
  sections: Record<string, string>;
  createdAt: string | null;
  updatedAt: string | null;
  sourcePath: string;
  revision: string;
}

export type FieldChange = { from: unknown; to: unknown };

export interface MutationResult {
  dryRun: boolean;
  changed: boolean;
  changes: Record<string, FieldChange>;
  previousRevision: string;
  story: ApiStory;
}

export interface BulkItemResult {
  id: string;
  ok: boolean;
  changed?: boolean;
  changes?: Record<string, FieldChange>;
  previousRevision?: string;
  revision?: string;
  story?: ApiStory;
  error?: ErrorDetail;
  errors?: ErrorDetail[];
}

type LabelField = (typeof LABEL_FIELDS)[number];

interface SetOps {
  replace?: string[];
  add: string[];
  remove: string[];
}

/** A validated change set, independent of any one story. */
interface Changes {
  title?: string;
  body?: string;
  status?: string;
  type?: string | null;
  backlogPriority?: string | null;
  milestone?: string | null;
  labelFields: Partial<Record<LabelField, string | null>>;
  labels?: SetOps;
  dependencies?: SetOps;
}

interface Vocab {
  statusesWritable: string[];
  statusesKnown: string[];
  typesDeclared: string[];
  typesKnown: string[];
  /** Backlog.md's own scale, the only values it accepts. */
  backlogPrioritiesWritable: string[];
  backlogPrioritiesKnown: string[];
  counts: Record<string, Record<string, number>>;
  milestones: { id: string; title: string; archived: boolean }[];
  maps: { id: string; title: string; kind: string }[];
}

interface Derived {
  vocab: Vocab;
  dependents: Map<string, string[]>;
  membership: Map<string, Set<string>>;
}

const LABEL_VALUE = /^[A-Za-z0-9][A-Za-z0-9._/+-]*$/;

function unique<T>(values: Iterable<T>): T[] {
  return [...new Set(values)];
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Inserts keeping alphabetical order when the list already is, otherwise appends. */
function insertLabel(labels: string[], label: string, at?: number): void {
  if (at !== undefined && at >= 0 && at <= labels.length) {
    labels.splice(at, 0, label);
    return;
  }
  const sorted = labels.every((l, i) => i === 0 || labels[i - 1] <= l);
  if (!sorted) {
    labels.push(label);
    return;
  }
  const index = labels.findIndex((l) => l > label);
  labels.splice(index === -1 ? labels.length : index, 0, label);
}

function namespaceOf(label: string): string | undefined {
  const at = label.indexOf(':');
  return at === -1 ? undefined : label.slice(0, at);
}

function labelFieldForNamespace(ns: string | undefined): LabelField | undefined {
  return ns === undefined ? undefined : LABEL_FIELDS.find((f) => fieldSpec(f)!.labelNamespace === ns);
}

export interface StoryServiceOptions {
  host?: WorkspaceHost;
  now?: () => Date;
}

export class StoryService {
  readonly host: WorkspaceHost;
  private readonly conventions: ConventionsReader;
  private readonly derived = new WeakMap<Workspace, Derived>();
  private readonly now: () => Date;

  constructor(
    readonly project: Project,
    opts: StoryServiceOptions = {},
  ) {
    this.host = opts.host ?? new WorkspaceHost(project.root, project.backlogDirectory, project.storyMapsDirectory, project.completedStatuses);
    this.conventions = new ConventionsReader(project.backlogConfigPath);
    this.now = opts.now ?? (() => new Date());
  }

  // ------------------------------------------------------------------ reads

  private derive(ws: Workspace): Derived {
    const hit = this.derived.get(ws);
    if (hit) return hit;
    const conv = this.conventions.get();
    const items = ws.index.items;
    const counts: Record<string, Record<string, number>> = {};
    const count = (field: string, value: string | undefined) => {
      if (!value) return;
      const bucket = (counts[field] ??= {});
      bucket[value] = (bucket[value] ?? 0) + 1;
    };
    const dependents = new Map<string, string[]>();
    for (const item of items) {
      count('status', item.status);
      count('type', item.type);
      count('backlogPriority', item.priority);
      count('milestone', item.milestone);
      count('state', item.completed ? 'completed' : 'active');
      for (const f of LABEL_FIELDS) count(f, itemValue(item, f) as string | undefined);
      for (const dep of item.dependencies) {
        const key = normalizeId(dep);
        const list = dependents.get(key) ?? [];
        if (!list.includes(item.id)) list.push(item.id);
        dependents.set(key, list);
      }
    }
    const observed = (field: string) => Object.keys(counts[field] ?? {}).sort();
    const vocab: Vocab = {
      statusesWritable:
        conv.statuses.length > 0 ? conv.statuses : unique([...BACKLOG_MD_DEFAULT_STATUSES, ...observed('status')]),
      statusesKnown: unique([...conv.statuses, ...observed('status')]),
      typesDeclared: conv.types,
      typesKnown: unique([...conv.types, ...observed('type')]),
      backlogPrioritiesWritable: BACKLOG_MD_PRIORITIES,
      backlogPrioritiesKnown: unique([...BACKLOG_MD_PRIORITIES, ...observed('backlogPriority')]),
      counts,
      milestones: ws.milestones.map((m) => ({ id: m.id, title: m.title, archived: m.archived })),
      maps: ws.maps.map((m) => ({ id: m.id, title: m.title, kind: m.kind })),
    };
    const value: Derived = { vocab, dependents, membership: buildMapMembership(ws) };
    this.derived.set(ws, value);
    return value;
  }

  private toApiStory(item: WorkItem, ws: Workspace, raw?: string): ApiStory {
    const d = this.derive(ws);
    const key = normalizeId(item.id);
    return {
      id: item.id,
      title: item.title,
      body: item.body,
      state: item.completed ? 'completed' : 'active',
      status: item.status,
      type: item.type ?? null,
      backlogPriority: item.priority ?? null,
      priority: item.priorityLabel ?? null,
      wstatus: item.wstatus ?? null,
      wtype: item.wtype ?? null,
      area: item.area ?? null,
      owner: item.owner ?? null,
      risk: item.risk ?? null,
      milestone: item.milestone ?? null,
      labels: [...item.labels],
      dependencies: [...item.dependencies],
      dependents: [...(d.dependents.get(key) ?? [])],
      maps: (ws.placements.get(key) ?? []).map((p) => ({ id: p.mapId, role: p.role })),
      documentation: [...item.documentation],
      acceptanceCriteria: item.acceptanceCriteria.map((c) => ({ ...c })),
      bodyAcceptanceCriteria: item.bodyAcceptanceCriteria.map((c) => ({ ...c })),
      definitionOfDone: item.definitionOfDone.map((c) => ({ ...c })),
      sections: { ...item.sections },
      createdAt: isoDate(item.createdDate),
      updatedAt: isoDate(item.updatedDate),
      sourcePath: item.sourcePath,
      revision: item.revision ?? contentRevision(raw ?? ''),
    };
  }

  /** A short machine-readable index of the API. */
  discovery(basePath = `/api/${API_VERSION}/storymap`): Record<string, unknown> {
    return {
      name: `${this.project.projectName} Storymap API`,
      apiVersion: API_VERSION,
      documentation: `${basePath}/openapi.json`,
      metadata: `${basePath}/meta`,
      stories: `${basePath}/stories`,
      guidance: 'Call the metadata endpoint for valid field values instead of assuming them.',
    };
  }

  meta(opts: { readOnly?: boolean } = {}): Record<string, unknown> {
    const ws = this.host.get();
    const { vocab } = this.derive(ws);
    const valuesFor = (name: StoryFieldName): string[] | undefined => {
      switch (name) {
        case 'status':
          return vocab.statusesKnown;
        case 'state':
          return ['active', 'completed'];
        case 'type':
          return vocab.typesKnown;
        case 'backlogPriority':
          return vocab.backlogPrioritiesKnown;
        case 'milestone':
          return vocab.milestones.map((m) => m.id);
        default:
          return (LABEL_FIELDS as readonly string[]).includes(name) ? Object.keys(vocab.counts[name] ?? {}).sort() : undefined;
      }
    };
    const fields: Record<string, unknown> = {};
    for (const name of FIELD_NAMES) {
      const spec: FieldSpec = STORY_FIELDS[name];
      const values = valuesFor(name);
      const vocabulary = name === 'type' && vocab.typesDeclared.length === 0 ? 'open' : (spec.vocabulary ?? null);
      fields[name] = {
        type: spec.type,
        description: spec.description,
        nullable: spec.nullable,
        writable: spec.writable,
        creatable: spec.creatable,
        required: spec.required ?? false,
        bulkWritable: spec.writable,
        setOperations: spec.setOperations ?? false,
        filter: spec.filter ? { include: spec.filter, exclude: `${spec.filter}_not` } : null,
        sortable: spec.sortable ?? false,
        vocabulary,
        ...(values ? { values } : {}),
        ...(name === 'status' ? { writableValues: vocab.statusesWritable, declaredValues: this.conventions.get().statuses } : {}),
        ...(name === 'type' ? { declaredValues: vocab.typesDeclared } : {}),
        ...(name === 'backlogPriority' ? { writableValues: vocab.backlogPrioritiesWritable } : {}),
        ...(vocab.counts[name] ? { counts: vocab.counts[name] } : {}),
        ...(spec.labelNamespace ? { labelNamespace: spec.labelNamespace } : {}),
        storage: spec.storage,
      };
    }
    const label = (f: string) => Object.keys(vocab.counts[f] ?? {}).sort();
    return {
      apiVersion: API_VERSION,
      resource: 'story',
      project: { name: this.project.projectName, backlogDirectory: this.project.backlogDirectory },
      counts: { total: ws.index.size, active: ws.index.active.length, completed: ws.index.completed.length },
      operations: OPERATIONS,
      fields,
      statuses: vocab.statusesKnown,
      writableStatuses: vocab.statusesWritable,
      types: vocab.typesKnown,
      priorities: label('priority'),
      backlogPriorities: vocab.backlogPrioritiesKnown,
      wstatuses: label('wstatus'),
      wtypes: label('wtype'),
      areas: label('area'),
      owners: label('owner'),
      risks: label('risk'),
      milestones: vocab.milestones,
      maps: vocab.maps,
      filters: {
        parameters: Object.keys(FILTER_PARAMS),
        textParameters: [...TEXT_PARAMS],
        operators: [
          { syntax: '<param>=a,b', meaning: 'IN (a, b)' },
          { syntax: '<param>_not=a,b', meaning: 'NOT IN (a, b)' },
        ],
        noneToken: NONE,
        semantics: 'Values within one parameter are ORed; different parameters are ANDed; `none` matches a field with no value.',
      },
      sort: { fields: SORT_FIELDS, default: 'id', orders: ['asc', 'desc'], nulls: 'last when ascending' },
      pagination: { defaultLimit: LIMITS.defaultPageSize, maxLimit: LIMITS.maxPageSize, style: 'cursor', nextCursorField: 'nextCursor' },
      bulk: {
        maxIds: LIMITS.maxBulkIds,
        atomic: true,
        fields: FIELD_NAMES.filter((n) => STORY_FIELDS[n].writable),
      },
      labelOperations: { replace: 'send an array', add: '{"add": [...]}', remove: '{"remove": [...]}', idempotent: true },
      concurrency: { revisionField: 'revision', ifMatchHeader: true, bodyField: 'expectedRevision', conflictCode: 'REVISION_CONFLICT' },
      dryRun: { queryParameter: 'dryRun=true', bodyField: 'dryRun' },
      idempotency: { header: 'Idempotency-Key', operations: ['createStory', 'bulkUpdateStories'], scope: 'server process', ttlSeconds: 86400 },
      newValues: { bodyField: 'allowNewValues', appliesTo: 'fields whose vocabulary is `open`' },
      errors: Object.entries(ERROR_CODES).map(([code, e]) => ({ code, status: e.status, description: e.description })),
      capabilities: {
        filter: true,
        sort: true,
        pagination: true,
        create: !opts.readOnly,
        update: !opts.readOnly,
        bulkUpdate: !opts.readOnly,
        dryRun: true,
        optimisticConcurrency: true,
        idempotency: true,
        labelOperations: true,
      },
    };
  }

  get(id: string): ApiStory {
    const ws = this.host.get();
    const item = ws.index.get(id);
    if (!item) throw apiError('STORY_NOT_FOUND', `no work item claims the id "${id}"`, { value: id });
    return this.toApiStory(item, ws);
  }

  list(params: Record<string, unknown>): Record<string, unknown> {
    const reserved = ['limit', 'cursor', 'sort', 'order', 'fields'];
    const filter = parseApiFilter(params, reserved);
    const ws = this.host.get();
    const d = this.derive(ws);
    this.checkFilterValues(filter.conditions, d.vocab);

    const one = (name: string): string | undefined => {
      const raw = params[name];
      if (raw === undefined) return undefined;
      if (typeof raw !== 'string') throw apiError('MALFORMED_REQUEST', `query parameter "${name}" must be given once`, { field: name });
      return raw.trim() === '' ? undefined : raw.trim();
    };

    const limitRaw = one('limit');
    const limit = limitRaw === undefined ? LIMITS.defaultPageSize : Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > LIMITS.maxPageSize) {
      throw apiError('INVALID_LIMIT', `limit must be an integer from 1 to ${LIMITS.maxPageSize}`, { field: 'limit', value: limitRaw });
    }
    const sort = one('sort') ?? 'id';
    if (!(SORT_FIELDS as string[]).includes(sort)) {
      throw apiError('INVALID_SORT', `cannot sort by "${sort}"`, { field: 'sort', value: sort, allowedValues: SORT_FIELDS });
    }
    const order = one('order') ?? 'asc';
    if (order !== 'asc' && order !== 'desc') {
      throw apiError('INVALID_SORT', 'order must be asc or desc', { field: 'order', value: order, allowedValues: ['asc', 'desc'] });
    }
    const fieldsRaw = one('fields');
    const projection = fieldsRaw?.split(',').map((f) => f.trim()).filter(Boolean);
    for (const f of projection ?? []) {
      if (!fieldSpec(f)) throw apiError('INVALID_FIELD', `unknown field "${f}" in fields`, { field: 'fields', value: f, allowedValues: FIELD_NAMES });
    }

    const predicate = compileApiFilter(filter, d.membership);
    const keyOf = sortKey(sort, d.vocab);
    const direction = order === 'desc' ? -1 : 1;
    const matched = ws.index.items
      .filter(predicate)
      .map((item) => ({ item, key: keyOf(item) }))
      .sort((a, b) => compareKeys(a.key, b.key) * direction);

    // Independent of parameter order, so reordering the query between pages keeps the cursor valid.
    const conditions = Object.entries(filter.conditions)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([param, c]) => [param, [...(c.in ?? [])].sort(), [...(c.not ?? [])].sort()]);
    const fingerprint = contentRevision(JSON.stringify({ c: conditions, t: filter.text ?? null, s: sort, o: order }));
    let start = 0;
    const cursorRaw = one('cursor');
    if (cursorRaw) {
      const cursor = decodeCursor(cursorRaw);
      if (!cursor || cursor.f !== fingerprint) {
        throw apiError('INVALID_CURSOR', 'the cursor is malformed or was issued for a different filter, sort or order', { field: 'cursor' });
      }
      const at = matched.findIndex((m) => compareKeys(m.key, cursor.k) * direction > 0);
      start = at === -1 ? matched.length : at;
    }
    const page = matched.slice(start, start + limit);
    const more = start + limit < matched.length;
    const items = page.map(({ item }) => {
      const story = this.toApiStory(item, ws);
      if (!projection) return story;
      const out: Record<string, unknown> = { id: story.id };
      for (const f of projection) out[f] = story[f as keyof ApiStory];
      return out;
    });
    return {
      items,
      count: items.length,
      total: matched.length,
      limit,
      sort,
      order,
      nextCursor: more ? encodeCursor({ f: fingerprint, k: page[page.length - 1].key }) : null,
    };
  }

  private checkFilterValues(conditions: Record<string, { in?: string[]; not?: string[] }>, vocab: Vocab): void {
    const allowed: Record<string, string[]> = {
      state: ['active', 'completed'],
      status: vocab.statusesKnown,
      backlogPriority: [...vocab.backlogPrioritiesKnown, NONE],
      milestone: [...vocab.milestones.map((m) => m.id), NONE],
      map: [...vocab.maps.map((m) => m.id), NONE],
      ...(vocab.typesDeclared.length > 0 ? { type: [...vocab.typesKnown, NONE] } : {}),
    };
    for (const [param, condition] of Object.entries(conditions)) {
      const list = allowed[param];
      if (!list) continue;
      for (const value of [...(condition.in ?? []), ...(condition.not ?? [])]) {
        if (!list.includes(value)) {
          throw apiError('INVALID_FILTER', `"${value}" is not a known value for ${param}`, { field: param, value, allowedValues: list });
        }
      }
    }
  }

  // --------------------------------------------------------------- validation

  /**
   * Validates a change set against the field table and the current vocabulary.
   * `mode` decides which fields may appear. Throws with every problem found.
   */
  private parseChanges(input: Record<string, unknown>, mode: 'create' | 'update', ws: Workspace, allowNewValues: boolean): Changes {
    const { vocab } = this.derive(ws);
    const problems: ErrorDetail[] = [];
    const out: Changes = { labelFields: {} };
    const problem = (code: ErrorCode, message: string, extra: Omit<ErrorDetail, 'code' | 'message'> = {}) =>
      problems.push({ code, message, ...extra });

    const writable = FIELD_NAMES.filter((n) => (mode === 'create' ? STORY_FIELDS[n].creatable : STORY_FIELDS[n].writable));

    const text = (field: string, value: unknown, opts: { multiline?: boolean; max?: number } = {}): string | undefined => {
      if (typeof value !== 'string') {
        problem('INVALID_VALUE', `${field} must be a string`, { field, value });
        return undefined;
      }
      if (!opts.multiline) {
        const trimmed = value.trim();
        if (trimmed === '' || /[\r\n]/.test(trimmed)) {
          problem('INVALID_VALUE', `${field} must be a non-empty single line`, { field, value });
          return undefined;
        }
        if (opts.max && trimmed.length > opts.max) {
          problem('INVALID_VALUE', `${field} is longer than ${opts.max} characters`, { field });
          return undefined;
        }
        return trimmed;
      }
      if (Buffer.byteLength(value, 'utf8') > LIMITS.maxBodyBytes) {
        problem('INVALID_VALUE', `${field} is larger than ${LIMITS.maxBodyBytes} bytes`, { field });
        return undefined;
      }
      return value;
    };

    const enumerated = (field: string, value: unknown, allowed: string[], code: ErrorCode): string | undefined => {
      const v = text(field, value);
      if (v === undefined) return undefined;
      if (!allowed.includes(v)) {
        problem(code, `"${v}" is not a valid ${field}`, { field, value: v, allowedValues: allowed });
        return undefined;
      }
      return v;
    };

    const openValue = (field: LabelField, value: unknown): string | undefined => {
      const v = text(field, value);
      if (v === undefined) return undefined;
      const spec = fieldSpec(field)!;
      if (!LABEL_VALUE.test(v)) {
        problem('INVALID_VALUE', `${field} "${v}" may contain only letters, digits and . _ / + -, starting with a letter or digit`, { field, value: v });
        return undefined;
      }
      const known = Object.keys(vocab.counts[field] ?? {}).sort();
      if (!allowNewValues && !known.includes(v)) {
        problem(spec.invalidCode!, `"${v}" is not a known ${field}; send allowNewValues: true to introduce it`, {
          field,
          value: v,
          allowedValues: known,
        });
        return undefined;
      }
      return v;
    };

    const setOps = (field: 'labels' | 'dependencies', value: unknown): SetOps | undefined => {
      const strings = (list: unknown, where: string): string[] | undefined => {
        if (!Array.isArray(list) || list.some((v) => typeof v !== 'string')) {
          problem('INVALID_VALUE', `${where} must be an array of strings`, { field, value: list });
          return undefined;
        }
        return unique((list as string[]).map((v) => v.trim()));
      };
      if (Array.isArray(value)) {
        const replace = strings(value, field);
        return replace && { replace, add: [], remove: [] };
      }
      if (isPlainObject(value)) {
        const extra = Object.keys(value).filter((k) => k !== 'add' && k !== 'remove');
        if (extra.length > 0) {
          problem('INVALID_VALUE', `${field} operations accept only "add" and "remove"`, { field, value: extra, allowedValues: ['add', 'remove'] });
          return undefined;
        }
        const add = value.add === undefined ? [] : strings(value.add, `${field}.add`);
        const remove = value.remove === undefined ? [] : strings(value.remove, `${field}.remove`);
        if (!add || !remove) return undefined;
        const both = add.filter((v) => remove.includes(v));
        if (both.length > 0) {
          problem('CONFLICTING_CHANGES', `${field} both adds and removes ${both.join(', ')}`, { field, value: both });
          return undefined;
        }
        return { add, remove };
      }
      problem('INVALID_VALUE', `${field} must be an array or an object with "add" / "remove"`, { field, value });
      return undefined;
    };

    for (const [key, value] of Object.entries(input)) {
      const spec = fieldSpec(key);
      if (!spec) {
        problem('INVALID_FIELD', `"${key}" is not a story field`, { field: key, allowedValues: writable });
        continue;
      }
      if (!(writable as string[]).includes(key)) {
        const why =
          key === 'id' ? 'ids are allocated by the server' : spec.storage.startsWith('derived') ? spec.storage : 'it is read-only';
        problem('FIELD_NOT_WRITABLE', `${key} cannot be set: ${why}`, { field: key });
        continue;
      }
      if (value === null) {
        if (!spec.nullable) problem('FIELD_NOT_NULLABLE', `${key} cannot be null`, { field: key, value: null });
        else if ((LABEL_FIELDS as string[]).includes(key)) out.labelFields[key as LabelField] = null;
        else (out as unknown as Record<string, unknown>)[key] = null;
        continue;
      }
      switch (key as StoryFieldName) {
        case 'title':
          out.title = text('title', value, { max: LIMITS.maxTitleLength });
          break;
        case 'body':
          out.body = text('body', value, { multiline: true });
          break;
        case 'status':
          out.status = enumerated('status', value, vocab.statusesWritable, 'INVALID_STATUS');
          break;
        case 'type':
          if (vocab.typesDeclared.length > 0) out.type = enumerated('type', value, vocab.typesDeclared, 'INVALID_TYPE');
          else {
            const v = text('type', value);
            if (v !== undefined && !LABEL_VALUE.test(v)) problem('INVALID_VALUE', `type "${v}" has invalid characters`, { field: 'type', value: v });
            else out.type = v;
          }
          break;
        case 'backlogPriority':
          // Backlog.md accepts any case and writes lowercase.
          out.backlogPriority = enumerated(
            'backlogPriority',
            typeof value === 'string' ? value.trim().toLowerCase() : value,
            vocab.backlogPrioritiesWritable,
            'INVALID_BACKLOG_PRIORITY',
          );
          break;
        case 'milestone': {
          const v = text('milestone', value);
          if (v === undefined) break;
          const found = vocab.milestones.find((m) => m.id === v) ?? vocab.milestones.find((m) => m.id.toLowerCase() === v.toLowerCase());
          if (!found) {
            problem('INVALID_MILESTONE', `no milestone has the id "${v}"`, { field: 'milestone', value: v, allowedValues: vocab.milestones.map((m) => m.id) });
          } else out.milestone = found.id;
          break;
        }
        case 'labels': {
          const ops = setOps('labels', value);
          if (!ops) break;
          for (const label of [...(ops.replace ?? []), ...ops.add]) {
            if (label === '' || /[\r\n]/.test(label) || label.length > LIMITS.maxLabelLength) {
              problem('INVALID_LABEL', `label "${label}" must be a non-empty single line of at most ${LIMITS.maxLabelLength} characters`, { field: 'labels', value: label });
              continue;
            }
            const field = labelFieldForNamespace(namespaceOf(label));
            if (field) openValue(field, label.slice(label.indexOf(':') + 1));
          }
          out.labels = ops;
          break;
        }
        case 'dependencies': {
          const ops = setOps('dependencies', value);
          if (!ops) break;
          const resolve = (id: string) => {
            const target = ws.index.get(id);
            if (!target) problem('INVALID_DEPENDENCY', `dependency "${id}" names no existing story`, { field: 'dependencies', value: id });
            return target?.id ?? id;
          };
          out.dependencies = {
            ...(ops.replace ? { replace: unique(ops.replace.map(resolve)) } : {}),
            add: unique(ops.add.map(resolve)),
            remove: ops.remove,
          };
          break;
        }
        default:
          if ((LABEL_FIELDS as string[]).includes(key)) {
            const v = openValue(key as LabelField, value);
            if (v !== undefined) out.labelFields[key as LabelField] = v;
          }
      }
    }

    // A structured field and a label in its namespace must not both be set.
    if (out.labels) {
      for (const label of [...(out.labels.replace ?? []), ...out.labels.add, ...out.labels.remove]) {
        const field = labelFieldForNamespace(namespaceOf(label));
        if (field && field in out.labelFields) {
          problem('CONFLICTING_CHANGES', `"${field}" and the label "${label}" both set the ${fieldSpec(field)!.labelNamespace}: namespace; send one`, {
            field,
            value: label,
          });
        }
      }
    }

    if (mode === 'create' && input.title === undefined) {
      problem('REQUIRED_FIELD', 'title is required to create a story', { field: 'title' });
    }
    if (problems.length > 0) throw validationErrors(problems);
    return out;
  }

  // ----------------------------------------------------------------- planning

  /**
   * The edit a change set makes to one file. Pure: reads nothing, writes
   * nothing. Returns the new bytes and the before/after of every field that
   * actually changes, or the problems that stop it.
   */
  private plan(
    raw: string,
    item: WorkItem,
    changes: Changes,
    stamp: string,
  ): { raw: string; changes: Record<string, FieldChange>; next: WorkItem } | { problems: ErrorDetail[] } {
    const problems: ErrorDetail[] = [];
    const front: Record<string, FrontValue | undefined> = {};

    if (changes.title !== undefined && changes.title !== item.title) front.title = changes.title;
    if (changes.status !== undefined && changes.status !== item.status) front.status = changes.status;
    for (const [field, key] of [['type', 'type'], ['backlogPriority', 'priority'], ['milestone', 'milestone']] as const) {
      const wanted = changes[field];
      if (wanted === undefined) continue;
      const current = item[key];
      if (wanted === null) {
        if (current !== undefined || key in item.frontmatter) front[key] = undefined;
      } else if (wanted !== current) {
        front[key] = wanted;
      }
    }

    // Labels: whole-array replace, then remove, then add, then structured fields.
    const labels = changes.labels?.replace ? [...changes.labels.replace] : [...item.labels];
    const touched = new Set<string>();
    for (const label of changes.labels?.remove ?? []) {
      const at = labels.indexOf(label);
      if (at !== -1) labels.splice(at, 1);
      const ns = namespaceOf(label);
      if (ns) touched.add(ns);
    }
    for (const label of [...(changes.labels?.replace ?? []), ...(changes.labels?.add ?? [])]) {
      const ns = namespaceOf(label);
      if (ns) touched.add(ns);
    }
    for (const label of changes.labels?.add ?? []) {
      if (!labels.includes(label)) insertLabel(labels, label);
    }
    for (const [field, value] of Object.entries(changes.labelFields) as [LabelField, string | null][]) {
      const ns = fieldSpec(field)!.labelNamespace!;
      touched.add(ns);
      const first = labels.findIndex((l) => namespaceOf(l) === ns);
      const kept = labels.filter((l) => namespaceOf(l) !== ns);
      labels.length = 0;
      labels.push(...kept);
      if (value !== null) insertLabel(labels, `${ns}:${value}`, first === -1 ? undefined : first);
    }
    for (const ns of touched) {
      if (!labelFieldForNamespace(ns)) continue;
      const inNs = labels.filter((l) => namespaceOf(l) === ns);
      if (inNs.length > 1) {
        problems.push({
          code: 'CONFLICTING_LABELS',
          message: `the result would carry ${inNs.join(' and ')}; remove one in the same request`,
          field: 'labels',
          value: inNs,
        });
      }
    }
    if (!sameList(labels, item.labels)) front.labels = labels;

    if (changes.dependencies) {
      const deps = changes.dependencies.replace ? [...changes.dependencies.replace] : [...item.dependencies];
      const removed = new Set(changes.dependencies.remove.map(normalizeId));
      const kept = deps.filter((d) => !removed.has(normalizeId(d)));
      for (const dep of changes.dependencies.add) {
        if (!kept.some((d) => normalizeId(d) === normalizeId(dep))) kept.push(dep);
      }
      if (kept.some((d) => normalizeId(d) === normalizeId(item.id))) {
        problems.push({ code: 'INVALID_DEPENDENCY', message: `${item.id} cannot depend on itself`, field: 'dependencies', value: item.id });
      }
      if (!sameList(kept, item.dependencies)) front.dependencies = kept;
    }

    const bodyChanges = changes.body !== undefined && changes.body !== item.body;
    if (problems.length > 0) return { problems };
    if (Object.keys(front).length === 0 && !bodyChanges) return { raw, changes: {}, next: item };

    front.updated_date = stamp;
    let next: string;
    try {
      next = editFrontMatter(raw, front);
      if (bodyChanges) next = replaceDescription(next, changes.body!);
      verifyFrontMatterEdit(raw, next, front);
    } catch (error) {
      if (error instanceof WorkItemWriteError && error.code === 'UNSUPPORTED_BODY_LAYOUT') {
        return { problems: [{ code: 'UNSUPPORTED_BODY_LAYOUT', message: error.message, field: 'body' }] };
      }
      throw error;
    }
    const reparsed = this.parseAt(next, item.sourcePath).item;
    if (!reparsed || (bodyChanges && reparsed.body !== changes.body && reparsed.body !== changes.body!.trim())) {
      throw new WorkItemWriteError('WRITE_VERIFICATION_FAILED', `the edited file for ${item.id} does not read back as intended`);
    }
    return { raw: next, changes: diffFields(item, reparsed), next: reparsed };
  }

  // ---------------------------------------------------------------- mutations

  /**
   * Parses a file as the workspace reader would: `completed/` archives it, and a
   * configured terminal status completes it wherever it lives, so an edited
   * status reads back with the state it now implies.
   */
  private parseAt(raw: string, sourcePath: string): ReturnType<typeof parseWorkItem> {
    const archived = sourcePath.startsWith(join(this.project.backlogDirectory, 'completed') + sep);
    return parseWorkItem(raw, sourcePath, archived, this.project.completedStatuses);
  }

  private readCurrent(id: string): { ws: Workspace; item: WorkItem; path: string; raw: string } {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const ws = this.host.get();
      const cached = ws.index.get(id);
      if (!cached) break;
      const path = join(this.project.root, cached.sourcePath);
      let raw: string;
      try {
        raw = readFileSync(path, 'utf8');
      } catch {
        this.host.invalidate(); // renamed or removed since the last read
        continue;
      }
      const item = this.parseAt(raw, cached.sourcePath).item;
      if (item && normalizeId(item.id) === normalizeId(cached.id)) return { ws, item, path, raw };
      this.host.invalidate();
    }
    throw apiError('STORY_NOT_FOUND', `no work item claims the id "${id}"`, { value: id });
  }

  private splitControl(body: unknown, allowed: readonly string[]): { fields: Record<string, unknown>; control: Record<string, unknown> } {
    if (!isPlainObject(body)) throw apiError('MALFORMED_REQUEST', 'the request body must be a JSON object');
    const fields: Record<string, unknown> = {};
    const control: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body)) {
      if (allowed.includes(key)) control[key] = value;
      else fields[key] = value;
    }
    for (const key of ['allowNewValues', 'dryRun'] as const) {
      if (control[key] !== undefined && typeof control[key] !== 'boolean') {
        throw apiError('MALFORMED_REQUEST', `${key} must be a boolean`, { field: key, value: control[key] });
      }
    }
    if (control.expectedRevision !== undefined && typeof control.expectedRevision !== 'string') {
      throw apiError('MALFORMED_REQUEST', 'expectedRevision must be a string', { field: 'expectedRevision', value: control.expectedRevision });
    }
    return { fields, control };
  }

  /** Runs a mutation: under the backlog lock when it writes, and with writer failures as API errors either way. */
  private mutate<T>(dryRun: boolean, fn: () => T): T {
    try {
      return dryRun ? fn() : withBacklogLock(join(this.project.root, this.project.backlogDirectory), fn);
    } catch (error) {
      throw translateWriteError(error);
    }
  }

  /** PATCH: change some fields of one story. */
  patch(id: string, body: unknown, opts: { ifMatch?: string; dryRun?: boolean } = {}): MutationResult {
    const { fields, control } = this.splitControl(body, CONTROL_KEYS);
    const expected = reconcileRevision(opts.ifMatch, control.expectedRevision as string | undefined);
    const dryRun = Boolean(opts.dryRun || control.dryRun);
    if (Object.keys(fields).length === 0) {
      throw apiError('VALIDATION_ERROR', 'the request names no fields to change', { allowedValues: FIELD_NAMES.filter((n) => STORY_FIELDS[n].writable) });
    }
    const run = (): MutationResult => {
      const current = this.readCurrent(id);
      const changes = this.parseChanges(fields, 'update', current.ws, Boolean(control.allowNewValues));
      const revision = contentRevision(current.raw);
      if (expected !== undefined && expected !== revision) throw conflict(current.item.id, expected, revision);
      const planned = this.plan(current.raw, current.item, changes, backlogTimestamp(this.now()));
      if ('problems' in planned) throw validationErrors(planned.problems);
      const changed = Object.keys(planned.changes).length > 0;
      if (dryRun || !changed) {
        return { dryRun, changed, changes: planned.changes, previousRevision: revision, story: this.toApiStory(planned.next, current.ws, planned.raw) };
      }
      if (!replaceFileAtomic(current.path, planned.raw, current.raw)) {
        throw conflict(current.item.id, revision, contentRevision(readFileSync(current.path, 'utf8')));
      }
      this.host.invalidate();
      return { dryRun, changed, changes: planned.changes, previousRevision: revision, story: this.get(current.item.id) };
    };
    return this.mutate(dryRun, run);
  }

  /** Change the same fields on many stories: all of them, or none. */
  bulkUpdate(body: unknown, opts: { dryRun?: boolean } = {}): Record<string, unknown> {
    if (!isPlainObject(body)) throw apiError('MALFORMED_REQUEST', 'the request body must be a JSON object');
    const allowedKeys = ['ids', 'changes', 'expectedRevisions', 'allowNewValues', 'dryRun'];
    for (const key of Object.keys(body)) {
      if (!allowedKeys.includes(key)) {
        throw apiError('INVALID_FIELD', `"${key}" is not a bulk-update key; field changes go inside "changes"`, { field: key, allowedValues: allowedKeys });
      }
    }
    const { ids, changes: rawChanges, expectedRevisions = {}, allowNewValues, dryRun: bodyDryRun } = body;
    if (!Array.isArray(ids) || ids.length === 0 || ids.some((v) => typeof v !== 'string' || v.trim() === '')) {
      throw apiError('MALFORMED_REQUEST', 'ids must be a non-empty array of story ids', { field: 'ids', value: ids });
    }
    if (ids.length > LIMITS.maxBulkIds) {
      throw apiError('BULK_LIMIT_EXCEEDED', `a bulk update may name at most ${LIMITS.maxBulkIds} stories`, { field: 'ids', value: ids.length, limit: LIMITS.maxBulkIds });
    }
    const keys = (ids as string[]).map(normalizeId);
    const duplicates = unique(keys.filter((k, i) => keys.indexOf(k) !== i));
    if (duplicates.length > 0) throw apiError('DUPLICATE_IDS', `ids names ${duplicates.join(', ')} more than once`, { field: 'ids', value: duplicates });
    if (!isPlainObject(rawChanges) || Object.keys(rawChanges).length === 0) {
      throw apiError('MALFORMED_REQUEST', 'changes must be a non-empty object of field values', { field: 'changes', value: rawChanges });
    }
    if (!isPlainObject(expectedRevisions) || Object.values(expectedRevisions).some((v) => typeof v !== 'string')) {
      throw apiError('MALFORMED_REQUEST', 'expectedRevisions must map story ids to revision strings', { field: 'expectedRevisions' });
    }
    for (const [key, value] of [['allowNewValues', allowNewValues], ['dryRun', bodyDryRun]] as const) {
      if (value !== undefined && typeof value !== 'boolean') throw apiError('MALFORMED_REQUEST', `${key} must be a boolean`, { field: key, value });
    }
    const expectedByKey = new Map(Object.entries(expectedRevisions as Record<string, string>).map(([k, v]) => [normalizeId(k), v]));
    const dryRun = Boolean(opts.dryRun || bodyDryRun);

    const run = () => {
      const ws = this.host.get();
      const changes = this.parseChanges(rawChanges, 'update', ws, Boolean(allowNewValues));
      const stamp = backlogTimestamp(this.now());
      const planned: { id: string; path?: string; raw?: string; next?: string; result: BulkItemResult; item?: WorkItem }[] = [];
      for (const id of ids as string[]) {
        let current;
        try {
          current = this.readCurrent(id);
        } catch (error) {
          if (!(error instanceof ApiError)) throw error;
          planned.push({ id, result: { id, ok: false, error: error.detail } });
          continue;
        }
        const revision = contentRevision(current.raw);
        const expected = expectedByKey.get(normalizeId(id));
        if (expected !== undefined && expected !== revision) {
          const e = conflict(current.item.id, expected, revision);
          planned.push({ id, result: { id: current.item.id, ok: false, error: e.detail } });
          continue;
        }
        const plan = this.plan(current.raw, current.item, changes, stamp);
        if ('problems' in plan) {
          planned.push({
            id,
            result: { id: current.item.id, ok: false, error: plan.problems[0], ...(plan.problems.length > 1 ? { errors: plan.problems } : {}) },
          });
          continue;
        }
        const changed = Object.keys(plan.changes).length > 0;
        planned.push({
          id,
          path: current.path,
          raw: current.raw,
          next: plan.raw,
          item: plan.next,
          result: { id: current.item.id, ok: true, changed, changes: plan.changes, previousRevision: revision, revision: contentRevision(plan.raw) },
        });
      }

      const failed = planned.filter((p) => !p.result.ok);
      const changedCount = planned.filter((p) => p.result.changed).length;
      const summary = {
        dryRun,
        atomic: true,
        requested: ids.length,
        matched: planned.filter((p) => p.result.error?.code !== 'STORY_NOT_FOUND').length,
      };
      if (failed.length > 0) {
        const conflictOnly = failed.every((p) => p.result.error?.code === 'REVISION_CONFLICT');
        throw new ApiError(
          {
            code: conflictOnly ? 'REVISION_CONFLICT' : 'BULK_VALIDATION_FAILED',
            message: `${failed.length} of ${ids.length} stories cannot take these changes; nothing was written`,
          },
          { ...summary, succeeded: 0, valid: planned.length - failed.length, failed: failed.length, results: planned.map((p) => p.result) },
        );
      }

      if (!dryRun) {
        const written: typeof planned = [];
        try {
          for (const p of planned) {
            if (!p.result.changed) continue;
            if (!replaceFileAtomic(p.path!, p.next!, p.raw!)) {
              throw conflict(p.result.id, p.result.previousRevision!, contentRevision(readFileSync(p.path!, 'utf8')));
            }
            written.push(p);
          }
        } catch (error) {
          for (const p of written.reverse()) replaceFileAtomic(p.path!, p.raw!);
          this.host.invalidate();
          throw error;
        }
        this.host.invalidate();
      }

      const after = dryRun ? ws : this.host.get();
      const aggregate: Record<string, { from: unknown[]; to: unknown[] }> = {};
      for (const p of planned) {
        p.result.story = dryRun ? this.toApiStory(p.item!, ws, p.next) : this.toApiStory(after.index.get(p.result.id)!, after);
        for (const [field, change] of Object.entries(p.result.changes ?? {})) {
          const entry = (aggregate[field] ??= { from: [], to: [] });
          for (const [slot, value] of [['from', change.from], ['to', change.to]] as const) {
            if (!entry[slot].some((v) => JSON.stringify(v) === JSON.stringify(value))) entry[slot].push(value);
          }
        }
      }
      return {
        ...summary,
        succeeded: planned.length,
        failed: 0,
        changed: changedCount,
        ...(dryRun ? { wouldChange: changedCount } : {}),
        unchanged: planned.length - changedCount,
        changes: aggregate,
        results: planned.map((p) => p.result),
      };
    };
    return this.mutate(dryRun, run);
  }

  /** POST: create a story with a server-allocated id. */
  create(body: unknown, opts: { dryRun?: boolean } = {}): { dryRun: boolean; story: ApiStory } {
    const { fields, control } = this.splitControl(body, ['allowNewValues', 'dryRun']);
    const dryRun = Boolean(opts.dryRun || control.dryRun);
    const run = () => {
      const ws = this.host.get();
      const changes = this.parseChanges(fields, 'create', ws, Boolean(control.allowNewValues));
      const conv = this.conventions.get();
      const { vocab } = this.derive(ws);

      const labels: string[] = [...(changes.labels?.replace ?? []), ...(changes.labels?.add ?? [])];
      for (const [field, value] of Object.entries(changes.labelFields) as [LabelField, string | null][]) {
        if (value !== null) insertLabel(labels, `${fieldSpec(field)!.labelNamespace}:${value}`);
      }
      const problems: ErrorDetail[] = [];
      for (const ns of unique(labels.map(namespaceOf).filter((n): n is string => Boolean(labelFieldForNamespace(n))))) {
        const inNs = labels.filter((l) => namespaceOf(l) === ns);
        if (inNs.length > 1) problems.push({ code: 'CONFLICTING_LABELS', message: `a story cannot carry ${inNs.join(' and ')}`, field: 'labels', value: inNs });
      }
      if (problems.length > 0) throw validationErrors(problems);

      const id = this.allocateId(ws, conv);
      const status = changes.status ?? conv.defaultStatus ?? vocab.statusesWritable[0] ?? BACKLOG_MD_DEFAULT_STATUSES[0];
      const content = renderNewWorkItem({
        id,
        title: changes.title!,
        status,
        createdDate: backlogTimestamp(this.now()),
        labels: unique(labels),
        ...(changes.milestone ? { milestone: changes.milestone } : {}),
        dependencies: unique([...(changes.dependencies?.replace ?? []), ...(changes.dependencies?.add ?? [])]),
        ...(changes.backlogPriority ? { priority: changes.backlogPriority } : {}),
        ...(changes.type ? { type: changes.type } : {}),
        body: changes.body ?? '',
        definitionOfDone: conv.definitionOfDone,
      });
      const relPath = join(this.project.backlogDirectory, 'tasks', workItemFileName(id, changes.title!));
      const parsed = this.parseAt(content, relPath);
      if (!parsed.item || parsed.problems.length > 0 || parsed.item.id !== id || parsed.item.title !== changes.title) {
        throw new WorkItemWriteError('WRITE_VERIFICATION_FAILED', 'the new work item does not read back as intended');
      }
      if (dryRun) return { dryRun, story: this.toApiStory(parsed.item, ws, content) };
      createFileExclusive(join(this.project.root, relPath), content);
      this.host.invalidate();
      return { dryRun, story: this.get(id) };
    };
    return this.mutate(dryRun, run);
  }

  /**
   * The next free id: one past the highest number in use under the project's
   * prefix, counting archived and draft files Backlog.md also numbers.
   */
  private allocateId(ws: Workspace, conv: BacklogConventions): string {
    const numbered = ws.index.items.map((i) => /^(.*)-(\d+)$/.exec(i.id)).filter((m): m is RegExpExecArray => Boolean(m));
    let prefix = conv.taskPrefix?.toUpperCase();
    if (!prefix) {
      const byPrefix = new Map<string, number>();
      for (const m of numbered) byPrefix.set(m[1].toUpperCase(), (byPrefix.get(m[1].toUpperCase()) ?? 0) + 1);
      prefix = [...byPrefix.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? 'TASK';
    }
    let max = 0;
    let widest = 0;
    const consider = (candidate: string) => {
      const m = /^(.*)-(\d+)$/.exec(candidate.trim());
      if (!m || m[1].toUpperCase() !== prefix) return;
      max = Math.max(max, Number(m[2]));
      if (m[2].startsWith('0')) widest = Math.max(widest, m[2].length);
    };
    for (const item of ws.index.items) consider(item.id);
    const backlog = join(this.project.root, this.project.backlogDirectory);
    for (const dir of ['tasks', 'completed', 'drafts', join('archive', 'tasks'), join('archive', 'drafts')]) {
      const abs = join(backlog, dir);
      if (!existsSync(abs)) continue;
      for (const name of readdirSync(abs)) {
        const m = /^([^\s]+?)\s+-\s/.exec(name) ?? /^([^\s]+)\.md$/.exec(name);
        if (m) consider(m[1]);
      }
    }
    const width = conv.zeroPaddedIds ?? widest;
    return `${prefix}-${String(max + 1).padStart(width, '0')}`;
  }
}

// -------------------------------------------------------------------- helpers

export const OPERATIONS = [
  { name: 'discover', method: 'GET', path: '/api/v1/storymap', description: 'Links to everything else.' },
  { name: 'getMeta', method: 'GET', path: '/api/v1/storymap/meta', description: 'Fields, valid values, limits and error codes.' },
  { name: 'getOpenApi', method: 'GET', path: '/api/v1/storymap/openapi.json', description: 'OpenAPI 3.1 document.' },
  { name: 'listStories', method: 'GET', path: '/api/v1/storymap/stories', description: 'Filter, sort and page stories.' },
  { name: 'getStory', method: 'GET', path: '/api/v1/storymap/stories/{id}', description: 'One story.' },
  { name: 'createStory', method: 'POST', path: '/api/v1/storymap/stories', description: 'Create a story; the id is allocated.' },
  { name: 'updateStory', method: 'PATCH', path: '/api/v1/storymap/stories/{id}', description: 'Change some fields of one story.' },
  { name: 'bulkUpdateStories', method: 'POST', path: '/api/v1/storymap/stories/bulk-update', description: 'Change the same fields on many stories, atomically.' },
];

function diffFields(before: WorkItem, after: WorkItem): Record<string, FieldChange> {
  const out: Record<string, FieldChange> = {};
  for (const field of FIELD_NAMES.filter((n) => STORY_FIELDS[n].writable)) {
    const from = itemValue(before, field);
    const to = itemValue(after, field);
    if (JSON.stringify(from) !== JSON.stringify(to)) out[field] = { from, to };
  }
  return out;
}

function conflict(id: string, expected: string, current: string): ApiError {
  return apiError('REVISION_CONFLICT', `${id} changed since revision ${expected}; fetch it again and reapply your change`, {
    field: 'revision',
    id,
    expectedRevision: expected,
    currentRevision: current,
  });
}

/** `If-Match: "abc"`, `W/"abc"`, `abc` or `*`, reconciled with a body `expectedRevision`. */
export function reconcileRevision(ifMatch: string | undefined, bodyRevision: string | undefined): string | undefined {
  let header: string | undefined;
  if (ifMatch !== undefined && ifMatch.trim() !== '' && ifMatch.trim() !== '*') {
    header = ifMatch.trim().replace(/^W\//, '').replace(/^"(.*)"$/, '$1');
  }
  if (header !== undefined && bodyRevision !== undefined && header !== bodyRevision) {
    throw apiError('MALFORMED_REQUEST', 'If-Match and expectedRevision name different revisions', { field: 'expectedRevision' });
  }
  return header ?? bodyRevision;
}

function translateWriteError(error: unknown): unknown {
  if (!(error instanceof WorkItemWriteError)) return error;
  switch (error.code) {
    case 'WRITE_LOCK_TIMEOUT':
      return apiError('WRITE_LOCK_TIMEOUT', error.message);
    case 'UNSUPPORTED_BODY_LAYOUT':
      return apiError('UNSUPPORTED_BODY_LAYOUT', error.message, { field: 'body' });
    case 'FILE_EXISTS':
      return apiError('INTERNAL_ERROR', `id allocation collided with an existing file: ${error.message}`);
    default:
      return apiError('WRITE_VERIFICATION_FAILED', error.message);
  }
}

// ----------------------------------------------------------------- sort + page

type KeyPart = string | number | null;

const PRIORITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

function idKey(id: string): KeyPart[] {
  const m = /^(.*?)-(\d+)$/.exec(id.toUpperCase());
  return m ? [0, m[1], Number(m[2]), id.toUpperCase()] : [1, id.toUpperCase(), 0, id.toUpperCase()];
}

function sortKey(sort: string, vocab: Vocab): (item: WorkItem) => KeyPart[] {
  const primary = (item: WorkItem): KeyPart[] => {
    switch (sort) {
      case 'id':
        return [];
      case 'title':
        return [item.title.toLowerCase()];
      case 'state':
        return [item.completed ? 1 : 0];
      case 'status': {
        const rank = vocab.statusesKnown.indexOf(item.status);
        return [rank === -1 ? vocab.statusesKnown.length : rank, item.status];
      }
      case 'backlogPriority':
        return item.priority === undefined ? [null, null] : [PRIORITY_RANK[item.priority.toLowerCase()] ?? 3, item.priority];
      case 'createdAt':
        return [isoDate(item.createdDate)];
      case 'updatedAt':
        return [isoDate(item.updatedDate)];
      default:
        return [(itemValue(item, sort) as string | null) ?? null];
    }
  };
  return (item) => [...primary(item), ...idKey(item.id)];
}

function compareKeys(a: readonly KeyPart[], b: readonly KeyPart[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] ?? null;
    const y = b[i] ?? null;
    if (x === y) continue;
    if (x === null) return 1;
    if (y === null) return -1;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    const sx = String(x);
    const sy = String(y);
    if (sx !== sy) return sx < sy ? -1 : 1;
  }
  return 0;
}

function encodeCursor(cursor: { f: string; k: KeyPart[] }): string {
  return Buffer.from(JSON.stringify({ v: 1, ...cursor }), 'utf8').toString('base64url');
}

function decodeCursor(raw: string): { f: string; k: KeyPart[] } | undefined {
  try {
    const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (value?.v !== 1 || typeof value.f !== 'string' || !Array.isArray(value.k)) return undefined;
    if (value.k.some((p: unknown) => p !== null && typeof p !== 'string' && typeof p !== 'number')) return undefined;
    return { f: value.f, k: value.k };
  } catch {
    return undefined;
  }
}
