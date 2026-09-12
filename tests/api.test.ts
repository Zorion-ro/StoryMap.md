import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { request } from 'node:http';
import type { Server } from 'node:http';
import { createApp } from '../src/server';
import { projectAt } from '../src/project/config';
import { ERROR_CODES } from '../src/api';
import type { ApiAccess } from '../src/api';

/**
 * The machine API over real HTTP, against a scratch Backlog.md project.
 *
 * Every mutating suite gets its own project so tests cannot see each other's
 * writes, and asserts on the files as well as the responses: the Markdown is
 * the only store, so a response that disagrees with the file is a failure.
 */

const CONFIG = `project_name: "Scratch"
default_status: "Backlog"
statuses: ["Backlog", "Ready", "In Progress", "Done", "Cancelled"]
types: ["story", "bug", "task"]
task_prefix: "FW"
zero_padded_ids: 3
definition_of_done:
  - "Meets the Definition of Done"
`;

interface Spec {
  id: string;
  status: string;
  labels?: string[];
  milestone?: string;
  deps?: string[];
  priority?: string;
  title?: string;
  completed?: boolean;
  created?: string;
}

function story(s: Spec): string {
  const labels = s.labels ?? [];
  return [
    '---',
    `id: ${s.id}`,
    `title: ${s.title ?? `Story ${s.id}`}`,
    `status: ${s.status}`,
    'assignee: []',
    `created_date: '${s.created ?? '2026-08-01 10:00'}'`,
    labels.length ? `labels:\n${labels.map((l) => `  - '${l}'`).join('\n')}` : 'labels: []',
    ...(s.milestone ? [`milestone: ${s.milestone}`] : []),
    (s.deps ?? []).length ? `dependencies:\n${s.deps!.map((d) => `  - ${d}`).join('\n')}` : 'dependencies: []',
    ...(s.priority ? [`priority: ${s.priority}`] : []),
    'type: story',
    '---',
    '',
    '## Description',
    '',
    '<!-- SECTION:DESCRIPTION:BEGIN -->',
    `Body of ${s.id}.`,
    '<!-- SECTION:DESCRIPTION:END -->',
    '',
  ].join('\n');
}

const STORIES: Spec[] = [
  { id: 'FW-001', status: 'Done', completed: true, labels: ['area:auth', 'owner:platform', 'priority:p1', 'wstatus:done', 'wtype:feature'], milestone: 'm-0', priority: 'high' },
  { id: 'FW-002', status: 'Backlog', labels: ['area:auth', 'owner:platform', 'priority:p2', 'risk:medium', 'wtype:defect'], milestone: 'm-0', deps: ['FW-001'], priority: 'medium' },
  { id: 'FW-003', status: 'Ready', labels: ['area:checkout', 'owner:frontend', 'priority:p1', 'wtype:defect'], priority: 'low' },
  { id: 'FW-004', status: 'In Progress', labels: ['area:checkout', 'owner:backend', 'priority:p3', 'risk:high', 'wtype:feature'], milestone: 'm-1' },
  { id: 'FW-005', status: 'Done', labels: ['area:deploy', 'owner:platform', 'priority:p2', 'wtype:defect'], milestone: 'm-0' },
  { id: 'FW-006', status: 'Cancelled', labels: ['owner:frontend', 'wtype:defect'] },
  { id: 'FW-007', status: 'Backlog', labels: ['owner:platform', 'priority:p1', 'wtype:chore'], milestone: 'm-1' },
  { id: 'FW-008', status: 'Ready', labels: ['owner:backend', 'priority:p2', 'wtype:defect'], title: 'Needle in the haystack' },
  { id: 'FW-009', status: 'Backlog', labels: [] },
  { id: 'FW-010', status: 'In Progress', labels: ['owner:platform', 'wtype:feature'] },
  { id: 'FW-011', status: 'Backlog', labels: ['owner:frontend'] },
  { id: 'FW-012', status: 'Ready', labels: ['owner:platform', 'priority:p2', 'wtype:defect'] },
];

const MAP = `schemaVersion: 1
id: checkout
title: Checkout
kind: journey
releaseSlices:
  - id: now
    title: Now
    order: 10
activities:
  - id: pay
    title: Pay
    steps:
      - id: total
        title: See the total
        slices:
          now:
            - FW-003
            - FW-004
        supporting:
          - FW-002
`;

const scratch: string[] = [];
after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'sm-api-'));
  scratch.push(root);
  for (const dir of ['backlog/tasks', 'backlog/completed', 'backlog/milestones', 'backlog/story-maps']) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  writeFileSync(join(root, 'backlog.config.yml'), CONFIG);
  for (const s of STORIES) {
    const dir = s.completed ? 'completed' : 'tasks';
    writeFileSync(join(root, 'backlog', dir, `${s.id.toLowerCase()} - Story.md`), story(s));
  }
  writeFileSync(join(root, 'backlog/milestones/m-0 - first.md'), '---\nid: m-0\ntitle: "First"\n---\n');
  writeFileSync(join(root, 'backlog/milestones/m-1 - second.md'), '---\nid: m-1\ntitle: "Second"\n---\n');
  writeFileSync(join(root, 'backlog/story-maps/checkout.yaml'), MAP);
  return root;
}

interface Client {
  root: string;
  base: string;
  call: (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; body: any; headers: Headers; text: string }>;
  file: (id: string) => string;
  close: () => Promise<void>;
}

