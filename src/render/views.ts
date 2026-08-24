import type {
  Facets,
  ResolvedStoryMap,
  ValidationReport,
  WorkItem,
  Workspace,
} from '../core';
import { criteriaSummary } from '../core';
import { esc, markdown, q } from './html';
import {
  criteriaBadge,
  labelChips,
  missingCard,
  priorityPill,
  statePill,
  statusPill,
  storyCard,
  wstatusPill,
} from './components';

type Query = Record<string, string | undefined>;

function queryString(base: Query, overrides: Query): string {
  const merged: Query = { ...base, ...overrides };
  const parts: string[] = [];
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined || value === '') continue;
    parts.push(`${q(key)}=${q(value)}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

function select(name: string, current: string | undefined, options: { value: string; label: string }[], base: Query): string {
  const opts = options
    .map((o) => `<option value="${esc(o.value)}"${current === o.value ? ' selected' : ''}>${esc(o.label)}</option>`)
    .join('');
  return `<label class="f"><span>${esc(name)}</span><select name="${esc(name)}" data-base="${esc(queryString(base, { [name]: '' }))}">${opts}</select></label>`;
}

function facetOptions(name: string, facet: { value: string; count: number }[]): { value: string; label: string }[] {
  return [
    { value: '', label: `all ${name}` },
    ...facet.map((f) => ({ value: f.value, label: `${f.value} (${f.count})` })),
  ];
}

// ------------------------------------------------------------------ stories

export function storiesView(opts: {
  items: WorkItem[];
  total: number;
  facets: Facets;
  query: Query;
  maps: { id: string; title: string }[];
  milestones: { id: string; title: string }[];
  membership: Map<string, Set<string>>;
}): string {
  const { items, total, facets, query, maps, milestones } = opts;
  const base: Query = { ...query };
  delete base.id;

  const rows = items
    .map((item) => {
      const s = criteriaSummary(item);
      return `<tr class="row" data-href="/story/${q(item.id)}">
  <td class="c-id"><a href="/story/${q(item.id)}">${esc(item.id)}</a></td>
  <td class="c-title"><a href="/story/${q(item.id)}">${esc(item.title)}</a></td>
  <td class="c-state">${statePill(item)}</td>
  <td class="c-status">${statusPill(item)}</td>
  <td class="c-wstatus">${wstatusPill(item)}</td>
  <td class="c-prio">${priorityPill(item)}</td>
  <td class="c-area">${item.area ? `<a class="chip ns-area" href="/?area=${q(item.area)}">${esc(item.area)}</a>` : ''}</td>
  <td class="c-owner">${item.owner ? `<a class="chip ns-owner" href="/?owner=${q(item.owner)}">${esc(item.owner)}</a>` : ''}</td>
  <td class="c-type">${esc(item.wtype ?? '')}</td>
  <td class="c-deps">${item.dependencies.map((d) => `<a class="dep" href="/story/${q(d)}">${esc(d)}</a>`).join(' ')}</td>
  <td class="c-ac" title="${s.total ? `${s.checked} of ${s.total} acceptance criteria checked` : 'no checkbox criteria'}">${criteriaBadge(item)}</td>
</tr>`;
    })
    .join('\n');

  const filters = `
<form class="filters" method="get" action="/">
  <label class="f grow"><span>search</span><input type="search" name="text" value="${esc(query.text ?? '')}" placeholder="id, title, label or body…" /></label>
  ${select('state', query.state, [
    { value: '', label: 'active + completed' },
    { value: 'active', label: 'active only' },
    { value: 'completed', label: 'completed only' },
  ], base)}
  ${select('status', query.status, facetOptions('status', facets.status), base)}
  ${select('wstatus', query.wstatus, facetOptions('wstatus', facets.wstatus), base)}
  ${select('area', query.area, facetOptions('area', facets.area), base)}
  ${select('owner', query.owner, facetOptions('owner', facets.owner), base)}
  ${select('priority', query.priority, facetOptions('priority', facets.priority), base)}
  ${select('wtype', query.wtype, facetOptions('wtype', facets.wtype), base)}
  ${select('map', query.map, [
    { value: '', label: 'any map' },
    { value: 'none', label: 'not on any map' },
    ...maps.map((m) => ({ value: m.id, label: m.title })),
  ], base)}
  ${select('milestone', query.milestone, [
    { value: '', label: 'any milestone' },
    { value: 'none', label: 'no milestone' },
    ...milestones.map((m) => {
      const n = facets.milestone.find((f) => f.value === m.id)?.count ?? 0;
      return { value: m.id, label: `${m.title} (${n})` };
    }),
  ], base)}
  <button type="submit" class="btn">Apply</button>
  <a class="btn ghost" href="/">Reset</a>
</form>`;

  return `<section class="page">
  <div class="page-head">
    <h1>Stories</h1>
    <p class="count"><strong>${items.length}</strong> shown of ${total} work items</p>
  </div>
  ${filters}
  <div class="table-scroll">
  <table class="stories">
    <thead><tr>
      <th>ID</th><th>Title</th><th>State</th><th>Status</th><th>Delivery</th><th>Pri</th>
      <th>Area</th><th>Owner</th><th>Type</th><th>Depends on</th><th title="acceptance criteria checked">AC</th>
    </tr></thead>
    <tbody>${rows || '<tr><td colspan="11" class="empty">No stories match these filters.</td></tr>'}</tbody>
  </table>
  </div>
</section>`;
}

// ------------------------------------------------------------- story detail

export function storyDetailView(item: WorkItem, opts: {
  memberOf: { id: string; title: string; role: 'primary' | 'supporting' }[];
  dependents: WorkItem[];
  backHref: string;
  resolveDep: (id: string) => WorkItem | undefined;
  milestoneTitle?: string;
}): string {
  const s = criteriaSummary(item);
  const criteria = item.acceptanceCriteria.length ? item.acceptanceCriteria : item.bodyAcceptanceCriteria;

  const criteriaBlock = criteria.length
    ? `<section class="panel">
         <h2>Acceptance criteria <span class="muted">${s.checked}/${s.total} · ${s.source === 'body' ? 'from the description body' : 'native Backlog.md block'}</span></h2>
         <ul class="criteria">${criteria
           .map(
             (c) =>
               `<li class="task ${c.checked ? 'done' : 'open'}"><span class="box">${c.checked ? '✓' : ''}</span><span class="ac-num">#${c.index}</span><span>${esc(c.text)}</span></li>`,
           )
           .join('')}</ul>
       </section>`
    : '';

  const dodBlock = item.definitionOfDone.length
    ? `<section class="panel">
         <h2>Definition of Done</h2>
         <ul class="criteria">${item.definitionOfDone
           .map(
             (c) =>
               `<li class="task ${c.checked ? 'done' : 'open'}"><span class="box">${c.checked ? '✓' : ''}</span><span class="ac-num">#${c.index}</span><span>${esc(c.text)}</span></li>`,
           )
           .join('')}</ul>
       </section>`
    : '';

  const sectionBlocks = Object.entries(item.sections)
    .map(
      ([name, value]) =>
        `<section class="panel"><h2>${esc(name.replace(/_/g, ' ').toLowerCase())}</h2><div class="md-body">${markdown(value)}</div></section>`,
    )
    .join('');

  const deps = item.dependencies.length
    ? `<div class="meta-row"><span class="k">Depends on</span><span class="v">${item.dependencies
        .map((d) => {
          const target = opts.resolveDep(d);
          return target
            ? `<a class="dep" href="/story/${q(d)}" title="${esc(target.title)}">${esc(d)}</a>`
            : `<span class="dep missing" title="no work item claims this id">${esc(d)}</span>`;
        })
        .join(' ')}</span></div>`
    : '';

  const dependents = opts.dependents.length
    ? `<div class="meta-row"><span class="k">Blocks</span><span class="v">${opts.dependents
        .map((d) => `<a class="dep" href="/story/${q(d.id)}" title="${esc(d.title)}">${esc(d.id)}</a>`)
        .join(' ')}</span></div>`
    : '';

  const onMaps = opts.memberOf.length
    ? `<div class="meta-row"><span class="k">On maps</span><span class="v">${opts.memberOf
        .map(
          (m) =>
            `<a class="chip map" href="/maps/${q(m.id)}?highlight=${q(item.id)}">${esc(m.title)}<span class="role">${m.role}</span></a>`,
        )
        .join('')}</span></div>`
    : '<div class="meta-row"><span class="k">On maps</span><span class="v muted">not placed on any story map</span></div>';

  const docs = item.documentation.length
    ? `<div class="meta-row"><span class="k">Documentation</span><span class="v">${item.documentation
        .map((d) => `<code>${esc(d)}</code>`)
        .join(' ')}</span></div>`
    : '';

  return `<section class="page detail">
  <a class="back" href="${esc(opts.backHref)}">← back</a>
  <div class="detail-head">
    <div class="detail-id">${esc(item.id)}</div>
    <h1>${esc(item.title)}</h1>
    <div class="pills">${statePill(item)}${statusPill(item)}${wstatusPill(item)}${priorityPill(item)}</div>
  </div>

  <section class="panel meta">
    <div class="meta-row"><span class="k">Labels</span><span class="v chips">${labelChips(item)}</span></div>
    ${deps}${dependents}${onMaps}${docs}
    <div class="meta-row"><span class="k">Milestone</span><span class="v">${
      item.milestone
        ? `<a class="chip" href="/?milestone=${q(item.milestone)}">${esc(opts.milestoneTitle ?? item.milestone)}</a>`
        : '<span class="muted">none</span>'
    }</span></div>
    <div class="meta-row"><span class="k">Type</span><span class="v">${esc(item.type ?? '—')}</span></div>
    <div class="meta-row"><span class="k">Created</span><span class="v">${esc(item.createdDate ?? '—')}${item.updatedDate ? ` · updated ${esc(item.updatedDate)}` : ''}</span></div>
    <div class="meta-row"><span class="k">Source</span><span class="v"><code>${esc(item.sourcePath)}</code></span></div>
  </section>

  ${criteriaBlock}
  ${dodBlock}

  <section class="panel">
    <h2>Description</h2>
    <div class="md-body">${markdown(item.body)}</div>
  </section>

  ${sectionBlocks}
</section>`;
}

// --------------------------------------------------------------- map index

export function mapsIndexView(
  resolved: ResolvedStoryMap[],
  report: ValidationReport,
  storyMapsDirectory = 'story-maps',
): string {
  if (resolved.length === 0) {
    return `<section class="page"><div class="page-head"><h1>Story maps</h1></div>
      <p class="empty-state">No story maps here yet. Add a <code>.yaml</code> map under
      <code>${esc(storyMapsDirectory)}/</code> and it appears as soon as you save it.</p></section>`;
  }
  const cards = resolved
    .map((r) => {
      const steps = r.map.activities.reduce((n, a) => n + a.steps.length, 0);
      return `<a class="map-card ${r.map.kind}" href="/maps/${q(r.map.id)}">
      <div class="map-card-head">
        <h2>${esc(r.map.title)}</h2>
        <span class="pill kind k-${esc(r.map.kind)}">${esc(r.map.kind)}</span>
      </div>
      ${r.map.summary ? `<p class="map-summary">${esc(r.map.summary)}</p>` : ''}
      <div class="map-personas">${r.map.personas.map((p) => `<span class="chip persona">${esc(p)}</span>`).join('')}</div>
      <dl class="map-stats">
        <div><dt>activities</dt><dd>${r.map.activities.length}</dd></div>
        <div><dt>steps</dt><dd>${steps}</dd></div>
        <div><dt>stories</dt><dd>${r.counts.primary}</dd></div>
        <div><dt>completed</dt><dd>${r.counts.completed}</dd></div>
        <div><dt>active</dt><dd>${r.counts.active}</dd></div>
        <div><dt>supporting</dt><dd>${r.counts.supporting}</dd></div>
      </dl>
      ${r.counts.missing ? `<p class="map-bad">${r.counts.missing} unknown story reference(s)</p>` : ''}
    </a>`;
    })
    .join('');

  const problems = report.errorCount
    ? `<div class="banner bad"><strong>${report.errorCount} validation error(s).</strong> See <a href="/coverage">Coverage</a>, or run <code>npm run storymap:validate</code>.</div>`
    : '<div class="banner ok">All map references resolve.</div>';

  return `<section class="page">
    <div class="page-head"><h1>Story maps</h1></div>
    ${problems}
    <div class="map-grid">${cards}</div>
  </section>`;
}

// ---------------------------------------------------------------- map view

export function mapView(r: ResolvedStoryMap, query: Query): string {
  const focus = query.activity;
  const hideCompleted = query.completed === 'hide';
  const highlight = (query.highlight ?? '').trim().toUpperCase();

  const activities = focus ? r.activities.filter((a) => a.id === focus) : r.activities;
  const slices = r.map.releaseSlices;

  // One CSS grid per activity keeps step columns aligned within an activity and
  // lets each activity scroll independently — a single 40-column grid across
  // the whole map is what makes large story maps unreadable.
  const activityBlocks = activities
    .map((activity) => {
      const stepHeads = activity.steps
        .map((s) => `<div class="step-head"><span class="step-title">${esc(s.title)}</span><span class="step-id">${esc(s.id)}</span></div>`)
        .join('');

      const sliceRows = slices
        .map((slice) => {
          const cells = activity.steps
            .map((step) => {
              const cell = step.cells.find((c) => c.sliceId === slice.id);
              const cards = (cell?.placements ?? [])
                .map((p) => (p.missing ? missingCard(p.storyId) : storyCard(p.item!, { mapId: r.map.id })))
                .join('');
              return `<div class="cell${cards ? '' : ' empty'}">${cards}</div>`;
            })
            .join('');
          return `<div class="slice-label"><span>${esc(slice.title)}</span></div>${cells}`;
        })
        .join('');

      const supportingRow = activity.steps.some((s) => s.supporting.length)
        ? `<div class="slice-label supporting-label"><span>supporting</span></div>${activity.steps
            .map((step) => {
              const cards = step.supporting
                .map((p) => (p.missing ? missingCard(p.storyId) : storyCard(p.item!, { supporting: true, mapId: r.map.id })))
                .join('');
              return `<div class="cell supporting${cards ? '' : ' empty'}">${cards}</div>`;
            })
            .join('')}`
        : '';

      const cols = `grid-template-columns: var(--slice-w) repeat(${activity.steps.length}, minmax(var(--card-w), 1fr));`;
      return `<section class="activity" data-activity="${esc(activity.id)}">
        <header class="activity-head">
          <h2>${esc(activity.title)}</h2>
          <a class="focus-link" href="?${focus ? '' : `activity=${q(activity.id)}`}">${focus ? 'show all activities' : 'focus'}</a>
        </header>
        <div class="grid-scroll">
          <div class="map-grid-inner" style="${cols}">
            <div class="corner"></div>${stepHeads}
            ${sliceRows}
            ${supportingRow}
          </div>
        </div>
      </section>`;
    })
    .join('');

  const activityNav = r.activities
    .map((a) => `<a class="chip${focus === a.id ? ' on' : ''}" href="?${queryString(query, { activity: focus === a.id ? '' : a.id })}">${esc(a.title)}</a>`)
    .join('');

  const missingBanner = r.missingIds.length
    ? `<div class="banner bad"><strong>${r.missingIds.length} unknown story reference(s):</strong> ${r.missingIds.map((m) => esc(m)).join(', ')}</div>`
    : '';

  return `<section class="page wide-page">
  <div class="page-head">
    <div>
      <a class="back" href="/maps">← all maps</a>
      <h1>${esc(r.map.title)} <span class="pill kind k-${esc(r.map.kind)}">${esc(r.map.kind)}</span></h1>
      ${r.map.summary ? `<p class="map-summary">${esc(r.map.summary)}</p>` : ''}
      <p class="muted">${r.map.personas.map((p) => `<span class="chip persona">${esc(p)}</span>`).join('')}
      <span class="muted"> · ${r.counts.primary} stories · ${r.counts.completed} completed · ${r.counts.active} active · ${r.counts.supporting} supporting</span></p>
    </div>
  </div>
  ${missingBanner}
  <form class="filters map-filters" method="get">
    ${focus ? `<input type="hidden" name="activity" value="${esc(focus)}" />` : ''}
    <label class="f grow"><span>highlight story</span><input type="search" name="highlight" value="${esc(query.highlight ?? '')}" placeholder="${esc(r.referencedIds[0] ?? 'story id')}" /></label>
    <label class="f check"><input type="checkbox" name="completed" value="hide" ${hideCompleted ? 'checked' : ''} /><span>hide completed</span></label>
    <button type="submit" class="btn">Apply</button>
    <a class="btn ghost" href="/maps/${q(r.map.id)}">Reset</a>
    <span class="source">source: <code>${esc(r.map.sourcePath)}</code></span>
  </form>
  <div class="activity-nav">${activityNav}</div>
  <div class="map-body ${hideCompleted ? 'hide-completed' : ''}" data-highlight="${esc(highlight)}">
    ${activityBlocks}
  </div>
</section>`;
}

// --------------------------------------------------------------- coverage

export function coverageView(opts: {
  workspace: Workspace;
  report: ValidationReport;
  buckets: { key: string; label: string; items: WorkItem[]; note: string }[];
}): string {
  const { report, buckets, workspace } = opts;
  const total = workspace.index.size;
  const accounted = buckets.reduce((n, b) => n + b.items.length, 0);

  const bucketRows = buckets
    .map(
      (b) => `<tr>
      <td class="c-title"><strong>${esc(b.label)}</strong><br /><span class="muted">${esc(b.note)}</span></td>
      <td class="num">${b.items.length}</td>
      <td class="num">${b.items.filter((i) => !i.completed).length}</td>
      <td class="num">${b.items.filter((i) => i.completed).length}</td>
      <td><a class="btn ghost small" href="/coverage/${q(b.key)}">list</a></td>
    </tr>`,
    )
    .join('');

  const issues = report.issues.length
    ? `<section class="panel"><h2>Validation</h2><ul class="issues">${report.issues
        .map(
          (i) =>
            `<li class="issue ${esc(i.severity)}"><span class="sev">${esc(i.severity)}</span><code>${esc(i.code)}</code>${i.where ? ` <span class="muted">${esc(i.where)}</span>` : ''}<div>${esc(i.message)}</div></li>`,
        )
        .join('')}</ul></section>`
    : '<section class="panel"><h2>Validation</h2><p class="ok-line">No structural problems found.</p></section>';

  return `<section class="page">
    <div class="page-head"><h1>Coverage</h1>
      <p class="count">${accounted} of ${total} work items accounted for${accounted === total ? '' : ' — MISMATCH'}</p>
    </div>
    <section class="panel">
      <h2>Every story, in exactly one bucket</h2>
      <div class="table-scroll"><table class="stories">
        <thead><tr><th>Bucket</th><th class="num">Stories</th><th class="num">Active</th><th class="num">Completed</th><th></th></tr></thead>
        <tbody>${bucketRows}
        <tr class="total"><td><strong>Total</strong></td><td class="num"><strong>${accounted}</strong></td>
          <td class="num">${workspace.index.active.length}</td><td class="num">${workspace.index.completed.length}</td><td></td></tr>
        </tbody>
      </table></div>
    </section>
    ${issues}
  </section>`;
}

export function bucketListView(label: string, note: string, items: WorkItem[]): string {
  const rows = items
    .map(
      (item) => `<tr>
    <td class="c-id"><a href="/story/${q(item.id)}">${esc(item.id)}</a></td>
    <td class="c-title"><a href="/story/${q(item.id)}">${esc(item.title)}</a></td>
    <td>${statePill(item)}</td><td>${statusPill(item)}</td><td>${wstatusPill(item)}</td>
    <td>${esc(item.area ?? '')}</td>
  </tr>`,
    )
    .join('');
  return `<section class="page">
    <a class="back" href="/coverage">← coverage</a>
    <div class="page-head"><h1>${esc(label)}</h1><p class="count">${items.length} stories</p></div>
    <p class="muted">${esc(note)}</p>
    <div class="table-scroll"><table class="stories">
      <thead><tr><th>ID</th><th>Title</th><th>State</th><th>Status</th><th>Delivery</th><th>Area</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="6" class="empty">Nothing in this bucket.</td></tr>'}</tbody>
    </table></div>
  </section>`;
}

export function notFoundView(what: string): string {
  return `<section class="page"><div class="page-head"><h1>Not found</h1></div>
    <p class="empty-state">${esc(what)}</p>
    <p><a class="btn" href="/">Back to stories</a></p></section>`;
}
