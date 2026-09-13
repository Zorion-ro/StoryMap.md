import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/server';
import { projectAt } from '../src/project/config';

function story(id: string, o: { status: string; owner?: string; wtype?: string; milestone?: string; completed?: boolean }): string {
  return `---
id: ${id}
title: Story ${id}
status: ${o.status}
created_date: '2026-08-01 10:00'
labels:
${o.owner ? `  - 'owner:${o.owner}'\n` : ''}  - 'wtype:${o.wtype ?? 'feature'}'
  - 'priority:p2'
${o.milestone ? `milestone: ${o.milestone}\n` : ''}dependencies: []
priority: medium
---

Body of ${id}.
`;
}

const STORIES: [string, Parameters<typeof story>[1]][] = [
  ['FW-001', { status: 'Backlog', owner: 'platform', wtype: 'defect', milestone: 'm-0' }],
  ['FW-002', { status: 'Ready', owner: 'platform', wtype: 'feature', milestone: 'm-1' }],
  ['FW-003', { status: 'In Progress', owner: 'backend', wtype: 'feature', milestone: 'm-0' }],
  ['FW-004', { status: 'Done', owner: 'platform', wtype: 'defect', milestone: 'm-2' }],
  ['FW-005', { status: 'Cancelled', wtype: 'chore', milestone: 'm-1' }],
  ['FW-006', { status: 'Backlog', owner: 'backend', wtype: 'defect' }],
];

const MAP = `schemaVersion: 1
id: seller
title: Seller journey
kind: journey
releaseSlices:
  - id: first
    title: First
    order: 10
activities:
  - id: start
    title: Start
    steps:
      - id: sign-in
        title: Sign in
        slices:
          first:
            - FW-001
            - FW-002
`;

let root: string;
let server: Server;
let base: string;

const get = async (path: string) => {
  const res = await fetch(base + path);
  return { status: res.status, body: await res.text() };
};
const shown = (body: string) => Number(/<strong>(\d+)<\/strong> shown of/.exec(body)?.[1]);
const listed = (body: string) => [...body.matchAll(/<tr class="row"[^>]*data-id="([^"]+)"/g)].map((m) => m[1]);
const cards = (body: string) => [...body.matchAll(/<article class="kb-card[^"]*"[^>]*data-id="([^"]+)"/g)].map((m) => m[1]);
const bulk = (body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + '/api/stories/bulk', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, json: (await r.json()) as Record<string, any> }));
const read = (id: string) => readFileSync(join(root, `backlog/tasks/${id.toLowerCase()}.md`), 'utf8');

