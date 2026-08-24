import type { ResolvedStoryMap, VisualCard, VisualStoryMapModel } from '../core';
import { cardsAt } from '../core';
import { esc, q } from './html';

/**
 * The lane-based story-map wall: activities across the top, their steps beneath,
 * release/delivery lanes down the side, story cards in the cells.
 *
 * Everything here reads the pre-built view model; no placement decision is made
 * in this file.
 */

type Query = Record<string, string | undefined>;

function href(base: string, query: Query, overrides: Query): string {
  const merged = { ...query, ...overrides };
  const parts: string[] = [];
  for (const [k, v] of Object.entries(merged)) {
    if (v === undefined || v === '') continue;
    parts.push(`${q(k)}=${q(v)}`);
  }
  return parts.length ? `${base}?${parts.join('&')}` : base;
}

/**
 * A small presentational marker per activity, matched on the activity's own id
 * and title. Purely decorative: it adds no meaning the text does not carry, and
 * an unmatched activity gets a neutral dot rather than a wrong picture.
 */
function activityMarker(id: string, title: string): string {
  const s = `${id} ${title}`.toLowerCase();
  const table: [RegExp, string][] = [
    [/photo|capture|image/, '📷'],
    [/document|describe|talon|extract/, '📄'],
    [/inspect/, '🔍'],
    [/find|detect|scan/, '🔎'],
    [/auction|bid/, '🔨'],
    [/offer|deal|price|value/, '🏷️'],
    [/handover|logistic|transport/, '🚚'],
    [/policy|govern/, '⚖️'],
    [/organis|organiz|team|administ/, '🏢'],
    [/publish|track|inform|notif/, '📣'],
    [/buy|browse/, '🛒'],
    [/secret|vault|harden|secur|edge|personal data/, '🛡️'],
    [/build|ship|deploy|release|prove|recover/, '📦'],
    [/test|verif|specif|assur|report|\brun\b/, '🧪'],
    [/start|begin|access|sign/, '🚩'],
    [/data|event|identity|observ|develop/, '⚙️'],
  ];
  for (const [re, icon] of table) if (re.test(s)) return icon;
  return '•';
}

/** A shape per lane tone, so the lane is distinguishable without relying on colour. */
function laneMarker(tone: string): string {
  if (tone === 'delivered') return '✓';
  if (tone === 'built') return '◑';
  if (tone === 'progress') return '◐';
  if (tone === 'next') return '○';
  if (tone === 'later') return '·';
  if (tone === 'blocked') return '!';
  if (tone === 'closed') return '×';
  return '—';
}

function card(c: VisualCard, mapId: string): string {
  if (c.missing) {
    return `<div class="sm-card sm-card--missing" data-story="${esc(c.storyId)}">
      <span class="sm-card__head"><span class="sm-card__id">${esc(c.storyId)}</span></span>
      <span class="sm-card__title">${esc(c.title)}</span>
      <span class="sm-card__meta"><span class="sm-pill sm-pill--missing">unresolved</span></span>
    </div>`;
  }
  // The coarse status and the delivery label are different dimensions, but when
  // the delivery label merely restates the status ("Done"/"done") showing both
  // is noise on a card this small. Show it only when it adds something.
  const restates = (c.wstatus ?? '').replace(/_/g, ' ') === c.status.toLowerCase();
  const meta = [
    `<span class="sm-pill sm-pill--${esc(c.tone)}">${esc(c.status)}</span>`,
    c.wstatus && !restates
      ? `<span class="sm-pill sm-pill--soft">${esc(c.wstatus.replace(/_/g, ' '))}</span>`
      : '',
    c.priorityLabel && /^p[01]$/.test(c.priorityLabel)
      ? `<span class="sm-pill sm-pill--prio p-${esc(c.priorityLabel)}">${esc(c.priorityLabel.toUpperCase())}</span>`
      : '',
  ]
    .filter(Boolean)
    .join('');

  return `<a class="sm-card sm-card--${esc(c.tone)}${c.supporting ? ' sm-card--supporting' : ''}"
   href="/story/${q(c.storyId)}?from=${q(mapId)}"
   data-story="${esc(c.storyId)}"
   data-completed="${c.completed ? '1' : '0'}">
  <span class="sm-card__head">
    <span class="sm-card__id">${esc(c.storyId)}</span>
    ${c.workType ? `<span class="sm-card__type">${esc(c.workType)}</span>` : ''}
  </span>
  <span class="sm-card__title" title="${esc(c.title)}">${esc(c.title)}</span>
  <span class="sm-card__meta">${meta}</span>
</a>`;
}

