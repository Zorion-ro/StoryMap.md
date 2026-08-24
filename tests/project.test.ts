import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, describe, after } from 'node:test';
import { discoverProject, projectAtExplicitRoot } from '../src/project/discover';
import { ConfigError, loadProject, projectAt, renderConfig } from '../src/project/config';

/**
 * Discovery and configuration, proven on throw-away directories rather than on
 * this repository — the point of the exercise is that neither depends on it.
 */

const roots: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'storymap-project-'));
  roots.push(dir);
  return dir;
}

after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

/** A minimal Backlog.md project: a config, a task, and a git marker. */
function backlogProject(opts: { git?: boolean; backlogDir?: string; storymapConfig?: string } = {}): string {
  const root = scratch();
  const backlogDir = opts.backlogDir ?? 'backlog';
  mkdirSync(join(root, backlogDir, 'tasks'), { recursive: true });
  writeFileSync(
    join(root, 'backlog.config.yml'),
    `project_name: "Widgets"\nbacklog_directory: "${backlogDir}"\n`,
  );
  writeFileSync(
    join(root, backlogDir, 'tasks', 'task-1 - one.md'),
    `---\nid: TASK-1\ntitle: One\nstatus: To Do\n---\n\n## Description\n\n<!-- SECTION:DESCRIPTION:BEGIN -->\nbody\n<!-- SECTION:DESCRIPTION:END -->\n`,
  );
  if (opts.git !== false) mkdirSync(join(root, '.git'));
  if (opts.storymapConfig !== undefined) writeFileSync(join(root, 'storymap.config.yml'), opts.storymapConfig);
  return root;
}

describe('project discovery', () => {
  test('finds a backlog.config.yml in the current directory', () => {
    const root = backlogProject();
    const found = discoverProject(root);
    assert.equal(found?.root, root);
    assert.equal(found?.via, 'backlog-config');
  });

  test('finds the project from a deeply nested working directory', () => {
    const root = backlogProject();
    const nested = join(root, 'apps', 'foo', 'src');
    mkdirSync(nested, { recursive: true });
    const found = discoverProject(nested);
    assert.equal(found?.root, root, 'walking upward must reach the project root');
    assert.equal(found?.via, 'backlog-config');
  });

  test('a storymap.config.yml outranks a backlog.config.yml at the same level', () => {
    const root = backlogProject({ storymapConfig: 'schemaVersion: 1\n' });
    const found = discoverProject(root);
    assert.equal(found?.via, 'storymap-config');
    assert.equal(found?.storymapConfigPath, join(root, 'storymap.config.yml'));
    assert.equal(found?.backlogConfigPath, join(root, 'backlog.config.yml'));
  });

  test('a nearer sub-project config beats the repository around it', () => {
    const outer = scratch();
    mkdirSync(join(outer, '.git'));
    writeFileSync(join(outer, 'backlog.config.yml'), 'project_name: "Outer"\n');
    const inner = join(outer, 'packages', 'inner');
    mkdirSync(join(inner, 'backlog', 'tasks'), { recursive: true });
    writeFileSync(join(inner, 'storymap.config.yml'), 'schemaVersion: 1\n');

    const found = discoverProject(join(inner, 'src'));
    assert.equal(found?.root, inner, 'the nearer config wins over the enclosing repository');
    assert.equal(found?.via, 'storymap-config');
  });

  test('falls back to the Git root when no config exists', () => {
    const root = scratch();
    mkdirSync(join(root, '.git'));
    const nested = join(root, 'a', 'b');
    mkdirSync(nested, { recursive: true });
    const found = discoverProject(nested);
    assert.equal(found?.root, root);
    assert.equal(found?.via, 'git');
  });

  test('never adopts a config from outside the enclosing repository', () => {
    const outer = scratch();
    writeFileSync(join(outer, 'storymap.config.yml'), 'schemaVersion: 1\n');
    const repo = join(outer, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });

    const found = discoverProject(repo);
    assert.equal(found?.root, repo, 'the git root is the ceiling; the stray parent config is ignored');
    assert.equal(found?.via, 'git');
  });

  test('reports nothing when there is no project at all', () => {
    const root = scratch();
    // A scratch directory under /tmp has no git marker and no config above it
    // that belongs to a repository, so discovery must decline.
    const found = discoverProject(root);
    assert.equal(found, undefined);
  });
});

