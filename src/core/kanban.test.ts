import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseWorkItem } from './backlog-reader';
import { buildKanban, DEFAULT_STATUSES, sortColumn, visibleStatuses } from './kanban';
import type { WorkItem } from './types';

function item(id: string, status: string, extra = ''): WorkItem {
  return parseWorkItem(`---\nid: ${id}\ntitle: ${id}\nstatus: ${status}\n${extra}---\n`, `${id}.md`, false).item!;
}

const STATUSES = ['Backlog', 'Ready', 'In Progress', 'Done - Local'];

describe('kanban grouping (Backlog.md board semantics)', () => {
  test('one column per declared status, in declared order, empty ones included', () => {
    const board = buildKanban([item('A-1', 'Ready'), item('A-2', 'Backlog')], { statuses: STATUSES });
    assert.equal(board.lanes.length, 1);
    assert.deepEqual(board.lanes[0].columns.map((c) => [c.status, c.items.length, c.declared]), [
      ['Backlog', 1, true],
      ['Ready', 1, true],
      ['In Progress', 0, true],
      ['Done - Local', 0, true],
    ]);
  });

  test('a status the config does not declare gets a trailing, undeclared column instead of vanishing', () => {
    const board = buildKanban([item('A-1', 'Ready'), item('A-2', 'superseded')], { statuses: STATUSES });
    const last = board.lanes[0].columns.at(-1)!;
    assert.equal(last.status, 'superseded');
    assert.equal(last.declared, false);
    assert.deepEqual(last.items.map((i) => i.id), ['A-2']);
  });

  test('no declared statuses falls back to Backlog.md defaults', () => {
    assert.deepEqual(buildKanban([], {}).statuses, DEFAULT_STATUSES);
  });

  test('a status filter decides which columns are drawn', () => {
    assert.deepEqual(visibleStatuses(STATUSES, { op: 'in', values: ['Ready', 'Backlog'] }), ['Backlog', 'Ready']);
    assert.deepEqual(visibleStatuses(STATUSES, { op: 'not', values: ['Done - Local'] }), ['Backlog', 'Ready', 'In Progress']);
    assert.deepEqual(visibleStatuses(STATUSES, undefined), STATUSES);
  });

  test('in-column order: ordinal first, then created ascending, or updated descending in a done column', () => {
    const tiebreak = (a: WorkItem, b: WorkItem) => a.id.localeCompare(b.id);
    const todo = [
      item('A-1', 'Ready', "created_date: '2026-01-03'\n"),
      item('A-2', 'Ready', "created_date: '2026-01-01'\n"),
      item('A-3', 'Ready', "created_date: '2026-01-09'\nordinal: 5\n"),
      item('A-4', 'Ready', "created_date: '2026-01-09'\nordinal: 2\n"),
    ];
    assert.deepEqual(sortColumn(todo, 'Ready', tiebreak).map((i) => i.id), ['A-4', 'A-3', 'A-2', 'A-1']);
    const done = [
      item('B-1', 'Done - Local', "created_date: '2026-01-01'\nupdated_date: '2026-02-01'\n"),
      item('B-2', 'Done - Local', "created_date: '2026-01-02'\nupdated_date: '2026-03-01'\n"),
    ];
    assert.deepEqual(sortColumn(done, 'Done - Local', tiebreak).map((i) => i.id), ['B-2', 'B-1']);
  });

  test('milestone lanes, as the Backlog.md board offers, skipping empty lanes', () => {
    const board = buildKanban(
      [item('A-1', 'Ready', 'milestone: m-1\n'), item('A-2', 'Backlog'), item('A-3', 'Backlog', 'milestone: m-9\n')],
      { statuses: STATUSES, laneMode: 'milestone', milestones: [{ id: 'm-0', title: 'Zero' }, { id: 'm-1', title: 'One' }] },
    );
    assert.deepEqual(board.lanes.map((l) => [l.key, l.title, l.count]), [
      ['none', 'No milestone', 1],
      ['m-1', 'One', 1],
      ['m-9', 'm-9', 1],
    ]);
  });
});
