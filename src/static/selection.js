/*
 * Pure helpers for the Stories page, shared by the browser and the tests:
 * the selection model and the canonical filter URL.
 *
 * No DOM access here — stories.js owns that.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StorySelection = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** Same order as FILTER_FIELDS in src/core/story-query.ts. */
  var FILTER_FIELDS = ['state', 'status', 'wstatus', 'area', 'owner', 'priority', 'wtype', 'map', 'milestone'];

  /**
   * A selection over the stories currently shown, in their display order.
   *
   * The scope is only ever what is shown: selectAll selects the shown stories,
   * and prune drops anything no longer shown, so a selection can never quietly
   * grow to stories the reader cannot see.
   *
   * Modelled on the Backlog.md board: a toggle moves the anchor, and a
   * shift-range adds every story between the anchor and the target.
   */
  function createSelection(shownIds, initial) {
    var order = shownIds.slice();
    var shown = {};
    order.forEach(function (id) { shown[id] = true; });
    var picked = {};
    var anchor = null;
    (initial || []).forEach(function (id) { if (shown[id]) picked[id] = true; });

    function ids() {
      return order.filter(function (id) { return picked[id]; });
    }

    return {
      ids: ids,
      count: function () { return ids().length; },
      shownCount: function () { return order.length; },
      has: function (id) { return picked[id] === true; },
      allShown: function () { return order.length > 0 && ids().length === order.length; },
      toggle: function (id, on) {
        if (!shown[id]) return;
        var next = on === undefined ? !picked[id] : on;
        if (next) picked[id] = true; else delete picked[id];
        anchor = id;
      },
      range: function (id) {
        if (!shown[id]) return;
        if (anchor === null || !shown[anchor]) { picked[id] = true; anchor = id; return; }
        var a = order.indexOf(anchor);
        var b = order.indexOf(id);
        var lo = Math.min(a, b);
        var hi = Math.max(a, b);
        for (var i = lo; i <= hi; i += 1) picked[order[i]] = true;
      },
      selectAll: function () { order.forEach(function (id) { picked[id] = true; }); },
      clear: function () { picked = {}; anchor = null; },
      prune: function (visibleIds) {
        var keep = {};
        visibleIds.forEach(function (id) { if (picked[id]) keep[id] = true; });
        picked = keep;
      },
    };
  }

  /**
   * Turns submitted form entries into the canonical query, matching
   * serializeStoryQuery on the server: filter fields in a fixed order, empty
   * values dropped, duplicates dropped, `<field>.op=not` only when the field has
   * values, and the view parameters last.
   */
  function canonicalParams(entries) {
    var values = {};
    var ops = {};
    var text = '';
    var view = '';
    var lanes = '';
    entries.forEach(function (pair) {
      var key = pair[0];
      var value = String(pair[1] == null ? '' : pair[1]).trim();
      if (key === 'text') { if (value) text = value; return; }
      if (key === 'view') { if (value === 'kanban') view = value; return; }
      if (key === 'lanes') { if (value === 'milestone') lanes = value; return; }
      var dot = key.lastIndexOf('.op');
      if (dot > 0 && dot === key.length - 3) {
        if (value === 'not') ops[key.slice(0, dot)] = 'not';
        return;
      }
      if (FILTER_FIELDS.indexOf(key) === -1 || !value) return;
      values[key] = values[key] || [];
      if (values[key].indexOf(value) === -1) values[key].push(value);
    });
    var out = [];
    if (text) out.push(['text', text]);
    FILTER_FIELDS.forEach(function (field) {
      var list = values[field];
      if (!list || !list.length) return;
      list.forEach(function (v) { out.push([field, v]); });
      if (ops[field] === 'not') out.push([field + '.op', 'not']);
    });
    if (view) out.push(['view', view]);
    if (view && lanes) out.push(['lanes', lanes]);
    return out;
  }

  function toSearch(params) {
    if (!params.length) return '';
    return '?' + params.map(function (p) {
      return encodeURIComponent(p[0]) + '=' + encodeURIComponent(p[1]);
    }).join('&');
  }

  /** The filter part only — the key a selection is remembered under, whatever the view. */
  function filterKey(params) {
    return toSearch(params.filter(function (p) { return p[0] !== 'view' && p[0] !== 'lanes'; }));
  }

  /**
   * Reads the bulk-edit form's field choices into a change set. A field left
   * on "No change" is absent — never an empty value — and "Clear" is `null`.
   */
  function changesFromChoices(choices) {
    var changes = {};
    var problems = [];
    Object.keys(choices).forEach(function (field) {
      var c = choices[field];
      if (!c || c.choice === '__keep') return;
      if (c.choice === '__clear') {
        if (field === 'status') problems.push('status cannot be cleared');
        else changes[field] = null;
        return;
      }
      if (c.choice === '__other') {
        var typed = String(c.other || '').trim();
        if (!typed) problems.push('type a new ' + field + ' value, or choose No change');
        else changes[field] = typed;
        return;
      }
      if (field === 'map') {
        var step = String(c.step || '').split('/');
        if (step.length !== 2 || !c.slice) problems.push('choose a step and a release slice on the map');
        else changes.map = { map: c.choice, activity: step[0], step: step[1], slice: c.slice };
        return;
      }
      changes[field] = c.choice;
    });
    return { changes: changes, problems: problems };
  }

  /** `owner → platform`, `milestone → cleared`, for the review and the success message. */
  function describeChanges(changes, labels) {
    labels = labels || {};
    return Object.keys(changes).map(function (field) {
      var v = changes[field];
      if (v === null) return field + ' → cleared';
      if (field === 'map') return 'map → ' + (labels[v.map] || v.map) + ' · ' + v.activity + '/' + v.step + ' · ' + v.slice;
      return field + ' → ' + (labels[field + ':' + v] || v);
    });
  }

  return {
    FILTER_FIELDS: FILTER_FIELDS,
    createSelection: createSelection,
    canonicalParams: canonicalParams,
    toSearch: toSearch,
    filterKey: filterKey,
    changesFromChoices: changesFromChoices,
    describeChanges: describeChanges,
  };
});
