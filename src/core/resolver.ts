import type {
  ResolvedActivity,
  ResolvedCell,
  ResolvedPlacement,
  ResolvedStep,
  ResolvedStoryMap,
  StoryMap,
} from './types';
import type { WorkItemIndex } from './work-item-index';
import { normalizeId } from './work-item-index';

/**
 * Joins a story map to the work-item index.
 *
 * A referenced id that no work item claims is kept as a placement with
 * `missing: true` so the UI can show the broken reference. Dropping it silently
 * is the one behaviour this must never have.
 */
export function resolveStoryMap(map: StoryMap, index: WorkItemIndex): ResolvedStoryMap {
  const referenced: string[] = [];
  const seenRef = new Set<string>();
  const missing: string[] = [];
  const seenMissing = new Set<string>();
  let primary = 0;
  let supporting = 0;
  let active = 0;
  let completed = 0;

  const place = (storyId: string, kind: ResolvedPlacement['kind']): ResolvedPlacement => {
    const key = normalizeId(storyId);
    if (!seenRef.has(key)) {
      seenRef.add(key);
      referenced.push(storyId);
    }
    const item = index.get(storyId);
    if (!item) {
      if (!seenMissing.has(key)) {
        seenMissing.add(key);
        missing.push(storyId);
      }
      return { storyId, missing: true, kind };
    }
    if (kind === 'primary') {
      primary += 1;
      if (item.completed) completed += 1;
      else active += 1;
    } else {
      supporting += 1;
    }
    return { storyId, item, missing: false, kind };
  };

  const activities: ResolvedActivity[] = map.activities.map((activity) => {
    const steps: ResolvedStep[] = activity.steps.map((step) => {
      const cells: ResolvedCell[] = map.releaseSlices.map((slice) => ({
        sliceId: slice.id,
        placements: (step.slices[slice.id] ?? []).map((storyId) => place(storyId, 'primary')),
      }));
      return {
        id: step.id,
        title: step.title,
        cells,
        supporting: (step.supporting ?? []).map((storyId) => place(storyId, 'supporting')),
      };
    });
    return { id: activity.id, title: activity.title, steps };
  });

  return {
    map,
    activities,
    referencedIds: referenced,
    missingIds: missing,
    counts: { primary, supporting, active, completed, missing: missing.length },
  };
}

/** Every story id placed as `primary` anywhere in the map, normalised. */
export function primaryIds(map: StoryMap): string[] {
  const out: string[] = [];
  for (const activity of map.activities) {
    for (const step of activity.steps) {
      for (const list of Object.values(step.slices)) out.push(...list);
    }
  }
  return out;
}

/** Every story id referenced as `supporting` anywhere in the map. */
export function supportingIds(map: StoryMap): string[] {
  const out: string[] = [];
  for (const activity of map.activities) {
    for (const step of activity.steps) out.push(...(step.supporting ?? []));
  }
  return out;
}