function legend(model: VisualStoryMapModel): string {
  // Card tones and lane tones both come from the core's tone model, so the
  // swatch a reader sees here is the same class the card and pill are drawn
  // with — there is one mapping, not three.
  const statuses: [string, string][] = [
    ['done', 'Done'],
    ['progress', 'In Progress'],
    ['todo', 'To Do'],
    ['backlog', 'Backlog'],
    ['blocked', 'Blocked'],
  ];
  const laneSource = model.lanesDerived
    ? model.laneMode === 'workflow'
      ? 'Workflow lanes (derived)'
      : 'Delivery lanes (derived)'
    : 'Release slices (from the map file)';

  return `<details class="sm-legend" id="sm-legend" open>
    <summary><span class="sm-legend__toggle">Legend</span></summary>
    <div class="sm-legend__strip">
      <div class="sm-legend__group">
        <span class="sm-legend__label">Card status</span>
        ${statuses
          .map(
            ([tone, label]) =>
              `<span class="sm-legend__item"><i class="sm-swatch sm-swatch--${tone}"></i>${esc(label)}</span>`,
          )
          .join('')}
      </div>
      <div class="sm-legend__group">
        <span class="sm-legend__label">${esc(laneSource)}</span>
        ${model.lanes
          .map(
            (l) =>
              `<span class="sm-legend__item"><i class="sm-swatch sm-swatch--lane-${esc(l.tone)}">${laneMarker(l.tone)}</i>${esc(l.title)}</span>`,
          )
          .join('')}
      </div>
      <div class="sm-legend__group">
        <span class="sm-legend__label">Cards</span>
        <span class="sm-legend__item"><i class="sm-swatch sm-swatch--supporting"></i>Supporting / cross-cutting</span>
        <span class="sm-legend__item"><i class="sm-swatch sm-swatch--missing"></i>Unresolved reference</span>
        <span class="sm-legend__item"><span class="sm-card__type">Fix</span>work type, from <code>wtype:</code></span>
      </div>
    </div>
  </details>`;
}

