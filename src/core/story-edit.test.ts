import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';
import { commitStoryEdit, nodeFs, parseEditRequest, planStoryEdit } from './story-edit';
import type { FsOps, StoryChanges } from './story-edit';
import { Workspace } from './workspace';

const NOW = new Date('2026-09-12T20:14:00Z');
const STATUSES = ['Backlog', 'Ready', 'In Progress', 'Done'];

const STORY_1 = `---
id: FW-001
title: >-
  A long folded title that spans
  two lines
status: Backlog
assignee: []
created_date: '2026-08-13 01:01'
updated_date: '2026-08-24 19:05'
labels:
  - 'area:security'
  - 'area:ci'
  - 'owner:platform'
  - 'priority:p0'
  - 'wstatus:backlog'
  - 'wtype:fix'
milestone: m-0
dependencies: []
priority: high
type: story
custom_key: keep me   # a comment
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Body of FW-001.
<!-- SECTION:DESCRIPTION:END -->
`;

const STORY_2 = `---\r\nid: FW-002\r\ntitle: Second\r\nstatus: Ready\r\ncreated_date: '2026-08-13'\r\nlabels: []\r\ndependencies: []\r\n---\r\n\r\nBody two.\r\n`;

const STORY_3 = `---
id: FW-003
title: Third
status: In Progress
labels:
  - owner:backend
  - priority:p2
---
Body three.
`;

const MAP = `# a comment the edit must keep
schemaVersion: 1
id: seller
title: Seller
kind: journey
releaseSlices:
  - id: first
    title: First
    order: 10
  - id: later
    title: Later
    order: 20
activities:
  - id: start
    title: Start
    steps:
      - id: sign-in
        title: Sign in
        slices:
          first:
            - FW-001   # primary here
          later:
            - FW-003
        supporting:
          - FW-002
      - id: pay
        title: Pay
`;

let root: string;
const file = (rel: string) => readFileSync(join(root, rel), 'utf8');
const plan = (ids: string[], changes: StoryChanges) => planStoryEdit(Workspace.load(root), ids, changes, { statuses: STATUSES, now: NOW });

function setup() {
  if (root) rmSync(root, { recursive: true, force: true });
  root = mkdtempSync(join(tmpdir(), 'sm-edit-'));
  for (const d of ['backlog/tasks', 'backlog/milestones', 'backlog/story-maps']) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, 'backlog/tasks/fw-001 - one.md'), STORY_1);
  writeFileSync(join(root, 'backlog/tasks/fw-002 - two.md'), STORY_2);
  writeFileSync(join(root, 'backlog/tasks/fw-003 - three.md'), STORY_3);
  for (const m of ['m-0', 'm-1']) writeFileSync(join(root, `backlog/milestones/${m}.md`), `---\nid: ${m}\ntitle: Milestone ${m}\n---\n`);
  writeFileSync(join(root, 'backlog/story-maps/seller.yaml'), MAP);
}

