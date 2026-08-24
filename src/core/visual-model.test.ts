import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, describe, before, after } from 'node:test';
import { Workspace, fingerprint } from './workspace';
import { buildVisualStoryMap, cardsAt, deliveryLaneFor, toneFor, workflowLaneFor, workTypeFor } from './visual-model';
import type { WorkItem } from './types';
import { filterStories, facets } from './queries';

const MAP = `schemaVersion: 1
id: demo
title: Demo journey
kind: journey
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
  - id: alpha
    title: First activity
    steps:
      - id: a1
        title: Step A1
        slices:
          delivered:
            - STORY-001
            - STORY-002
          planned:
            - STORY-003
      - id: a2
        title: Step A2
        slices:
          planned:
            - STORY-004
        supporting:
          - STORY-005
  - id: beta
    title: Second activity
    steps:
      - id: b1
        title: Step B1
        slices:
          planned:
            - STORY-006
            - STORY-404
`;

function story(id: string, o: { status: string; completed: boolean; wstatus?: string }): string {
  return `---
id: ${id}
title: Story ${id}
status: ${o.status}
assignee: []
created_date: '2026-08-01 10:00'
labels:
  - 'area:demo'
${o.wstatus ? `  - 'wstatus:${o.wstatus}'\n` : ''}dependencies: []
type: story
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Body ${id}.
<!-- SECTION:DESCRIPTION:END -->
`;
}

let root: string;
let ws: Workspace;