export function visualMapView(
  resolved: ResolvedStoryMap,
  model: VisualStoryMapModel,
  query: Query,
  options: {
    facetStatuses: string[];
    facetWstatus: string[];
    milestones: { id: string; title: string; count: number }[];
  },
): string {
  const base = `/maps/${resolved.map.id}`;
  const mapId = resolved.map.id;
  const density = query.density ?? 'normal';
  const focus = query.activity;

  // -------------------------------------------------------------- header row
  const activityHeads = model.activities
    .map(
      (a) => `<div class="sm-activity" style="grid-column: span ${Math.max(1, a.steps.length)};">
        <span class="sm-activity__inner">
          <span class="sm-activity__icon" aria-hidden="true">${activityMarker(a.id, a.title)}</span>
          <span class="sm-activity__title">${esc(a.title)}</span>
          <span class="sm-activity__count" title="${a.cardCount} stories in this activity">${a.cardCount}</span>
          <a class="sm-activity__focus" href="${esc(href(base, query, { activity: focus === a.id ? '' : a.id }))}"
             title="${focus === a.id ? 'Show every activity' : 'Show only this activity'}">${focus === a.id ? 'show all' : 'focus'}</a>
        </span>
      </div>`,
    )
    .join('');

  const stepHeads = model.steps
    .map(
      (s) => `<div class="sm-step" data-step="${esc(s.id)}">
        <span class="sm-step__ordinal">${s.ordinal}.</span>
        <span class="sm-step__title">${esc(s.title)}</span>
      </div>`,
    )
    .join('');

  // ------------------------------------------------------------------- lanes
  const laneRows = model.lanes
    .map((lane) => {
      const cells = model.steps
        .map((step) => {
          const cards = cardsAt(model, lane.id, step.id);
          return `<div class="sm-cell${cards.length ? '' : ' sm-cell--empty'}" data-lane="${esc(lane.id)}" data-step="${esc(step.id)}">${cards
            .map((c) => card(c, mapId))
            .join('')}</div>`;
        })
        .join('');
      return `<div class="sm-lane-label sm-lane-label--${esc(lane.tone)}">
          <span class="sm-lane-label__mark" aria-hidden="true">${laneMarker(lane.tone)}</span>
          <span class="sm-lane-label__name">${esc(lane.title)}</span>
          <span class="sm-lane-label__count">${lane.count} ${lane.count === 1 ? 'story' : 'stories'}</span>
        </div>${cells}`;
    })
    .join('');

  const columns = `grid-template-columns: var(--sm-lane-w) repeat(${Math.max(1, model.steps.length)}, minmax(var(--sm-col-w), 1fr));`;

  // ----------------------------------------------------------------- toolbar
  const select = (name: string, label: string, current: string | undefined, options_: { value: string; label: string }[]) =>
    `<label class="sm-f"><span>${esc(label)}</span><select name="${esc(name)}">${options_
      .map((o) => `<option value="${esc(o.value)}"${current === o.value ? ' selected' : ''}>${esc(o.label)}</option>`)
      .join('')}</select></label>`;

  const hidden = (name: string, value?: string) =>
    value ? `<input type="hidden" name="${esc(name)}" value="${esc(value)}" />` : '';

  const toolbar = `<form class="sm-toolbar" method="get" action="${esc(base)}">
    ${hidden('activity', focus)}
    ${hidden('view', 'visual')}
    <label class="sm-f sm-f--grow"><span>Highlight story</span>
      <input type="search" name="highlight" value="${esc(query.highlight ?? '')}" placeholder="${esc(resolved.referencedIds[0] ?? 'story id')}" aria-label="Highlight a story by id" />
    </label>
    ${select('status', 'Status', query.status, [
      { value: '', label: 'All' },
      ...options.facetStatuses.map((s) => ({ value: s, label: s })),
    ])}
    ${select('wstatus', 'Delivery state', query.wstatus, [
      { value: '', label: 'All' },
      ...options.facetWstatus.map((s) => ({ value: s, label: s.replace(/_/g, ' ') })),
    ])}
    ${select('milestone', 'Milestone', query.milestone, [
      { value: '', label: 'All' },
      { value: 'none', label: 'No milestone' },
      ...options.milestones.map((m) => ({ value: m.id, label: `${m.title} (${m.count})` })),
    ])}
    ${select('lanes', 'Lanes', model.laneMode, [
      { value: 'slices', label: 'Release slices (file)' },
      { value: 'workflow', label: 'Workflow state (derived)' },
      { value: 'delivery', label: 'Delivery state (derived)' },
    ])}
    ${select('density', 'Density', density, [
      { value: 'compact', label: 'Compact' },
      { value: 'normal', label: 'Normal' },
      { value: 'comfortable', label: 'Comfortable' },
    ])}
    <label class="sm-f sm-f--check">
      <input type="checkbox" name="completed" value="hide" ${query.completed === 'hide' ? 'checked' : ''} />
      <span>Hide completed</span>
    </label>
    <button type="submit" class="btn">Apply</button>
    <a class="btn ghost" href="${esc(base)}">Reset</a>
  </form>`;

  // -------------------------------------------------------------- supporting
  const supportingPanel = model.supporting.length
    ? `<aside class="sm-supporting" aria-labelledby="sm-supporting-h">
        <h2 id="sm-supporting-h">Supporting capabilities <span class="sm-count">${model.supporting.length}</span></h2>
        <p class="sm-supporting__note">Referenced by a step without belonging to it — these serve the journey rather than sitting inside it.</p>
        <div class="sm-supporting__list">${model.supporting.map((c) => card(c, mapId)).join('')}</div>
      </aside>`
    : '';

  const derivedNote = model.lanesDerived
    ? `<p class="sm-note">Lanes are <strong>derived from each story's ${
        model.laneMode === 'workflow' ? 'workflow state' : 'delivery state'
      }</strong>, not read from the map file. The file declares ${resolved.map.releaseSlices
        .map((s) => `<code>${esc(s.id)}</code>`)
        .join(', ')} — switch <em>Lanes</em> to “Release slices” to see the map as it is written.</p>`
    : '';

  const missingBanner = resolved.missingIds.length
    ? `<div class="banner bad"><strong>${resolved.missingIds.length} unresolved story reference(s):</strong> ${resolved.missingIds
        .map((m) => esc(m))
        .join(', ')}</div>`
    : '';

  const filtered = model.totals.hiddenByFilter
    ? `<span class="sm-count sm-count--muted">${model.totals.hiddenByFilter} hidden by filters</span>`
    : '';

  return `<section class="page wide-page sm" data-density="${esc(density)}">
  <div class="sm-head">
    <div class="sm-head__main">
      <a class="back" href="/maps">← all maps</a>
      <h1>${esc(resolved.map.title)} <span class="pill kind k-${esc(resolved.map.kind)}">${esc(resolved.map.kind)}</span></h1>
      ${resolved.map.summary ? `<p class="sm-head__summary">${esc(resolved.map.summary)}</p>` : ''}
      <p class="sm-head__stats">
        ${resolved.map.personas.map((p) => `<span class="chip persona">${esc(p)}</span>`).join('')}
        <span class="sm-count">${model.totals.shown} shown</span>
        <span class="sm-count">${model.totals.completed} completed</span>
        <span class="sm-count">${model.totals.active} active</span>
        <span class="sm-count">${model.totals.supporting} supporting</span>
        ${filtered}
      </p>
    </div>
    <div class="sm-head__side">
      <div class="sm-viewswitch" role="group" aria-label="Map view mode">
        <a class="on" href="${esc(href(base, query, { view: '' }))}" aria-current="page">Visual map</a>
        <a href="${esc(href(base, query, { view: 'detailed' }))}">Detailed</a>
      </div>
      <p class="sm-source">source: <code>${esc(resolved.map.sourcePath)}</code></p>
    </div>
  </div>

  ${missingBanner}
  ${toolbar}
  ${derivedNote}
  ${legend(model)}

  <div class="sm-wall">
    <div class="sm-scroll" tabindex="0" role="region" aria-label="Story map, scrolls horizontally">
      <div class="sm-grid" style="${columns}">
        <div class="sm-corner sm-corner--activities"><span>Activities</span></div>
        ${activityHeads}
        <div class="sm-corner sm-corner--steps"><span>Steps</span></div>
        ${stepHeads}
        ${laneRows}
      </div>
    </div>
    ${supportingPanel}
  </div>

  ${
    model.totals.shown === 0
      ? '<p class="empty-state">No stories match these filters. <a href="' + esc(base) + '">Reset</a>.</p>'
      : ''
  }
</section>`;
}
