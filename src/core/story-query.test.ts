import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseWorkItem } from './backlog-reader';
import { matches } from './queries';
import {
  isEmptyStoryQuery,
  matchesStoryQuery,
  parseStoryQuery,
  serializeStoryQuery,
} from './story-query';
import type { StoryQuery } from './story-query';
import type { WorkItem } from './types';

function item(id: string, o: { status: string; labels?: string[]; milestone?: string; priority?: string; completed?: boolean }): WorkItem {
  const raw = `---
id: ${id}
title: Story ${id}
status: ${o.status}
labels: [${(o.labels ?? []).map((l) => `'${l}'`).join(', ')}]
${o.milestone ? `milestone: ${o.milestone}\n` : ''}${o.priority ? `priority: ${o.priority}\n` : ''}---
Body of ${id}.
`;
  return parseWorkItem(raw, `tasks/${id}.md`, o.completed ?? false).item!;
}

const ITEMS = [
  item('FW-1', { status: 'Backlog', labels: ['owner:platform', 'wtype:defect', 'priority:p1'], milestone: 'm-0', priority: 'high' }),
  item('FW-2', { status: 'Ready', labels: ['owner:backend', 'wtype:feature', 'priority:p2'], milestone: 'm-1' }),
  item('FW-3', { status: 'In Progress', labels: ['owner:platform', 'wtype:feature'], milestone: 'm-2' }),
  item('FW-4', { status: 'Done', labels: ['owner:platform', 'wtype:chore'], completed: true }),
  item('FW-5', { status: 'Cancelled', labels: ['wtype:defect'], milestone: 'm-0', priority: 'low' }),
];
const MEMBERSHIP = new Map<string, Set<string>>([
  ['FW-1', new Set(['seller'])],
  ['FW-2', new Set(['seller', 'dealer'])],
  ['FW-3', new Set(['dealer'])],
]);

const run = (search: string) =>
  ITEMS.filter((i) => matchesStoryQuery(i, parseStoryQuery(new URLSearchParams(search)), MEMBERSHIP)).map((i) => i.id);

describe('story query: parsing', () => {
  test('a single value is inclusion', () => {
    assert.deepEqual(parseStoryQuery(new URLSearchParams('status=Done')), { fields: { status: { op: 'in', values: ['Done'] } } });
  });

  test('repeated values collect in order, duplicates and blanks dropped', () => {
    const q = parseStoryQuery(new URLSearchParams('status=Backlog&status=Ready&status=&status=Backlog&status=%20'));
    assert.deepEqual(q.fields.status, { op: 'in', values: ['Backlog', 'Ready'] });
  });

  test('`.op=not` makes the field an exclusion; anything else stays inclusion', () => {
    assert.equal(parseStoryQuery(new URLSearchParams('status=Done&status.op=not')).fields.status?.op, 'not');
    assert.equal(parseStoryQuery(new URLSearchParams('status=Done&status.op=bogus')).fields.status?.op, 'in');
  });

  test('an operator with no values, or empty values, is no restriction', () => {
    assert.ok(isEmptyStoryQuery(parseStoryQuery(new URLSearchParams('status.op=not'))));
    assert.ok(isEmptyStoryQuery(parseStoryQuery(new URLSearchParams('status=&owner=&text='))));
  });

  test('reads Express-style query objects, where a repeated key is an array', () => {
    const q = parseStoryQuery({ owner: ['platform', 'backend'], 'owner.op': 'not', status: 'Ready', junk: { a: 1 } });
    assert.deepEqual(q.fields.owner, { op: 'not', values: ['platform', 'backend'] });
    assert.deepEqual(q.fields.status, { op: 'in', values: ['Ready'] });
  });

  test('serialising is canonical and round-trips', () => {
    const q: StoryQuery = {
      text: 'auth',
      fields: { milestone: { op: 'in', values: ['m-0', 'm-1'] }, status: { op: 'not', values: ['Done', 'Cancelled'] }, owner: { op: 'in', values: [] } },
    };
    const s = serializeStoryQuery(q, [['view', 'kanban']]);
    assert.equal(s, '?text=auth&status=Done&status=Cancelled&status.op=not&milestone=m-0&milestone=m-1&view=kanban');
    const back = parseStoryQuery(new URLSearchParams(s));
    assert.deepEqual(back, { text: 'auth', fields: { status: q.fields.status, milestone: q.fields.milestone } });
    assert.equal(serializeStoryQuery({ fields: {} }), '');
  });
});

