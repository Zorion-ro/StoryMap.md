import type { WorkItem } from './types';
import { normalizeId } from './work-item-index';

/**
 * The Stories filter model: a free-text search plus, per categorical field, a
 * set of values that is either included or excluded.
 *
 *   status IN [Backlog, Ready]        values inside one field are ORed
 *   owner NOT IN [platform, backend]  exclusion is NOT IN, and may name several
 *   status ... AND owner ...          different fields are ANDed
 *
 * A field with no values places no restriction, whatever its operator.
 *
 * In a URL each field is its repeated parameter, with an optional `<field>.op`:
 *
 *   ?status=Backlog&status=Ready          status IN [Backlog, Ready]
 *   ?status=Done&status.op=not            status NOT IN [Done]
 *
 * so every single-value URL written before this model existed (`?status=Done`,
 * `?map=none`, `?milestone=m-1`) still means exactly what it meant.
 */

export const FILTER_FIELDS = ['state', 'status', 'wstatus', 'area', 'owner', 'priority', 'wtype', 'map', 'milestone'] as const;
export type FilterField = (typeof FILTER_FIELDS)[number];

export type FilterOp = 'in' | 'not';

export interface FieldFilter {
  op: FilterOp;
  /** Distinct, non-empty values in the order they were given. */
  values: string[];
}

export interface StoryQuery {
  text?: string;
  fields: Partial<Record<FilterField, FieldFilter>>;
}

/**
 * The value a filter uses to mean "this field is empty": a story on no map, in
 * no milestone, or carrying no label in the namespace. `state` and `status`
 * always have a value, so for them it simply matches nothing.
 */
export const NONE = 'none';

/** Backlog.md's own three priorities, which old `?priority=high` URLs name. */
const NATIVE_PRIORITIES = new Set(['high', 'medium', 'low']);

type ParamSource = URLSearchParams | Record<string, unknown>;

function paramValues(source: ParamSource, key: string): string[] {
  const raw: unknown[] =
    source instanceof URLSearchParams
      ? source.getAll(key)
      : Array.isArray(source[key])
        ? (source[key] as unknown[])
        : source[key] === undefined
          ? []
          : [source[key]];
  const out: string[] = [];
  for (const value of raw) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

/**
 * Reads a query from URL parameters, as Express or `URLSearchParams` hand them
 * over. Unknown parameters are ignored; an empty value (`?status=`, what the old
 * "all" option submitted) is no value; an unrecognised operator is inclusion.
 */
export function parseStoryQuery(source: ParamSource): StoryQuery {
  const query: StoryQuery = { fields: {} };
  const text = paramValues(source, 'text')[0];
  if (text) query.text = text;
  for (const field of FILTER_FIELDS) {
    const values = paramValues(source, field);
    if (values.length === 0) continue;
    const op: FilterOp = paramValues(source, `${field}.op`).includes('not') ? 'not' : 'in';
    query.fields[field] = { op, values };
  }
  return query;
}

/**
 * The canonical parameter list for a query — fields in {@link FILTER_FIELDS}
 * order, `.op` only when it is `not` — so one filter always has one URL.
 */
export function storyQueryParams(query: StoryQuery): [string, string][] {
  const out: [string, string][] = [];
  if (query.text) out.push(['text', query.text]);
  for (const field of FILTER_FIELDS) {
    const f = query.fields[field];
    if (!f || f.values.length === 0) continue;
    for (const value of f.values) out.push([field, value]);
    if (f.op === 'not') out.push([`${field}.op`, 'not']);
  }
  return out;
}

/** `?a=1&b=2`, or the empty string for an unrestricted query. */
export function serializeStoryQuery(query: StoryQuery, extra: [string, string][] = []): string {
  const parts = [...storyQueryParams(query), ...extra].map(
    ([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`,
  );
  return parts.length ? `?${parts.join('&')}` : '';
}

export function isEmptyStoryQuery(query: StoryQuery): boolean {
  return !query.text && FILTER_FIELDS.every((f) => !query.fields[f]?.values.length);
}

/** One field restricted to exactly these values; convenient for links. */
export function fieldQuery(field: FilterField, values: string[], op: FilterOp = 'in'): StoryQuery {
  return { fields: { [field]: { op, values } } };
}

/**
 * Whether one value of a field filter describes this story. Map membership is
 * a set, so a story "is" every map that places or references it.
 */
function valueMatches(
  item: WorkItem,
  field: FilterField,
  value: string,
  mapMembership?: Map<string, Set<string>>,
): boolean {
  const optional = (actual: string | undefined) => (value === NONE ? !actual : actual === value);
  switch (field) {
    case 'state':
      return value === 'active' ? !item.completed : value === 'completed' ? item.completed : false;
    case 'status':
      return item.status === value;
    case 'wstatus':
      return optional(item.wstatus);
    case 'area':
      return optional(item.area);
    case 'owner':
      return optional(item.owner);
    case 'wtype':
      return optional(item.wtype);
    case 'priority': {
      // `priority` is the project's `priority:` label scale — what the Pri
      // column shows. A Backlog.md word (high/medium/low) also still matches
      // the native front-matter field, so `?priority=high` keeps working.
      if (value === NONE) return !item.priorityLabel;
      const wanted = value.toLowerCase();
      if ((item.priorityLabel ?? '').toLowerCase() === wanted) return true;
      return NATIVE_PRIORITIES.has(wanted) && (item.priority ?? '').toLowerCase() === wanted;
    }
    case 'milestone':
      return optional(item.milestone);
    case 'map': {
      const maps = mapMembership?.get(normalizeId(item.id));
      return value === NONE ? !maps || maps.size === 0 : Boolean(maps?.has(value));
    }
  }
}

export function matchesStoryQuery(
  item: WorkItem,
  query: StoryQuery,
  mapMembership?: Map<string, Set<string>>,
): boolean {
  for (const field of FILTER_FIELDS) {
    const f = query.fields[field];
    if (!f || f.values.length === 0) continue;
    // Without membership there is nothing to test a map against; the filter
    // is skipped rather than excluding everything.
    if (field === 'map' && !mapMembership) continue;
    const hit = f.values.some((v) => valueMatches(item, field, v, mapMembership));
    if (f.op === 'in' ? !hit : hit) return false;
  }
  if (query.text) {
    const needle = query.text.toLowerCase();
    const haystack = `${item.id}\n${item.title}\n${item.labels.join(' ')}\n${item.body}`.toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

/** Human wording for one field filter: `status is not Done, Cancelled`. */
export function describeFieldFilter(field: FilterField, f: FieldFilter): string {
  return `${field} ${f.op === 'not' ? 'is not' : 'is'} ${f.values.join(', ')}`;
}