async function start(access: ApiAccess = {}, root = makeProject()): Promise<Client> {
  const { app } = createApp(projectAt(root), access);
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    root,
    base,
    async call(method, path, body, headers = {}) {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
        ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
      return { status: res.status, body: parsed, headers: res.headers, text };
    },
    file(id) {
      for (const dir of ['tasks', 'completed']) {
        const d = join(root, 'backlog', dir);
        const name = readdirSync(d).find((n) => n.toLowerCase().startsWith(`${id.toLowerCase()} - `));
        if (name) return readFileSync(join(d, name), 'utf8');
      }
      throw new Error(`no file for ${id}`);
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const API = '/api/v1/storymap';
const ids = (body: { items: { id: string }[] }) => body.items.map((i) => i.id);

function assertError(res: { status: number; body: any }, status: number, code: string) {
  assert.equal(res.status, status, `expected ${status} ${code}, got ${res.status} ${JSON.stringify(res.body)}`);
  assert.equal(res.body?.error?.code, code);
  assert.equal(typeof res.body.error.message, 'string');
}

// ---------------------------------------------------------------------------

describe('discovery, metadata and OpenAPI', () => {
  let c: Client;
  before(async () => {
    c = await start();
  });
  after(() => c.close());

  test('the root names every other endpoint', async () => {
    const res = await c.call('GET', API);
    assert.equal(res.status, 200);
    assert.equal(res.body.apiVersion, 'v1');
    assert.equal(res.body.metadata, `${API}/meta`);
    assert.equal(res.body.stories, `${API}/stories`);
    assert.equal(res.body.documentation, `${API}/openapi.json`);
    assert.match(res.headers.get('content-type') ?? '', /application\/json; charset=utf-8/);
  });

  test('meta exposes current values for enumerated fields', async () => {
    const { body } = await c.call('GET', `${API}/meta`);
    assert.deepEqual(body.writableStatuses, ['Backlog', 'Ready', 'In Progress', 'Done', 'Cancelled']);
    assert.deepEqual(body.owners, ['backend', 'frontend', 'platform']);
    assert.deepEqual(body.priorities, ['p1', 'p2', 'p3']);
    assert.deepEqual(body.backlogPriorities, ['high', 'medium', 'low']);
    assert.deepEqual(body.milestones.map((m: { id: string }) => m.id), ['m-0', 'm-1']);
    assert.deepEqual(body.maps.map((m: { id: string }) => m.id), ['checkout']);
    assert.equal(body.fields.owner.counts.platform, 6);
    assert.equal(body.bulk.maxIds, 200);
    assert.equal(body.pagination.maxLimit, 500);
    assert.ok(body.errors.some((e: { code: string }) => e.code === 'REVISION_CONFLICT'));
  });

  test('meta says which fields are writable and nullable', async () => {
    const { fields } = (await c.call('GET', `${API}/meta`)).body;
    assert.equal(fields.status.writable, true);
    assert.equal(fields.status.nullable, false);
    assert.equal(fields.owner.writable, true);
    assert.equal(fields.owner.nullable, true);
    assert.equal(fields.owner.vocabulary, 'open');
    assert.equal(fields.milestone.nullable, true);
    assert.equal(fields.id.writable, false);
    assert.equal(fields.state.writable, false);
    assert.equal(fields.maps.writable, false);
    assert.equal(fields.revision.writable, false);
    assert.deepEqual(fields.status.filter, { include: 'status', exclude: 'status_not' });
    assert.equal(fields.labels.setOperations, true);
  });

  test('the OpenAPI document loads and describes every route', async () => {
    const res = await c.call('GET', `${API}/openapi.json`);
    assert.equal(res.status, 200);
    const doc = res.body;
    assert.equal(doc.openapi, '3.1.0');
    const operations = Object.values(doc.paths).flatMap((p: any) => Object.values(p).map((o: any) => o.operationId));
    for (const op of ['discover', 'getMeta', 'getOpenApi', 'listStories', 'getStory', 'createStory', 'updateStory', 'bulkUpdateStories']) {
      assert.ok(operations.includes(op), `missing ${op}`);
    }
    const story = doc.components.schemas.Story;
    assert.deepEqual(story.properties.status.enum, ['Backlog', 'Ready', 'In Progress', 'Done', 'Cancelled']);
    assert.deepEqual(story.properties.milestone.type, ['string', 'null']);
    assert.deepEqual(doc.components.schemas.Error.properties.error.properties.code.enum, Object.keys(ERROR_CODES));
    const params = doc.paths[`${API}/stories`].get.parameters.map((p: { name: string }) => p.name);
    for (const p of ['status', 'status_not', 'wtype', 'owner_not', 'limit', 'cursor', 'sort']) assert.ok(params.includes(p), `missing ${p}`);
    assert.ok(doc.components.securitySchemes.bearer);
  });

  test('an unknown API route is a JSON 404, not an HTML page', async () => {
    const res = await c.call('GET', `${API}/nope`);
    assertError(res, 404, 'ROUTE_NOT_FOUND');
  });
});

describe('reading stories', () => {
  let c: Client;
  before(async () => {
    c = await start();
  });
  after(() => c.close());

  test('lists every story with the canonical shape', async () => {
    const { status, body } = await c.call('GET', `${API}/stories`);
    assert.equal(status, 200);
    assert.equal(body.total, 12);
    assert.equal(body.count, 12);
    assert.equal(body.nextCursor, null);
    const first = body.items[0];
    assert.equal(first.id, 'FW-001');
    assert.equal(first.state, 'completed');
    assert.equal(first.owner, 'platform');
    assert.equal(first.priority, 'p1');
    assert.equal(first.backlogPriority, 'high');
    assert.equal(first.createdAt, '2026-08-01T10:00:00Z');
    assert.equal(first.updatedAt, null);
    assert.deepEqual(first.dependents, ['FW-002']);
    const nine = body.items.find((i: { id: string }) => i.id === 'FW-009');
    assert.equal(nine.owner, null, 'absent is null, not missing');
    assert.deepEqual(nine.labels, []);
    assert.equal(nine.milestone, null);
  });

  test('gets one story, with an ETag of its revision', async () => {
    const res = await c.call('GET', `${API}/stories/FW-002`);
    assert.equal(res.status, 200);
    assert.equal(res.body.id, 'FW-002');
    assert.equal(res.body.body, 'Body of FW-002.');
    assert.deepEqual(res.body.dependencies, ['FW-001']);
    assert.deepEqual(res.body.maps, [{ id: 'checkout', role: 'supporting' }]);
    assert.equal(res.headers.get('etag'), `"${res.body.revision}"`);
    assert.match(res.body.revision, /^[0-9a-f]{20}$/);
  });

  test('ids resolve case- and padding-insensitively', async () => {
    assert.equal((await c.call('GET', `${API}/stories/fw-2`)).body.id, 'FW-002');
  });

  test('a missing story is a 404 with a code', async () => {
    assertError(await c.call('GET', `${API}/stories/FW-999`), 404, 'STORY_NOT_FOUND');
  });

  test('pages with a cursor until the end, with no gaps or repeats', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res: { body: { items: { id: string }[]; nextCursor: string | null; total: number; count: number } } = await c.call(
        'GET',
        `${API}/stories?limit=5${cursor ? `&cursor=${cursor}` : ''}`,
      );
      assert.equal(res.body.total, 12);
      seen.push(...ids(res.body));
      cursor = res.body.nextCursor;
      pages += 1;
    } while (cursor);
    assert.equal(pages, 3);
    assert.deepEqual(seen, STORIES.map((s) => s.id));
  });

  test('a cursor survives a story being created between pages', async () => {
    const first = (await c.call('GET', `${API}/stories?sort=title&limit=4`)).body;
    const created = await c.call('POST', `${API}/stories`, { title: 'AAA sorts first' });
    assert.equal(created.status, 201);
    const second = (await c.call('GET', `${API}/stories?sort=title&limit=4&cursor=${first.nextCursor}`)).body;
    assert.equal(ids(second).some((id: string) => ids(first).includes(id)), false, 'no repeats');
  });

  test('a cursor stays valid when the same filters are sent in a different order', async () => {
    const first = (await c.call('GET', `${API}/stories?owner=platform,frontend&status_not=Done&limit=2`)).body;
    const next = await c.call('GET', `${API}/stories?status_not=Done&owner=frontend,platform&limit=2&cursor=${first.nextCursor}`);
    assert.equal(next.status, 200, JSON.stringify(next.body));
    assert.equal(ids(next.body).some((id: string) => ids(first).includes(id)), false);
  });

  test('sorts by a field in either order, nulls last', async () => {
    const asc = ids((await c.call('GET', `${API}/stories?sort=priority&order=asc&fields=priority&wtype=defect`)).body);
    assert.deepEqual(asc, ['FW-003', 'FW-002', 'FW-005', 'FW-008', 'FW-012', 'FW-006']);
    const status = ids((await c.call('GET', `${API}/stories?sort=status&order=desc&status=Backlog,Cancelled`)).body);
    assert.equal(status[0], 'FW-006', 'Cancelled comes after Backlog in declared order');
  });

  test('projects fields', async () => {
    const { body } = await c.call('GET', `${API}/stories?fields=title,status&limit=1`);
    assert.deepEqual(Object.keys(body.items[0]).sort(), ['id', 'status', 'title']);
  });

  test('refuses a bad limit, sort, cursor or projection', async () => {
    assertError(await c.call('GET', `${API}/stories?limit=0`), 400, 'INVALID_LIMIT');
    assertError(await c.call('GET', `${API}/stories?limit=501`), 400, 'INVALID_LIMIT');
    assertError(await c.call('GET', `${API}/stories?sort=body`), 400, 'INVALID_SORT');
    assertError(await c.call('GET', `${API}/stories?order=up`), 400, 'INVALID_SORT');
    assertError(await c.call('GET', `${API}/stories?cursor=garbage`), 400, 'INVALID_CURSOR');
    const page = (await c.call('GET', `${API}/stories?limit=2`)).body;
    assertError(await c.call('GET', `${API}/stories?limit=2&status=Ready&cursor=${page.nextCursor}`), 400, 'INVALID_CURSOR');
    assertError(await c.call('GET', `${API}/stories?fields=nope`), 422, 'INVALID_FIELD');
  });
});

