import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, describe, before, after } from 'node:test';
import { parseStoryMap } from './story-map-reader';
import { resolveStoryMap, primaryIds, supportingIds } from './resolver';
import { Workspace, fingerprint, WorkspaceHost } from './workspace';
import { validate } from './validator';
import { criteriaSummary, filterStories, buildMapMembership, facets } from './queries';

const VALID_MAP = `schemaVersion: 1
id: seller-journey
title: Seller Journey
kind: journey
personas:
  - seller
releaseSlices:
  - id: delivered
    title: Delivered
    order: 10
  - id: next
    title: Next
    order: 20
activities:
  - id: prepare
    title: Prepare the vehicle
    steps:
      - id: photos
        title: Capture vehicle photos
        slices:
          delivered:
            - STORY-130
          next:
            - STORY-134
        supporting:
          - STORY-059
`;

function story(id: string, status: string, completed: boolean): string {
  return `---
id: ${id}
title: Story ${id}
status: ${status}
assignee: []
created_date: '2026-08-01 10:00'
labels:
  - 'area:frontend'
  - 'owner:frontend'
  - 'wstatus:${completed ? 'done' : 'backlog'}'
  - 'wtype:feature'
dependencies: []
type: story
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Body ${id}.
<!-- SECTION:DESCRIPTION:END -->
`;
}

function makeEstate(mapYaml: string | null): string {
  const root = mkdtempSync(join(tmpdir(), 'smc-map-'));
  mkdirSync(join(root, 'backlog/tasks'), { recursive: true });
  mkdirSync(join(root, 'backlog/completed'), { recursive: true });
  mkdirSync(join(root, 'backlog/story-maps'), { recursive: true });
  writeFileSync(join(root, 'backlog/tasks/story-134 - a.md'), story('STORY-134', 'To Do', false));
  writeFileSync(join(root, 'backlog/completed/story-130 - b.md'), story('STORY-130', 'Done', true));
  writeFileSync(join(root, 'backlog/completed/story-059 - c.md'), story('STORY-059', 'Done', true));
  if (mapYaml !== null) {
    writeFileSync(join(root, 'backlog/story-maps/seller-journey.yaml'), mapYaml);
  }
  return root;
}

describe('parseStoryMap', () => {
  test('reads a valid map', () => {
    const { map, issues } = parseStoryMap(VALID_MAP, 'm.yaml');
    assert.equal(issues.length, 0);
    assert.ok(map);
    assert.equal(map.id, 'seller-journey');
    assert.equal(map.kind, 'journey');
    assert.deepEqual(map.personas, ['seller']);
    assert.equal(map.releaseSlices.length, 2);
    assert.equal(map.activities[0].steps[0].slices.delivered[0], 'STORY-130');
    assert.deepEqual(map.activities[0].steps[0].supporting, ['STORY-059']);
  });

  test('orders release slices by their declared order', () => {
    const { map } = parseStoryMap(VALID_MAP.replace('order: 10', 'order: 99'), 'm.yaml');
    assert.deepEqual(map!.releaseSlices.map((s) => s.id), ['next', 'delivered']);
  });

  test('rejects an unsupported schema version', () => {
    const { map, issues } = parseStoryMap(VALID_MAP.replace('schemaVersion: 1', 'schemaVersion: 7'), 'm.yaml');
    assert.equal(map, undefined);
    assert.equal(issues[0].code, 'map_unsupported_schema_version');
  });

  test('rejects a missing schema version', () => {
    const { issues } = parseStoryMap(VALID_MAP.replace('schemaVersion: 1\n', ''), 'm.yaml');
    assert.equal(issues[0].code, 'map_missing_schema_version');
  });

  test('rejects a step placing stories in an undeclared slice', () => {
    const { issues } = parseStoryMap(VALID_MAP.replace('          next:', '          v1:'), 'm.yaml');
    assert.ok(issues.some((i) => i.code === 'step_unknown_slice'));
  });

  test('rejects duplicate activity ids', () => {
    const doubled = `${VALID_MAP}  - id: prepare
    title: Duplicate
    steps:
      - id: other
        title: Other
        slices: {}
`;
    const { issues } = parseStoryMap(doubled, 'm.yaml');
    assert.ok(issues.some((i) => i.code === 'activity_duplicate_id'));
  });

  test('rejects duplicate step ids inside one activity', () => {
    const doubled = `${VALID_MAP}      - id: photos
        title: Duplicate step
        slices: {}
`;
    const { issues } = parseStoryMap(doubled, 'm.yaml');
    assert.ok(issues.some((i) => i.code === 'step_duplicate_id'));
  });

  test('rejects an activity with no steps', () => {
    const { issues } = parseStoryMap(
      'schemaVersion: 1\nid: m\ntitle: M\nreleaseSlices:\n  - id: a\n    title: A\n    order: 1\nactivities:\n  - id: x\n    title: X\n    steps: []\n',
      'm.yaml',
    );
    assert.ok(issues.some((i) => i.code === 'activity_no_steps'));
  });

  test('rejects unparseable YAML rather than throwing', () => {
    const { map, issues } = parseStoryMap('schemaVersion: 1\n  bad: [indent\n', 'm.yaml');
    assert.equal(map, undefined);
    assert.equal(issues[0].code, 'map_unparseable');
  });
});

