import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { parseWorkItem } from './backlog-reader';
import {
  WorkItemWriteError,
  backlogTimestamp,
  createFileExclusive,
  editFrontMatter,
  lockPathFor,
  renderNewWorkItem,
  replaceDescription,
  replaceFileAtomic,
  verifyFrontMatterEdit,
  withBacklogLock,
  workItemFileName,
} from './work-item-writer';

const ITEM = `---
id: FW-397
title: >-
  The dev app compose has no parity gate
status: Done - Local
assignee: []
created_date: '2026-08-27 08:14'
labels:
  - 'area:deployment'
  - 'owner:platform'
  - 'risk:medium'
milestone: m-0
dependencies:
  - FW-393
priority: medium
type: story
custom_key: keep me # a comment
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Old body.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 one
<!-- AC:END -->
`;

describe('editFrontMatter', () => {
  test('rewrites only the changed keys, in Backlog.md’s shapes', () => {
    const changes = { status: 'In Progress', labels: ['area:deployment', 'owner:sre', 'risk:medium'] };
    const out = editFrontMatter(ITEM, changes);
    verifyFrontMatterEdit(ITEM, out, changes);
    const before = ITEM.split('\n');
    const after = out.split('\n');
    assert.equal(after.length, before.length);
    const differing = after.filter((line, i) => line !== before[i]);
    assert.deepEqual(differing, ['status: In Progress', "  - 'owner:sre'"]);
  });

  test('inserts a new key where Backlog.md puts it, and removes a cleared one', () => {
    const changes = { updated_date: '2026-09-12 21:00', milestone: undefined };
    const out = editFrontMatter(ITEM, changes);
    verifyFrontMatterEdit(ITEM, out, changes);
    assert.match(out, /created_date: '2026-08-27 08:14'\nupdated_date: '2026-09-12 21:00'\nlabels:/);
    assert.doesNotMatch(out, /milestone:/);
    assert.match(out, /custom_key: keep me # a comment/, 'unknown keys and comments survive');
  });

  test('quotes values YAML would misread', () => {
    const changes = { title: "Colon: and 'quotes' #not-a-comment" };
    const out = editFrontMatter(ITEM, changes);
    verifyFrontMatterEdit(ITEM, out, changes);
    assert.equal(parseWorkItem(out, 'x.md', false).item!.title, changes.title);
  });

  test('an empty list is written as []', () => {
    const out = editFrontMatter(ITEM, { dependencies: [] });
    assert.match(out, /\ndependencies: \[\]\n/);
  });

  test('keeps CRLF line endings', () => {
    const crlf = ITEM.replace(/\n/g, '\r\n');
    const out = editFrontMatter(crlf, { status: 'Ready' });
    assert.ok(out.includes('status: Ready\r\n'));
    assert.ok(!/[^\r]\n/.test(out), 'no bare LF introduced');
  });

  test('verification refuses an edit that changes an unintended key', () => {
    const out = ITEM.replace('type: story', 'type: bug');
    assert.throws(() => verifyFrontMatterEdit(ITEM, out, {}), (e: unknown) => e instanceof WorkItemWriteError && e.code === 'WRITE_VERIFICATION_FAILED');
  });

  test('a file without front matter is refused', () => {
    assert.throws(() => editFrontMatter('# no front matter', { status: 'x' }), /front-matter/);
  });
});

describe('replaceDescription', () => {
  test('replaces the marker block and nothing else', () => {
    const out = replaceDescription(ITEM, 'New\n\nbody');
    const item = parseWorkItem(out, 'x.md', false).item!;
    assert.equal(item.body, 'New\n\nbody');
    assert.equal(item.acceptanceCriteria.length, 1);
    assert.equal(out.replace('New\n\nbody', 'Old body.'), ITEM);
  });

  test('a file with no marker blocks has its whole body replaced', () => {
    const plain = '---\nid: X-1\ntitle: t\nstatus: To Do\n---\n\nHand written.\n';
    const out = replaceDescription(plain, 'Replaced.');
    assert.equal(parseWorkItem(out, 'x.md', false).item!.body, 'Replaced.');
  });

  test('other marker blocks without a description block are refused', () => {
    const odd = '---\nid: X-1\ntitle: t\nstatus: To Do\n---\n\n<!-- AC:BEGIN -->\n- [ ] #1 a\n<!-- AC:END -->\n';
    assert.throws(() => replaceDescription(odd, 'x'), (e: unknown) => e instanceof WorkItemWriteError && e.code === 'UNSUPPORTED_BODY_LAYOUT');
  });
});

describe('new work items', () => {
  test('render in Backlog.md’s layout and read back', () => {
    const raw = renderNewWorkItem({
      id: 'FW-012',
      title: 'Dealer rating: support',
      status: 'Backlog',
      createdDate: '2026-09-12 10:00',
      labels: ['owner:frontend'],
      milestone: 'm-0',
      dependencies: ['FW-001'],
      priority: 'medium',
      body: 'Rate dealers.',
      definitionOfDone: ['Meets the DoD'],
    });
    const { item, problems } = parseWorkItem(raw, 'x.md', false);
    assert.deepEqual(problems, []);
    assert.equal(item!.title, 'Dealer rating: support');
    assert.deepEqual(item!.labels, ['owner:frontend']);
    assert.equal(item!.body, 'Rate dealers.');
    assert.equal(item!.definitionOfDone[0].text, 'Meets the DoD');
    assert.match(raw, /^---\nid: FW-012\ntitle: "Dealer rating: support"\nstatus: Backlog\nassignee: \[\]\ncreated_date: '2026-09-12 10:00'\n/);
  });

  test('file names follow Backlog.md', () => {
    assert.equal(workItemFileName('FW-012', 'Dealer rating: support?'), 'fw-012 - Dealer-rating-support.md');
  });

  test('timestamps are UTC yyyy-mm-dd HH:MM', () => {
    assert.equal(backlogTimestamp(new Date('2026-09-12T23:59:30Z')), '2026-09-12 23:59');
  });
});

describe('disk writes', () => {
  test('replaceFileAtomic refuses when the file changed underneath', () => {
    const dir = mkdtempSync(join(tmpdir(), 'smw-'));
    const path = join(dir, 'a.md');
    writeFileSync(path, 'one');
    assert.equal(replaceFileAtomic(path, 'two', 'stale'), false);
    assert.equal(readFileSync(path, 'utf8'), 'one');
    assert.equal(replaceFileAtomic(path, 'two', 'one'), true);
    assert.equal(readFileSync(path, 'utf8'), 'two');
    assert.deepEqual(readdirSync(dir), ['a.md'], 'no temporary files left behind');
    rmSync(dir, { recursive: true, force: true });
  });

  test('createFileExclusive never overwrites', () => {
    const dir = mkdtempSync(join(tmpdir(), 'smw-'));
    const path = join(dir, 'a.md');
    createFileExclusive(path, 'first');
    assert.throws(() => createFileExclusive(path, 'second'), (e: unknown) => e instanceof WorkItemWriteError && e.code === 'FILE_EXISTS');
    assert.equal(readFileSync(path, 'utf8'), 'first');
    assert.deepEqual(readdirSync(dir), ['a.md']);
    rmSync(dir, { recursive: true, force: true });
  });

  test('the backlog lock is exclusive, released, and taken over from a dead holder', () => {
    const dir = mkdtempSync(join(tmpdir(), 'smw-'));
    const lock = lockPathFor(dir);
    const inside = withBacklogLock(dir, () => {
      assert.ok(existsSync(lock));
      assert.throws(() => withBacklogLock(dir, () => 1, { timeoutMs: 50 }), /backlog lock/);
      return 42;
    });
    assert.equal(inside, 42);
    assert.ok(!existsSync(lock), 'released');
    writeFileSync(lock, `999999999\n${Date.now()}\n`);
    assert.equal(withBacklogLock(dir, () => 'taken over', { timeoutMs: 200 }), 'taken over');
    rmSync(dir, { recursive: true, force: true });
  });
});
