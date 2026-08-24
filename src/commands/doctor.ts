import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { STORY_MAP_SCHEMA_VERSION, WorkspaceHost, validate } from '../core';
import { ConfigError } from '../project/config';
import { CONFIG_SCHEMA_VERSION } from '../project/config';
import { resolveProject, VERSION } from '../cli';
import type { Args } from '../cli';

type Mark = 'ok' | 'warn' | 'fail';

interface Check {
  mark: Mark;
  label: string;
  detail?: string;
}

const GLYPH: Record<Mark, string> = { ok: '✓', warn: '!', fail: '✗' };

/** Lowest Node major this package supports, mirroring `engines.node`. */
export const MIN_NODE_MAJOR = 20;

function nodeMajor(version = process.versions.node): number {
  return Number(version.split('.')[0]);
}

function countMarkdown(dir: string): number | undefined {
  try {
    return readdirSync(dir).filter((n) => n.endsWith('.md')).length;
  } catch {
    return undefined;
  }
}

/**
 * `storymap doctor` — diagnoses the project and the environment.
 *
 * Where `validate` asks "is the data structurally sound", doctor asks "is this
 * a working StoryMap.md project at all", and says what to do when it is not.
 */
export async function runDoctor(args: Args, cwd: string): Promise<number> {
  const checks: Check[] = [];
  const out = process.stdout;
  out.write(`\nStoryMap.md ${VERSION} — doctor\n\n`);

  const major = nodeMajor();
  checks.push(
    major >= MIN_NODE_MAJOR
      ? { mark: 'ok', label: `Node ${process.versions.node} is supported` }
      : { mark: 'fail', label: `Node ${process.versions.node} is too old`, detail: `needs Node ${MIN_NODE_MAJOR} or newer` },
  );

  let project;
  try {
    project = resolveProject(args, cwd);
  } catch (error) {
    checks.push({
      mark: 'fail',
      label: 'no StoryMap.md project found',
      detail: error instanceof ConfigError ? error.message : (error as Error).message,
    });
    render(checks, out);
    out.write('\nRun `storymap init` from your project root.\n\n');
    return 1;
  }

  checks.push({ mark: 'ok', label: `project root  ${project.root}`, detail: `found via ${project.discoveredVia}` });
  checks.push(
    project.gitRoot
      ? { mark: 'ok', label: 'Git repository detected' }
      : { mark: 'warn', label: 'not inside a Git repository', detail: 'StoryMap.md works, but nothing versions your maps' },
  );

  checks.push(
    project.storymapConfigPath
      ? { mark: 'ok', label: `storymap.config.yml valid (schemaVersion ${CONFIG_SCHEMA_VERSION})` }
      : {
          mark: 'warn',
          label: 'no storymap.config.yml',
          detail: 'settings are being inferred; run `storymap init` to record them',
        },
  );
  checks.push(
    project.backlogConfigPath
      ? { mark: 'ok', label: 'backlog.config.yml valid' }
      : { mark: 'warn', label: 'no backlog.config.yml', detail: 'the backlog directory is a convention, not a declaration' },
  );

  const backlogDir = join(project.root, project.backlogDirectory);
  const tasksDir = join(backlogDir, 'tasks');
  const completedDir = join(backlogDir, 'completed');
  const mapsDir = join(project.root, project.storyMapsDirectory);

  if (!existsSync(backlogDir)) {
    checks.push({ mark: 'fail', label: `backlog directory missing`, detail: project.backlogDirectory });
    render(checks, out);
    out.write('\nCreate it, or point `backlog.directory` in storymap.config.yml at the right place.\n\n');
    return 1;
  }
  checks.push({ mark: 'ok', label: `backlog directory  ${project.backlogDirectory}` });

  const activeFiles = countMarkdown(tasksDir);
  const completedFiles = countMarkdown(completedDir);

  const workspace = new WorkspaceHost(project.root, project.backlogDirectory, project.storyMapsDirectory).get();
  const unreadable = workspace.read.problems.filter((p) => p.kind !== 'duplicate_id');

  checks.push(
    activeFiles === undefined
      ? { mark: 'warn', label: 'no tasks/ directory', detail: `expected ${project.backlogDirectory}/tasks` }
      : { mark: 'ok', label: `${workspace.index.active.length} active work items parse`, detail: `${activeFiles} file(s) in tasks/` },
  );
  checks.push(
    completedFiles === undefined
      ? { mark: 'ok', label: 'no completed/ directory yet', detail: 'nothing has been finished — that is a valid empty set' }
      : {
          mark: 'ok',
          label: `${workspace.index.completed.length} completed work items parse`,
          detail: `${completedFiles} file(s) in completed/`,
        },
  );
  if (unreadable.length > 0) {
    checks.push({
      mark: 'fail',
      label: `${unreadable.length} work-item file(s) could not be read`,
      detail: unreadable.slice(0, 3).map((p) => `${p.sourcePath}: ${p.detail}`).join('\n      '),
    });
  }

  checks.push(
    existsSync(mapsDir)
      ? { mark: 'ok', label: `story-map directory  ${project.storyMapsDirectory}` }
      : {
          mark: 'warn',
          label: 'no story-map directory yet',
          detail: `create ${project.storyMapsDirectory}/ and add a .yaml map`,
        },
  );

  const mapSchemaIssues = workspace.mapRead.issues.filter((i) => i.code === 'map_unsupported_schema_version');
  checks.push(
    mapSchemaIssues.length === 0
      ? { mark: 'ok', label: `story-map schema ${STORY_MAP_SCHEMA_VERSION} supported`, detail: `${workspace.maps.length} map(s) read` }
      : {
          mark: 'fail',
          label: `${mapSchemaIssues.length} map(s) declare an unsupported schemaVersion`,
          detail: mapSchemaIssues.map((i) => `${i.where}: ${i.message}`).join('\n      '),
        },
  );

  const duplicates = workspace.index.duplicates;
  checks.push(
    duplicates.length === 0
      ? { mark: 'ok', label: 'no duplicate work-item ids' }
      : {
          mark: 'fail',
          label: `${duplicates.length} duplicate work-item id(s)`,
          detail: duplicates.slice(0, 3).map((d) => `${d.sourcePath}: ${d.detail}`).join('\n      '),
        },
  );

  const report = validate(workspace);
  const unresolved = report.issues.filter((i) => i.code === 'map_unknown_story');
  checks.push(
    unresolved.length === 0
      ? { mark: 'ok', label: 'no unresolved map references' }
      : {
          mark: 'fail',
          label: `${unresolved.length} map reference(s) resolve to nothing`,
          detail: unresolved.slice(0, 3).map((i) => `${i.where}: ${i.message}`).join('\n      '),
        },
  );

  render(checks, out);

  const failures = checks.filter((c) => c.mark === 'fail').length;
  const warnings = checks.filter((c) => c.mark === 'warn').length;
  out.write(`\n${failures === 0 ? 'Healthy' : `${failures} problem(s)`}${warnings ? `, ${warnings} note(s)` : ''}.\n\n`);
  return failures === 0 ? 0 : 1;
}

function render(checks: readonly Check[], out: NodeJS.WriteStream): void {
  for (const check of checks) {
    out.write(`  ${GLYPH[check.mark]} ${check.label}\n`);
    if (check.detail) out.write(`      ${check.detail}\n`);
  }
}
