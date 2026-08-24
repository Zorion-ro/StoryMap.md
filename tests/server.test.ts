import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, describe, before, after } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/server';
import { computeCoverage } from '../src/coverage';
import { projectAt } from '../src/project/config';
import { Workspace } from '../src/core';

function story(id: string, opts: { status: string; completed: boolean; area?: string; title?: string; deps?: string[] }): string {
  return `---
id: ${id}
title: ${opts.title ?? `Story ${id}`}
status: ${opts.status}
assignee: []
created_date: '2026-08-01 10:00'
labels:
  - 'area:${opts.area ?? 'frontend'}'
  - 'owner:frontend'
  - 'wstatus:${opts.completed ? 'done' : 'blocked'}'
  - 'wtype:feature'
  - 'priority:p1'
dependencies: [${(opts.deps ?? []).map((d) => `'${d}'`).join(', ')}]
priority: high
type: story
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Body of ${id} with \`code\` and a <script>tag</script>.

## Acceptance criteria

- [x] one
- [ ] two
<!-- SECTION:DESCRIPTION:END -->
`;
}

const MAP = `schemaVersion: 1
id: demo-journey
title: Demo journey
kind: journey
summary: A demo.
personas:
  - seller
releaseSlices:
  - id: delivered
    title: Delivered
    order: 10
    expects: completed
  - id: planned
    title: Not yet delivered
    order: 20
    expects: active
activities:
  - id: act
    title: An activity
    steps:
      - id: step-one
        title: First step
        slices:
          delivered:
            - STORY-001
          planned:
            - STORY-002
        supporting:
          - STORY-003
      - id: step-two
        title: Second step
        slices:
          planned:
            - STORY-404
`;

let root: string;
let server: Server;
let base: string;

async function get(path: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.text() };
}