describe('bulk edit: planning and writing', () => {
  beforeEach(setup);
  after(() => rmSync(root, { recursive: true, force: true }));

  test('one-item update changes exactly the intended lines', () => {
    const p = plan(['FW-001'], { status: 'In Progress' });
    assert.ok(p.ok);
    assert.deepEqual(p.items[0].changes, [{ field: 'status', from: 'Backlog', to: 'In Progress' }]);
    assert.deepEqual(commitStoryEdit(p), { ok: true, written: ['backlog/tasks/fw-001 - one.md'] });
    assert.equal(
      file('backlog/tasks/fw-001 - one.md'),
      STORY_1.replace('status: Backlog', 'status: In Progress').replace("updated_date: '2026-08-24 19:05'", "updated_date: '2026-09-12 20:14'"),
    );
  });

  test('several fields on several stories in one operation; unspecified fields untouched', () => {
    const p = plan(['FW-001', 'FW-002', 'FW-003'], { owner: 'platform', priority: 'P1' });
    assert.ok(p.ok, JSON.stringify(p.items));
    assert.equal(p.changedCount, 3);
    commitStoryEdit(p);
    const one = file('backlog/tasks/fw-001 - one.md');
    // No story spells p1 yet, so the value is written as typed, in place of p0.
    assert.ok(one.includes("  - 'owner:platform'\n  - 'priority:P1'\n"), one);
    assert.ok(one.includes('custom_key: keep me   # a comment'));
    assert.ok(one.includes('status: Backlog') && one.includes('milestone: m-0') && one.includes("  - 'area:security'\n  - 'area:ci'"));
    // CRLF file keeps CRLF, gains labels in Backlog.md's quoted style
    const two = file('backlog/tasks/fw-002 - two.md');
    assert.ok(two.includes("labels:\r\n  - 'owner:platform'\r\n  - 'priority:P1'\r\n"), JSON.stringify(two));
    assert.ok(!/[^\r]\n/.test(two), 'no bare LF introduced');
    assert.ok(two.includes("created_date: '2026-08-13'\r\nupdated_date: '2026-09-12 20:14'\r\n"));
    // plain-style list keeps plain style
    const three = file('backlog/tasks/fw-003 - three.md');
    assert.ok(three.includes('  - owner:platform\n  - priority:P1\n'), three);
  });

  test('a value typed in another case reuses the spelling already in the estate', () => {
    const p = plan(['FW-002'], { priority: 'P2' });
    assert.equal(p.changes.priority, 'p2');
  });

  test('a story that already has the value is reported unchanged and not rewritten', () => {
    const p = plan(['FW-001', 'FW-002'], { status: 'Ready' });
    assert.ok(p.ok);
    assert.deepEqual(p.items.map((i) => i.changed), [true, false]);
    assert.equal(p.writes.length, 1);
  });

  test('replacing a namespace with several labels warns and leaves one', () => {
    const p = plan(['FW-001'], { area: 'auth' });
    assert.deepEqual(p.items[0].warnings, ['replaces 2 area labels (security, ci)']);
    commitStoryEdit(p);
    assert.ok(file('backlog/tasks/fw-001 - one.md').includes("labels:\n  - 'area:auth'\n  - 'owner:platform'"));
  });

  test('explicit clear removes a label and the milestone key; absent fields stay', () => {
    const p = plan(['FW-001'], { owner: null, milestone: null });
    assert.ok(p.ok);
    commitStoryEdit(p);
    const one = file('backlog/tasks/fw-001 - one.md');
    assert.ok(!one.includes('owner:') && !one.includes('milestone:'));
    assert.ok(one.includes("  - 'wtype:fix'") && one.includes('status: Backlog'));
  });

  test('setting a milestone on a story with none inserts it after labels', () => {
    commitStoryEdit(plan(['FW-003'], { milestone: 'm-1' }));
    assert.ok(file('backlog/tasks/fw-003 - three.md').includes('  - priority:p2\nmilestone: m-1\n'));
  });

  test('validation failures refuse the whole request and write nothing', () => {
    const cases: [StoryChanges, RegExp][] = [
      [{ status: 'Nope' }, /not a status in backlog.config.yml/],
      [{ milestone: 'm-99' }, /not a milestone/],
      [{ area: 'none' }, /reserved/],
      [{ owner: 'a,b' }, /comma/],
      [{ map: { map: 'seller', activity: 'start', step: 'nope', slice: 'first' } }, /no step/],
      [{ map: { map: 'seller', activity: 'start', step: 'pay', slice: 'nope' } }, /no release slice/],
    ];
    for (const [changes, message] of cases) {
      const p = plan(['FW-001', 'FW-002'], changes);
      assert.equal(p.ok, false, JSON.stringify(changes));
      assert.match(p.fieldErrors.map((e) => e.message).join(' '), message);
      assert.equal(p.writes.length, 0);
    }
    const unknown = plan(['FW-001', 'FW-404'], { status: 'Ready' });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.items[1].error, 'no work item claims this id');
    assert.equal(file('backlog/tasks/fw-001 - one.md'), STORY_1);
  });

  test('request shape: absent is "no change", null is "clear", status cannot be cleared', () => {
    assert.deepEqual(parseEditRequest({ ids: ['FW-1'], changes: { owner: null, area: 'x' } }).changes, { owner: null, area: 'x' });
    assert.match(parseEditRequest({ ids: ['FW-1'], changes: { status: null } }).errors[0].message, /cannot be cleared/);
    assert.match(parseEditRequest({ ids: ['FW-1'], changes: {} }).errors[0].message, /at least one field/);
    assert.match(parseEditRequest({ ids: [], changes: { owner: 'x' } }).errors[0].message, /at least one story/);
    assert.match(parseEditRequest({ ids: ['FW-1'], changes: { state: 'active' } }).errors[0].message, /not an editable field/);
    assert.deepEqual(parseEditRequest({ ids: ['FW-1', 'fw-001', 'FW-2'], changes: { owner: 'x' } }).ids, ['FW-1', 'FW-2']);
  });

  test('a file changed after planning is a conflict, and nothing is written', () => {
    const p = plan(['FW-001', 'FW-002'], { status: 'In Progress' });
    writeFileSync(join(root, 'backlog/tasks/fw-002 - two.md'), STORY_2.replace('Second', 'Edited elsewhere'));
    const result = commitStoryEdit(p);
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.reason, 'conflict');
    assert.equal(file('backlog/tasks/fw-001 - one.md'), STORY_1);
    assert.notEqual(plan(['FW-001', 'FW-002'], { status: 'In Progress' }).token, p.token, 'the token moves with the files');
  });

  test('a failed rename midway restores the files already replaced', () => {
    const p = plan(['FW-001', 'FW-002', 'FW-003'], { status: 'Done' });
    let renames = 0;
    const flaky: FsOps = { ...nodeFs, rename: (a, b) => { if (++renames === 3) throw new Error('disk full'); nodeFs.rename(a, b); } };
    const result = commitStoryEdit(p, flaky);
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.reason === 'write_failed' && result.rolledBack);
    assert.equal(file('backlog/tasks/fw-001 - one.md'), STORY_1);
    assert.equal(file('backlog/tasks/fw-002 - two.md'), STORY_2);
    assert.equal(file('backlog/tasks/fw-003 - three.md'), STORY_3);
  });

  test('when a rollback also fails, the result names the files left changed', () => {
    const p = plan(['FW-001', 'FW-002'], { status: 'Done' });
    let renames = 0;
    const broken: FsOps = {
      ...nodeFs,
      rename: (a, b) => { if (++renames === 2) throw new Error('gone'); nodeFs.rename(a, b); },
      writeFile: (path, data, mode) => { if (!path.endsWith('.tmp')) throw new Error('read-only'); nodeFs.writeFile(path, data, mode); },
    };
    const result = commitStoryEdit(p, broken);
    assert.ok(!result.ok && result.reason === 'write_failed');
    assert.ok(!result.ok && result.reason === 'write_failed' && !result.rolledBack);
    assert.deepEqual(!result.ok && result.reason === 'write_failed' && result.notRestored, ['backlog/tasks/fw-001 - one.md']);
  });

  test('map clear removes every reference, primary and supporting, keeping comments', () => {
    const p = plan(['FW-001', 'FW-002'], { map: null });
    assert.ok(p.ok, JSON.stringify(p.items));
    assert.deepEqual(p.items[1].warnings, ['also removes supporting references (seller)']);
    assert.deepEqual(p.writes.map((w) => w.sourcePath), ['backlog/story-maps/seller.yaml'], 'work items are not touched');
    commitStoryEdit(p);
    const map = file('backlog/story-maps/seller.yaml');
    assert.equal(map, MAP.replace('          first:\n            - FW-001   # primary here\n', '          first: []\n').replace('        supporting:\n          - FW-002\n', '        supporting: []\n'));
  });

  test('map set moves the primary placement into the chosen cell, creating keys as needed', () => {
    const p = plan(['FW-001'], { map: { map: 'seller', activity: 'start', step: 'pay', slice: 'later' } });
    assert.ok(p.ok, JSON.stringify(p.items));
    assert.deepEqual(p.items[0].changes, [{ field: 'map', from: 'seller', to: 'seller/start/pay/later' }]);
    commitStoryEdit(p);
    assert.ok(file('backlog/story-maps/seller.yaml').endsWith('        title: Pay\n        slices:\n          later:\n            - FW-001\n'));
    assert.equal(plan(['FW-001'], { map: { map: 'seller', activity: 'start', step: 'pay', slice: 'later' } }).changedCount, 0, 'already there');
    const again = plan(['FW-002'], { map: { map: 'seller', activity: 'start', step: 'pay', slice: 'later' } });
    commitStoryEdit(again);
    assert.ok(file('backlog/story-maps/seller.yaml').endsWith('          later:\n            - FW-001\n            - FW-002\n'));
    assert.ok(file('backlog/story-maps/seller.yaml').includes('        supporting:\n          - FW-002\n'), 'supporting reference kept');
  });

  test('a map layout the line editor cannot express is refused, not corrupted', () => {
    writeFileSync(join(root, 'backlog/story-maps/seller.yaml'), MAP.replace('          first:\n            - FW-001   # primary here\n', '          first: [FW-001, FW-003]\n'));
    const p = plan(['FW-001'], { map: null });
    assert.equal(p.ok, false);
    assert.match(p.items[0].error ?? '', /cannot edit line by line/);
  });
});
