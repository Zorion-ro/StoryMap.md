import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { WorkspaceHost } from '../core';
import {
  BACKLOG_CONFIG_FILE,
  STORYMAP_CONFIG_FILE,
  discoverProject,
  projectAtExplicitRoot,
} from '../project/discover';
import { ConfigError, containedDirectory, loadProject, renderConfig } from '../project/config';
import { UsageError } from '../cli';
import type { Args } from '../cli';

/**
 * `storymap init` — records this project's settings in `storymap.config.yml`.
 *
 * It writes exactly one file and creates at most one empty directory. It never
 * touches a work item, never edits `backlog.config.yml`, and never invents a
 * story map: the maps are the human's to write.
 */
export async function runInit(args: Args, cwd: string): Promise<number> {
  const explicit = args.flags.get('project');
  const discovery =
    typeof explicit === 'string'
      ? projectAtExplicitRoot(explicit)
      : (discoverProject(cwd) ?? projectAtExplicitRoot(cwd));
  const root = discovery.root;
  const out = process.stdout;

  out.write('\nStoryMap.md initialization\n\n');

  const mark = (ok: boolean, label: string) => out.write(`  ${ok ? '✓' : '✗'} ${label}\n`);
  mark(Boolean(discovery.gitRoot), discovery.gitRoot ? 'Git repository detected' : 'not a Git repository (maps will not be versioned)');

  const backlogFlag = args.flags.get('backlog-dir');
  if (backlogFlag !== undefined && typeof backlogFlag !== 'string') {
    throw new UsageError('--backlog-dir needs a value');
  }

  if (!discovery.backlogConfigPath && backlogFlag === undefined) {
    throw new ConfigError(
      [
        `no ${BACKLOG_CONFIG_FILE} in ${root}.`,
        '',
        'StoryMap.md reads Backlog.md work items, so this release expects a',
        'Backlog.md-compatible repository. Either:',
        '',
        `  • run \`backlog init\` first, or`,
        '  • point StoryMap.md at an existing folder of work items:',
        '        storymap init --backlog-dir <directory>',
      ].join('\n'),
    );
  }
  mark(Boolean(discovery.backlogConfigPath), discovery.backlogConfigPath ? 'Backlog.md detected' : 'Backlog.md config not used (--backlog-dir given)');

  const base = loadProject(discovery);
  const backlogDirectory = backlogFlag
    ? containedDirectory(root, backlogFlag, '--backlog-dir')
    : base.backlogDirectory;

  const backlogAbs = join(root, backlogDirectory);
  if (!existsSync(backlogAbs)) {
    throw new ConfigError(`backlog directory "${backlogDirectory}" does not exist under ${root}`);
  }
  mark(true, `Backlog directory: ${backlogDirectory}`);

  const mapsFlag = args.flags.get('maps-dir');
  if (mapsFlag !== undefined && typeof mapsFlag !== 'string') throw new UsageError('--maps-dir needs a value');
  const storyMapsDirectory = mapsFlag
    ? containedDirectory(root, mapsFlag, '--maps-dir')
    : backlogFlag
      ? `${backlogDirectory}/story-maps`
      : base.storyMapsDirectory;

  const workspace = new WorkspaceHost(root, backlogDirectory, storyMapsDirectory).get();
  const unreadable = workspace.read.problems.filter((p) => p.kind !== 'duplicate_id');
  mark(unreadable.length === 0, `${workspace.index.size} work items found (${workspace.index.active.length} active, ${workspace.index.completed.length} completed)`);
  if (unreadable.length > 0) {
    for (const problem of unreadable.slice(0, 5)) {
      out.write(`      ${problem.sourcePath}: ${problem.detail}\n`);
    }
  }

  const mapsAbs = join(root, storyMapsDirectory);
  const created: string[] = [];
  if (!existsSync(mapsAbs)) {
    mkdirSync(mapsAbs, { recursive: true });
    created.push(`${storyMapsDirectory}/`);
  }
  const existingMaps = readdirSync(mapsAbs).filter((n) => /\.ya?ml$/.test(n)).length;
  out.write(`\n  Story-map directory:\n  ${storyMapsDirectory}${existingMaps ? `  (${existingMaps} map(s))` : '  (empty — add your first map here)'}\n`);

  const configPath = resolve(root, STORYMAP_CONFIG_FILE);
  const force = args.flags.get('force') === true;
  if (existsSync(configPath) && !force) {
    out.write(`\n  ${STORYMAP_CONFIG_FILE} already exists; left untouched.\n  Re-run with --force to overwrite it.\n\n`);
    return 0;
  }
  writeFileSync(
    configPath,
    renderConfig({ backlogDirectory, storyMapsDirectory }, { includeBacklogDirectory: !discovery.backlogConfigPath || Boolean(backlogFlag) }),
    'utf8',
  );
  created.push(STORYMAP_CONFIG_FILE);

  out.write(`\n  ${force ? 'Rewritten' : 'Created'}:\n`);
  for (const name of created) out.write(`  ${name}\n`);
  out.write('\n  Next:  storymap browser\n\n');
  return 0;
}
