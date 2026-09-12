import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, describe, before, after } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/server';
import { ConfigError, projectAt } from '../src/project/config';
import { BACKLOG_MD_DEFAULT_STATUSES, WorkflowError, normalizeWstatus, resolveWorkflow } from '../src/core/workflow';

/**
 * Workflow lanes come from the project's own status vocabulary.
 *
 * Backlog.md lets a project declare any statuses it likes. A classifier that
 * compares against `'Done'` and `'In Progress'` puts every item of a project
 * with other words into its least-finished lane — finished work included. These
 * cases prove the vocabulary is read, from the files a project really has.
 */

describe('resolveWorkflow', () => {
  test("Backlog.md's defaults when a project declares nothing", () => {
    const wf = resolveWorkflow();
    assert.deepEqual(wf.statuses, BACKLOG_MD_DEFAULT_STATUSES);
    assert.deepEqual(wf.laneOrder, ['In Progress', 'To Do', 'Done']);
    assert.deepEqual(wf.doneStatuses, ['Done']);
    assert.deepEqual(wf.activeStatuses, ['In Progress']);
    assert.equal(wf.stageOf('To Do'), 'planned');
  });

  test('without laning settings, unfinished work reads most-advanced first and done comes last', () => {
    const wf = resolveWorkflow({ statuses: ['Idea', 'Doing', 'Checking', 'Shipped'] });
    assert.deepEqual(wf.laneOrder, ['Checking', 'Doing', 'Idea', 'Shipped']);
    assert.deepEqual(wf.doneStatuses, ['Shipped']);
    assert.deepEqual(wf.activeStatuses, ['Checking']);
    assert.equal(wf.stageOf('Idea'), 'later');
    assert.equal(wf.stageOf('Doing'), 'planned');
    assert.equal(wf.stageOf('Nope'), undefined);
  });

  test('refuses a setting it cannot honour, by name', () => {
    const statuses = ['Backlog', 'Doing', 'Done'];
    const refuses = (input: Parameters<typeof resolveWorkflow>[0], pattern: RegExp) =>
      assert.throws(() => resolveWorkflow(input), (e: unknown) => e instanceof WorkflowError && pattern.test(e.message));
    refuses({ statuses, laneOrder: ['Doing', 'Done'] }, /leaves out Backlog/);
    refuses({ statuses, laneOrder: ['Doing', 'Done', 'Backlog', 'Shipped'] }, /"Shipped", which is not a configured status/);
    refuses({ statuses, doneStatuses: ['Finished'] }, /workflow\.doneStatuses.*"Finished"/);
    refuses({ statuses, doneStatuses: statuses }, /at least one must be unfinished/);
    refuses({ statuses, doneStatuses: ['Done'], activeStatuses: ['Done'] }, /both an active and a done status/);
    refuses({ statuses, defaultStatus: 'To Do' }, /default status "To Do"/);
    refuses({ statuses: ['A', 'a'] }, /more than once/);
  });

  test('a wstatus has one spelling whatever separator it was written with', () => {
    for (const v of ['implemented_not_deployed', 'implemented-not-deployed', ' Implemented not deployed ']) {
      assert.equal(normalizeWstatus(v), 'implemented_not_deployed');
    }
    assert.equal(normalizeWstatus(undefined), '');
  });
});

const BACKLOG_CONFIG = `project_name: "Deployments"
default_status: "Backlog"
statuses:
  - "Backlog"
  - "Ready"
  - "In Progress"
  - "Review"
  - "Done - Local"
  - "Done - Integrated"
  - "Done - Production"
`;

const STORYMAP_CONFIG = `schemaVersion: 1
backlog:
  completedStatuses:
    - Done - Production
workflow:
  laneOrder:
    - In Progress
    - Review
    - Ready
    - Backlog
    - Done - Local
    - Done - Integrated
    - Done - Production
  doneStatuses: [Done - Local, Done - Integrated, Done - Production]
  activeStatuses: [In Progress, Review]
`;

const item = (id: string, status: string, wstatus?: string) => `---
id: ${id}
title: Story ${id}
status: ${status}
labels:
${wstatus ? `  - 'wstatus:${wstatus}'` : '  []'}
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
b
<!-- SECTION:DESCRIPTION:END -->
`;

