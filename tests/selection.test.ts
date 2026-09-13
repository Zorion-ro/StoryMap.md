import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, test } from 'node:test';
import { parseStoryQuery, serializeStoryQuery } from '../src/core';

// The browser's own helper file, loaded as the page loads it (UMD, no build step).
const S = createRequire(__filename)('../src/static/selection.js');

describe('selection model', () => {
  const shown = ['FW-1', 'FW-2', 'FW-3', 'FW-4', 'FW-5'];

  test('select one, several, and clear', () => {
    const sel = S.createSelection(shown);
    sel.toggle('FW-2');
    assert.deepEqual(sel.ids(), ['FW-2']);
    sel.toggle('FW-4');
    sel.toggle('FW-1');
    assert.deepEqual(sel.ids(), ['FW-1', 'FW-2', 'FW-4'], 'always in display order');
    sel.toggle('FW-2');
    assert.deepEqual(sel.ids(), ['FW-1', 'FW-4']);
    sel.clear();
    assert.equal(sel.count(), 0);
  });

  test('shift-range adds everything between the anchor and the target', () => {
    const sel = S.createSelection(shown);
    sel.toggle('FW-4');
    sel.range('FW-2');
    assert.deepEqual(sel.ids(), ['FW-2', 'FW-3', 'FW-4']);
  });

  test('select all is exactly the shown stories, never more', () => {
    const sel = S.createSelection(shown);
    sel.selectAll();
    assert.equal(sel.count(), 5);
    assert.ok(sel.allShown());
    sel.toggle('FW-99');
    assert.equal(sel.count(), 5, 'an id not shown cannot be selected');
  });

  test('a remembered selection is pruned to what is shown now', () => {
    const sel = S.createSelection(['FW-2', 'FW-3'], ['FW-1', 'FW-3', 'FW-9']);
    assert.deepEqual(sel.ids(), ['FW-3']);
    sel.selectAll();
    sel.prune(['FW-2']);
    assert.deepEqual(sel.ids(), ['FW-2']);
  });
});

describe('canonical filter URL in the browser', () => {
  test('matches the server serialiser for the same form entries', () => {
    const entries: [string, string][] = [
      ['view', 'kanban'],
      ['text', ' auth '],
      ['milestone', 'm-1'],
      ['milestone.op', 'in'],
      ['status', 'Done'],
      ['status', 'Cancelled'],
      ['status', 'Done'],
      ['status.op', 'not'],
      ['owner', ''],
      ['owner.op', 'not'],
      ['lanes', 'milestone'],
      ['junk', 'x'],
    ];
    const params = S.canonicalParams(entries);
    const search = S.toSearch(params);
    assert.equal(search, '?text=auth&status=Done&status=Cancelled&status.op=not&milestone=m-1&view=kanban&lanes=milestone');
    const server = serializeStoryQuery(parseStoryQuery(new URLSearchParams(search)), [['view', 'kanban'], ['lanes', 'milestone']]);
    assert.equal(search, server);
  });

  test('empty selections produce an unrestricted URL; the selection key ignores the view', () => {
    assert.equal(S.toSearch(S.canonicalParams([['status.op', 'not'], ['status', '']])), '');
    assert.equal(S.filterKey([['status', 'Done'], ['view', 'kanban']]), '?status=Done');
  });
});

describe('bulk-edit form reading', () => {
  test('"No change" is absent, "Clear" is null, a typed value is trimmed', () => {
    const { changes, problems } = S.changesFromChoices({
      status: { choice: 'Ready' },
      owner: { choice: '__clear' },
      area: { choice: '__keep' },
      wtype: { choice: '__other', other: '  spike ' },
      milestone: { choice: '__keep' },
      map: { choice: 'seller', step: 'start/sign-in', slice: 'first' },
    });
    assert.deepEqual(problems, []);
    assert.deepEqual(changes, {
      status: 'Ready',
      owner: null,
      wtype: 'spike',
      map: { map: 'seller', activity: 'start', step: 'sign-in', slice: 'first' },
    });
    assert.ok(!('area' in changes) && !('milestone' in changes));
  });

  test('an empty "another value" and a cleared status are problems, not silent clears', () => {
    const { changes, problems } = S.changesFromChoices({ area: { choice: '__other', other: ' ' }, status: { choice: '__clear' } });
    assert.deepEqual(changes, {});
    assert.equal(problems.length, 2);
  });

  test('describes changes for the review and the confirmation', () => {
    assert.deepEqual(S.describeChanges({ owner: 'platform', milestone: null }, { 'owner:platform': 'platform' }), ['owner → platform', 'milestone → cleared']);
  });
});