describe('buildVisualStoryMap', () => {
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'sm-vis-'));
    mkdirSync(join(root, 'backlog/tasks'), { recursive: true });
    mkdirSync(join(root, 'backlog/completed'), { recursive: true });
    mkdirSync(join(root, 'backlog/story-maps'), { recursive: true });
    writeFileSync(join(root, 'backlog/completed/1.md'), story('STORY-001', { status: 'Done', completed: true, wstatus: 'done' }));
    writeFileSync(join(root, 'backlog/completed/2.md'), story('STORY-002', { status: 'Done', completed: true, wstatus: 'done' }));
    writeFileSync(join(root, 'backlog/tasks/3.md'), story('STORY-003', { status: 'In Progress', completed: false, wstatus: 'in_progress' }));
    writeFileSync(join(root, 'backlog/tasks/4.md'), story('STORY-004', { status: 'To Do', completed: false, wstatus: 'ready' }));
    writeFileSync(join(root, 'backlog/completed/5.md'), story('STORY-005', { status: 'Done', completed: true, wstatus: 'done' }));
    writeFileSync(join(root, 'backlog/tasks/6.md'), story('STORY-006', { status: 'To Do', completed: false, wstatus: 'blocked' }));
    writeFileSync(join(root, 'backlog/story-maps/demo.yaml'), MAP);
    ws = Workspace.load(root);
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  const model = () => buildVisualStoryMap(ws.resolve('demo')!);

  test('preserves activity order from the file', () => {
    assert.deepEqual(model().activities.map((a) => a.id), ['alpha', 'beta']);
  });

  test('preserves step order and numbers them within their activity', () => {
    const m = model();
    assert.deepEqual(m.steps.map((s) => s.id), ['a1', 'a2', 'b1']);
    assert.deepEqual(m.steps.map((s) => s.ordinal), [1, 2, 1]);
    assert.deepEqual(m.steps.map((s) => s.activityId), ['alpha', 'alpha', 'beta']);
  });

  test('preserves slice order from the file', () => {
    assert.deepEqual(model().lanes.map((l) => l.id), ['delivered', 'planned']);
    assert.equal(model().lanesDerived, false);
  });

  test('places each story in the cell its file names', () => {
    const m = model();
    assert.deepEqual(cardsAt(m, 'delivered', 'a1').map((c) => c.storyId), ['STORY-001', 'STORY-002']);
    assert.deepEqual(cardsAt(m, 'planned', 'a1').map((c) => c.storyId), ['STORY-003']);
    assert.deepEqual(cardsAt(m, 'planned', 'a2').map((c) => c.storyId), ['STORY-004']);
    assert.deepEqual(cardsAt(m, 'delivered', 'a2'), []);
  });

  test('an empty cell resolves to an empty array, never undefined', () => {
    assert.deepEqual(cardsAt(model(), 'delivered', 'b1'), []);
    assert.deepEqual(cardsAt(model(), 'no-such-lane', 'no-such-step'), []);
  });

  test('completed stories resolve and keep their cell', () => {
    const card = cardsAt(model(), 'delivered', 'a1')[0];
    assert.equal(card.completed, true);
    assert.equal(card.tone, 'done');
  });

  test('supporting stories stay out of the primary grid', () => {
    const m = model();
    assert.deepEqual(m.supporting.map((c) => c.storyId), ['STORY-005']);
    assert.equal(m.supporting[0].supporting, true);
    const inGrid = m.lanes.flatMap((l) => m.steps.flatMap((s) => cardsAt(m, l.id, s.id).map((c) => c.storyId)));
    assert.ok(!inGrid.includes('STORY-005'));
  });

  test('an unresolved reference becomes a visible card, not a hole', () => {
    const cards = cardsAt(model(), 'planned', 'b1');
    assert.deepEqual(cards.map((c) => c.storyId), ['STORY-006', 'STORY-404']);
    assert.equal(cards[1].missing, true);
    assert.equal(cards[1].tone, 'missing');
  });

  test('counts lanes, activities and totals', () => {
    const m = model();
    assert.equal(m.lanes.find((l) => l.id === 'delivered')!.count, 2);
    assert.equal(m.lanes.find((l) => l.id === 'planned')!.count, 4);
    assert.equal(m.activities[0].cardCount, 4);
    assert.equal(m.totals.shown, 6);
    assert.equal(m.totals.completed, 2);
    assert.equal(m.totals.supporting, 1);
    assert.equal(m.totals.missing, 1);
  });

  test('hideCompleted removes completed cards and reports how many', () => {
    const m = buildVisualStoryMap(ws.resolve('demo')!, { hideCompleted: true });
    assert.deepEqual(cardsAt(m, 'delivered', 'a1'), []);
    assert.equal(m.totals.completed, 0);
    assert.equal(m.totals.hiddenByFilter, 3, 'two primary plus the supporting one');
    assert.deepEqual(m.supporting, []);
  });

  test('focusing an activity keeps only that activity and its steps', () => {
    const m = buildVisualStoryMap(ws.resolve('demo')!, { activity: 'beta' });
    assert.deepEqual(m.activities.map((a) => a.id), ['beta']);
    assert.deepEqual(m.steps.map((s) => s.id), ['b1']);
  });

  test('a status filter narrows the cells', () => {
    const m = buildVisualStoryMap(ws.resolve('demo')!, { status: 'In Progress' });
    assert.equal(m.totals.shown, 1);
    assert.deepEqual(cardsAt(m, 'planned', 'a1').map((c) => c.storyId), ['STORY-003']);
  });

  test('derived delivery lanes are opt-in and regroup the same stories', () => {
    const m = buildVisualStoryMap(ws.resolve('demo')!, { laneMode: 'delivery' });
    assert.equal(m.lanesDerived, true);
    // Empty derived lanes collapse; delivered is last whatever survives.
    assert.deepEqual(m.lanes.map((l) => l.id), ['in-progress', 'next', 'later', 'delivered']);
    assert.deepEqual(cardsAt(m, 'delivered', 'a1').map((c) => c.storyId), ['STORY-001', 'STORY-002']);
    assert.deepEqual(cardsAt(m, 'in-progress', 'a1').map((c) => c.storyId), ['STORY-003']);
    assert.deepEqual(cardsAt(m, 'next', 'a2').map((c) => c.storyId), ['STORY-004']);
    // STORY-404 resolves to nothing, so it has no state to derive a lane from and
    // falls through to the last lane rather than disappearing.
    assert.deepEqual(cardsAt(m, 'later', 'b1').map((c) => c.storyId), ['STORY-006', 'STORY-404']);
    // Same population, different grouping: nothing is invented or lost.
    assert.equal(m.totals.shown, 6);
  });

  test('an unresolved reference is still drawn when its declared lane does not exist', () => {
    // In delivery mode there is no `planned` lane to hold it, and a reference
    // the map makes must never vanish: it falls through to the lane that
    // absorbs unknowns — never to a finished lane.
    const m = buildVisualStoryMap(ws.resolve('demo')!, { laneMode: 'delivery' });
    const allMissing = m.lanes.flatMap((l) => m.steps.flatMap((s) => cardsAt(m, l.id, s.id))).filter((c) => c.missing);
    assert.equal(allMissing.length, 1, 'drawn exactly once');
    assert.deepEqual(cardsAt(m, 'later', 'b1').map((c) => c.storyId), ['STORY-006', 'STORY-404']);
    assert.equal(m.totals.shown, 6, 'nothing is lost by regrouping');
  });
});

