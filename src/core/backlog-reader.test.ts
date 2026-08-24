import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, describe, before, after } from 'node:test';
import { parseWorkItem, readBacklog, resolveBacklogPaths, parseBodyAcceptanceCriteria } from './backlog-reader';
import { WorkItemIndex, normalizeId } from './work-item-index';

const ACTIVE = `---
id: STORY-142
title: Sync a note that was written while offline
status: In Progress
assignee: []
created_date: '2026-08-16 20:45'
updated_date: '2026-08-22 19:01'
labels:
  - 'area:sync'
  - 'owner:platform'
  - 'priority:p3'
  - 'risk:low'
  - 'wstatus:in_progress'
  - 'wtype:bug'
  - 'homegrown-label'
dependencies:
  - STORY-138
documentation:
  - backlog/docs/doc-001 - Definition-of-Done.md
priority: low
type: story
legacy_owner: platform
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
# Heading

## 5. Acceptance criteria

- [x] The note reaches the server exactly once.
- [ ] A conflicting edit is surfaced, not merged silently.

## 6. Not acceptance criteria

- [ ] This must not be collected.
<!-- SECTION:DESCRIPTION:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Meets the project's Definition of Done
<!-- DOD:END -->
`;

const COMPLETED = `---
id: STORY-059
title: Pin the image library that parses uploaded attachments
status: Done
assignee: []
created_date: '2026-08-14 09:35'
labels:
  - 'area:security'
  - 'wstatus:done'
dependencies: []
type: story
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Body of a delivered story.
<!-- SECTION:DESCRIPTION:END -->
`;

const COMPOSITE = `---
id: STORY-SEC-02D
title: The sync service has no signing secret
status: Done
assignee: []
created_date: '2026-08-20 23:47'
labels:
  - 'area:sync'
dependencies: []
type: story
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Composite identifier story.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A native criterion.
- [ ] #2 A second native criterion.
<!-- AC:END -->
`;

describe('parseWorkItem', () => {
  test('reads an active story with all optional label namespaces', () => {
    const { item, problems } = parseWorkItem(ACTIVE, 'backlog/tasks/story-142 - x.md', false);
    assert.equal(problems.length, 0);
    assert.ok(item);
    assert.equal(item.id, 'STORY-142');
    assert.equal(item.status, 'In Progress');
    assert.equal(item.type, 'story');
    assert.equal(item.priority, 'low');
    assert.equal(item.completed, false);
    assert.deepEqual(item.dependencies, ['STORY-138']);
    assert.equal(item.documentation.length, 1);
    assert.equal(item.area, 'sync');
    assert.equal(item.owner, 'platform');
    assert.equal(item.wstatus, 'in_progress');
    assert.equal(item.wtype, 'bug');
    assert.equal(item.priorityLabel, 'p3');
    assert.equal(item.risk, 'low');
    assert.deepEqual(item.otherLabels, ['homegrown-label']);
    assert.equal(item.createdDate, '2026-08-16 20:45');
    assert.equal(item.updatedDate, '2026-08-22 19:01');
  });

  test('preserves unknown front-matter keys instead of dropping them', () => {
    const { item } = parseWorkItem(ACTIVE, 'x.md', false);
    // Backlog.md 1.50.1 discards keys it does not know on edit. This tool must not.
    assert.equal(item!.frontmatter.legacy_owner, 'platform');
    assert.equal(item!.frontmatter.assignee instanceof Array, true);
  });

  test('collects acceptance criteria from the body, scoped to the right heading', () => {
    const { item } = parseWorkItem(ACTIVE, 'x.md', false);
    assert.equal(item!.acceptanceCriteria.length, 0, 'no native AC block on this story');
    assert.equal(item!.bodyAcceptanceCriteria.length, 2);
    assert.equal(item!.bodyAcceptanceCriteria[0].checked, true);
    assert.equal(item!.bodyAcceptanceCriteria[1].checked, false);
    assert.ok(!item!.bodyAcceptanceCriteria.some((c) => c.text.includes('must not be collected')));
  });

  test('reads the native AC block and its checked state', () => {
    const { item } = parseWorkItem(COMPOSITE, 'x.md', true);
    assert.equal(item!.acceptanceCriteria.length, 2);
    assert.equal(item!.acceptanceCriteria[0].index, 1);
    assert.equal(item!.acceptanceCriteria[0].checked, true);
    assert.equal(item!.acceptanceCriteria[1].checked, false);
  });

  test('reads the Definition of Done block', () => {
    const { item } = parseWorkItem(ACTIVE, 'x.md', false);
    assert.equal(item!.definitionOfDone.length, 1);
    assert.match(item!.definitionOfDone[0].text, /Definition of Done/);
  });

  test('marks a completed story completed', () => {
    const { item } = parseWorkItem(COMPLETED, 'backlog/completed/story-059 - x.md', true);
    assert.equal(item!.completed, true);
    assert.equal(item!.status, 'Done');
  });

  test('accepts a composite identifier unchanged', () => {
    const { item } = parseWorkItem(COMPOSITE, 'x.md', true);
    assert.equal(item!.id, 'STORY-SEC-02D');
  });

  test('reports a file with no front matter rather than throwing', () => {
    const { item, problems } = parseWorkItem('# just markdown\n', 'x.md', false);
    assert.equal(item, undefined);
    assert.equal(problems[0].kind, 'no_front_matter');
  });

  test('reports unparseable front matter rather than throwing', () => {
    const { item, problems } = parseWorkItem('---\nid: [unclosed\n---\nbody\n', 'x.md', false);
    assert.equal(item, undefined);
    assert.equal(problems[0].kind, 'unparseable_front_matter');
  });

  test('reports a missing id and yields no item, since identity is mandatory', () => {
    const { item, problems } = parseWorkItem('---\ntitle: No id\nstatus: To Do\n---\nbody\n', 'x.md', false);
    assert.equal(item, undefined);
    assert.ok(problems.some((p) => p.kind === 'missing_id'));
  });
});