const ITEMS: [string, string, string?][] = [
  ['S-1', 'Backlog'],
  ['S-2', 'Ready'],
  ['S-3', 'In Progress'],
  ['S-4', 'Review'],
  // Both spellings of the label that used to decide these, and none.
  ['S-5', 'Done - Local', 'implemented-not-deployed'],
  ['S-6', 'Done - Local', 'in-progress'],
  ['S-7', 'Done - Local'],
  ['S-8', 'Done - Integrated'],
  ['S-9', 'Done - Production'],
  ['S-10', 'Shipped'],
];

const MAP = `schemaVersion: 1
id: flow
title: Flow
kind: journey
releaseSlices:
  - id: only
    title: Only
    order: 1
activities:
  - id: a
    title: A
    steps:
      - id: s
        title: S
        slices:
          only:
${ITEMS.map(([id]) => `            - ${id}`).join('\n')}
`;

describe('a project with a deployment-aware status vocabulary', () => {
  let root: string;
  let server: Server;
  let base: string;

  const get = async (path: string) => {
    const response = await fetch(`${base}${path}`);
    return { status: response.status, body: await response.text() };
  };

  /** Lane id -> story ids drawn in it, in rendered order. */
  const wall = (body: string) => {
    const out = new Map<string, string[]>();
    for (const m of body.matchAll(/data-lane="([^"]+)" data-step="[^"]+">([\s\S]*?)<\/div>\s*(?=<div class="sm-(?:lane-label|cell)|<\/div>)/g)) {
      out.set(m[1], [...m[2].matchAll(/data-story="([^"]+)"/g)].map((s) => s[1]));
    }
    return out;
  };

  before(async () => {
    root = mkdtempSync(join(tmpdir(), 'storymap-vocabulary-'));
    mkdirSync(join(root, 'backlog/tasks'), { recursive: true });
    mkdirSync(join(root, 'backlog/story-maps'), { recursive: true });
    writeFileSync(join(root, 'backlog.config.yml'), BACKLOG_CONFIG);
    writeFileSync(join(root, 'storymap.config.yml'), STORYMAP_CONFIG);
    for (const [id, status, wstatus] of ITEMS) {
      writeFileSync(join(root, `backlog/tasks/${id.toLowerCase()} - s.md`), item(id, status, wstatus));
    }
    writeFileSync(join(root, 'backlog/story-maps/flow.yaml'), MAP);
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

  test('the configured statuses are read', () => {
    const wf = projectAt(root).workflow;
    assert.deepEqual(wf.laneOrder, ['In Progress', 'Review', 'Ready', 'Backlog', 'Done - Local', 'Done - Integrated', 'Done - Production']);
  });

  test('lanes render in the declared order, the three done levels last, production at the bottom', async () => {
    const { status, body } = await get('/maps/flow?lanes=workflow');
    assert.equal(status, 200);
    const titles = [...body.matchAll(/sm-lane-label__name">([^<]+)</g)].map((m) => m[1]);
    assert.deepEqual(titles, ['Unknown status', 'In Progress', 'Review', 'Ready', 'Backlog', 'Done - Local', 'Done - Integrated', 'Done - Production']);
  });

  test('every item is in the lane of its own status; none of the done items is in Backlog', async () => {
    const lanes = wall((await get('/maps/flow?lanes=workflow')).body);
    assert.deepEqual(lanes.get('status:Backlog'), ['S-1']);
    assert.deepEqual(lanes.get('status:Review'), ['S-4']);
    assert.deepEqual(lanes.get('status:Done - Local'), ['S-5', 'S-6', 'S-7']);
    assert.deepEqual(lanes.get('status:Done - Integrated'), ['S-8']);
    assert.deepEqual(lanes.get('status:Done - Production'), ['S-9']);
    assert.deepEqual(lanes.get('status-unknown'), ['S-10'], 'an undeclared status is shown as unknown');
  });

  test('a project whose laning names a status it does not have is refused, not misdrawn', () => {
    writeFileSync(join(root, 'storymap.config.yml'), STORYMAP_CONFIG.replace('    - Review\n', '    - Reviewing\n'));
    try {
      assert.throws(() => projectAt(root), (e: unknown) => e instanceof ConfigError && /"Reviewing", which is not a configured status/.test(e.message));
    } finally {
      writeFileSync(join(root, 'storymap.config.yml'), STORYMAP_CONFIG);
    }
  });
});