describe('filters', () => {
  let c: Client;
  before(async () => {
    c = await start();
  });
  after(() => c.close());
  const list = async (query: string) => {
    const res = await c.call('GET', `${API}/stories?${query}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return ids(res.body);
  };

  test('one include', async () => {
    assert.deepEqual(await list('status=Ready'), ['FW-003', 'FW-008', 'FW-012']);
  });

  test('several includes on one field are ORed, by comma or repetition', async () => {
    assert.deepEqual(await list('status=Ready,Cancelled'), ['FW-003', 'FW-006', 'FW-008', 'FW-012']);
    assert.deepEqual(await list('status=Ready&status=Cancelled'), ['FW-003', 'FW-006', 'FW-008', 'FW-012']);
  });

  test('one exclusion', async () => {
    assert.deepEqual(await list('wtype=defect&status_not=Done'), ['FW-002', 'FW-003', 'FW-006', 'FW-008', 'FW-012']);
  });

  test('several exclusions are NOT IN', async () => {
    assert.deepEqual(await list('wtype=defect&status_not=Done,Cancelled'), ['FW-002', 'FW-003', 'FW-008', 'FW-012']);
  });

  test('different fields are ANDed', async () => {
    assert.deepEqual(await list('owner=platform&priority=p1,p2'), ['FW-001', 'FW-002', 'FW-005', 'FW-007', 'FW-012']);
    assert.deepEqual(await list('wtype=defect,feature&owner=platform&status_not=Done,Cancelled'), ['FW-002', 'FW-010', 'FW-012']);
  });

  test('include and exclude on the same field combine', async () => {
    assert.deepEqual(await list('status=Ready,Backlog&status_not=Backlog'), ['FW-003', 'FW-008', 'FW-012']);
    assert.deepEqual(await list('status=Ready&status_not=Ready'), []);
  });

  test('none means no value', async () => {
    assert.deepEqual(await list('milestone=none&owner=platform'), ['FW-010', 'FW-012']);
    assert.deepEqual(await list('wtype_not=none&owner=frontend'), ['FW-003', 'FW-006']);
    assert.deepEqual(await list('map=checkout'), ['FW-002', 'FW-003', 'FW-004']);
  });

  test('state, id, label, dependency, backlogPriority and text', async () => {
    assert.deepEqual(await list('state=completed'), ['FW-001']);
    assert.deepEqual(await list('id=fw-3,FW-004'), ['FW-003', 'FW-004']);
    assert.deepEqual(await list('label=risk:medium'), ['FW-002']);
    assert.deepEqual(await list('dependency=FW-001'), ['FW-002']);
    assert.deepEqual(await list('backlogPriority=high,low'), ['FW-001', 'FW-003']);
    assert.deepEqual(await list('text=needle'), ['FW-008']);
    assert.deepEqual(await list('q=NEEDLE'), ['FW-008']);
  });

  test('priority follows the browser: the label scale, with high/medium/low falling back to native', async () => {
    assert.deepEqual(await list('priority=high'), ['FW-001']);
  });

  test('an empty filter value is no condition', async () => {
    assert.equal((await list('status=&owner=')).length, 12);
  });

  test('an unknown parameter or an impossible value is INVALID_FILTER with the allowed values', async () => {
    const unknown = await c.call('GET', `${API}/stories?colour=red`);
    assertError(unknown, 400, 'INVALID_FILTER');
    assert.ok(unknown.body.error.allowedValues.includes('status_not'));
    const bad = await c.call('GET', `${API}/stories?status=Doing`);
    assertError(bad, 400, 'INVALID_FILTER');
    assert.equal(bad.body.error.field, 'status');
    assert.ok(bad.body.error.allowedValues.includes('In Progress'));
    assertError(await c.call('GET', `${API}/stories?state=open`), 400, 'INVALID_FILTER');
    assertError(await c.call('GET', `${API}/stories?milestone=m-9`), 400, 'INVALID_FILTER');
  });
});

describe('creating stories', () => {
  let c: Client;
  before(async () => {
    c = await start();
  });
  after(() => c.close());

  test('allocates the next id, writes a Backlog.md file, and answers 201 with Location', async () => {
    const res = await c.call('POST', `${API}/stories`, {
      title: 'Dealer rating support',
      body: 'Let buyers rate dealers.',
      wtype: 'feature',
      priority: 'p2',
      backlogPriority: 'Medium',
      area: 'checkout',
      owner: 'frontend',
      milestone: 'm-0',
      dependencies: ['fw-3'],
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const s = res.body.story;
    assert.equal(s.id, 'FW-013');
    assert.equal(res.headers.get('location'), `${API}/stories/FW-013`);
    assert.equal(s.status, 'Backlog', 'default_status from backlog.config.yml');
    assert.equal(s.owner, 'frontend');
    assert.equal(s.backlogPriority, 'medium');
    assert.deepEqual(s.labels, ['area:checkout', 'owner:frontend', 'priority:p2', 'wtype:feature']);
    assert.deepEqual(s.dependencies, ['FW-003']);
    assert.equal(s.definitionOfDone[0].text, 'Meets the Definition of Done');
    assert.ok(existsSync(join(c.root, 'backlog/tasks/fw-013 - Dealer-rating-support.md')));
    assert.equal((await c.call('GET', `${API}/stories/FW-013`)).body.revision, s.revision);
  });

  test('dry run validates and allocates nothing', async () => {
    const before = readdirSync(join(c.root, 'backlog/tasks')).length;
    const res = await c.call('POST', `${API}/stories?dryRun=true`, { title: 'Just checking' });
    assert.equal(res.status, 200);
    assert.equal(res.body.dryRun, true);
    assert.equal(readdirSync(join(c.root, 'backlog/tasks')).length, before);
  });

  test('a client cannot choose the id', async () => {
    const res = await c.call('POST', `${API}/stories`, { id: 'FW-500', title: 'Mine' });
    assertError(res, 422, 'FIELD_NOT_WRITABLE');
  });

  test('title is required', async () => {
    assertError(await c.call('POST', `${API}/stories`, { status: 'Ready' }), 422, 'REQUIRED_FIELD');
  });

  test('an invalid enum value is refused with the allowed values', async () => {
    const res = await c.call('POST', `${API}/stories`, { title: 'x', status: 'Doing' });
    assertError(res, 422, 'INVALID_STATUS');
    assert.deepEqual(res.body.error.allowedValues, ['Backlog', 'Ready', 'In Progress', 'Done', 'Cancelled']);
    assertError(await c.call('POST', `${API}/stories`, { title: 'x', type: 'epic' }), 422, 'INVALID_TYPE');
    assertError(await c.call('POST', `${API}/stories`, { title: 'x', backlogPriority: 'P1' }), 422, 'INVALID_BACKLOG_PRIORITY');
  });

  test('several problems come back together', async () => {
    const res = await c.call('POST', `${API}/stories`, { title: '', status: 'Doing', colour: 'red' });
    assertError(res, 422, 'VALIDATION_ERROR');
    assert.deepEqual(res.body.errors.map((e: { code: string }) => e.code).sort(), ['INVALID_FIELD', 'INVALID_STATUS', 'INVALID_VALUE']);
  });

  test('an Idempotency-Key replays the first result instead of creating twice', async () => {
    const body = { title: 'Created once' };
    const first = await c.call('POST', `${API}/stories`, body, { 'Idempotency-Key': 'k-1' });
    const again = await c.call('POST', `${API}/stories`, body, { 'Idempotency-Key': 'k-1' });
    assert.equal(first.status, 201);
    assert.equal(again.status, 201);
    assert.equal(again.body.story.id, first.body.story.id);
    assert.equal(again.headers.get('idempotent-replayed'), 'true');
    const matches = readdirSync(join(c.root, 'backlog/tasks')).filter((n) => n.includes('Created-once'));
    assert.equal(matches.length, 1);
    assertError(await c.call('POST', `${API}/stories`, { title: 'Different' }, { 'Idempotency-Key': 'k-1' }), 409, 'IDEMPOTENCY_KEY_REUSED');
  });

  test('malformed JSON and a non-object body are 400 in JSON', async () => {
    assertError(await c.call('POST', `${API}/stories`, '{nope'), 400, 'MALFORMED_REQUEST');
    assertError(await c.call('POST', `${API}/stories`, '[1,2]'), 400, 'MALFORMED_REQUEST');
  });
});

describe('updating one story', () => {
  let c: Client;
  before(async () => {
    c = await start();
  });
  after(() => c.close());
  const patch = (id: string, body: unknown, headers?: Record<string, string>) => c.call('PATCH', `${API}/stories/${id}`, body, headers);

  test('one field, leaving every other field and byte untouched', async () => {
    const before = c.file('FW-003');
    const res = await patch('FW-003', { status: 'In Progress' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.changed, true);
    assert.deepEqual(res.body.changes.status, { from: 'Ready', to: 'In Progress' });
    assert.equal(res.body.story.status, 'In Progress');
    assert.equal(res.body.story.owner, 'frontend');
    const after = c.file('FW-003');
    const added = after.split('\n').filter((l) => !before.split('\n').includes(l));
    assert.equal(added.length, 2);
    assert.equal(added[0], 'status: In Progress');
    assert.match(added[1], /^updated_date: '\d{4}-\d{2}-\d{2} \d{2}:\d{2}'$/);
    assert.ok(res.body.story.updatedAt);
  });

  test('several fields at once, through labels where they live', async () => {
    const res = await patch('FW-002', { owner: 'backend', priority: 'p1', backlogPriority: 'high', status: 'Ready' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const s = res.body.story;
    assert.equal(s.owner, 'backend');
    assert.equal(s.priority, 'p1');
    assert.equal(s.backlogPriority, 'high');
    assert.deepEqual(s.labels, ['area:auth', 'owner:backend', 'priority:p1', 'risk:medium', 'wtype:defect']);
    assert.match(c.file('FW-002'), /\n {2}- 'owner:backend'\n/);
  });

  test('an explicit null clears a nullable field', async () => {
    const res = await patch('FW-004', { milestone: null, area: null });
    assert.equal(res.status, 200);
    assert.equal(res.body.story.milestone, null);
    assert.equal(res.body.story.area, null);
    assert.doesNotMatch(c.file('FW-004'), /milestone:|area:/);
  });

  test('null for a required field is refused', async () => {
    assertError(await patch('FW-004', { status: null }), 422, 'FIELD_NOT_NULLABLE');
    assertError(await patch('FW-004', { title: null }), 422, 'FIELD_NOT_NULLABLE');
  });

  test('invalid values, unknown fields and read-only fields are refused and write nothing', async () => {
    const before = c.file('FW-007');
    assertError(await patch('FW-007', { status: 'Doing' }), 422, 'INVALID_STATUS');
    const owner = await patch('FW-007', { owner: 'platfrom' });
    assertError(owner, 422, 'INVALID_OWNER');
    assert.deepEqual(owner.body.error.allowedValues, ['backend', 'frontend', 'platform']);
    assertError(await patch('FW-007', { milestone: 'm-9' }), 422, 'INVALID_MILESTONE');
    assertError(await patch('FW-007', { colour: 'red' }), 422, 'INVALID_FIELD');
    assertError(await patch('FW-007', { state: 'completed' }), 422, 'FIELD_NOT_WRITABLE');
    assertError(await patch('FW-007', { maps: [] }), 422, 'FIELD_NOT_WRITABLE');
    assertError(await patch('FW-007', { dependencies: ['FW-404'] }), 422, 'INVALID_DEPENDENCY');
    assertError(await patch('FW-007', { dependencies: { add: ['FW-007'] } }), 422, 'INVALID_DEPENDENCY');
    assertError(await patch('FW-007', {}), 422, 'VALIDATION_ERROR');
    assert.equal(c.file('FW-007'), before);
  });

  test('a new value for an open field needs allowNewValues', async () => {
    const res = await patch('FW-007', { owner: 'data', allowNewValues: true });
    assert.equal(res.status, 200);
    assert.equal(res.body.story.owner, 'data');
  });

  test('setting a value it already has changes nothing and writes nothing', async () => {
    const before = c.file('FW-010');
    const first = await patch('FW-010', { status: 'In Progress', owner: 'platform' });
    assert.equal(first.status, 200);
    assert.equal(first.body.changed, false);
    assert.deepEqual(first.body.changes, {});
    assert.equal(c.file('FW-010'), before);
  });

  test('the same mutation twice is safe', async () => {
    const one = await patch('FW-011', { status: 'Ready' });
    const two = await patch('FW-011', { status: 'Ready' });
    assert.equal(one.body.changed, true);
    assert.equal(two.body.changed, false);
    assert.equal(two.body.story.revision, one.body.story.revision);
  });

  test('dry run reports the change and writes nothing', async () => {
    const before = c.file('FW-012');
    const res = await patch('FW-012', { status: 'Done' }, {});
    assert.equal(res.status, 200);
    const dry = await c.call('PATCH', `${API}/stories/FW-009?dryRun=true`, { status: 'Ready', owner: 'backend' });
    assert.equal(dry.body.dryRun, true);
    assert.deepEqual(dry.body.changes.status, { from: 'Backlog', to: 'Ready' });
    assert.equal(dry.body.story.owner, 'backend');
    assert.match(c.file('FW-009'), /status: Backlog/);
    assert.notEqual(c.file('FW-012'), before);
  });

  test('a missing story is 404', async () => {
    assertError(await patch('FW-999', { status: 'Ready' }), 404, 'STORY_NOT_FOUND');
  });

  test('the change is visible in the browser at once', async () => {
    await patch('FW-008', { title: 'Renamed through the API' });
    const res = await fetch(`${c.base}/story/FW-008`);
    assert.ok((await res.text()).includes('Renamed through the API'));
  });

  test('an edit on disk is visible through the API at once', async () => {
    const dir = join(c.root, 'backlog/tasks');
    const name = readdirSync(dir).find((n) => n.startsWith('fw-006'))!;
    writeFileSync(join(dir, name), readFileSync(join(dir, name), 'utf8').replace('status: Cancelled', 'status: Ready'));
    assert.equal((await c.call('GET', `${API}/stories/FW-006`)).body.status, 'Ready');
  });

  test('the body can be replaced', async () => {
    const res = await patch('FW-005', { body: 'A new\n\ndescription.' });
    assert.equal(res.body.story.body, 'A new\n\ndescription.');
    assert.match(c.file('FW-005'), /<!-- SECTION:DESCRIPTION:BEGIN -->\nA new\n\ndescription.\n<!-- SECTION:DESCRIPTION:END -->/);
  });

  test('a mutation without a JSON content type is 415', async () => {
    const res = await fetch(`${c.base}${API}/stories/FW-005`, { method: 'PATCH', body: 'status=Done' });
    assert.equal(res.status, 415);
    assert.equal((await res.json()).error.code, 'UNSUPPORTED_MEDIA_TYPE');
  });
});

describe('labels', () => {
  let c: Client;
  before(async () => {
    c = await start();
  });
  after(() => c.close());
  const labels = async (id: string, body: unknown) => {
    const res = await c.call('PATCH', `${API}/stories/${id}`, body);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body;
  };

  test('add and remove in one request', async () => {
    const r = await labels('FW-002', { labels: { add: ['risk:high', 'customer-facing'], remove: ['risk:medium'] } });
    assert.deepEqual(r.story.labels, ['area:auth', 'customer-facing', 'owner:platform', 'priority:p2', 'risk:high', 'wtype:defect']);
    assert.equal(r.story.risk, 'high');
  });

  test('adding a present label and removing an absent one are no-ops, not errors', async () => {
    const r = await labels('FW-002', { labels: { add: ['customer-facing'], remove: ['never-there'] } });
    assert.equal(r.changed, false);
  });

  test('a whole array replaces the labels', async () => {
    const r = await labels('FW-009', { labels: ['a', 'b'] });
    assert.deepEqual(r.story.labels, ['a', 'b']);
  });

  test('a second label in a structured namespace is refused', async () => {
    const res = await c.call('PATCH', `${API}/stories/FW-003`, { labels: { add: ['owner:backend'] } });
    assertError(res, 422, 'CONFLICTING_LABELS');
  });

  test('a structured field and a label for the same namespace in one request is refused', async () => {
    const res = await c.call('PATCH', `${API}/stories/FW-003`, { owner: 'backend', labels: { remove: ['owner:frontend'] } });
    assertError(res, 422, 'CONFLICTING_CHANGES');
  });

  test('a structured label value is validated like the field', async () => {
    assertError(await c.call('PATCH', `${API}/stories/FW-003`, { labels: { add: ['wtype:defcet'], remove: ['wtype:defect'] } }), 422, 'INVALID_WTYPE');
  });
});

describe('optimistic concurrency', () => {
  let c: Client;
  before(async () => {
    c = await start();
  });
  after(() => c.close());

  test('a matching revision is accepted, by header or body', async () => {
    const { revision } = (await c.call('GET', `${API}/stories/FW-004`)).body;
    const byHeader = await c.call('PATCH', `${API}/stories/FW-004`, { status: 'Ready' }, { 'If-Match': `"${revision}"` });
    assert.equal(byHeader.status, 200);
    const byBody = await c.call('PATCH', `${API}/stories/FW-004`, { status: 'Done', expectedRevision: byHeader.body.story.revision });
    assert.equal(byBody.status, 200);
  });

  test('a stale revision is 409 with the current revision, and nothing is written', async () => {
    const { revision: stale } = (await c.call('GET', `${API}/stories/FW-007`)).body;
    await c.call('PATCH', `${API}/stories/FW-007`, { status: 'Ready' });
    const before = c.file('FW-007');
    const res = await c.call('PATCH', `${API}/stories/FW-007`, { status: 'Done' }, { 'If-Match': `"${stale}"` });
    assertError(res, 409, 'REVISION_CONFLICT');
    assert.equal(res.body.error.expectedRevision, stale);
    assert.equal(res.body.error.currentRevision, (await c.call('GET', `${API}/stories/FW-007`)).body.revision);
    assert.equal(c.file('FW-007'), before);
  });

  test('a hand edit on disk also counts as a newer revision', async () => {
    const { revision } = (await c.call('GET', `${API}/stories/FW-011`)).body;
    const dir = join(c.root, 'backlog/tasks');
    const name = readdirSync(dir).find((n) => n.startsWith('fw-011'))!;
    writeFileSync(join(dir, name), readFileSync(join(dir, name), 'utf8').replace('Body of FW-011.', 'Edited by hand.'));
    assertError(await c.call('PATCH', `${API}/stories/FW-011`, { status: 'Ready', expectedRevision: revision }), 409, 'REVISION_CONFLICT');
  });
});

describe('bulk update', () => {
  let c: Client;
  before(async () => {
    c = await start();
  });
  after(() => c.close());
  const bulk = (body: unknown, query = '') => c.call('POST', `${API}/stories/bulk-update${query}`, body);

  test('one item', async () => {
    const res = await bulk({ ids: ['FW-009'], changes: { owner: 'platform' } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.succeeded, 1);
    assert.equal(res.body.results[0].story.owner, 'platform');
  });

  test('many items and several fields, with per-story and summary changes', async () => {
    const res = await bulk({ ids: ['FW-003', 'FW-008', 'FW-012'], changes: { priority: 'p1', owner: 'platform', milestone: 'm-1' } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.atomic, true);
    assert.equal(res.body.requested, 3);
    assert.equal(res.body.failed, 0);
    assert.equal(res.body.changed, 3);
    assert.deepEqual(res.body.changes.owner, { from: ['frontend', 'backend'], to: ['platform'] }, 'FW-012 already had the owner');
    for (const id of ['FW-003', 'FW-008', 'FW-012']) {
      const s = (await c.call('GET', `${API}/stories/${id}`)).body;
      assert.equal(s.owner, 'platform');
      assert.equal(s.priority, 'p1');
      assert.equal(s.milestone, 'm-1');
    }
    assert.equal((await c.call('GET', `${API}/stories/FW-004`)).body.milestone, 'm-1', 'unnamed stories untouched');
    assert.equal((await c.call('GET', `${API}/stories/FW-002`)).body.owner, 'platform');
  });

  test('stories already carrying the values count as unchanged and are not rewritten', async () => {
    const before = c.file('FW-003');
    const res = await bulk({ ids: ['FW-003', 'FW-004'], changes: { milestone: 'm-1' } });
    assert.equal(res.body.changed, 0);
    assert.equal(res.body.unchanged, 2);
    assert.equal(c.file('FW-003'), before);
  });

  test('dry run reports matches and changes and writes nothing', async () => {
    const before = [c.file('FW-002'), c.file('FW-005')];
    const res = await bulk({ ids: ['FW-002', 'FW-005', 'FW-010'], changes: { owner: 'backend', status: 'Ready' } }, '?dryRun=true');
    assert.equal(res.status, 200);
    assert.equal(res.body.dryRun, true);
    assert.equal(res.body.matched, 3);
    assert.equal(res.body.wouldChange, 3);
    assert.deepEqual(res.body.changes.status.to, ['Ready']);
    assert.equal(res.body.results[0].story.owner, 'backend');
    assert.deepEqual([c.file('FW-002'), c.file('FW-005')], before);
  });

  test('one invalid story refuses the whole batch and writes nothing', async () => {
    const before = c.file('FW-002');
    const res = await bulk({ ids: ['FW-002', 'FW-404'], changes: { status: 'Cancelled' } });
    assertError(res, 422, 'BULK_VALIDATION_FAILED');
    assert.equal(res.body.succeeded, 0);
    assert.equal(res.body.failed, 1);
    assert.deepEqual(res.body.results.map((r: { ok: boolean }) => r.ok), [true, false]);
    assert.equal(res.body.results[1].error.code, 'STORY_NOT_FOUND');
    assert.equal(c.file('FW-002'), before);
  });

  test('a per-story conflict refuses the batch with 409', async () => {
    const res = await bulk({ ids: ['FW-002', 'FW-005'], changes: { status: 'Cancelled' }, expectedRevisions: { 'FW-005': 'stale' } });
    assertError(res, 409, 'REVISION_CONFLICT');
    assert.equal(res.body.results[1].error.code, 'REVISION_CONFLICT');
  });

  test('invalid changes are refused before any story is read', async () => {
    assertError(await bulk({ ids: ['FW-002'], changes: { status: 'Doing' } }), 422, 'INVALID_STATUS');
    assertError(await bulk({ ids: ['FW-002'], changes: { colour: 'red' } }), 422, 'INVALID_FIELD');
    assertError(await bulk({ ids: ['FW-002'], changes: { status: null } }), 422, 'FIELD_NOT_NULLABLE');
    assertError(await bulk({ ids: ['FW-002'], changes: {} }), 400, 'MALFORMED_REQUEST');
    assertError(await bulk({ ids: [], changes: { status: 'Ready' } }), 400, 'MALFORMED_REQUEST');
    assertError(await bulk({ ids: ['FW-002'], status: 'Ready' }), 422, 'INVALID_FIELD');
    assertError(await bulk({ ids: ['FW-002', 'fw-2'], changes: { status: 'Ready' } }), 422, 'DUPLICATE_IDS');
  });

  test('explicit null clears across the batch', async () => {
    const res = await bulk({ ids: ['FW-003', 'FW-004'], changes: { milestone: null } });
    assert.equal(res.status, 200);
    assert.equal((await c.call('GET', `${API}/stories/FW-004`)).body.milestone, null);
  });

  test('every bulk-writable field the brief names is accepted', async () => {
    const res = await bulk(
      { ids: ['FW-010'], changes: { status: 'Ready', wstatus: 'ready', area: 'auth', owner: 'backend', priority: 'p2', wtype: 'defect', milestone: 'm-0' }, allowNewValues: true },
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const s = res.body.results[0].story;
    assert.deepEqual([s.status, s.wstatus, s.area, s.owner, s.priority, s.wtype, s.milestone], ['Ready', 'ready', 'auth', 'backend', 'p2', 'defect', 'm-0']);
  });

  test('more ids than the limit is BULK_LIMIT_EXCEEDED', async () => {
    const tooMany = Array.from({ length: 201 }, (_, i) => `FW-${i + 1000}`);
    assertError(await bulk({ ids: tooMany, changes: { status: 'Ready' } }), 422, 'BULK_LIMIT_EXCEEDED');
  });

  test('an Idempotency-Key replays a bulk update', async () => {
    const body = { ids: ['FW-011'], changes: { status: 'Cancelled' } };
    const first = await c.call('POST', `${API}/stories/bulk-update`, body, { 'Idempotency-Key': 'b-1' });
    const again = await c.call('POST', `${API}/stories/bulk-update`, body, { 'Idempotency-Key': 'b-1' });
    assert.equal(first.body.changed, 1);
    assert.equal(again.body.changed, 1, 'the replay reports the original result');
    assert.equal(again.headers.get('idempotent-replayed'), 'true');
  });
});

describe('authorization', () => {
  test('without a token, only loopback host names are served', async () => {
    const c = await start();
    try {
      // fetch will not send a forged Host header, so speak HTTP directly — as a DNS-rebinding page would.
      const withHost = (host: string) =>
        new Promise<{ status: number; body: string }>((resolve, reject) => {
          const req = request(`${c.base}${API}/stories`, { headers: { Host: host } }, (res) => {
            let body = '';
            res.on('data', (chunk) => (body += chunk));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
          });
          req.on('error', reject);
          req.end();
        });
      const evil = await withHost('evil.example:80');
      assert.equal(evil.status, 403);
      assert.equal(JSON.parse(evil.body).error.code, 'FORBIDDEN');
      assert.equal((await withHost('localhost:6480')).status, 200);
    } finally {
      await c.close();
    }
  });

  test('a cross-origin request is refused, so a web page cannot drive the API', async () => {
    const c = await start();
    try {
      const res = await c.call('PATCH', `${API}/stories/FW-002`, { status: 'Done' }, { Origin: 'https://evil.example' });
      assertError(res, 403, 'FORBIDDEN');
      assert.match(c.file('FW-002'), /status: Backlog/);
    } finally {
      await c.close();
    }
  });

  test('with a token, requests without it are 401 except discovery', async () => {
    const c = await start({ token: 's3cret' });
    try {
      assertError(await c.call('GET', `${API}/stories`), 401, 'UNAUTHORIZED');
      assertError(await c.call('GET', `${API}/meta`, undefined, { Authorization: 'Bearer wrong' }), 401, 'UNAUTHORIZED');
      assert.equal((await c.call('GET', `${API}/stories`, undefined, { Authorization: 'Bearer s3cret' })).status, 200);
      assert.equal((await c.call('GET', API)).status, 200);
      assert.equal((await c.call('GET', `${API}/openapi.json`)).body.security[0].bearer !== undefined, true);
    } finally {
      await c.close();
    }
  });

  test('bound beyond loopback without a token, writes are refused', async () => {
    const c = await start({ bindHost: '0.0.0.0' });
    try {
      assertError(await c.call('PATCH', `${API}/stories/FW-002`, { status: 'Done' }), 403, 'FORBIDDEN');
      assert.equal((await c.call('GET', `${API}/stories/FW-002`)).status, 200);
    } finally {
      await c.close();
    }
  });

  test('read-only refuses every mutation', async () => {
    const c = await start({ readOnly: true });
    try {
      assertError(await c.call('PATCH', `${API}/stories/FW-002`, { status: 'Done' }), 403, 'READ_ONLY');
      assertError(await c.call('POST', `${API}/stories`, { title: 'x' }), 403, 'READ_ONLY');
      assert.equal((await c.call('GET', `${API}/meta`)).body.capabilities.update, false);
    } finally {
      await c.close();
    }
  });
});

describe('a work item Backlog.md did not write', () => {
  test('is updated without disturbing its hand-written layout', async () => {
    const root = makeProject();
    const path = join(root, 'backlog/tasks/hand.md');
    const raw = '---\nid: FW-050\ntitle: Hand written\nstatus: Backlog\n---\n\n# Notes\n\nFree text.\n';
    writeFileSync(path, raw);
    const c = await start({}, root);
    try {
      const res = await c.call('PATCH', `${API}/stories/FW-050`, { status: 'Ready', owner: 'platform' });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const after = readFileSync(path, 'utf8');
      assert.match(after, /^---\nid: FW-050\ntitle: Hand written\nstatus: Ready\nupdated_date: '[^']+'\nlabels:\n {2}- 'owner:platform'\n---\n\n# Notes\n\nFree text.\n$/);
    } finally {
      await c.close();
    }
  });
});
