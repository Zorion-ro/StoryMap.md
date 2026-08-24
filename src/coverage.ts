import type { WorkItem, Workspace } from './core';
import { normalizeId, primaryIds, supportingIds } from './core';

/**
 * Places every work item in exactly one bucket, so the tool can prove that no
 * story was quietly left out of the mapping exercise.
 *
 * The goal is 100% accounting, not 100% placement: "intentionally unmapped" and
 * "ambiguous" are legitimate destinations and are reported as such.
 */

export type BucketKey =
  | 'journey'
  | 'capability'
  | 'supporting-only'
  | 'unmapped';

export interface Bucket {
  key: BucketKey;
  label: string;
  note: string;
  items: WorkItem[];
}

export interface Coverage {
  buckets: Bucket[];
  total: number;
  accounted: boolean;
  /** Story id -> maps that place it as primary / reference it as supporting. */
  membership: Map<string, { primary: string[]; supporting: string[] }>;
}

export function computeCoverage(workspace: Workspace): Coverage {
  const membership = new Map<string, { primary: string[]; supporting: string[] }>();
  const kindOf = new Map<string, 'journey' | 'capability'>();

  for (const map of workspace.maps) {
    kindOf.set(map.id, map.kind);
    for (const id of primaryIds(map)) {
      const key = normalizeId(id);
      const entry = membership.get(key) ?? { primary: [], supporting: [] };
      entry.primary.push(map.id);
      membership.set(key, entry);
    }
    for (const id of supportingIds(map)) {
      const key = normalizeId(id);
      const entry = membership.get(key) ?? { primary: [], supporting: [] };
      entry.supporting.push(map.id);
      membership.set(key, entry);
    }
  }

  const journey: WorkItem[] = [];
  const capability: WorkItem[] = [];
  const supportingOnly: WorkItem[] = [];
  const unmapped: WorkItem[] = [];

  for (const item of workspace.index.items) {
    const entry = membership.get(normalizeId(item.id));
    if (entry && entry.primary.length > 0) {
      const kinds = entry.primary.map((m) => kindOf.get(m));
      if (kinds.includes('journey')) journey.push(item);
      else capability.push(item);
    } else if (entry && entry.supporting.length > 0) {
      supportingOnly.push(item);
    } else {
      unmapped.push(item);
    }
  }

  const buckets: Bucket[] = [
    {
      key: 'journey',
      label: 'Mapped to a user journey',
      note: 'placed as a primary story in a map whose kind is `journey` — work a person experiences',
      items: journey,
    },
    {
      key: 'capability',
      label: 'Mapped to a technical / platform capability',
      note: 'placed as a primary story in a map whose kind is `capability` — real work with no user journey position',
      items: capability,
    },
    {
      key: 'supporting-only',
      label: 'Cross-cutting reference only',
      note: 'referenced as `supporting` by one or more maps but owned by none; it enables journeys rather than belonging to one',
      items: supportingOnly,
    },
    {
      key: 'unmapped',
      label: 'Not on any map',
      note: 'no map places or references it; place it on a map, or record deliberately why it stays off one',
      items: unmapped,
    },
  ];

  const accountedCount = buckets.reduce((n, b) => n + b.items.length, 0);
  return {
    buckets,
    total: workspace.index.size,
    accounted: accountedCount === workspace.index.size,
    membership,
  };
}

/** Coverage grouped by an item property, for the Markdown report. */
export function groupBy(items: readonly WorkItem[], pick: (i: WorkItem) => string | undefined): Map<string, number> {
  const out = new Map<string, number>();
  for (const item of items) {
    const key = pick(item) ?? '(none)';
    out.set(key, (out.get(key) ?? 0) + 1);
  }
  return new Map([...out.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}