describe('deliveryLaneFor and toneFor', () => {
  const item = (o: Partial<WorkItem>): WorkItem =>
    ({
      id: 'STORY-1',
      title: 't',
      status: 'To Do',
      labels: [],
      dependencies: [],
      documentation: [],
      acceptanceCriteria: [],
      bodyAcceptanceCriteria: [],
      definitionOfDone: [],
      body: '',
      sections: {},
      frontmatter: {},
      sourcePath: 'x.md',
      completed: false,
      otherLabels: [],
      ...o,
    }) as WorkItem;

  test('is deterministic across the delivery vocabulary', () => {
    assert.equal(deliveryLaneFor(item({ completed: true })), 'delivered');
    assert.equal(deliveryLaneFor(item({ status: 'In Progress' })), 'in-progress');
    assert.equal(deliveryLaneFor(item({ wstatus: 'deployed_partial' })), 'in-progress');
    assert.equal(deliveryLaneFor(item({ wstatus: 'ready' })), 'next');
    assert.equal(deliveryLaneFor(item({ wstatus: 'backlog' })), 'later');
    assert.equal(deliveryLaneFor(item({ wstatus: 'blocked' })), 'later');
  });

  test('done in code but not on a host is its own lane, not Later', () => {
    // 44 stories in this estate are `status: Done` while still in tasks/.
    assert.equal(deliveryLaneFor(item({ status: 'Done', completed: false })), 'built');
    assert.equal(deliveryLaneFor(item({ wstatus: 'implemented_not_deployed' })), 'built');
    assert.equal(deliveryLaneFor(item({ wstatus: 'implemented_pending_deploy' })), 'built');
  });

  test('closed without delivery is Later, never almost-delivered', () => {
    assert.equal(deliveryLaneFor(item({ status: 'Done', wstatus: 'cancelled' })), 'later');
    assert.equal(deliveryLaneFor(item({ status: 'Done', wstatus: 'superseded' })), 'later');
  });

  test('tone distinguishes blocked from ordinary to-do', () => {
    assert.equal(toneFor(item({ completed: true })), 'done');
    assert.equal(toneFor(item({ status: 'In Progress' })), 'progress');
    assert.equal(toneFor(item({ wstatus: 'blocked' })), 'blocked');
    assert.equal(toneFor(item({ wstatus: 'backlog' })), 'backlog');
    assert.equal(toneFor(item({ wstatus: 'ready' })), 'todo');
  });
});

describe('workflowLaneFor — the planning classifier', () => {
  const item = (o: Partial<WorkItem>): WorkItem =>
    ({
      id: 'STORY-1',
      title: 't',
      status: 'To Do',
      labels: [],
      dependencies: [],
      documentation: [],
      acceptanceCriteria: [],
      bodyAcceptanceCriteria: [],
      definitionOfDone: [],
      body: '',
      sections: {},
      frontmatter: {},
      sourcePath: 'x.md',
      completed: false,
      otherLabels: [],
      ...o,
    }) as WorkItem;

  test('work under way lands in In Progress', () => {
    assert.equal(workflowLaneFor(item({ status: 'In Progress', wstatus: 'in_progress' })), 'in-progress');
    assert.equal(workflowLaneFor(item({ status: 'In Progress', wstatus: 'deployed_partial' })), 'in-progress');
  });

  test('ready and todo land in To Do', () => {
    assert.equal(workflowLaneFor(item({ status: 'To Do', wstatus: 'ready' })), 'todo');
    assert.equal(workflowLaneFor(item({ status: 'To Do', wstatus: 'todo' })), 'todo');
  });

  test('backlog lands in Backlog', () => {
    assert.equal(workflowLaneFor(item({ status: 'To Do', wstatus: 'backlog' })), 'backlog');
  });

  test('really finished work lands in Done', () => {
    assert.equal(workflowLaneFor(item({ status: 'Done', wstatus: 'done' })), 'done');
    assert.equal(workflowLaneFor(item({ status: 'Done', wstatus: 'done', completed: true })), 'done');
  });

  test('Done in name only is NOT Done', () => {
    // Five stories in this estate are exactly this: the coarse status says Done
    // while the delivery label says the work is not on a host yet.
    assert.equal(workflowLaneFor(item({ status: 'Done', wstatus: 'implemented_not_deployed' })), 'in-progress');
    assert.equal(workflowLaneFor(item({ status: 'Done', wstatus: 'implemented_pending_deploy' })), 'in-progress');
    // And a stale planning label outranks a Done status in the other direction.
    assert.equal(workflowLaneFor(item({ status: 'Done', wstatus: 'backlog' })), 'backlog');
  });

  test('blocked and needs-decision share one visible lane', () => {
    assert.equal(workflowLaneFor(item({ status: 'To Do', wstatus: 'blocked' })), 'blocked');
    assert.equal(workflowLaneFor(item({ status: 'To Do', wstatus: 'needs-decision' })), 'blocked');
    assert.equal(workflowLaneFor(item({ status: 'To Do', wstatus: 'blocked-needs-decision' })), 'blocked');
  });

  test('closed without delivery is neither Done nor Backlog', () => {
    assert.equal(workflowLaneFor(item({ status: 'Done', wstatus: 'cancelled' })), 'closed');
    assert.equal(workflowLaneFor(item({ status: 'Done', wstatus: 'superseded' })), 'closed');
    assert.equal(workflowLaneFor(item({ status: 'Done', wstatus: 'cancelled', completed: true })), 'closed');
  });

  test('an unknown wstatus falls back to the coarse status, never silently to Done', () => {
    assert.equal(workflowLaneFor(item({ status: 'To Do', wstatus: 'invented-value' })), 'backlog');
    assert.equal(workflowLaneFor(item({ status: 'In Progress', wstatus: 'invented-value' })), 'in-progress');
    assert.equal(workflowLaneFor(item({ status: 'To Do' })), 'backlog', 'no wstatus at all');
  });

  test('a story that reached production is never shown as backlog', () => {
    assert.equal(workflowLaneFor(item({ status: 'To Do', wstatus: 'backlog', completed: true })), 'done');
  });
});

