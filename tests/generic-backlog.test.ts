import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, describe, before, after } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/server';
import { projectAt } from '../src/project/config';

/**
 * A project that uses Backlog.md and nothing else.
 *
 * No `wtype:`, no `wstatus:`, no `area:`, no `owner:`, no milestones, no
 * completed directory to begin with — only the fields Backlog.md itself
 * writes. Everything here must still render, and no filter may break.
 */

const PLAIN = `---
id: STORY-001
title: Sign in with an email code
status: To Do
assignee: []
created_date: '2026-01-02 09:00'
labels: []
dependencies: []
priority: high
type: story
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
A returning customer receives a one-time code by email and types it in.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] #1 A code arrives within a minute
- [ ] #2 A used code is refused
<!-- AC:END -->
`;

const IN_PROGRESS = `---
id: STORY-002
title: Remember the last basket
status: In Progress
labels:
  - checkout
dependencies:
  - STORY-001
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The basket survives a closed tab.
<!-- SECTION:DESCRIPTION:END -->
`;

/** No marker comments at all: a work item somebody wrote by hand. */
const HANDWRITTEN = `---
id: BUG-003
title: The total ignores a discount
status: To Do
priority: medium
---

The order summary adds the discount twice on the second render.

## Acceptance criteria

- [ ] The total matches the server's figure
- [ ] A regression test covers the second render
`;

const DONE = `---
id: STORY-004
title: Print a receipt
status: Done
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Delivered in the first release.
<!-- SECTION:DESCRIPTION:END -->
`;

const MAP = `schemaVersion: 1
id: checkout
title: Buying something
kind: journey
personas:
  - Customer
releaseSlices:
  - id: first
    title: First release
    order: 10
  - id: later
    title: Later
    order: 20
activities:
  - id: arrive
    title: Arrive
    steps:
      - id: sign-in
        title: Sign in
        slices:
          first:
            - STORY-001
          later:
            - STORY-002
  - id: pay
    title: Pay
    steps:
      - id: total
        title: See the total
        slices:
          first:
            - STORY-004
          later:
            - BUG-003
`;

describe('a plain Backlog.md project', () => {
  let root: string;
  let server: Server;
  let base: string;

  const get = async (path: string) => {
    const response = await fetch(`${base}${path}`);
    return { status: response.status, body: await response.text() };
  };

  before(async () => {
    root = mkdtempSync(join(tmpdir(), 'storymap-generic-'));
    mkdirSync(join(root, 'backlog/tasks'), { recursive: true });
    mkdirSync(join(root, 'backlog/story-maps'), { recursive: true });
    writeFileSync(join(root, 'backlog.config.yml'), 'project_name: "Corner Shop"\n');
    writeFileSync(join(root, 'backlog/tasks/story-001 - sign-in.md'), PLAIN);
    writeFileSync(join(root, 'backlog/tasks/story-002 - basket.md'), IN_PROGRESS);
    writeFileSync(join(root, 'backlog/tasks/bug-003 - discount.md'), HANDWRITTEN);
    writeFileSync(join(root, 'backlog/tasks/story-004 - receipt.md'), DONE);
    writeFileSync(join(root, 'backlog/story-maps/checkout.yaml'), MAP);

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

  test('there is no completed directory, and that is a valid empty set', async () => {
    const { status, body } = await get('/');
    assert.equal(status, 200);
    assert.match(body, /<strong>4<\/strong> shown of 4/);
    assert.match(body, /<strong>0<\/strong> completed/);
  });

  test('the project name comes from backlog.config.yml', async () => {
    assert.match((await get('/')).body, /Corner Shop/);
  });

  test('filters over absent metadata narrow to nothing rather than breaking', async () => {
    for (const query of ['?area=security', '?owner=platform', '?wtype=defect', '?wstatus=blocked', '?milestone=m-1']) {
      const { status, body } = await get(`/${query}`);
      assert.equal(status, 200, `${query} must still render`);
      assert.match(body, /<strong>0<\/strong> shown of 4/, `${query} matches nothing here`);
    }
  });

  test('a story with no wtype label shows no type chip', async () => {
    const { status, body } = await get('/story/STORY-001');
    assert.equal(status, 200);
    assert.ok(body.includes('Sign in with an email code'));
    assert.ok(!body.includes('wtype'), 'nothing may invent a work type');
  });

  test('native acceptance criteria are read from the AC block', async () => {
    const { body } = await get('/story/STORY-001');
    assert.match(body, /1\s*\/\s*2|1 of 2/, 'one of the two criteria is checked');
    assert.ok(body.includes('A used code is refused'));
  });

  test('a hand-written item with no marker comments still has a body', async () => {
    const { status, body } = await get('/story/BUG-003');
    assert.equal(status, 200);
    assert.ok(body.includes('adds the discount twice'), 'the description must not come back empty');
    assert.ok(body.includes("matches the server"), 'its acceptance criteria are found in the body');
  });

  test('the map renders and places every story', async () => {
    const { status, body } = await get('/maps/checkout');
    assert.equal(status, 200);
    for (const id of ['STORY-001', 'STORY-002', 'BUG-003', 'STORY-004']) {
      assert.ok(body.includes(id), `${id} belongs on the wall`);
    }
    assert.ok(body.includes('Buying something'));
  });

  test('workflow lanes fall back to the native status when no wstatus exists', async () => {
    const { body } = await get('/maps/checkout?lanes=workflow');
    // `In Progress` and `Done` are Backlog.md's own statuses; they must be
    // enough to place a card without any project-specific delivery label.
    assert.ok(body.includes('STORY-002'));
    assert.ok(body.includes('STORY-004'));
  });

  test('ids sort by their numeric tail within a prefix', async () => {
    const { body } = await get('/');
    const order = ['BUG-003', 'STORY-001', 'STORY-002', 'STORY-004'].map((id) => body.indexOf(id));
    assert.deepEqual([...order].sort((a, b) => a - b), order, `unexpected order: ${order.join(',')}`);
  });

  test('coverage accounts for every story', async () => {
    const { status, body } = await get('/coverage');
    assert.equal(status, 200);
    assert.ok(body.includes('4'));
  });

  test('the browser assets are served', async () => {
    assert.equal((await get('/static/app.css')).status, 200);
    assert.equal((await get('/static/app.js')).status, 200);
  });
});
