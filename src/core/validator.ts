import type { StoryMap, ValidationIssue, ValidationReport } from './types';
import { primaryIds, supportingIds } from './resolver';
import type { Workspace } from './workspace';
import { normalizeId } from './work-item-index';

/**
 * Structural validation over the whole estate. Errors are things that make a map
 * or a story unusable; warnings are things a human should look at but that do
 * not break the tool.
 */
export function validate(workspace: Workspace): ValidationReport {
  const issues: ValidationIssue[] = [];

  // ---- work items -------------------------------------------------------
  for (const problem of workspace.read.problems) {
    issues.push({
      severity: 'error',
      code: `story_${problem.kind}`,
      message: problem.detail,
      where: problem.sourcePath,
    });
  }
  for (const duplicate of workspace.index.duplicates) {
    issues.push({
      severity: 'error',
      code: 'story_duplicate_id',
      message: duplicate.detail,
      where: duplicate.sourcePath,
    });
  }

  // ---- map files --------------------------------------------------------
  issues.push(...workspace.mapRead.issues);

  const placementOwners = new Map<string, string[]>();

  for (const map of workspace.maps) {
    const resolved = workspace.resolve(map.id);
    if (!resolved) continue;

    for (const id of resolved.missingIds) {
      issues.push({
        severity: 'error',
        code: 'map_unknown_story',
        message: `references ${id}, which is neither an active nor a completed work item`,
        where: map.sourcePath,
      });
    }

    // A story placed twice as `primary` inside one map is a mistake — the map
    // would show the same card in two journey positions with no way to tell
    // which one is meant.
    countDuplicates(primaryIds(map)).forEach((count, id) => {
      if (count > 1) {
        issues.push({
          severity: 'error',
          code: 'map_duplicate_primary_placement',
          message: `${id} is placed ${count} times as a primary story in this map`,
          where: map.sourcePath,
        });
      }
    });

    // Supporting and primary in the same map is contradictory: it is either
    // owned by this journey or it merely serves it.
    const primarySet = new Set(primaryIds(map).map(normalizeId));
    countDuplicates(supportingIds(map)).forEach((_count, id) => {
      if (primarySet.has(normalizeId(id))) {
        issues.push({
          severity: 'error',
          code: 'map_supporting_and_primary',
          message: `${id} is both a primary and a supporting story in this map`,
          where: map.sourcePath,
        });
      }
    });

    // A slice that declares what it expects lets the map notice its own decay:
    // when work ships, a story sitting in `planned` is now misfiled.
    for (const slice of map.releaseSlices) {
      if (!slice.expects) continue;
      for (const activity of resolved.activities) {
        for (const step of activity.steps) {
          const cell = step.cells.find((c) => c.sliceId === slice.id);
          for (const placement of cell?.placements ?? []) {
            if (!placement.item) continue;
            const actual = placement.item.completed ? 'completed' : 'active';
            if (actual !== slice.expects) {
              issues.push({
                severity: 'warning',
                code: 'slice_expectation_drift',
                message: `${placement.storyId} sits in slice "${slice.id}" (expects ${slice.expects}) but is ${actual}; move it to keep the map true`,
                where: map.sourcePath,
              });
            }
          }
        }
      }
    }

    if (resolved.counts.primary === 0) {
      issues.push({
        severity: 'error',
        code: 'map_empty',
        message: 'map places no primary stories; an empty placeholder map is not useful',
        where: map.sourcePath,
      });
    }

    for (const id of primaryIds(map)) {
      const key = normalizeId(id);
      placementOwners.set(key, [...(placementOwners.get(key) ?? []), map.id]);
    }
  }

  // A story owned as `primary` by two different maps is almost always an
  // accident. Cross-cutting work belongs in one map plus `supporting` refs.
  for (const [id, maps] of placementOwners) {
    if (maps.length > 1) {
      issues.push({
        severity: 'error',
        code: 'story_primary_in_multiple_maps',
        message: `${id} is a primary story in more than one map (${maps.join(', ')}); use \`supporting\` for cross-cutting references`,
      });
    }
  }

  const errorCount = issues.filter((i) => i.severity === 'error').length;
  const warningCount = issues.length - errorCount;
  return { issues, errorCount, warningCount, ok: errorCount === 0 };
}

function countDuplicates(ids: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  const display = new Map<string, string>();
  for (const id of ids) {
    const key = normalizeId(id);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (!display.has(key)) display.set(key, id);
  }
  const out = new Map<string, number>();
  for (const [key, count] of counts) out.set(display.get(key) ?? key, count);
  return out;
}

export function formatReport(report: ValidationReport): string {
  if (report.issues.length === 0) return 'OK — no structural problems found.';
  const lines: string[] = [];
  for (const issue of report.issues) {
    const where = issue.where ? ` ${issue.where}` : '';
    lines.push(`${issue.severity.toUpperCase().padEnd(7)} ${issue.code.padEnd(34)}${where}\n        ${issue.message}`);
  }
  lines.push('');
  lines.push(`${report.errorCount} error(s), ${report.warningCount} warning(s)`);
  return lines.join('\n');
}
