import { FILTER_FIELDS, NONE, matchesStoryQuery, normalizeId } from '../core';
import type { FieldFilter, FilterField, StoryQuery, WorkItem } from '../core';
import { apiError } from './errors';
import { FIELD_NAMES, fieldSpec } from './fields';

/**
 * The list endpoint's filters, on top of the Storymap query model.
 *
 *   <param>=a,b        IN (a, b)       — values within one parameter are ORed
 *   <param>_not=a,b    NOT IN (a, b)
 *   different params   AND
 *   none               the field has no value (as in the browser's `?map=none`)
 *
 * Fields the browser filters on are matched by `matchesStoryQuery` itself, so a
 * filter means the same thing on the page and in the API. The API adds fields
 * the page has no control for: id, type, backlogPriority, risk, label and
 * dependency.
 */

export interface Condition {
  in?: string[];
  not?: string[];
}

export interface ApiFilter {
  text?: string;
  conditions: Record<string, Condition>;
}

/** Filter parameter -> story field it filters, from the field table. */
export const FILTER_PARAMS: Record<string, string> = Object.fromEntries(
  FIELD_NAMES.filter((n) => fieldSpec(n)!.filter).map((n) => [fieldSpec(n)!.filter!, n]),
);

export const TEXT_PARAMS = ['text', 'q'] as const;

/** Filters the browser has too, matched by the browser's own code. */
const SHARED = new Set<string>(FILTER_FIELDS);

function listValues(raw: unknown, param: string): string[] {
  const parts = Array.isArray(raw) ? raw : [raw];
  const out: string[] = [];
  for (const part of parts) {
    if (typeof part !== 'string') {
      throw apiError('INVALID_FILTER', `query parameter "${param}" must be a string`, { field: param, value: part });
    }
    for (const value of part.split(',')) {
      const trimmed = value.trim();
      if (trimmed && !out.includes(trimmed)) out.push(trimmed);
    }
  }
  return out;
}

/** Reads filter parameters; throws INVALID_FILTER for any parameter it does not know. */
export function parseApiFilter(params: Record<string, unknown>, reserved: readonly string[]): ApiFilter {
  const filter: ApiFilter = { conditions: {} };
  for (const [param, raw] of Object.entries(params)) {
    if (reserved.includes(param)) continue;
    if ((TEXT_PARAMS as readonly string[]).includes(param)) {
      const text = listValues(raw, param).join(',');
      if (text) filter.text = filter.text ? `${filter.text} ${text}` : text;
      continue;
    }
    const negated = param.endsWith('_not');
    const base = negated ? param.slice(0, -4) : param;
    if (!(base in FILTER_PARAMS)) {
      const allowed = [...Object.keys(FILTER_PARAMS).flatMap((p) => [p, `${p}_not`]), ...TEXT_PARAMS, ...reserved];
      throw apiError('INVALID_FILTER', `unknown query parameter "${param}"`, { field: param, allowedValues: allowed });
    }
    const values = listValues(raw, param);
    if (values.length === 0) continue;
    const condition = (filter.conditions[base] ??= {});
    const slot = negated ? 'not' : 'in';
    condition[slot] = [...(condition[slot] ?? []), ...values];
  }
  return filter;
}

function single(item: WorkItem, param: string): string | undefined {
  switch (param) {
    case 'id':
      return normalizeId(item.id);
    case 'type':
      return item.type;
    case 'backlogPriority':
      return item.priority;
    case 'risk':
      return item.risk;
    default:
      return undefined;
  }
}

function valuesOf(item: WorkItem, param: string): string[] {
  if (param === 'label') return item.labels;
  if (param === 'dependency') return item.dependencies.map(normalizeId);
  const value = single(item, param);
  return value === undefined || value === '' ? [] : [value];
}

function normalizeWanted(param: string, value: string): string {
  return (param === 'id' || param === 'dependency') && value !== NONE ? normalizeId(value) : value;
}

function hits(item: WorkItem, param: string, wanted: string[]): boolean {
  const values = valuesOf(item, param);
  return wanted.some((w) => (w === NONE ? values.length === 0 : values.includes(normalizeWanted(param, w))));
}

/**
 * Compiles the filter to a predicate. `membership` is the story -> map ids
 * index the browser uses for its own map filter.
 */
export function compileApiFilter(filter: ApiFilter, membership: Map<string, Set<string>>): (item: WorkItem) => boolean {
  const shared: StoryQuery = { fields: {}, ...(filter.text ? { text: filter.text } : {}) };
  const local: [string, Condition][] = [];
  for (const [param, condition] of Object.entries(filter.conditions)) {
    if (!SHARED.has(param)) {
      local.push([param, condition]);
      continue;
    }
    // The browser model holds one operator per field. IN a AND NOT IN b is IN (a minus b).
    let field: FieldFilter | undefined;
    if (condition.in && condition.in.length > 0) {
      const refused = new Set(condition.not ?? []);
      field = { op: 'in', values: condition.in.filter((v) => !refused.has(v)) };
      if (field.values.length === 0) return () => false;
    } else if (condition.not && condition.not.length > 0) {
      field = { op: 'not', values: condition.not };
    }
    if (field) shared.fields[param as FilterField] = field;
  }
  return (item) => {
    if (!matchesStoryQuery(item, shared, membership)) return false;
    for (const [param, condition] of local) {
      if (condition.in && condition.in.length > 0 && !hits(item, param, condition.in)) return false;
      if (condition.not && condition.not.length > 0 && hits(item, param, condition.not)) return false;
    }
    return true;
  };
}
