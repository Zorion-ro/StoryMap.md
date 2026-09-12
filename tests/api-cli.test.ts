import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, test } from 'node:test';
import { main, parseArgs } from '../src/cli';

/**
 * The story commands: the machine API without a server. `--json` output must be
 * one JSON document on stdout and nothing else, whatever happened.
 */

const scratch: string[] = [];
after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function item(id: string, status: string, labels: string[]): string {
  return `---\nid: ${id}\ntitle: Story ${id}\nstatus: ${status}\nassignee: []\ncreated_date: '2026-08-01 10:00'\nlabels:\n${labels
    .map((l) => `  - '${l}'`)
    .join('\n')}\ndependencies: []\n---\n\n## Description\n\n<!-- SECTION:DESCRIPTION:BEGIN -->\nBody.\n<!-- SECTION:DESCRIPTION:END -->\n`;
}

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'sm-apicli-'));
  scratch.push(root);
  mkdirSync(join(root, 'backlog/tasks'), { recursive: true });
  mkdirSync(join(root, 'backlog/milestones'), { recursive: true });
  mkdirSync(join(root, '.git'));
  writeFileSync(join(root, 'backlog.config.yml'), 'project_name: "Scratch"\nstatuses: ["Backlog", "Ready", "In Progress", "Done"]\ntask_prefix: "FW"\n');
  writeFileSync(join(root, 'backlog/milestones/m-0 - a.md'), '---\nid: m-0\ntitle: A\n---\n');
  writeFileSync(join(root, 'backlog/tasks/fw-1 - a.md'), item('FW-1', 'Backlog', ['owner:platform', 'wtype:defect']));
  writeFileSync(join(root, 'backlog/tasks/fw-2 - b.md'), item('FW-2', 'Done', ['owner:platform', 'wtype:defect']));
  writeFileSync(join(root, 'backlog/tasks/fw-3 - c.md'), item('FW-3', 'Ready', ['owner:frontend', 'wtype:feature']));
  return root;
}

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

function findTsx(): string {
  let dir = resolve(__dirname, '..');
  for (;;) {
    const candidate = join(dir, 'node_modules', '.bin', 'tsx');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error('tsx is not installed');
    dir = parent;
  }
}

