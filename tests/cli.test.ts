import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test, describe, after } from 'node:test';
import { main, parseArgs } from '../src/cli';

/**
 * The public command line.
 *
 * Most commands are exercised in-process, because they are pure functions of a
 * directory plus argv and return an exit code rather than calling `exit`. The
 * browser is exercised as a real child process, because a server that cannot be
 * started and stopped from a terminal is not finished.
 */

const scratchDirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'storymap-cli-'));
  scratchDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

/** Runs `main` with stdout and stderr captured. */
async function run(argv: string[], cwd: string): Promise<{ code: number; out: string; err: string }> {
  const chunks: string[] = [];
  const errs: string[] = [];
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  (process.stdout as NodeJS.WriteStream).write = ((chunk: string) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  (process.stderr as NodeJS.WriteStream).write = ((chunk: string) => {
    errs.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = await main(argv, cwd);
    return { code, out: chunks.join(''), err: errs.join('') };
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
}

const TASK = `---
id: TASK-1
title: Do the thing
status: To Do
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
the thing
<!-- SECTION:DESCRIPTION:END -->
`;

const MAP = `schemaVersion: 1
id: only
title: The only map
kind: journey
releaseSlices:
  - id: now
    title: Now
    order: 10
activities:
  - id: a
    title: An activity
    steps:
      - id: s
        title: A step
        slices:
          now:
            - TASK-1
`;

function project(opts: { map?: string; git?: boolean } = {}): string {
  const root = scratch();
  mkdirSync(join(root, 'backlog', 'tasks'), { recursive: true });
  mkdirSync(join(root, 'backlog', 'story-maps'), { recursive: true });
  writeFileSync(join(root, 'backlog.config.yml'), 'project_name: "Scratch"\n');
  writeFileSync(join(root, 'backlog', 'tasks', 'task-1 - do.md'), TASK);
  if (opts.map !== undefined) writeFileSync(join(root, 'backlog', 'story-maps', 'only.yaml'), opts.map);
  if (opts.git !== false) mkdirSync(join(root, '.git'));
  return root;
}

/**
 * The `tsx` executable, wherever npm put it.
 *
 * A standalone checkout has it in this package's own `node_modules`; a
 * workspace hoists it to the root above. Walk up rather than counting
 * directories, so the test does not encode one repository's shape.
 */
function findTsx(): string {
  let dir = resolve(__dirname, '..');
  for (;;) {
    const candidate = join(dir, 'node_modules', '.bin', 'tsx');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error('tsx is not installed anywhere above ' + __dirname);
    dir = parent;
  }
}

describe('argument parsing', () => {
  test('reads commands, values and negations', () => {
    const args = parseArgs(['browser', '--port', '7000', '--no-open', '--project=/tmp/x', '--debug']);
    assert.equal(args.command, 'browser');
    assert.equal(args.flags.get('port'), '7000');
    assert.equal(args.flags.get('open'), false);
    assert.equal(args.flags.get('project'), '/tmp/x');
    assert.equal(args.flags.get('debug'), true);
  });

  test('a value option with nothing after it is a usage error', () => {
    assert.throws(() => parseArgs(['browser', '--port']), /--port needs a value/);
  });
});

describe('storymap --help / --version', () => {
  test('--help lists every command and exits 0', async () => {
    const { code, out } = await run(['--help'], process.cwd());
    assert.equal(code, 0);
    for (const command of ['init', 'browser', 'validate', 'doctor']) {
      assert.ok(out.includes(command), `help must mention ${command}`);
    }
  });

  test('no arguments prints the same help rather than failing', async () => {
    const { code, out } = await run([], process.cwd());
    assert.equal(code, 0);
    assert.ok(out.includes('storymap <command>'));
  });

  test('--version prints the package version', async () => {
    const { code, out } = await run(['--version'], process.cwd());
    assert.equal(code, 0);
    const version = JSON.parse(readFileSync(resolve(__dirname, '..', 'package.json'), 'utf8')).version;
    assert.equal(out.trim(), version);
  });

  test('an unknown command is a usage error, not a crash', async () => {
    const { code, err } = await run(['sing'], process.cwd());
    assert.equal(code, 2);
    assert.match(err, /unknown command "sing"/);
  });
});

describe('storymap validate', () => {
  test('a sound project exits 0', async () => {
    const { code, out } = await run(['validate'], project({ map: MAP }));
    assert.equal(code, 0);
    assert.match(out, /Work items\s+1/);
    assert.match(out, /Story maps\s+1/);
    assert.match(out, /Broken references\s+0/);
    assert.ok(out.includes('OK'));
  });

  test('a map naming a story nobody wrote exits non-zero and says which', async () => {
    const root = project({ map: MAP.replace('- TASK-1', '- TASK-999') });
    const { code, out } = await run(['validate'], root);
    assert.equal(code, 1);
    assert.match(out, /Broken references\s+1/);
    assert.ok(out.includes('TASK-999'));
  });

  test('runs from a nested directory', async () => {
    const root = project({ map: MAP });
    const nested = join(root, 'src', 'deep');
    mkdirSync(nested, { recursive: true });
    const { code, out } = await run(['validate'], nested);
    assert.equal(code, 0);
    assert.ok(out.includes(root), 'it must report the discovered root, not the working directory');
  });

  test('outside any project it explains what to do', async () => {
    const { code, err } = await run(['validate'], scratch());
    assert.equal(code, 1);
    assert.match(err, /storymap init/);
    assert.ok(!err.includes('at Object.'), 'a user error must not print a stack trace');
  });
});

describe('storymap doctor', () => {
  test('a healthy project exits 0 and reports each check', async () => {
    const { code, out } = await run(['doctor'], project({ map: MAP }));
    assert.equal(code, 0);
    assert.ok(out.includes('Git repository detected'));
    assert.ok(out.includes('backlog directory'));
    assert.ok(out.includes('no duplicate work-item ids'));
    assert.ok(out.includes('no unresolved map references'));
    assert.ok(out.includes('Healthy'));
  });

  test('a missing backlog directory fails with the directory named', async () => {
    const root = scratch();
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, 'backlog.config.yml'), 'backlog_directory: "nowhere"\n');
    const { code, out } = await run(['doctor'], root);
    assert.equal(code, 1);
    assert.ok(out.includes('backlog directory missing'));
    assert.ok(out.includes('nowhere'));
  });

  test('a map with an unsupported schema fails the diagnosis', async () => {
    const root = project({ map: MAP.replace('schemaVersion: 1', 'schemaVersion: 9') });
    const { code, out } = await run(['doctor'], root);
    assert.equal(code, 1);
    assert.ok(out.includes('unsupported schemaVersion'));
  });

  test('outside any project it says so and exits non-zero', async () => {
    const { code, out } = await run(['doctor'], scratch());
    assert.equal(code, 1);
    assert.ok(out.includes('no StoryMap.md project found'));
    assert.ok(out.includes('storymap init'));
  });
});

describe('storymap init', () => {
  test('writes a config, creates the map directory, and touches nothing else', async () => {
    const root = project();
    const before = readFileSync(join(root, 'backlog', 'tasks', 'task-1 - do.md'), 'utf8');
    const backlogConfigBefore = readFileSync(join(root, 'backlog.config.yml'), 'utf8');

    const { code, out } = await run(['init'], root);
    assert.equal(code, 0);
    assert.ok(out.includes('Backlog.md detected'));
    assert.ok(out.includes('1 work items found'));

    const config = readFileSync(join(root, 'storymap.config.yml'), 'utf8');
    assert.match(config, /schemaVersion: 1/);
    assert.match(config, /directory: backlog\/story-maps/);

    assert.equal(readFileSync(join(root, 'backlog', 'tasks', 'task-1 - do.md'), 'utf8'), before, 'work items are read-only');
    assert.equal(readFileSync(join(root, 'backlog.config.yml'), 'utf8'), backlogConfigBefore, 'Backlog.md config is not ours to edit');
    assert.equal(existsSync(join(root, 'backlog', 'story-maps')), true);
  });

  test('does not invent a story map', async () => {
    const root = project();
    await run(['init'], root);
    const maps = readFileSync(join(root, 'storymap.config.yml'), 'utf8');
    assert.ok(maps.length > 0);
    assert.deepEqual(
      require('node:fs').readdirSync(join(root, 'backlog', 'story-maps')),
      [],
      'the maps are the human’s to write',
    );
  });

  test('refuses to overwrite an existing config without --force', async () => {
    const root = project();
    await run(['init'], root);
    writeFileSync(join(root, 'storymap.config.yml'), 'schemaVersion: 1\n# hand edited\n');
    const { code, out } = await run(['init'], root);
    assert.equal(code, 0);
    assert.ok(out.includes('--force'));
    assert.ok(readFileSync(join(root, 'storymap.config.yml'), 'utf8').includes('hand edited'));
  });

  test('--force rewrites it', async () => {
    const root = project();
    await run(['init'], root);
    writeFileSync(join(root, 'storymap.config.yml'), 'schemaVersion: 1\n# hand edited\n');
    const { code } = await run(['init', '--force'], root);
    assert.equal(code, 0);
    assert.ok(!readFileSync(join(root, 'storymap.config.yml'), 'utf8').includes('hand edited'));
  });

  test('without Backlog.md it says what this release expects', async () => {
    const root = scratch();
    mkdirSync(join(root, '.git'));
    const { code, err } = await run(['init'], root);
    assert.equal(code, 1);
    assert.match(err, /Backlog\.md-compatible repository/);
    assert.match(err, /--backlog-dir/);
  });

  test('--backlog-dir configures a project that has no Backlog.md config', async () => {
    const root = scratch();
    mkdirSync(join(root, '.git'));
    mkdirSync(join(root, 'work', 'tasks'), { recursive: true });
    writeFileSync(join(root, 'work', 'tasks', 'task-1.md'), TASK);
    const { code } = await run(['init', '--backlog-dir', 'work'], root);
    assert.equal(code, 0);
    const config = readFileSync(join(root, 'storymap.config.yml'), 'utf8');
    assert.match(config, /directory: work$/m);
    assert.match(config, /directory: work\/story-maps/);
  });
});

describe('storymap browser', () => {
  /** A port nothing is listening on right now. */
  async function freePort(): Promise<number> {
    return new Promise((resolvePort) => {
      const probe = createServer();
      probe.listen(0, '127.0.0.1', () => {
        const { port } = probe.address() as { port: number };
        probe.close(() => resolvePort(port));
      });
    });
  }

  test('starts, serves the wall, and stops on a signal', async () => {
    const root = project({ map: MAP });
    const port = await freePort();
    const cli = resolve(__dirname, '..', 'src', 'cli.ts');
    const tsx = findTsx();

    const child = spawn(tsx, [cli, 'browser', '--port', String(port), '--no-open'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => {
      out += String(d);
    });

    try {
      await new Promise<void>((resolveReady, rejectReady) => {
        const timer = setTimeout(() => rejectReady(new Error(`server never announced itself:\n${out}`)), 20000);
        child.stdout.on('data', () => {
          if (out.includes('Listening on')) {
            clearTimeout(timer);
            resolveReady();
          }
        });
        child.on('exit', (code) => {
          clearTimeout(timer);
          rejectReady(new Error(`exited early with ${code}:\n${out}`));
        });
      });

      assert.ok(out.includes('Scratch'), 'the banner names the project');
      assert.ok(out.includes(`http://127.0.0.1:${port}`));

      const home = await fetch(`http://127.0.0.1:${port}/`);
      assert.equal(home.status, 200);
      assert.ok((await home.text()).includes('TASK-1'));
      assert.equal((await fetch(`http://127.0.0.1:${port}/static/app.css`)).status, 200);
      assert.equal((await fetch(`http://127.0.0.1:${port}/maps/only`)).status, 200);
    } finally {
      child.kill('SIGTERM');
      await new Promise<void>((resolveExit) => child.on('exit', () => resolveExit()));
    }
    assert.equal(child.killed || child.exitCode !== null, true, 'no StoryMap.md process may be left running');
  });

  test('a busy port is refused rather than silently shared', async () => {
    const root = project({ map: MAP });
    const held = createServer((_req, res) => res.end('not storymap'));
    const port = await new Promise<number>((resolvePort) => {
      held.listen(0, '127.0.0.1', () => resolvePort((held.address() as { port: number }).port));
    });
    try {
      const { code, err } = await run(['browser', '--port', String(port), '--no-open'], root);
      assert.equal(code, 1);
      assert.match(err, /already in use/);
      assert.match(err, /--port/);
    } finally {
      await new Promise<void>((resolveClose) => held.close(() => resolveClose()));
    }
  });

  test('a nonsense port is a usage error', async () => {
    const { code, err } = await run(['browser', '--port', 'soon', '--no-open'], project());
    assert.equal(code, 2);
    assert.match(err, /--port must be an integer/);
  });
});