describe('resolveStoryMap', () => {
  let root: string;
  before(() => {
    root = makeEstate(VALID_MAP);
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  test('resolves active, completed and supporting placements', () => {
    const ws = Workspace.load(root);
    const resolved = ws.resolve('seller-journey')!;
    assert.equal(resolved.counts.primary, 2);
    assert.equal(resolved.counts.supporting, 1);
    assert.equal(resolved.counts.completed, 1, 'STORY-130 is in completed/ and must still resolve');
    assert.equal(resolved.counts.active, 1);
    assert.equal(resolved.counts.missing, 0);
  });

  test('keeps a completed story in its journey position', () => {
    const ws = Workspace.load(root);
    const cell = ws.resolve('seller-journey')!.activities[0].steps[0].cells.find((c) => c.sliceId === 'delivered')!;
    assert.equal(cell.placements[0].item!.id, 'STORY-130');
    assert.equal(cell.placements[0].item!.completed, true);
  });

  test('surfaces an unknown story reference instead of dropping it', () => {
    const missingRoot = makeEstate(VALID_MAP.replace('- STORY-134', '- STORY-999'));
    const ws = Workspace.load(missingRoot);
    const resolved = ws.resolve('seller-journey')!;
    assert.deepEqual(resolved.missingIds, ['STORY-999']);
    const cell = resolved.activities[0].steps[0].cells.find((c) => c.sliceId === 'next')!;
    assert.equal(cell.placements.length, 1);
    assert.equal(cell.placements[0].missing, true);
    rmSync(missingRoot, { recursive: true, force: true });
  });

  test('primaryIds and supportingIds read the map, not the index', () => {
    const { map } = parseStoryMap(VALID_MAP, 'm.yaml');
    assert.deepEqual(primaryIds(map!), ['STORY-130', 'STORY-134']);
    assert.deepEqual(supportingIds(map!), ['STORY-059']);
  });
});

describe('validate', () => {
  test('passes a coherent estate', () => {
    const root = makeEstate(VALID_MAP);
    const report = validate(Workspace.load(root));
    assert.equal(report.ok, true, JSON.stringify(report.issues));
    assert.equal(report.errorCount, 0);
    rmSync(root, { recursive: true, force: true });
  });

  test('fails on an unknown story reference', () => {
    const root = makeEstate(VALID_MAP.replace('- STORY-134', '- STORY-999'));
    const report = validate(Workspace.load(root));
    assert.equal(report.ok, false);
    assert.ok(report.issues.some((i) => i.code === 'map_unknown_story'));
    rmSync(root, { recursive: true, force: true });
  });

  test('fails when one story is placed twice as primary in a map', () => {
    const root = makeEstate(VALID_MAP.replace('            - STORY-134', '            - STORY-134\n            - STORY-130'));
    const report = validate(Workspace.load(root));
    assert.ok(report.issues.some((i) => i.code === 'map_duplicate_primary_placement'));
    rmSync(root, { recursive: true, force: true });
  });

  test('fails when a story is both primary and supporting in one map', () => {
    const root = makeEstate(VALID_MAP.replace('          - STORY-059', '          - STORY-130'));
    const report = validate(Workspace.load(root));
    assert.ok(report.issues.some((i) => i.code === 'map_supporting_and_primary'));
    rmSync(root, { recursive: true, force: true });
  });

  test('fails when two maps claim the same story as primary', () => {
    const root = makeEstate(VALID_MAP);
    writeFileSync(
      join(root, 'backlog/story-maps/other.yaml'),
      VALID_MAP.replace('id: seller-journey', 'id: other-journey').replace('title: Seller Journey', 'title: Other'),
    );
    const report = validate(Workspace.load(root));
    assert.ok(report.issues.some((i) => i.code === 'story_primary_in_multiple_maps'));
    rmSync(root, { recursive: true, force: true });
  });

  test('fails on a duplicate map id', () => {
    const root = makeEstate(VALID_MAP);
    writeFileSync(join(root, 'backlog/story-maps/copy.yaml'), VALID_MAP);
    const report = validate(Workspace.load(root));
    assert.ok(report.issues.some((i) => i.code === 'map_duplicate_id'));
    rmSync(root, { recursive: true, force: true });
  });

  test('fails on a map that places no stories', () => {
    const root = makeEstate(
      'schemaVersion: 1\nid: empty\ntitle: Empty\nreleaseSlices:\n  - id: a\n    title: A\n    order: 1\nactivities:\n  - id: x\n    title: X\n    steps:\n      - id: s\n        title: S\n        slices: {}\n',
    );
    const report = validate(Workspace.load(root));
    assert.ok(report.issues.some((i) => i.code === 'map_empty'));
    rmSync(root, { recursive: true, force: true });
  });
});

describe('queries', () => {
  let root: string;
  before(() => {
    root = makeEstate(VALID_MAP);
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  test('filters by state, area and free text', () => {
    const ws = Workspace.load(root);
    assert.equal(filterStories(ws, { state: 'completed' }).length, 2);
    assert.equal(filterStories(ws, { state: 'active' }).length, 1);
    assert.equal(filterStories(ws, { area: 'frontend' }).length, 3);
    assert.equal(filterStories(ws, { text: 'STORY-130' }).length, 1);
    assert.equal(filterStories(ws, { text: 'nothing-matches' }).length, 0);
  });

  test('filters by map membership, including the unmapped case', () => {
    const ws = Workspace.load(root);
    const membership = buildMapMembership(ws);
    assert.equal(filterStories(ws, { map: 'seller-journey' }, membership).length, 3);
    assert.equal(filterStories(ws, { map: 'none' }, membership).length, 0);
  });

  test('facets count the two workflow dimensions separately', () => {
    const ws = Workspace.load(root);
    const f = facets(ws.index.items);
    assert.deepEqual(f.status.map((s) => s.value).sort(), ['Done', 'To Do']);
    assert.deepEqual(f.wstatus.map((s) => s.value).sort(), ['backlog', 'done']);
  });

  test('criteriaSummary reports which block the criteria came from', () => {
    const ws = Workspace.load(root);
    assert.equal(criteriaSummary(ws.index.get('STORY-130')!).source, 'none');
  });
});

describe('WorkspaceHost', () => {
  test('reloads when a story file changes and not when nothing does', async () => {
    const root = makeEstate(VALID_MAP);
    const host = new WorkspaceHost(root);
    assert.equal(host.get().index.size, 3);
    assert.equal(host.revision, 0);
    host.get();
    assert.equal(host.revision, 0, 'a second read with no change must not reload');

    // mtime granularity: make the change unmistakable in the fingerprint by size too
    writeFileSync(join(root, 'backlog/tasks/story-200 - new.md'), story('STORY-200', 'To Do', false));
    assert.equal(host.get().index.size, 4);
    assert.equal(host.revision, 1);
    rmSync(root, { recursive: true, force: true });
  });

  test('fingerprint changes when a map file changes', () => {
    const root = makeEstate(VALID_MAP);
    const before = fingerprint(root);
    writeFileSync(join(root, 'backlog/story-maps/seller-journey.yaml'), `${VALID_MAP}\n# edited\n`);
    assert.notEqual(fingerprint(root), before);
    rmSync(root, { recursive: true, force: true });
  });
});