describe('lane ordering — Done is always last', () => {
  const root2 = () => {
    const dir = mkdtempSync(join(tmpdir(), 'sm-order-'));
    mkdirSync(join(dir, 'backlog/tasks'), { recursive: true });
    mkdirSync(join(dir, 'backlog/completed'), { recursive: true });
    mkdirSync(join(dir, 'backlog/story-maps'), { recursive: true });
    return dir;
  };

  test('every derived lane set ends with the finished lane', () => {
    const dir = root2();
    // One story per workflow lane, so nothing collapses and the full order shows.
    const rows: [string, string, string, boolean][] = [
      ['STORY-001', 'To Do', 'blocked', false],
      ['STORY-002', 'In Progress', 'in_progress', false],
      ['STORY-003', 'To Do', 'ready', false],
      ['STORY-004', 'To Do', 'backlog', false],
      ['STORY-005', 'Done', 'cancelled', false],
      ['STORY-006', 'Done', 'done', true],
    ];
    for (const [id, status, wstatus, done] of rows) {
      const body = `---\nid: ${id}\ntitle: Story ${id}\nstatus: ${status}\nassignee: []\ncreated_date: '2026-08-01 10:00'\nlabels:\n  - 'wstatus:${wstatus}'\ndependencies: []\ntype: story\n---\n\n## Description\n\n<!-- SECTION:DESCRIPTION:BEGIN -->\nb\n<!-- SECTION:DESCRIPTION:END -->\n`;
      writeFileSync(join(dir, `backlog/${done ? 'completed' : 'tasks'}/${id}.md`), body);
    }
    writeFileSync(
      join(dir, 'backlog/story-maps/m.yaml'),
      `schemaVersion: 1\nid: m\ntitle: M\nkind: journey\nreleaseSlices:\n  - id: only\n    title: Only\n    order: 1\nactivities:\n  - id: a\n    title: A\n    steps:\n      - id: s\n        title: S\n        slices:\n          only:\n${rows.map(([id]) => `            - ${id}`).join('\n')}\n`,
    );
    const ws2 = Workspace.load(dir);

    const workflow = buildVisualStoryMap(ws2.resolve('m')!, { laneMode: 'workflow' });
    assert.deepEqual(workflow.lanes.map((l) => l.id), ['blocked', 'in-progress', 'todo', 'backlog', 'closed', 'done']);
    assert.equal(workflow.lanes[workflow.lanes.length - 1].id, 'done', 'Done is the bottom lane');

    const delivery = buildVisualStoryMap(ws2.resolve('m')!, { laneMode: 'delivery' });
    assert.equal(
      delivery.lanes[delivery.lanes.length - 1].id,
      'delivered',
      'the delivery projection also ends with the finished lane',
    );
    assert.ok(delivery.lanes.length > 1, 'and it is not the only lane');

    rmSync(dir, { recursive: true, force: true });
  });

  test('an explicit file order is never reordered by the application', () => {
    const dir = root2();
    writeFileSync(
      join(dir, 'backlog/tasks/STORY-001.md'),
      `---\nid: STORY-001\ntitle: S\nstatus: Done\nassignee: []\ncreated_date: '2026-08-01 10:00'\nlabels:\n  - 'wstatus:done'\ndependencies: []\ntype: story\n---\n\n## Description\n\n<!-- SECTION:DESCRIPTION:BEGIN -->\nb\n<!-- SECTION:DESCRIPTION:END -->\n`,
    );
    writeFileSync(
      join(dir, 'backlog/story-maps/m.yaml'),
      `schemaVersion: 1\nid: m\ntitle: M\nkind: journey\nreleaseSlices:\n  - id: mvp\n    title: MVP\n    order: 10\n  - id: alpha\n    title: Alpha\n    order: 20\n  - id: v1\n    title: V1\n    order: 30\nactivities:\n  - id: a\n    title: A\n    steps:\n      - id: s\n        title: S\n        slices:\n          v1:\n            - STORY-001\n`,
    );
    const ws2 = Workspace.load(dir);
    const sliced = buildVisualStoryMap(ws2.resolve('m')!, { laneMode: 'slices' });
    assert.deepEqual(sliced.lanes.map((l) => l.id), ['mvp', 'alpha', 'v1'], 'author order, empty lanes kept');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('workTypeFor', () => {
  const withType = (labels: string[]): WorkItem =>
    ({
      id: 'STORY-1',
      title: 't',
      status: 'To Do',
      labels,
      dependencies: [],
      documentation: [],
      acceptanceCriteria: [],
      bodyAcceptanceCriteria: [],
      definitionOfDone: [],
      body: '',
      sections: {},
      frontmatter: {},
      sourcePath: 'x.md',
      completed: false,
      otherLabels: [],
      wtype: labels.find((l) => l.startsWith('wtype:'))?.slice(6),
      type: 'story',
    }) as WorkItem;

  test('renders the estate’s real values for display', () => {
    assert.equal(workTypeFor(withType(['wtype:bug'])), 'Bug');
    assert.equal(workTypeFor(withType(['wtype:fix'])), 'Fix');
    assert.equal(workTypeFor(withType(['wtype:feature'])), 'Feature');
    assert.equal(workTypeFor(withType(['wtype:defect'])), 'Defect');
    assert.equal(workTypeFor(withType(['wtype:investigation'])), 'Investigation');
    assert.equal(workTypeFor(withType(['wtype:security'])), 'Security');
  });

  test('a multi-word value reads as words, not as a slug', () => {
    assert.equal(workTypeFor(withType(['wtype:needs-decision'])), 'Needs Decision');
    assert.equal(workTypeFor(withType(['wtype:visual_damage'])), 'Visual Damage');
  });

  test('no wtype means no type shown — never the generic native type', () => {
    // Every story in this estate carries `type: story`; showing it would put the
    // same meaningless word on every card.
    const none = withType([]);
    assert.equal(workTypeFor(none), undefined);
    assert.equal(none.type, 'story', 'the native type is present but deliberately unused');
  });

  test('two wtype labels resolve deterministically to the first', () => {
    const conflicted = withType(['wtype:bug']);
    (conflicted as { labels: string[] }).labels = ['wtype:bug', 'wtype:fix'];
    assert.equal(workTypeFor(conflicted), 'Bug', 'first label wins, every time');
  });
});

describe('milestones', () => {
  let dir: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'sm-ms-'));
    mkdirSync(join(dir, 'backlog/tasks'), { recursive: true });
    mkdirSync(join(dir, 'backlog/completed'), { recursive: true });
    mkdirSync(join(dir, 'backlog/story-maps'), { recursive: true });
    mkdirSync(join(dir, 'backlog/milestones'), { recursive: true });
    mkdirSync(join(dir, 'backlog/archive/milestones'), { recursive: true });

    const st = (id: string, milestone?: string) =>
      `---\nid: ${id}\ntitle: Story ${id}\nstatus: To Do\nassignee: []\ncreated_date: '2026-08-01 10:00'\nlabels:\n  - 'wstatus:backlog'\ndependencies: []\n${milestone ? `milestone: ${milestone}\n` : ''}type: story\n---\n\n## Description\n\n<!-- SECTION:DESCRIPTION:BEGIN -->\nb\n<!-- SECTION:DESCRIPTION:END -->\n`;
    writeFileSync(join(dir, 'backlog/tasks/STORY-001.md'), st('STORY-001', 'm-0'));
    writeFileSync(join(dir, 'backlog/tasks/STORY-002.md'), st('STORY-002', 'm-0'));
    writeFileSync(join(dir, 'backlog/tasks/STORY-003.md'), st('STORY-003'));
    writeFileSync(join(dir, 'backlog/tasks/STORY-004.md'), st('STORY-004', 'm-9'));
    writeFileSync(
      join(dir, 'backlog/milestones/m-0 - alfa.md'),
      '---\nid: m-0\ntitle: "Alfa Release 2.0"\n---\n\n## Description\n\nMilestone.\n',
    );
    writeFileSync(
      join(dir, 'backlog/archive/milestones/m-9 - old.md'),
      '---\nid: m-9\ntitle: "Retired Release"\n---\n\n## Description\n\nMilestone.\n',
    );
    writeFileSync(
      join(dir, 'backlog/story-maps/m.yaml'),
      `schemaVersion: 1\nid: m\ntitle: M\nkind: journey\nreleaseSlices:\n  - id: only\n    title: Only\n    order: 1\nactivities:\n  - id: a\n    title: A\n    steps:\n      - id: s\n        title: S\n        slices:\n          only:\n            - STORY-001\n            - STORY-002\n            - STORY-003\n            - STORY-004\n`,
    );
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  test('a story carries the milestone id its front matter names', () => {
    const ws2 = Workspace.load(dir);
    assert.equal(ws2.index.get('STORY-001')!.milestone, 'm-0');
    assert.equal(ws2.index.get('STORY-003')!.milestone, undefined);
  });

  test('milestone files are read, archived ones included', () => {
    const ws2 = Workspace.load(dir);
    assert.deepEqual(
      ws2.milestones.map((m) => [m.id, m.title, m.archived]),
      [['m-0', 'Alfa Release 2.0', false], ['m-9', 'Retired Release', true]],
    );
  });

  test('an id resolves to the title a person recognises', () => {
    const ws2 = Workspace.load(dir);
    assert.equal(ws2.milestoneTitle('m-0'), 'Alfa Release 2.0');
    assert.equal(ws2.milestoneTitle('m-9'), 'Retired Release', 'archived still resolves');
    assert.equal(ws2.milestoneTitle('m-404'), 'm-404', 'an undeclared id falls back to itself');
    assert.equal(ws2.milestoneTitle(undefined), undefined);
  });

  test('the story list filters by milestone, including the unassigned case', () => {
    const ws2 = Workspace.load(dir);
    assert.equal(filterStories(ws2, { milestone: 'm-0' }).length, 2);
    assert.equal(filterStories(ws2, { milestone: 'm-9' }).length, 1);
    assert.equal(filterStories(ws2, { milestone: 'none' }).length, 1);
    assert.equal(filterStories(ws2, {}).length, 4);
  });

  test('the milestone facet counts what is there', () => {
    const ws2 = Workspace.load(dir);
    assert.deepEqual(facets(ws2.index.items).milestone, [
      { value: 'm-0', count: 2 },
      { value: 'm-9', count: 1 },
    ]);
  });

  test('the wall filters by milestone without changing placement', () => {
    const ws2 = Workspace.load(dir);
    const all = buildVisualStoryMap(ws2.resolve('m')!);
    const only = buildVisualStoryMap(ws2.resolve('m')!, { milestone: 'm-0' });
    const none = buildVisualStoryMap(ws2.resolve('m')!, { milestone: 'none' });
    assert.equal(all.totals.shown, 4);
    assert.equal(only.totals.shown, 2);
    // `none` means no milestone at all — STORY-004 is in m-9, so it does not qualify.
    assert.equal(none.totals.shown, 1);
    assert.deepEqual(cardsAt(only, 'only', 's').map((c) => c.storyId), ['STORY-001', 'STORY-002']);
    assert.deepEqual(only.steps.map((s) => s.id), all.steps.map((s) => s.id), 'steps unchanged');
  });

  test('a milestone edit on disk is picked up by the fingerprint', () => {
    const before = fingerprint(dir);
    writeFileSync(
      join(dir, 'backlog/milestones/m-1 - beta.md'),
      '---\nid: m-1\ntitle: "Beta"\n---\n\n## Description\n\nMilestone.\n',
    );
    assert.notEqual(fingerprint(dir), before);
    rmSync(join(dir, 'backlog/milestones/m-1 - beta.md'));
  });
});