describe('story-map server', () => {
  before(async () => {
    root = mkdtempSync(join(tmpdir(), 'sm-srv-'));
    mkdirSync(join(root, 'backlog/tasks'), { recursive: true });
    mkdirSync(join(root, 'backlog/completed'), { recursive: true });
    mkdirSync(join(root, 'backlog/story-maps'), { recursive: true });
    writeFileSync(
      join(root, 'backlog/completed/a.md'),
      story('STORY-001', { status: 'Done', completed: true, area: 'security', title: 'A delivered story' }),
    );
    writeFileSync(
      join(root, 'backlog/tasks/b.md'),
      story('STORY-002', { status: 'To Do', completed: false, deps: ['STORY-001'] }),
    );
    writeFileSync(join(root, 'backlog/completed/c.md'), story('STORY-003', { status: 'Done', completed: true }));
    writeFileSync(join(root, 'backlog/tasks/d.md'), story('STORY-SEC-9X', { status: 'To Do', completed: false }));
    writeFileSync(join(root, 'backlog/story-maps/demo.yaml'), MAP);

    const { app } = createApp(projectAt(root));
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  });

  test('story list shows active and completed together', async () => {
    const { status, body } = await get('/');
    assert.equal(status, 200);
    assert.match(body, /<strong>4<\/strong> shown of 4/);
    assert.ok(body.includes('STORY-001'));
    assert.ok(body.includes('STORY-SEC-9X'));
  });

  test('filters narrow the list', async () => {
    assert.match((await get('/?state=completed')).body, /<strong>2<\/strong> shown of 4/);
    assert.match((await get('/?state=active')).body, /<strong>2<\/strong> shown of 4/);
    assert.match((await get('/?area=security')).body, /<strong>1<\/strong> shown of 4/);
    assert.match((await get('/?wstatus=blocked')).body, /<strong>2<\/strong> shown of 4/);
    assert.match((await get('/?text=delivered')).body, /<strong>1<\/strong> shown of 4/);
    assert.match((await get('/?map=none')).body, /<strong>1<\/strong> shown of 4/);
  });

  test('status and delivery state are shown as separate fields', async () => {
    const { body } = await get('/story/STORY-002');
    assert.ok(body.includes('pill status s-to-do'), 'coarse status pill');
    assert.ok(body.includes('pill wstatus w-blocked'), 'richer delivery-state pill');
  });

  test('story detail renders the real body and escapes it', async () => {
    const { status, body } = await get('/story/STORY-002');
    assert.equal(status, 200);
    assert.ok(body.includes('Body of STORY-002'));
    assert.ok(body.includes('<code>code</code>'));
    assert.ok(!body.includes('<script>tag</script>'), 'a story body must not inject markup');
    assert.ok(body.includes('backlog/tasks/b.md'), 'shows where it came from');
  });

  test('story detail resolves a completed story and a composite id', async () => {
    assert.equal((await get('/story/STORY-001')).status, 200);
    assert.equal((await get('/story/STORY-SEC-9X')).status, 200);
    assert.equal((await get('/story/story-1')).status, 200, 'unpadded, lower-case id resolves');
  });

  test('an unknown story id is a 404 that says so', async () => {
    const { status, body } = await get('/story/STORY-999');
    assert.equal(status, 404);
    assert.ok(body.includes('STORY-999'));
  });

  test('detail shows dependencies both ways and map membership', async () => {
    const forward = await get('/story/STORY-002');
    assert.ok(forward.body.includes('Depends on'));
    const backward = await get('/story/STORY-001');
    assert.ok(backward.body.includes('Blocks'), 'STORY-002 depends on STORY-001, so STORY-001 blocks it');
    assert.ok(backward.body.includes('Demo journey'));
  });

  test('the detailed view renders activities, steps, slices and cards', async () => {
    // The visual wall is the default now; this guards the detailed renderer,
    // which stays available for dense capability maps.
    const { status, body } = await get('/maps/demo-journey?view=detailed');
    assert.equal(status, 200);
    assert.ok(body.includes('An activity'));
    assert.ok(body.includes('First step'));
    assert.ok(body.includes('Delivered'));
    assert.ok(body.includes('data-story-id="STORY-001"'));
    assert.ok(body.includes('card completed'), 'a completed story keeps its place, visibly');
    assert.ok(body.includes('card completed supporting'), 'supporting placements render distinctly');
  });

  test('the detailed view shows an unknown story reference, not dropped', async () => {
    const { body } = await get('/maps/demo-journey?view=detailed');
    assert.ok(body.includes('card missing'));
    assert.ok(body.includes('STORY-404'));
    assert.ok(body.includes('unknown story reference'));
  });

  test('detailed-view filters focus, hide and highlight', async () => {
    assert.ok((await get('/maps/demo-journey?view=detailed&completed=hide')).body.includes('map-body hide-completed'));
    assert.ok((await get('/maps/demo-journey?view=detailed&highlight=STORY-001')).body.includes('data-highlight="STORY-001"'));
    const focused = await get('/maps/demo-journey?view=detailed&activity=act');
    assert.equal((focused.body.match(/class="activity"/g) ?? []).length, 1);
  });

  test('a card links to the same canonical story detail the list links to', async () => {
    const { body } = await get('/maps/demo-journey?view=detailed');
    assert.ok(body.includes('href="/story/STORY-001?from=demo-journey"'));
    const detail = await get('/story/STORY-001?from=demo-journey');
    assert.ok(detail.body.includes('href="/maps/demo-journey"'), 'back link returns to the map');
  });

  test('coverage accounts for every story exactly once', async () => {
    const { status, body } = await get('/coverage');
    assert.equal(status, 200);
    assert.match(body, /4 of 4 work items accounted for/);
    assert.ok(!body.includes('MISMATCH'));
  });

  test('the coverage buckets partition the estate', () => {
    const coverage = computeCoverage(Workspace.load(root));
    const total = coverage.buckets.reduce((n, b) => n + b.items.length, 0);
    assert.equal(total, 4);
    assert.equal(coverage.accounted, true);
    const seen = new Set<string>();
    for (const bucket of coverage.buckets) {
      for (const item of bucket.items) {
        assert.ok(!seen.has(item.id), `${item.id} appears in two buckets`);
        seen.add(item.id);
      }
    }
  });

  test('the JSON API exposes the index', async () => {
    const { body } = await get('/api/stories');
    const data = JSON.parse(body);
    assert.equal(data.total, 4);
    assert.equal(data.active, 2);
    assert.equal(data.completed, 2);
  });

  test('an edit on disk is picked up without a restart', async () => {
    writeFileSync(join(root, 'backlog/tasks/e.md'), story('STORY-500', { status: 'To Do', completed: false }));
    const { body } = await get('/');
    assert.match(body, /<strong>5<\/strong> shown of 5/);
    assert.equal((await get('/story/STORY-500')).status, 200);
  });

  test('a map edited on disk is reflected too', async () => {
    writeFileSync(
      join(root, 'backlog/story-maps/demo.yaml'),
      MAP.replace('title: First step', 'title: Renamed step'),
    );
    const { body } = await get('/maps/demo-journey?view=detailed');
    assert.ok(body.includes('Renamed step'));
    assert.ok(!body.includes('First step'));
  });
});