describe('stories page: filters, views, selection and bulk edit', () => {
  before(async () => {
    root = mkdtempSync(join(tmpdir(), 'sm-stories-'));
    for (const d of ['backlog/tasks', 'backlog/milestones', 'backlog/story-maps']) mkdirSync(join(root, d), { recursive: true });
    for (const [id, o] of STORIES) writeFileSync(join(root, `backlog/tasks/${id.toLowerCase()}.md`), story(id, o));
    for (const m of ['m-0', 'm-1', 'm-2']) writeFileSync(join(root, `backlog/milestones/${m}.md`), `---\nid: ${m}\ntitle: Milestone ${m}\n---\n`);
    writeFileSync(join(root, 'backlog/story-maps/seller.yaml'), MAP);
    writeFileSync(join(root, 'backlog.config.yml'), 'statuses: ["Backlog", "Ready", "In Progress", "Done"]\n');
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

  // ------------------------------------------------------------- filtering

  test('acceptance 1: status IS NOT Done', async () => {
    assert.deepEqual(listed((await get('/?status=Done&status.op=not')).body), ['FW-001', 'FW-002', 'FW-003', 'FW-005', 'FW-006']);
  });

  test('acceptance 2: status IS Backlog OR Ready OR In Progress', async () => {
    assert.deepEqual(listed((await get('/?status=Backlog&status=Ready&status=In+Progress')).body), ['FW-001', 'FW-002', 'FW-003', 'FW-006']);
  });

  test('acceptance 3: wtype IS defect OR feature AND owner IS platform', async () => {
    assert.deepEqual(listed((await get('/?wtype=defect&wtype=feature&owner=platform')).body), ['FW-001', 'FW-002', 'FW-004']);
  });

  test('acceptance 4: status NOT IN [Done, Cancelled] AND milestone IN [m-0, m-1]', async () => {
    const { body } = await get('/?status=Done&status=Cancelled&status.op=not&milestone=m-0&milestone=m-1');
    assert.deepEqual(listed(body), ['FW-001', 'FW-002', 'FW-003']);
  });

  test('old single-value URLs and the old empty "all" values still work', async () => {
    assert.equal(shown((await get('/?status=Backlog')).body), 2);
    assert.equal(shown((await get('/?map=none')).body), 4);
    assert.equal(shown((await get('/?milestone=none')).body), 1);
    assert.equal(shown((await get('/?state=active&status=&owner=&map=')).body), 6);
    assert.equal(shown((await get('/?priority=medium')).body), 6, 'native priority still matches');
  });

  test('the filter bar renders the operator and values so the state is visible at a glance', async () => {
    const { body } = await get('/?status=Done&status=Cancelled&status.op=not&owner=platform');
    assert.match(body, /class="mf mf--active mf--not" data-field="status"/);
    assert.match(body, /data-field="status">[\s\S]*?<span class="mf__op">is not<\/span><span class="mf__vals">Done, Cancelled<\/span>/);
    assert.match(body, /class="mf mf--active mf--in" data-field="owner"/);
    assert.match(body, /name="status.op" value="not" checked/);
    assert.match(body, /name="status" value="Done" checked/);
    assert.match(body, /data-field="area">[\s\S]*?<span class="mf__any">any<\/span>/);
  });

  test('a value named in the URL but absent from the estate stays visible and checked', async () => {
    const { body } = await get('/?owner=ghost');
    assert.equal(shown(body), 0);
    assert.match(body, /name="owner" value="ghost" checked/);
  });

  // ----------------------------------------------------------------- views

  test('acceptance 8/10: list and kanban links carry every filter, and only the view changes', async () => {
    const list = (await get('/?status=Done&status.op=not&milestone=m-0')).body;
    assert.ok(list.includes('href="/?status=Done&amp;status.op=not&amp;milestone=m-0&amp;view=kanban">Kanban</a>'));
    const kanban = (await get('/?status=Done&status.op=not&milestone=m-0&view=kanban')).body;
    assert.ok(kanban.includes('href="/?status=Done&amp;status.op=not&amp;milestone=m-0" class="on"') === false);
    assert.ok(kanban.includes('href="/?status=Done&amp;status.op=not&amp;milestone=m-0">List</a>'));
    assert.deepEqual(cards(kanban).sort(), listed(list).sort(), 'same filtered dataset in both views');
    assert.ok(kanban.includes('<input type="hidden" name="view" value="kanban" />'), 'Apply keeps the kanban view');
    assert.ok(kanban.includes('href="/?view=kanban">Reset</a>'), 'Reset clears filters, not the view');
    assert.ok(list.includes('href="/">Reset</a>'));
  });

  test('kanban columns follow backlog.config.yml order, hide excluded statuses, and show undeclared ones', async () => {
    const { body } = await get('/?view=kanban&status=Done&status.op=not');
    const columns = [...body.matchAll(/<section class="kb-col[^"]*" data-status="([^"]+)"[^>]*data-droppable="(\d)"/g)].map((m) => `${m[1]}:${m[2]}`);
    assert.deepEqual(columns, ['Backlog:1', 'Ready:1', 'In Progress:1', 'Cancelled:0']);
    assert.match(body, /data-status="Backlog"[\s\S]*?data-id="FW-001"[\s\S]*?data-id="FW-006"/);
    assert.match(body, /draggable="true" data-id="FW-001"/);
  });

  test('kanban milestone lanes mark each drop target with its milestone', async () => {
    const { body } = await get('/?view=kanban&lanes=milestone');
    assert.match(body, /<div class="kb-lane" data-milestone="m-0">/);
    assert.match(body, /data-status="Ready" data-milestone="m-1" data-droppable="1"/);
    assert.match(body, /<div class="kb-lane" data-milestone="">[\s\S]*?No milestone/);
  });

  test('selection controls are scoped to the stories shown', async () => {
    const { body } = await get('/?owner=platform');
    assert.equal((body.match(/<input type="checkbox" class="sel"/g) ?? []).length, 3);
    assert.ok(body.includes('Select all 3 shown'));
    assert.ok(body.includes('of the 3 stories shown'));
    assert.ok(body.includes('<script src="/static/selection.js" defer></script>'));
    assert.equal((await get('/static/stories.js')).status, 200);
    assert.equal((await get('/static/selection.js')).status, 200);
    assert.equal((await get('/static/../server.ts')).status, 404);
  });

  // ------------------------------------------------------------- bulk edit

  test('dry run describes the change and writes nothing', async () => {
    const before = read('FW-001');
    const { status, json } = await bulk({ ids: ['FW-001', 'FW-002'], changes: { owner: 'backend', priority: 'p1' }, dryRun: true });
    assert.equal(status, 200);
    assert.equal(json.changedCount, 2);
    assert.equal(typeof json.token, 'string');
    assert.deepEqual(json.items[0].changes, [
      { field: 'owner', from: 'platform', to: 'backend' },
      { field: 'priority', from: 'p2', to: 'p1' },
    ]);
    assert.equal(read('FW-001'), before);
  });

  test('acceptance 6: one bulk operation changes several fields on several stories, nothing else', async () => {
    const before = read('FW-006');
    const review = await bulk({ ids: ['FW-003', 'FW-006'], changes: { owner: 'platform', priority: 'p1' }, dryRun: true });
    const { status, json } = await bulk({ ids: ['FW-003', 'FW-006'], changes: { owner: 'platform', priority: 'p1' }, token: review.json.token });
    assert.equal(status, 200, JSON.stringify(json));
    assert.equal(json.changedCount, 2);
    const after = read('FW-006');
    assert.equal(
      after.replace(/updated_date: '[^']+'\n/, ''),
      before.replace("  - 'owner:backend'", "  - 'owner:platform'").replace("  - 'priority:p2'", "  - 'priority:p1'"),
    );
    assert.deepEqual(listed((await get('/?owner=platform&priority=p1')).body), ['FW-003', 'FW-006'], 'the page reflects the write at once');
  });

  test('acceptance 7: explicit clear of milestone and map', async () => {
    const { status, json } = await bulk({ ids: ['FW-001'], changes: { milestone: null, map: null } });
    assert.equal(status, 200, JSON.stringify(json));
    assert.ok(!read('FW-001').includes('milestone:'));
    assert.ok(!readFileSync(join(root, 'backlog/story-maps/seller.yaml'), 'utf8').includes('FW-001'));
    // FW-006 never had either.
    assert.deepEqual(listed((await get('/?map=none&milestone=none')).body), ['FW-001', 'FW-006']);
  });

  test('a validation failure is a 422 naming the problem, and nothing is written', async () => {
    const before = read('FW-002');
    const bad = await bulk({ ids: ['FW-002', 'FW-404'], changes: { status: 'Shipped' } });
    assert.equal(bad.status, 422);
    assert.match(bad.json.fieldErrors[0].message, /"Shipped" is not a status/);
    assert.equal(bad.json.items.find((i: { id: string }) => i.id === 'FW-404').error, 'no work item claims this id');
    assert.equal(read('FW-002'), before);
    const shape = await bulk({ ids: 'FW-002', changes: {} });
    assert.equal(shape.status, 400);
  });

  test('applying a stale review is a 409 conflict', async () => {
    const review = await bulk({ ids: ['FW-002'], changes: { wtype: 'chore' }, dryRun: true });
    writeFileSync(join(root, 'backlog/tasks/fw-002.md'), read('FW-002').replace('Body of FW-002.', 'Edited by someone else.'));
    const stale = await bulk({ ids: ['FW-002'], changes: { wtype: 'chore' }, token: review.json.token });
    assert.equal(stale.status, 409);
    assert.ok(read('FW-002').includes("'wtype:feature'"));
  });

  test('a kanban move is the same validated update: status (and lane milestone) only', async () => {
    const moved = await bulk({ ids: ['FW-002'], changes: { status: 'In Progress', milestone: 'm-0' } });
    assert.equal(moved.status, 200);
    const { body } = await get('/?view=kanban&lanes=milestone');
    assert.match(body, /data-status="In Progress" data-milestone="m-0"[\s\S]*?data-id="FW-002"/);
    const refused = await bulk({ ids: ['FW-002'], changes: { status: 'Cancelled' } });
    assert.equal(refused.status, 422, 'an undeclared column is not a valid target');
  });

  test('mutations refuse cross-origin requests, foreign hosts and non-JSON bodies', async () => {
    const body = { ids: ['FW-002'], changes: { wtype: 'chore' } };
    assert.equal((await bulk(body, { origin: 'https://evil.example' })).status, 403);
    const form = await fetch(base + '/api/stories/bulk', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(body) });
    assert.equal(form.status, 415);
    const { request } = await import('node:http');
    const port = (server.address() as AddressInfo).port;
    const rebind = await new Promise<number>((resolve) => {
      const req = request({ host: '127.0.0.1', port, path: '/api/stories/bulk', method: 'POST', headers: { host: 'evil.example', 'content-type': 'application/json' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.end(JSON.stringify(body));
    });
    assert.equal(rebind, 403);
    assert.ok(read('FW-002').includes("'wtype:feature'"));
  });
});