describe('story query: matching', () => {
  test('single include', () => assert.deepEqual(run('status=Ready'), ['FW-2']));

  test('multiple includes are ORed within a field', () => {
    assert.deepEqual(run('status=Backlog&status=Ready&status=In%20Progress'), ['FW-1', 'FW-2', 'FW-3']);
  });

  test('single exclusion', () => assert.deepEqual(run('status=Done&status.op=not'), ['FW-1', 'FW-2', 'FW-3', 'FW-5']));

  test('multiple exclusions are NOT IN', () => {
    assert.deepEqual(run('status=Done&status=Cancelled&status.op=not'), ['FW-1', 'FW-2', 'FW-3']);
  });

  test('different fields are ANDed', () => {
    assert.deepEqual(run('wtype=defect&wtype=feature&owner=platform'), ['FW-1', 'FW-3']);
    assert.deepEqual(run('status=Done&status=Cancelled&status.op=not&milestone=m-0&milestone=m-1'), ['FW-1', 'FW-2']);
  });

  test('exclusion keeps stories with no value for the field', () => {
    assert.deepEqual(run('owner=platform&owner.op=not'), ['FW-2', 'FW-5']);
  });

  test('`none` means "no value", included or excluded', () => {
    assert.deepEqual(run('owner=none'), ['FW-5']);
    assert.deepEqual(run('milestone=none'), ['FW-4']);
    assert.deepEqual(run('milestone=none&milestone.op=not'), ['FW-1', 'FW-2', 'FW-3', 'FW-5']);
    assert.deepEqual(run('priority=none'), ['FW-3', 'FW-4', 'FW-5']);
  });

  test('map membership is a set: IN any, NOT IN every named map', () => {
    assert.deepEqual(run('map=seller'), ['FW-1', 'FW-2']);
    assert.deepEqual(run('map=seller&map=dealer'), ['FW-1', 'FW-2', 'FW-3']);
    assert.deepEqual(run('map=dealer&map.op=not'), ['FW-1', 'FW-4', 'FW-5']);
    assert.deepEqual(run('map=none'), ['FW-4', 'FW-5']);
  });

  test('state is active / completed', () => {
    assert.deepEqual(run('state=completed'), ['FW-4']);
    assert.deepEqual(run('state=active&state=completed'), ITEMS.map((i) => i.id));
    assert.deepEqual(run('state=completed&state.op=not'), ['FW-1', 'FW-2', 'FW-3', 'FW-5']);
  });

  test('priority is the label scale, case-insensitively', () => {
    assert.deepEqual(run('priority=p1'), ['FW-1']);
    assert.deepEqual(run('priority=P1&priority=P2'), ['FW-1', 'FW-2']);
  });

  test('reset: an empty query matches everything', () => {
    assert.deepEqual(run(''), ITEMS.map((i) => i.id));
  });
});

describe('story query: backwards compatibility', () => {
  test('old single-value URLs mean what they meant', () => {
    assert.deepEqual(run('status=Backlog'), ['FW-1']);
    assert.deepEqual(run('milestone=m-0'), ['FW-1', 'FW-5']);
    assert.deepEqual(run('map=none'), ['FW-4', 'FW-5']);
    assert.deepEqual(run('state=active&owner=platform'), ['FW-1', 'FW-3']);
  });

  test('the old "all" option (an empty value) is no restriction', () => {
    assert.deepEqual(run('status=&owner=&milestone='), ITEMS.map((i) => i.id));
  });

  test('old ?priority=high still selects Backlog.md native priority', () => {
    assert.deepEqual(run('priority=high'), ['FW-1']);
    assert.deepEqual(run('priority=low'), ['FW-5']);
  });

  test('the legacy StoryFilter object still filters through the same matcher', () => {
    assert.equal(matches(ITEMS[0], { status: 'Backlog', owner: 'platform' }), true);
    assert.equal(matches(ITEMS[1], { status: 'Backlog' }), false);
    assert.equal(matches(ITEMS[3], { map: 'none' }, MEMBERSHIP), true);
  });
});