describe('parseBodyAcceptanceCriteria', () => {
  test('stops collecting at the next heading', () => {
    const criteria = parseBodyAcceptanceCriteria(
      '## Acceptance\n- [ ] one\n- [ ] two\n\n## Verification\n- [ ] not this\n',
    );
    assert.equal(criteria.length, 2);
  });

  test('returns nothing when the story keeps criteria as prose', () => {
    const criteria = parseBodyAcceptanceCriteria('## Acceptance criteria\n\n1. A numbered, non-checkbox criterion.\n');
    assert.equal(criteria.length, 0);
  });
});

describe('normalizeId', () => {
  test('folds case and zero padding on the numeric tail', () => {
    assert.equal(normalizeId('STORY-038'), normalizeId('story-38'));
    assert.equal(normalizeId('  STORY-142 '), 'STORY-142');
  });

  test('leaves a composite identifier alone apart from case', () => {
    assert.equal(normalizeId('story-sec-02d'), 'STORY-SEC-02D');
    assert.notEqual(normalizeId('STORY-OPS-001'), normalizeId('STORY-1'));
  });
});

describe('readBacklog against a temporary estate', () => {
  let root: string;

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'smc-'));
    mkdirSync(join(root, 'backlog/tasks'), { recursive: true });
    mkdirSync(join(root, 'backlog/completed'), { recursive: true });
    writeFileSync(join(root, 'backlog/tasks/story-142 - a.md'), ACTIVE);
    writeFileSync(join(root, 'backlog/completed/story-059 - b.md'), COMPLETED);
    writeFileSync(join(root, 'backlog/completed/story-sec-02d - c.md'), COMPOSITE);
    writeFileSync(join(root, 'backlog/tasks/notes.txt'), 'ignored');
  });

  after(() => rmSync(root, { recursive: true, force: true }));

  test('loads both directories and flags completion by directory', () => {
    const read = readBacklog(resolveBacklogPaths(root));
    assert.equal(read.items.length, 3);
    assert.equal(read.problems.length, 0);
    assert.equal(read.items.filter((i) => i.completed).length, 2);
    assert.equal(read.items.filter((i) => !i.completed).length, 1);
  });

  test('indexes by id and resolves regardless of filename', () => {
    const index = new WorkItemIndex(readBacklog(resolveBacklogPaths(root)));
    assert.equal(index.size, 3);
    assert.equal(index.get('STORY-142')!.title.startsWith('Sync a note'), true);
    assert.equal(index.get('story-59')!.id, 'STORY-059');
    assert.equal(index.get('STORY-SEC-02D')!.completed, true);
    assert.equal(index.get('STORY-999'), undefined);
  });

  test('does not modify the files it reads', () => {
    const path = join(root, 'backlog/tasks/story-142 - a.md');
    const before = readFileSync(path, 'utf8');
    readBacklog(resolveBacklogPaths(root));
    assert.equal(readFileSync(path, 'utf8'), before);
  });

  test('reports a duplicate id and keeps the first', () => {
    const dupRoot = mkdtempSync(join(tmpdir(), 'smc-dup-'));
    mkdirSync(join(dupRoot, 'backlog/tasks'), { recursive: true });
    writeFileSync(join(dupRoot, 'backlog/tasks/a.md'), ACTIVE);
    writeFileSync(join(dupRoot, 'backlog/tasks/b.md'), ACTIVE.replace('story-142', 'story-142-copy'));
    const index = new WorkItemIndex(readBacklog(resolveBacklogPaths(dupRoot)));
    assert.equal(index.size, 1);
    assert.equal(index.duplicates.length, 1);
    assert.match(index.duplicates[0].detail, /already claimed by/);
    rmSync(dupRoot, { recursive: true, force: true });
  });
});
