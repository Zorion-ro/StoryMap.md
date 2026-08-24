/* Small progressive enhancements. The pages work without this file. */
(function () {
  'use strict';

  // ---- theme: an explicit choice, remembered, defaulting to the OS ---------
  var root = document.documentElement;
  var themeBtn = document.getElementById('theme-toggle');
  if (themeBtn) {
    themeBtn.addEventListener('click', function () {
      var explicit = root.getAttribute('data-theme');
      var systemDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
      var currentlyDark = explicit ? explicit === 'dark' : systemDark;
      var next = currentlyDark ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      try { localStorage.setItem('storymap.theme', next); } catch (e) { /* private mode */ }
    });
  }

  // ---- the side panel is always there, and can be put away -----------------
  var setSidebar = function (hidden) {
    if (hidden) root.setAttribute('data-sidebar', 'hidden');
    else root.removeAttribute('data-sidebar');
    try { localStorage.setItem('storymap.sidebar', hidden ? 'hidden' : 'shown'); } catch (e) { /* private mode */ }
  };
  var collapse = document.getElementById('side-collapse');
  var reveal = document.getElementById('side-reveal');
  if (collapse) collapse.addEventListener('click', function () { setSidebar(true); });
  if (reveal) reveal.addEventListener('click', function () { setSidebar(false); });

  // ---- filters submit on change, so a select is one click not two ----------
  var form = document.querySelector('form.filters');
  if (form) {
    form.querySelectorAll('select, input[type="checkbox"]').forEach(function (el) {
      el.addEventListener('change', function () { form.submit(); });
    });
  }

  // ---- highlight a story id across the whole map --------------------------
  var mapBody = document.querySelector('.map-body');
  if (mapBody) {
    var wanted = (mapBody.getAttribute('data-highlight') || '').trim().toUpperCase();
    if (wanted) {
      var first = null;
      mapBody.querySelectorAll('.card').forEach(function (card) {
        var id = (card.getAttribute('data-story-id') || '').toUpperCase();
        if (id.indexOf(wanted) !== -1) {
          card.classList.add('hl');
          if (!first) first = card;
        }
      });
      if (first) first.scrollIntoView({ block: 'center', inline: 'center' });
    }
  }

  // ---- whole table row is clickable ---------------------------------------
  document.querySelectorAll('tr.row[data-href]').forEach(function (row) {
    row.addEventListener('click', function (event) {
      if (event.target.closest('a')) return;
      window.location.href = row.getAttribute('data-href');
    });
  });

  // ---- story-map wall: highlight, scroll into view, keyboard ---------------
  var wall = document.querySelector('.sm-grid');
  if (wall) {
    var field = document.querySelector('.sm-toolbar input[name="highlight"]');
    var apply = function (raw) {
      var wanted = (raw || '').trim().toUpperCase();
      var cards = wall.querySelectorAll('.sm-card');
      if (!wanted) {
        wall.classList.remove('is-highlighting');
        cards.forEach(function (c) { c.classList.remove('is-hit'); });
        return null;
      }
      var first = null;
      cards.forEach(function (c) {
        var id = (c.getAttribute('data-story') || '').toUpperCase();
        var hit = id.indexOf(wanted) !== -1;
        c.classList.toggle('is-hit', hit);
        if (hit && !first) first = c;
      });
      wall.classList.add('is-highlighting');
      return first;
    };

    // The server already rendered the value; match it on load and scroll to it.
    var initial = apply(field && field.value);
    if (initial) initial.scrollIntoView({ block: 'center', inline: 'center' });

    // Typing narrows immediately, without a round trip. Submitting still works.
    if (field) {
      field.addEventListener('input', function () { apply(field.value); });
      field.addEventListener('keydown', function (event) {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        var hit = apply(field.value);
        if (hit) hit.scrollIntoView({ block: 'center', inline: 'center' });
      });
    }

    // Arrow keys pan the wall when it has focus, so a keyboard user is not
    // forced to tab through every card to see the far end of the journey.
    var scroller = wall.closest('.sm-scroll');
    if (scroller) {
      scroller.addEventListener('keydown', function (event) {
        var step = event.shiftKey ? 600 : 220;
        if (event.key === 'ArrowRight') { scroller.scrollLeft += step; event.preventDefault(); }
        else if (event.key === 'ArrowLeft') { scroller.scrollLeft -= step; event.preventDefault(); }
      });
    }

    // Pin the step header directly beneath the activity header, whatever the
    // activity row actually measures at this density.
    var firstActivity = wall.querySelector('.sm-activity');
    if (firstActivity) {
      var setOffset = function () {
        wall.style.setProperty('--sm-activity-h', firstActivity.offsetHeight + 'px');
      };
      setOffset();
      if (typeof ResizeObserver === 'function') new ResizeObserver(setOffset).observe(firstActivity);
      else window.addEventListener('resize', setOffset);
    }
  }

  // ---- notice when Claude or a peer lane edits a file on disk -------------
  var toast = document.getElementById('reload-toast');
  var button = document.getElementById('reload-now');
  if (button) button.addEventListener('click', function () { window.location.reload(); });
  if (toast) {
    var start = Number(document.documentElement.getAttribute('data-revision') || '0');
    setInterval(function () {
      fetch('/api/revision', { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (d) { if (Number(d.revision) !== start) toast.hidden = false; })
        .catch(function () { /* server stopped; leave the page as it is */ });
    }, 2000);
  }
})();