describe('story commands', () => {
  test('repeatable options keep every value', () => {
    const args = parseArgs(['update', 'FW-1', '--add-label', 'a', '--add-label', 'b', '--status', 'Done - Local']);
    assert.deepEqual(args.lists?.get('add-label'), ['a', 'b']);
    assert.equal(args.flags.get('status'), 'Done - Local');
    assert.deepEqual(args.positional, ['FW-1']);
  });

  test('list --json is pure JSON with the filters applied', async () => {
    const root = project();
    const { code, out, err } = await run(['list', '--wtype', 'defect', '--status-not', 'Done', '--json'], root);
    assert.equal(code, 0, err);
    const body = JSON.parse(out);
    assert.deepEqual(body.items.map((i: { id: string }) => i.id), ['FW-1']);
    assert.equal(body.total, 1);
    assert.equal(err, '');
  });

  test('get, meta and openapi print JSON', async () => {
    const root = project();
    assert.equal(JSON.parse((await run(['get', 'fw-3', '--json'], root)).out).owner, 'frontend');
    assert.deepEqual(JSON.parse((await run(['meta', '--json'], root)).out).writableStatuses, ['Backlog', 'Ready', 'In Progress', 'Done']);
    assert.equal(JSON.parse((await run(['openapi', '--json'], root)).out).openapi, '3.1.0');
  });

  test('update changes the file and reports the change', async () => {
    const root = project();
    const { code, out } = await run(['update', 'FW-1', '--status', 'In Progress', '--owner', 'frontend', '--add-label', 'risk:high', '--allow-new-values', '--json'], root);
    assert.equal(code, 0, out);
    const body = JSON.parse(out);
    assert.deepEqual(body.changes.status, { from: 'Backlog', to: 'In Progress' });
    assert.equal(body.story.risk, 'high');
    assert.match(readFileSync(join(root, 'backlog/tasks/fw-1 - a.md'), 'utf8'), /status: In Progress/);
  });

  test('update --clear sets a field to null, and --expected-revision detects a conflict', async () => {
    const root = project();
    const first = JSON.parse((await run(['update', 'FW-3', '--milestone', 'm-0', '--json'], root)).out);
    const cleared = await run(['update', 'FW-3', '--clear', 'milestone', '--expected-revision', first.story.revision, '--json'], root);
    assert.equal(cleared.code, 0, cleared.out);
    assert.equal(JSON.parse(cleared.out).story.milestone, null);
    const stale = await run(['update', 'FW-3', '--status', 'Done', '--expected-revision', first.story.revision, '--json'], root);
    assert.equal(stale.code, 5);
    assert.equal(JSON.parse(stale.out).error.code, 'REVISION_CONFLICT');
  });

  test('create allocates an id', async () => {
    const root = project();
    const { code, out } = await run(['create', '--title', 'Dealer rating support', '--wtype', 'feature', '--json'], root);
    assert.equal(code, 0, out);
    assert.equal(JSON.parse(out).story.id, 'FW-4');
    assert.ok(readdirSync(join(root, 'backlog/tasks')).includes('fw-4 - Dealer-rating-support.md'));
  });

  test('bulk-update with --dry-run writes nothing; without it writes all', async () => {
    const root = project();
    const dry = JSON.parse((await run(['bulk-update', 'FW-1', 'FW-3', '--owner', 'platform', '--dry-run', '--json'], root)).out);
    assert.equal(dry.dryRun, true);
    assert.equal(dry.wouldChange, 1);
    assert.match(readFileSync(join(root, 'backlog/tasks/fw-3 - c.md'), 'utf8'), /owner:frontend/);
    const real = await run(['bulk-update', 'FW-1', 'FW-3', '--owner', 'platform', '--json'], root);
    assert.equal(real.code, 0, real.out);
    assert.match(readFileSync(join(root, 'backlog/tasks/fw-3 - c.md'), 'utf8'), /owner:platform/);
  });

  test('--data sends the exact API body', async () => {
    const root = project();
    const { code, out } = await run(['update', 'FW-1', '--data', '{"labels":{"add":["customer"]}}', '--json'], root);
    assert.equal(code, 0, out);
    assert.ok(JSON.parse(out).story.labels.includes('customer'));
  });

  test('failures are JSON on stdout, a message on stderr, and a meaningful exit code', async () => {
    const root = project();
    const invalid = await run(['update', 'FW-1', '--status', 'Doing', '--json'], root);
    assert.equal(invalid.code, 4);
    assert.equal(JSON.parse(invalid.out).error.code, 'INVALID_STATUS');
    assert.match(invalid.err, /INVALID_STATUS/);

    const missing = await run(['get', 'FW-99', '--json'], root);
    assert.equal(missing.code, 3);
    assert.equal(JSON.parse(missing.out).error.code, 'STORY_NOT_FOUND');

    const usage = await run(['list', '--colour', 'red', '--json'], root);
    assert.equal(usage.code, 2);
    assert.equal(JSON.parse(usage.out).error.code, 'USAGE_ERROR');

    const filter = await run(['list', '--status', 'Doing', '--json'], root);
    assert.equal(filter.code, 2);
    assert.equal(JSON.parse(filter.out).error.code, 'INVALID_FILTER');
  });

  test('as a real process: stdout is exactly one JSON document, diagnostics go to stderr', () => {
    const root = project();
    const cli = resolve(__dirname, '..', 'src', 'cli.ts');
    const ok = spawnSync(findTsx(), [cli, 'list', '--owner', 'platform', '--json'], { cwd: root, encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    assert.doesNotThrow(() => JSON.parse(ok.stdout));
    assert.ok(ok.stdout.trimStart().startsWith('{') && ok.stdout.trimEnd().endsWith('}'));
    assert.doesNotMatch(ok.stdout, /\[/, 'no ANSI escapes');

    const bad = spawnSync(findTsx(), [cli, 'update', 'FW-1', '--status', 'Doing', '--json'], { cwd: root, encoding: 'utf8' });
    assert.equal(bad.status, 4);
    assert.equal(JSON.parse(bad.stdout).error.code, 'INVALID_STATUS');
    assert.match(bad.stderr, /INVALID_STATUS/);
  });

  test('without --json, list prints one line per story', async () => {
    const root = project();
    const { code, out, err } = await run(['list', '--owner', 'platform'], root);
    assert.equal(code, 0);
    assert.equal(out, 'FW-1\tBacklog\tStory FW-1\nFW-2\tDone\tStory FW-2\n');
    assert.match(err, /2 shown of 2/);
  });
});
