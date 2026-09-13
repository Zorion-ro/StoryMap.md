/* The Stories page: filter controls, selection, bulk edit and the Kanban board.
 * Everything here is an enhancement — without it the filters still submit
 * and the list and board still render; only editing needs JavaScript. */
(function () {
  'use strict';
  var S = window.StorySelection;
  var page = document.querySelector('.stories-page');
  if (!page || !S) return;

  var view = page.getAttribute('data-view');
  var form = document.querySelector('form[data-story-filters]');
  var flash = document.getElementById('flash');

  function currentParams() {
    return S.canonicalParams(Array.from(new URLSearchParams(window.location.search).entries()));
  }

  // ------------------------------------------------------------ flash message
  function showFlash(kind, html) {
    if (!flash) return;
    flash.className = 'flash flash--' + kind;
    flash.innerHTML = html;
    flash.hidden = false;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  try {
    var pending = sessionStorage.getItem('storymap.flash');
    if (pending) {
      sessionStorage.removeItem('storymap.flash');
      var parsed = JSON.parse(pending);
      showFlash(parsed.kind, escapeHtml(parsed.text));
    }
  } catch (e) { /* storage unavailable: no message to carry */ }

  function reloadWith(kind, text) {
    try {
      sessionStorage.setItem('storymap.flash', JSON.stringify({ kind: kind, text: text }));
      sessionStorage.setItem('storymap.scroll', String(window.scrollY));
    } catch (e) { /* the reload still shows the new data */ }
    window.location.reload();
  }
  try {
    var y = sessionStorage.getItem('storymap.scroll');
    if (y) { sessionStorage.removeItem('storymap.scroll'); window.scrollTo(0, Number(y)); }
  } catch (e) { /* ignore */ }

  // ----------------------------------------------------------------- filters
  if (form) {
    var details = Array.from(form.querySelectorAll('details.mf'));

    var summarise = function (d) {
      var field = d.getAttribute('data-field');
      var checked = Array.from(d.querySelectorAll('input[type="checkbox"]:checked'));
      var not = d.querySelector('input[name="' + field + '.op"][value="not"]').checked;
      var vals = d.querySelector('.mf__vals');
      var op = d.querySelector('.mf__op');
      d.classList.toggle('mf--active', checked.length > 0);
      d.classList.toggle('mf--not', checked.length > 0 && not);
      d.classList.toggle('mf--in', checked.length > 0 && !not);
      if (!checked.length) {
        if (op) op.remove();
        vals.innerHTML = '<span class="mf__any">any</span>';
        return;
      }
      if (!op) {
        op = document.createElement('span');
        op.className = 'mf__op';
        vals.parentNode.insertBefore(op, vals);
      }
      op.textContent = not ? 'is not' : 'is';
      var labels = checked.map(function (c) { return c.parentNode.querySelector('.mf__label').textContent; });
      vals.innerHTML = labels.slice(0, 2).map(escapeHtml).join(', ') +
        (labels.length > 2 ? ' <span class="mf__more">+' + (labels.length - 2) + '</span>' : '');
    };

    details.forEach(function (d) {
      d.addEventListener('change', function () { d.classList.add('mf--dirty'); summarise(d); });
      var find = d.querySelector('.mf__find');
      if (find) {
        find.addEventListener('input', function () {
          var needle = find.value.trim().toLowerCase();
          d.querySelectorAll('.mf__item').forEach(function (item) {
            item.hidden = needle !== '' && item.textContent.toLowerCase().indexOf(needle) === -1;
          });
        });
        find.addEventListener('keydown', function (e) { if (e.key === 'Enter') e.preventDefault(); });
      }
      var clear = d.querySelector('[data-mf-clear]');
      if (clear) {
        clear.addEventListener('click', function () {
          d.querySelectorAll('input[type="checkbox"]').forEach(function (c) { c.checked = false; });
          d.querySelector('input[value="in"]').checked = true;
          d.classList.add('mf--dirty');
          summarise(d);
        });
      }
      // One open at a time, like a menu.
      d.addEventListener('toggle', function () {
        if (d.open) details.forEach(function (o) { if (o !== d) o.open = false; });
      });
    });
    document.addEventListener('click', function (e) {
      details.forEach(function (d) { if (d.open && !d.contains(e.target)) d.open = false; });
    });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      details.forEach(function (d) {
        if (d.open) { d.open = false; d.querySelector('summary').focus(); }
      });
    });

    // Submit one canonical URL, so a filter always bookmarks the same way.
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var params = S.canonicalParams(Array.from(new FormData(form).entries()));
      window.location.assign('/' + S.toSearch(params));
    });
    var lanes = form.querySelector('select[name="lanes"]');
    if (lanes) lanes.addEventListener('change', function () { form.requestSubmit ? form.requestSubmit() : form.submit(); });
  }

  // --------------------------------------------------------------- selection
  var boxes = Array.from(page.querySelectorAll('input.sel'));
  var shownIds = boxes.map(function (b) { return b.value; });
  var storageKey = 'storymap.selection' + S.filterKey(currentParams());
  var remembered = [];
  try { remembered = JSON.parse(sessionStorage.getItem(storageKey) || '[]'); } catch (e) { remembered = []; }
  var selection = S.createSelection(shownIds, remembered);

  var bar = page.querySelector('[data-selbar]');
  var pageBox = page.querySelector('[data-sel-page]');
  var countEl = bar && bar.querySelector('[data-sel-count]');
  var allBtn = bar && bar.querySelector('[data-sel-all]');
  var clearBtn = bar && bar.querySelector('[data-sel-clear]');
  var editBtn = bar && bar.querySelector('[data-bulk-open]');

  function render() {
    boxes.forEach(function (b) {
      var on = selection.has(b.value);
      b.checked = on;
      var holder = b.closest('tr, .kb-card');
      if (holder) holder.classList.toggle('is-selected', on);
    });
    var n = selection.count();
    if (bar) {
      bar.hidden = shownIds.length === 0;
      bar.classList.toggle('selbar--active', n > 0);
      countEl.textContent = String(n);
      clearBtn.disabled = n === 0;
      editBtn.disabled = n === 0;
      allBtn.disabled = selection.allShown();
    }
    if (pageBox) {
      pageBox.checked = selection.allShown();
      pageBox.indeterminate = n > 0 && !selection.allShown();
    }
    try {
      if (n) sessionStorage.setItem(storageKey, JSON.stringify(selection.ids()));
      else sessionStorage.removeItem(storageKey);
    } catch (e) { /* selection just will not survive a reload */ }
  }

  boxes.forEach(function (b) {
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      if (e.shiftKey) selection.range(b.value);
      else selection.toggle(b.value, b.checked);
      render();
    });
  });
  if (pageBox) {
    pageBox.addEventListener('change', function () {
      if (pageBox.checked) selection.selectAll(); else selection.clear();
      render();
    });
  }
  if (allBtn) allBtn.addEventListener('click', function () { selection.selectAll(); render(); });
  if (clearBtn) clearBtn.addEventListener('click', function () { selection.clear(); render(); });

  // Backlog.md's board gesture: Ctrl/Cmd-click toggles a card, Shift-click adds a range.
  page.querySelectorAll('.kb-card__link').forEach(function (link) {
    link.addEventListener('click', function (e) {
      if (!(e.ctrlKey || e.metaKey || e.shiftKey)) return;
      e.preventDefault();
      var id = link.closest('.kb-card').getAttribute('data-id');
      if (e.shiftKey) selection.range(id); else selection.toggle(id);
      render();
    });
  });
  document.addEventListener('keydown', function (e) {
    var dialogOpen = document.querySelector('dialog[open]');
    if (e.key === 'Escape' && !dialogOpen && selection.count() && !document.querySelector('details.mf[open]')) {
      selection.clear();
      render();
    }
  });
  render();

  // --------------------------------------------------------------- the API
  function post(body) {
    return fetch('/api/stories/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (res) {
      return res.json().catch(function () { return { ok: false, message: 'The server answered ' + res.status + '.' }; })
        .then(function (data) { data.status = res.status; return data; });
    }, function () {
      return { ok: false, status: 0, message: 'Could not reach the StoryMap.md server — is it still running?' };
    });
  }

  function problemsHtml(data) {
    var out = [];
    if (data.message) out.push('<p>' + escapeHtml(data.message) + '</p>');
    var lines = [];
    (data.fieldErrors || []).forEach(function (f) { lines.push(escapeHtml(f.message)); });
    (data.items || []).forEach(function (i) { if (i.error) lines.push('<code>' + escapeHtml(i.id) + '</code> ' + escapeHtml(i.error)); });
    if (lines.length) out.push('<ul>' + lines.slice(0, 20).map(function (l) { return '<li>' + l + '</li>'; }).join('') +
      (lines.length > 20 ? '<li>…and ' + (lines.length - 20) + ' more</li>' : '') + '</ul>');
    return out.join('');
  }

  function successText(data) {
    var parts = S.describeChanges(data.changes || {}, optionLabels);
    var unchanged = (data.items || []).length - data.changedCount;
    return 'Updated ' + data.changedCount + ' ' + (data.changedCount === 1 ? 'story' : 'stories') +
      (parts.length ? ': ' + parts.join(', ') : '') +
      (unchanged > 0 ? '. ' + unchanged + ' already had these values.' : '.');
  }

  // --------------------------------------------------------------- bulk edit
  var dialog = document.getElementById('bulk-dialog');
  var optionLabels = {};
  var review = null; // { ids, changes, token }

  if (dialog) {
    dialog.querySelectorAll('select[data-field]').forEach(function (sel) {
      Array.from(sel.options).forEach(function (o) {
        if (o.value.indexOf('__') !== 0) optionLabels[sel.getAttribute('data-field') === 'map' ? o.value : sel.getAttribute('data-field') + ':' + o.value] = o.textContent;
      });
    });
  }
  var q = function (sel) { return dialog.querySelector(sel); };

  function setStep(step) {
    q('[data-bulk-step="edit"]').hidden = step !== 'edit';
    q('[data-bulk-step="review"]').hidden = step !== 'review';
    q('[data-bulk-review]').hidden = step !== 'edit';
    q('[data-bulk-back]').hidden = step !== 'review';
    q('[data-bulk-apply]').hidden = step !== 'review';
  }
  function setError(html) {
    var el = q('[data-bulk-error]');
    el.innerHTML = html || '';
    el.hidden = !html;
  }
  function busy(on) {
    ['[data-bulk-review]', '[data-bulk-apply]', '[data-bulk-back]'].forEach(function (s) { q(s).disabled = on; });
    dialog.classList.toggle('is-busy', on);
  }

  function readChoices() {
    var choices = {};
    dialog.querySelectorAll('select[data-field]').forEach(function (sel) {
      var field = sel.getAttribute('data-field');
      var c = { choice: sel.value };
      var other = dialog.querySelector('[data-other-for="' + field + '"]');
      if (other) c.other = other.value;
      if (field === 'map' && sel.value.indexOf('__') !== 0) {
        var cell = dialog.querySelector('[data-cell-for="' + CSS.escape(sel.value) + '"]');
        c.step = cell.querySelector('[data-map-step]').value;
        c.slice = cell.querySelector('[data-map-slice]').value;
      }
      choices[field] = c;
    });
    return choices;
  }

  function resetForm() {
    dialog.querySelectorAll('select[data-field]').forEach(function (sel) { sel.value = '__keep'; sel.dispatchEvent(new Event('change')); });
    dialog.querySelectorAll('.bulk__other').forEach(function (i) { i.value = ''; });
  }

  function renderReview(data, ids, changes) {
    var lines = S.describeChanges(changes, optionLabels);
    var changed = data.items.filter(function (i) { return i.changed; });
    var warned = data.items.filter(function (i) { return i.warnings && i.warnings.length; });
    var html = '<p class="bulk__lead"><strong>' + data.changedCount + '</strong> of the ' + ids.length +
      ' selected ' + (ids.length === 1 ? 'story' : 'stories') + ' will change' +
      (data.changedCount < ids.length ? ' (' + (ids.length - data.changedCount) + ' already ' + (ids.length - data.changedCount === 1 ? 'has' : 'have') + ' these values)' : '') + '.</p>' +
      '<ul class="bulk__changes">' + lines.map(function (l) { return '<li>' + escapeHtml(l) + '</li>'; }).join('') + '</ul>' +
      '<p class="muted">Every other field stays as it is. ' + data.files.length + ' file' + (data.files.length === 1 ? '' : 's') + ' will be rewritten, each as a minimal change.</p>';
    if (warned.length) {
      html += '<div class="bulk__warn"><strong>Worth knowing</strong><ul>' + warned.slice(0, 12).map(function (i) {
        return '<li><code>' + escapeHtml(i.id) + '</code> ' + escapeHtml(i.warnings.join('; ')) + '</li>';
      }).join('') + (warned.length > 12 ? '<li>…and ' + (warned.length - 12) + ' more</li>' : '') + '</ul></div>';
    }
    if (changed.length) {
      html += '<details class="bulk__detail"><summary>Per-story changes</summary><table><tbody>' + changed.slice(0, 200).map(function (i) {
        return '<tr><td><code>' + escapeHtml(i.id) + '</code></td><td>' + i.changes.map(function (c) {
          return escapeHtml(c.field) + ': ' + escapeHtml(c.from || '—') + ' → ' + escapeHtml(c.to || '—');
        }).join('<br>') + '</td></tr>';
      }).join('') + '</tbody></table>' + (changed.length > 200 ? '<p class="muted">…and ' + (changed.length - 200) + ' more</p>' : '') + '</details>';
    }
    q('[data-bulk-review-body]').innerHTML = html;
    q('[data-bulk-apply]').textContent = data.changedCount
      ? 'Apply to ' + data.changedCount + ' ' + (data.changedCount === 1 ? 'story' : 'stories')
      : 'Nothing to change';
    q('[data-bulk-apply]').disabled = data.changedCount === 0;
  }

  /** Dry run, then show the review. Used by the dialog and by a multi-card drag. */
  function startReview(ids, changes) {
    setError('');
    busy(true);
    return post({ ids: ids, changes: changes, dryRun: true }).then(function (data) {
      busy(false);
      if (!data.ok) { setError(problemsHtml(data)); review = null; setStep('edit'); return; }
      review = { ids: ids, changes: changes, token: data.token };
      renderReview(data, ids, changes);
      setStep('review');
      q('[data-bulk-apply]').focus();
    });
  }

  function apply() {
    if (!review) return;
    setError('');
    busy(true);
    post({ ids: review.ids, changes: review.changes, token: review.token }).then(function (data) {
      busy(false);
      if (data.ok) {
        selection.clear();
        render();
        reloadWith('ok', successText(data));
        return;
      }
      if (data.status === 409) {
        review = null;
        setStep('edit');
      }
      setError(problemsHtml(data));
      if (data.error === 'write_failed' && !data.rolledBack) {
        showFlash('bad', problemsHtml(data) + ' <button type="button" class="btn small" onclick="location.reload()">Reload</button>');
      }
    });
  }

  if (dialog) {
    dialog.querySelectorAll('select[data-field]').forEach(function (sel) {
      sel.addEventListener('change', function () {
        var field = sel.getAttribute('data-field');
        var other = dialog.querySelector('[data-other-for="' + field + '"]');
        if (other) other.hidden = sel.value !== '__other';
        if (field === 'map') {
          dialog.querySelectorAll('[data-cell-for]').forEach(function (c) { c.hidden = c.getAttribute('data-cell-for') !== sel.value; });
        }
        sel.closest('tr').classList.toggle('is-set', sel.value !== '__keep');
      });
    });
    q('[data-bulk-cancel]').addEventListener('click', function () { dialog.close(); });
    q('[data-bulk-back]').addEventListener('click', function () { setError(''); setStep('edit'); });
    q('[data-bulk-review]').addEventListener('click', function () {
      var read = S.changesFromChoices(readChoices());
      if (read.problems.length) { setError('<ul><li>' + read.problems.map(escapeHtml).join('</li><li>') + '</li></ul>'); return; }
      if (!Object.keys(read.changes).length) { setError('<p>Choose at least one field to change.</p>'); return; }
      startReview(selection.ids(), read.changes);
    });
    q('[data-bulk-apply]').addEventListener('click', apply);
    dialog.addEventListener('close', function () { review = null; setError(''); setStep('edit'); });
  }

  function openDialog(ids) {
    dialog.querySelector('[data-bulk-count]').textContent = String(ids.length);
    setError('');
    setStep('edit');
    dialog.showModal();
  }

  if (editBtn && dialog) {
    editBtn.addEventListener('click', function () {
      if (!selection.count()) return;
      resetForm();
      openDialog(selection.ids());
    });
  }

  // ------------------------------------------------------------------ kanban
  if (view === 'kanban') {
    var dragged = null;
    var cards = Array.from(page.querySelectorAll('.kb-card'));
    var clearOver = function () { page.querySelectorAll('.kb-col.is-over').forEach(function (c) { c.classList.remove('is-over'); }); };

    cards.forEach(function (card) {
      card.addEventListener('dragstart', function (e) {
        var id = card.getAttribute('data-id');
        var group = selection.has(id) && selection.count() > 1 ? selection.ids() : [id];
        dragged = { ids: group, from: card.closest('.kb-col') };
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', id);
        group.forEach(function (gid) {
          var el = page.querySelector('.kb-card[data-id="' + CSS.escape(gid) + '"]');
          if (el) el.classList.add('is-dragging');
        });
      });
      card.addEventListener('dragend', function () {
        page.querySelectorAll('.kb-card.is-dragging').forEach(function (c) { c.classList.remove('is-dragging'); });
        clearOver();
        dragged = null;
      });
    });

    page.querySelectorAll('.kb-col').forEach(function (col) {
      var droppable = col.getAttribute('data-droppable') === '1';
      col.addEventListener('dragover', function (e) {
        if (!dragged || !droppable) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (!col.classList.contains('is-over')) { clearOver(); col.classList.add('is-over'); }
      });
      col.addEventListener('dragleave', function (e) {
        if (!col.contains(e.relatedTarget)) col.classList.remove('is-over');
      });
      col.addEventListener('drop', function (e) {
        e.preventDefault();
        clearOver();
        if (!dragged || !droppable || dragged.from === col) return;
        var changes = { status: col.getAttribute('data-status') };
        if (col.hasAttribute('data-milestone')) {
          changes.milestone = col.getAttribute('data-milestone') || null;
        }
        var ids = dragged.ids;
        dragged = null;
        if (ids.length > 1) {
          // A wide move gets the same review a bulk edit does.
          openDialog(ids);
          startReview(ids, changes);
          return;
        }
        col.classList.add('is-saving');
        post({ ids: ids, changes: changes }).then(function (data) {
          col.classList.remove('is-saving');
          if (data.ok) {
            reloadWith('ok', data.changedCount ? 'Moved ' + ids[0] + ' to ' + changes.status + '.' : ids[0] + ' was already there.');
          } else {
            showFlash('bad', '<strong>' + escapeHtml(ids[0]) + ' was not moved.</strong> ' + problemsHtml(data));
          }
        });
      });
    });
  }
})();
