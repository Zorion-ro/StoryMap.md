import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { BacklogPaths } from './backlog-reader';
import { parse as parseYaml } from 'yaml';
import { STORY_MAP_SCHEMA_VERSION } from './types';
import type { StoryMap, StoryMapActivity, StoryMapSlice, StoryMapStep, ValidationIssue } from './types';

/**
 * Reads the human-editable story-map YAML from the project's story-map directory.
 *
 * A map holds structure and story ids. It never holds a copy of a story's title,
 * status or body — those come from the work item, so there is exactly one place
 * a story can be edited.
 */

export interface StoryMapReadResult {
  maps: StoryMap[];
  issues: ValidationIssue[];
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter(Boolean);
}

export function parseStoryMap(raw: string, sourcePath: string): { map?: StoryMap; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  const err = (code: string, message: string) => issues.push({ severity: 'error', code, message, where: sourcePath });

  let doc: unknown;
  try {
    doc = parseYaml(raw);
  } catch (error) {
    err('map_unparseable', `YAML did not parse: ${(error as Error).message}`);
    return { issues };
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    err('map_not_object', 'the file does not contain a YAML mapping');
    return { issues };
  }
  const d = doc as Record<string, unknown>;

  const schemaVersion = typeof d.schemaVersion === 'number' ? d.schemaVersion : undefined;
  if (schemaVersion === undefined) {
    err('map_missing_schema_version', 'missing `schemaVersion`');
    return { issues };
  }
  if (schemaVersion !== STORY_MAP_SCHEMA_VERSION) {
    err(
      'map_unsupported_schema_version',
      `schemaVersion ${schemaVersion} is not supported; this tool reads ${STORY_MAP_SCHEMA_VERSION}`,
    );
    return { issues };
  }

  const id = asString(d.id);
  const title = asString(d.title);
  if (!id) err('map_missing_id', 'missing `id`');
  if (!title) err('map_missing_title', 'missing `title`');

  const kindRaw = asString(d.kind) ?? 'journey';
  if (kindRaw !== 'journey' && kindRaw !== 'capability') {
    err('map_bad_kind', `kind must be "journey" or "capability", got "${kindRaw}"`);
  }

  const releaseSlices: StoryMapSlice[] = [];
  const sliceIds = new Set<string>();
  if (Array.isArray(d.releaseSlices)) {
    for (const entry of d.releaseSlices) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      const sliceId = asString(e.id);
      if (!sliceId) {
        err('slice_missing_id', 'a releaseSlices entry has no `id`');
        continue;
      }
      if (sliceIds.has(sliceId)) {
        err('slice_duplicate_id', `duplicate release slice id "${sliceId}"`);
        continue;
      }
      sliceIds.add(sliceId);
      const expects = asString(e.expects);
      if (expects && expects !== 'completed' && expects !== 'active') {
        err('slice_bad_expects', `release slice "${sliceId}" has expects "${expects}"; use "completed" or "active"`);
      }
      releaseSlices.push({
        id: sliceId,
        title: asString(e.title) ?? sliceId,
        order: typeof e.order === 'number' ? e.order : releaseSlices.length * 10,
        ...(expects === 'completed' || expects === 'active' ? { expects } : {}),
      });
    }
  }
  if (releaseSlices.length === 0) {
    err('map_no_slices', 'a map needs at least one entry in `releaseSlices`');
  }

  const activities: StoryMapActivity[] = [];
  const activityIds = new Set<string>();
  if (Array.isArray(d.activities)) {
    for (const entry of d.activities) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      const activityId = asString(e.id);
      if (!activityId) {
        err('activity_missing_id', 'an activity has no `id`');
        continue;
      }
      if (activityIds.has(activityId)) {
        err('activity_duplicate_id', `duplicate activity id "${activityId}"`);
        continue;
      }
      activityIds.add(activityId);

      const steps: StoryMapStep[] = [];
      const stepIds = new Set<string>();
      if (Array.isArray(e.steps)) {
        for (const stepEntry of e.steps) {
          if (!stepEntry || typeof stepEntry !== 'object') continue;
          const s = stepEntry as Record<string, unknown>;
          const stepId = asString(s.id);
          if (!stepId) {
            err('step_missing_id', `a step in activity "${activityId}" has no \`id\``);
            continue;
          }
          if (stepIds.has(stepId)) {
            err('step_duplicate_id', `duplicate step id "${stepId}" in activity "${activityId}"`);
            continue;
          }
          stepIds.add(stepId);

          const slices: Record<string, string[]> = {};
          if (s.slices && typeof s.slices === 'object' && !Array.isArray(s.slices)) {
            for (const [sliceKey, storyList] of Object.entries(s.slices as Record<string, unknown>)) {
              if (!sliceIds.has(sliceKey)) {
                err(
                  'step_unknown_slice',
                  `step "${activityId}/${stepId}" places stories in slice "${sliceKey}", which is not declared in releaseSlices`,
                );
                continue;
              }
              slices[sliceKey] = asStringArray(storyList);
            }
          }
          steps.push({
            id: stepId,
            title: asString(s.title) ?? stepId,
            slices,
            supporting: asStringArray(s.supporting),
          });
        }
      }
      if (steps.length === 0) {
        err('activity_no_steps', `activity "${activityId}" has no steps`);
      }
      activities.push({ id: activityId, title: asString(e.title) ?? activityId, steps });
    }
  }
  if (activities.length === 0) {
    err('map_no_activities', 'a map needs at least one activity');
  }

  if (!id || !title || issues.some((i) => i.code === 'map_unsupported_schema_version')) {
    return { issues };
  }

  const map: StoryMap = {
    schemaVersion,
    id,
    title,
    kind: kindRaw === 'capability' ? 'capability' : 'journey',
    summary: asString(d.summary),
    personas: asStringArray(d.personas),
    releaseSlices: [...releaseSlices].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)),
    activities,
    sourcePath,
  };
  return { map, issues };
}

export function readStoryMaps(paths: BacklogPaths): StoryMapReadResult {
  const { repoRoot, storyMapsDir: dir } = paths;
  const result: StoryMapReadResult = { maps: [], issues: [] };
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return result; // no story-maps directory yet
  }
  const seen = new Map<string, string>();
  for (const name of entries.sort()) {
    if (!/\.ya?ml$/.test(name)) continue;
    const full = join(dir, name);
    if (!statSync(full).isFile()) continue;
    const rel = relative(repoRoot, full);
    const { map, issues } = parseStoryMap(readFileSync(full, 'utf8'), rel);
    result.issues.push(...issues);
    if (!map) continue;
    const prior = seen.get(map.id);
    if (prior) {
      result.issues.push({
        severity: 'error',
        code: 'map_duplicate_id',
        message: `map id "${map.id}" is already used by ${prior}`,
        where: rel,
      });
      continue;
    }
    seen.set(map.id, rel);
    result.maps.push(map);
  }
  return result;
}
