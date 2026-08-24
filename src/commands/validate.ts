import { WorkspaceHost, formatReport, validate } from '../core';
import type { ValidationReport } from '../core';
import { computeCoverage } from '../coverage';
import { resolveProject } from '../cli';
import type { Args } from '../cli';

/**
 * Counts by kind, so a CI log says what is wrong before anyone reads the
 * detail. Every code the validator can emit lands in exactly one row.
 */
export interface Tally {
  unreadable: number;
  duplicateIds: number;
  brokenReferences: number;
  malformedMaps: number;
  placement: number;
}

export function tally(report: ValidationReport): Tally {
  const t: Tally = { unreadable: 0, duplicateIds: 0, brokenReferences: 0, malformedMaps: 0, placement: 0 };
  for (const issue of report.issues) {
    if (issue.severity !== 'error') continue;
    const code = issue.code;
    if (code === 'story_duplicate_id' || code === 'map_duplicate_id') t.duplicateIds += 1;
    else if (code === 'map_unknown_story') t.brokenReferences += 1;
    else if (code.startsWith('story_')) {
      if (code === 'story_primary_in_multiple_maps') t.placement += 1;
      else t.unreadable += 1;
    } else if (
      code === 'map_duplicate_primary_placement' ||
      code === 'map_supporting_and_primary' ||
      code === 'map_empty'
    ) {
      t.placement += 1;
    } else t.malformedMaps += 1;
  }
  return t;
}

function row(label: string, value: number | string): string {
  return `  ${label.padEnd(20)}${String(value).padStart(6)}\n`;
}

/** `storymap validate` — suitable for CI; no server, no browser, no writes. */
export async function runValidate(args: Args, cwd: string): Promise<number> {
  const project = resolveProject(args, cwd);
  const workspace = new WorkspaceHost(project.root, project.backlogDirectory, project.storyMapsDirectory).get();
  const report = validate(workspace);
  const coverage = computeCoverage(workspace);
  const t = tally(report);

  const out = process.stdout;
  out.write(`\nStoryMap.md validation\n\n`);
  out.write(`  project             ${project.projectName}\n`);
  out.write(`  root                ${project.root}\n`);
  out.write(`  backlog             ${project.backlogDirectory}\n`);
  out.write(`  story maps          ${project.storyMapsDirectory}\n\n`);
  out.write(row('Work items', workspace.index.size));
  out.write(row('  active', workspace.index.active.length));
  out.write(row('  completed', workspace.index.completed.length));
  out.write(row('Story maps', workspace.maps.length));
  out.write(row('Unreadable files', t.unreadable));
  out.write(row('Duplicate ids', t.duplicateIds));
  out.write(row('Broken references', t.brokenReferences));
  out.write(row('Malformed maps', t.malformedMaps));
  out.write(row('Placement errors', t.placement));
  out.write(row('Warnings', report.warningCount));
  out.write('\n');

  for (const bucket of coverage.buckets) {
    out.write(`  ${bucket.label.padEnd(46)} ${String(bucket.items.length).padStart(4)}\n`);
  }
  const accounted = coverage.buckets.reduce((n, b) => n + b.items.length, 0);
  out.write(
    `  ${'TOTAL ACCOUNTED'.padEnd(46)} ${String(accounted).padStart(4)}` +
      `${coverage.accounted ? '  (reconciles)' : '  *** DOES NOT RECONCILE ***'}\n\n`,
  );
  out.write(`${formatReport(report)}\n`);

  if (!coverage.accounted) {
    process.stderr.write('\nCoverage does not reconcile: a story is in no bucket.\n');
    return 1;
  }
  return report.ok ? 0 : 1;
}
