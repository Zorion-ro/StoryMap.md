import type { WorkItem } from './types';
import type { Workspace } from './workspace';
import { primaryIds, supportingIds } from './resolver';
import { normalizeId } from './work-item-index';
import { FILTER_FIELDS, matchesStoryQuery } from './story-query';
import type { StoryQuery } from './story-query';

/**
 * The original one-value-per-field filter, kept for library callers. It is a
 * shorthand for a {@link StoryQuery} in which every field is `IN [value]`.
 */
export interface StoryFilter {
  text?: string;
  status?: string;
  /** 'active' | 'completed' | undefined for both. */
  state?: string;
  area?: string;
  owner?: string;
  /** A `priority:` label value, or one of Backlog.md's high | medium | low. */
  priority?: string;
  wstatus?: string;
  wtype?: string;
  /** Map id, or the literal 'none' for stories no map places. */
  map?: string;
  /** Milestone id, or the literal 'none' for unassigned stories. */
  milestone?: string;
}

export function storyFilterToQuery(filter: StoryFilter): StoryQuery {
  const query: StoryQuery = { fields: {} };
  if (filter.text) query.text = filter.text;
  for (const field of FILTER_FIELDS) {
    const value = filter[field];
    if (value) query.fields[field] = { op: 'in', values: [value] };
  }
  return query;
}

function isStoryQuery(filter: StoryFilter | StoryQuery): filter is StoryQuery {
  return typeof (filter as StoryQuery).fields === 'object';
}

export function matches(
  item: WorkItem,
  filter: StoryFilter | StoryQuery,
  mapMembership?: Map<string, Set<string>>,
): boolean {
  return matchesStoryQuery(item, isStoryQuery(filter) ? filter : storyFilterToQuery(filter), mapMembership);
}

export function filterStories(
  workspace: Workspace,
  filter: StoryFilter | StoryQuery,
  mapMembership?: Map<string, Set<string>>,
): WorkItem[] {
  return workspace.index.items.filter((item) => matches(item, filter, mapMembership));
}

/** `normalizedStoryId -> set of map ids that place or reference it`. */
export function buildMapMembership(workspace: Workspace): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const map of workspace.maps) {
    for (const id of [...primaryIds(map), ...supportingIds(map)]) {
      const key = normalizeId(id);
      const set = out.get(key) ?? new Set<string>();
      set.add(map.id);
      out.set(key, set);
    }
  }
  return out;
}

/** `normalizedStoryId -> set of map ids that place it as primary`. */
export function buildPrimaryMembership(workspace: Workspace): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const map of workspace.maps) {
    for (const id of primaryIds(map)) {
      const key = normalizeId(id);
      const set = out.get(key) ?? new Set<string>();
      set.add(map.id);
      out.set(key, set);
    }
  }
  return out;
}

export interface Facet {
  value: string;
  count: number;
}

function facet(items: readonly WorkItem[], pick: (i: WorkItem) => string | undefined): Facet[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    const value = pick(item);
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

export interface Facets {
  milestone: Facet[];
  status: Facet[];
  area: Facet[];
  owner: Facet[];
  priority: Facet[];
  wstatus: Facet[];
  wtype: Facet[];
}

export function facets(items: readonly WorkItem[]): Facets {
  return {
    milestone: facet(items, (i) => i.milestone),
    status: facet(items, (i) => i.status),
    area: facet(items, (i) => i.area),
    owner: facet(items, (i) => i.owner),
    // The `priority:` label scale, which is what the `priority` filter selects.
    priority: facet(items, (i) => i.priorityLabel),
    wstatus: facet(items, (i) => i.wstatus),
    wtype: facet(items, (i) => i.wtype),
  };
}

export interface CriteriaSummary {
  total: number;
  checked: number;
  /** Which block the criteria came from; some projects keep them in the body. */
  source: 'native' | 'body' | 'none';
}

export function criteriaSummary(item: WorkItem): CriteriaSummary {
  if (item.acceptanceCriteria.length > 0) {
    return {
      total: item.acceptanceCriteria.length,
      checked: item.acceptanceCriteria.filter((c) => c.checked).length,
      source: 'native',
    };
  }
  if (item.bodyAcceptanceCriteria.length > 0) {
    return {
      total: item.bodyAcceptanceCriteria.length,
      checked: item.bodyAcceptanceCriteria.filter((c) => c.checked).length,
      source: 'body',
    };
  }
  return { total: 0, checked: 0, source: 'none' };
}