describe('project configuration', () => {
  test('infers everything from backlog.config.yml alone', () => {
    const root = backlogProject({ backlogDir: 'docs/planning/backlog' });
    const project = loadProject(discoverProject(root)!);
    assert.equal(project.backlogDirectory, 'docs/planning/backlog');
    assert.equal(project.storyMapsDirectory, 'docs/planning/backlog/story-maps');
    assert.equal(project.projectName, 'Widgets');
    assert.equal(project.port, 6480);
  });

  test('a custom story-map directory is honoured', () => {
    const root = backlogProject({
      storymapConfig: 'schemaVersion: 1\nstoryMaps:\n  directory: docs/maps\nbrowser:\n  port: 7100\n',
    });
    const project = loadProject(discoverProject(root)!);
    assert.equal(project.storyMapsDirectory, 'docs/maps');
    assert.equal(project.port, 7100);
  });

  test('storymap.config.yml overrides the backlog directory', () => {
    const root = backlogProject({ storymapConfig: 'schemaVersion: 1\nbacklog:\n  directory: work-items\n' });
    mkdirSync(join(root, 'work-items', 'tasks'), { recursive: true });
    const project = loadProject(discoverProject(root)!);
    assert.equal(project.backlogDirectory, 'work-items');
    assert.equal(project.storyMapsDirectory, 'work-items/story-maps');
  });

  test('an unsupported schemaVersion is refused by name', () => {
    const root = backlogProject({ storymapConfig: 'schemaVersion: 2\n' });
    assert.throws(() => loadProject(discoverProject(root)!), (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /schemaVersion 2/);
      assert.match(error.message, /reads 1/);
      assert.equal(error.where, join(root, 'storymap.config.yml'));
      return true;
    });
  });

  test('a missing schemaVersion is refused', () => {
    const root = backlogProject({ storymapConfig: 'storyMaps:\n  directory: maps\n' });
    assert.throws(() => loadProject(discoverProject(root)!), /missing `schemaVersion`/);
  });

  test('unparseable YAML names the file', () => {
    const root = backlogProject({ storymapConfig: 'schemaVersion: 1\n  : : :\n' });
    assert.throws(() => loadProject(discoverProject(root)!), (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.where, join(root, 'storymap.config.yml'));
      return true;
    });
  });

  test('a directory outside the project is refused, not clamped', () => {
    const root = backlogProject({ storymapConfig: 'schemaVersion: 1\nbacklog:\n  directory: ../../etc\n' });
    assert.throws(() => loadProject(discoverProject(root)!), /must stay inside the project/);
  });

  test('an absolute directory is refused', () => {
    const root = backlogProject({ storymapConfig: 'schemaVersion: 1\nstoryMaps:\n  directory: /etc\n' });
    assert.throws(() => loadProject(discoverProject(root)!), /not an absolute path/);
  });

  test('a nonsense port is refused', () => {
    const root = backlogProject({ storymapConfig: 'schemaVersion: 1\nbrowser:\n  port: 99999\n' });
    assert.throws(() => loadProject(discoverProject(root)!), /browser.port/);
  });

  test('with no config at all the Backlog.md convention applies', () => {
    const root = scratch();
    mkdirSync(join(root, '.git'));
    const project = projectAt(root);
    assert.equal(project.backlogDirectory, 'backlog');
    assert.equal(project.storyMapsDirectory, 'backlog/story-maps');
  });

  test('an explicit root is used verbatim, with no upward search', () => {
    const root = backlogProject();
    const nested = join(root, 'deep');
    mkdirSync(nested);
    const project = loadProject(projectAtExplicitRoot(nested));
    assert.equal(project.root, nested);
    assert.equal(project.discoveredVia, 'explicit');
  });

  test('the written config records decisions, not conventions', () => {
    const rendered = renderConfig(
      { backlogDirectory: 'docs/planning/backlog', storyMapsDirectory: 'docs/planning/backlog/story-maps' },
      { includeBacklogDirectory: false },
    );
    assert.match(rendered, /^schemaVersion: 1$/m);
    assert.match(rendered, /^ {2}directory: docs\/planning\/backlog\/story-maps$/m);
    assert.ok(!rendered.includes('backlog:\n'), 'the backlog directory already lives in backlog.config.yml');
  });
});
