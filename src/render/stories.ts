import type { Facets, FilterField, KanbanBoard, StoryMap, StoryQuery, WorkItem } from '../core';
import { criteriaSummary, serializeStoryQuery } from '../core';
import { criteriaBadge, kanbanCard, priorityPill, statePill, statusPill, wstatusPill } from './components';
import { esc, q } from './html';
import { filterBar } from './story-filters';

/**
 * The Stories page: one filtered result set, shown as a list or as a Kanban
 * board, with selection and bulk edit on top of either.
 *
 * The view is part of the URL (`?view=kanban`), next to the filters, so
 * switching views, reloading and going back all keep the same stories.
 */

export type StoriesView = 'list' | 'kanban';

export interface StoriesPageOptions {
  items: WorkItem[];
  total: number;
  facets: Facets;
  query: StoryQuery;
  view: StoriesView;
  laneMode: 'none' | 'milestone';
  board?: KanbanBoard;
  maps: StoryMap[];
  mapCounts: Map<string, number>;
  noMapCount: number;
  milestones: { id: string; title: string; archived: boolean }[];
  statuses: string[];
  stateCounts: { active: number; completed: number };
  noneCounts: Partial<Record<FilterField, number>>;
}

function viewParams(view: StoriesView, laneMode: 'none' | 'milestone'): [string, string][] {
  if (view !== 'kanban') return [];
  return laneMode === 'milestone' ? [['view', 'kanban'], ['lanes', 'milestone']] : [['view', 'kanban']];
}

// -------------------------------------------------------------------- list

function listView(items: WorkItem[]): string {
  const rows = items
    .map((item) => {
      const s = criteriaSummary(item);
      return `<tr class="row" data-href="/story/${q(item.id)}" data-id="${esc(item.id)}">
  <td class="c-sel"><input type="checkbox" class="sel" value="${esc(item.id)}" aria-label="Select ${esc(item.id)}" /></td>
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

  return `<div class="table-scroll">
  <table class="stories">
    <thead><tr>
      <th class="c-sel"><input type="checkbox" data-sel-page aria-label="Select all ${items.length} shown stories" /></th>
      <th>ID</th><th>Title</th><th>State</th><th>Status</th><th>Delivery</th><th>Pri</th>
      <th>Area</th><th>Owner</th><th>Type</th><th>Depends on</th><th title="acceptance criteria checked">AC</th>
    </tr></thead>
    <tbody>${rows || '<tr><td colspan="12" class="empty">No stories match these filters.</td></tr>'}</tbody>
  </table>
  </div>`;
}

// ------------------------------------------------------------------ kanban

function kanbanView(board: KanbanBoard, milestoneTitle: (id?: string) => string | undefined): string {
  const laned = board.laneMode === 'milestone';
  const lanes = board.lanes
    .map((lane) => {
      const columns = lane.columns
        .map((col) => {
          const cards = col.items.map((i) => kanbanCard(i, { milestoneTitle: milestoneTitle(i.milestone), showMilestone: !laned })).join('');
          const label = `${col.status}, ${col.items.length} ${col.items.length === 1 ? 'story' : 'stories'}${laned ? `, ${lane.title}` : ''}`;
          return `<section class="kb-col${col.declared ? '' : ' kb-col--undeclared'}" data-status="${esc(col.status)}"${
            laned ? ` data-milestone="${esc(lane.milestone ?? '')}"` : ''
          } data-droppable="${col.declared ? '1' : '0'}" aria-label="${esc(label)}">
  <header class="kb-col__head">
    <h3 class="kb-col__title">${esc(col.status)}</h3>
    <span class="kb-col__count">${col.items.length}</span>
    ${col.declared ? '' : '<span class="kb-col__note" title="This status is not declared in backlog.config.yml; cards cannot be moved into it.">undeclared</span>'}
  </header>
  <div class="kb-col__body">${cards || '<p class="kb-col__empty">No stories</p>'}</div>
</section>`;
        })
        .join('');
      return `<div class="kb-lane"${laned ? ` data-milestone="${esc(lane.milestone ?? '')}"` : ''}>
  ${laned ? `<h2 class="kb-lane__head">${esc(lane.title)} <span class="kb-col__count">${lane.count}</span></h2>` : ''}
  <div class="kb-cols" style="--kb-cols: ${Math.max(1, lane.columns.length)}">${columns}</div>
</div>`;
    })
    .join('');

  return `<div class="kb" data-lanes="${esc(board.laneMode)}">
  <p class="kb__hint">Drag a card to another column to change its status${laned ? ' (and milestone, across lanes)' : ''}. Select several cards, then drag one of them, to move them together.</p>
  <div class="kb__scroll" tabindex="0" role="region" aria-label="Kanban board, scrolls horizontally">${lanes || '<p class="empty-state">No stories match these filters.</p>'}</div>
</div>`;
}

// --------------------------------------------------------------- bulk edit

const LABEL_FIELD_NAMES = ['wstatus', 'area', 'owner', 'priority', 'wtype'] as const;

function bulkDialog(o: StoriesPageOptions): string {
  const opt = (value: string, label: string) => `<option value="${esc(value)}">${esc(label)}</option>`;
  const keep = opt('__keep', 'No change');
  const row = (field: string, control: string, hint = '') =>
    `<tr data-row="${esc(field)}"><th scope="row"><label for="bulk-${esc(field)}">${esc(field)}</label></th><td>${control}${hint}</td></tr>`;

  const statusRow = row(
    'status',
    `<select id="bulk-status" data-field="status">${keep}${o.statuses.map((s) => opt(s, s)).join('')}</select>`,
  );
  const labelRows = LABEL_FIELD_NAMES.map((field) => {
    const values = o.facets[field].map((f) => f.value);
    return row(
      field,
      `<select id="bulk-${field}" data-field="${field}">${keep}${opt('__clear', `Clear (remove the ${field}: label)`)}<optgroup label="Set to">${values
        .map((v) => opt(v, v))
        .join('')}${opt('__other', 'Another value…')}</optgroup></select>
       <input type="text" class="bulk__other" data-other-for="${field}" placeholder="new ${field} value" aria-label="New ${field} value" hidden />`,
    );
  }).join('');
  const milestoneRow = row(
    'milestone',
    `<select id="bulk-milestone" data-field="milestone">${keep}${opt('__clear', 'Clear (no milestone)')}<optgroup label="Set to">${o.milestones
      .map((m) => opt(m.id, m.archived ? `${m.title} (archived)` : m.title))
      .join('')}</optgroup></select>`,
  );
  const mapRow = row(
    'map',
    `<select id="bulk-map" data-field="map">${keep}${opt('__clear', 'Clear (remove from every map)')}<optgroup label="Place on">${o.maps
      .map((m) => opt(m.id, m.title))
      .join('')}</optgroup></select>
     ${o.maps
       .map(
         (m) => `<span class="bulk__cell" data-cell-for="${esc(m.id)}" hidden>
       <select data-map-step aria-label="Step on ${esc(m.title)}">${m.activities
         .map(
           (a) =>
             `<optgroup label="${esc(a.title)}">${a.steps
               .map((s) => `<option value="${esc(`${a.id}/${s.id}`)}">${esc(s.title)}</option>`)
               .join('')}</optgroup>`,
         )
         .join('')}</select>
       <select data-map-slice aria-label="Release slice on ${esc(m.title)}">${m.releaseSlices.map((s) => opt(s.id, s.title)).join('')}</select>
     </span>`,
       )
       .join('')}`,
    '<p class="bulk__hint">Placing a story moves it out of every other primary cell. Clearing also removes supporting references.</p>',
  );

  return `<dialog class="bulk" id="bulk-dialog" aria-labelledby="bulk-title">
  <div class="bulk__inner">
    <header class="bulk__head">
      <h2 id="bulk-title">Edit <span data-bulk-count>0</span> selected stories</h2>
      <p class="muted">Only the fields you set are changed. Fields left on “No change” are not touched.</p>
    </header>
    <div data-bulk-step="edit">
      <table class="bulk__fields"><tbody>${statusRow}${labelRows}${milestoneRow}${mapRow}</tbody></table>
    </div>
    <div data-bulk-step="review" hidden>
      <div class="bulk__review" data-bulk-review-body></div>
    </div>
    <div class="bulk__error" role="alert" data-bulk-error hidden></div>
    <footer class="bulk__foot">
      <button type="button" class="btn ghost" data-bulk-cancel>Cancel</button>
      <button type="button" class="btn ghost" data-bulk-back hidden>Back</button>
      <button type="button" class="btn" data-bulk-review>Review changes</button>
      <button type="button" class="btn" data-bulk-apply hidden>Apply changes</button>
    </footer>
  </div>
</dialog>`;
}

// -------------------------------------------------------------------- page

export function storiesPage(o: StoriesPageOptions): string {
  const extras = viewParams(o.view, o.laneMode);
  const listHref = `/${serializeStoryQuery(o.query)}`;
  const kanbanHref = `/${serializeStoryQuery(o.query, viewParams('kanban', o.laneMode))}`;
  const resetHref = `/${serializeStoryQuery({ fields: {} }, extras)}`;
  const milestoneTitle = (id?: string) => (id ? o.milestones.find((m) => m.id === id)?.title ?? id : undefined);

  const lanesControl =
    o.view === 'kanban'
      ? `<label class="f kb-lanes"><span>lanes</span><select name="lanes">
          <option value=""${o.laneMode === 'none' ? ' selected' : ''}>none</option>
          <option value="milestone"${o.laneMode === 'milestone' ? ' selected' : ''}>milestone</option>
        </select></label>`
      : '';

  return `<section class="page stories-page${o.view === 'kanban' ? ' wide-page' : ''}" data-view="${o.view}">
  <div class="page-head">
    <div>
      <h1>Stories</h1>
      <p class="count"><strong>${o.items.length}</strong> shown of ${o.total} work items</p>
    </div>
    <div class="page-head__side">
      <div class="sm-viewswitch" role="group" aria-label="Stories view">
        <a href="${esc(listHref)}"${o.view === 'list' ? ' class="on" aria-current="page"' : ''}>List</a>
        <a href="${esc(kanbanHref)}"${o.view === 'kanban' ? ' class="on" aria-current="page"' : ''}>Kanban</a>
      </div>
    </div>
  </div>
  ${filterBar({
    query: o.query,
    facets: o.facets,
    maps: o.maps.map((m) => ({ id: m.id, title: m.title, count: o.mapCounts.get(m.id) ?? 0 })),
    milestones: o.milestones.map((m) => ({ id: m.id, title: m.archived ? `${m.title} (archived)` : m.title })),
    stateCounts: o.stateCounts,
    noMapCount: o.noMapCount,
    noneCounts: o.noneCounts,
    hidden: o.view === 'kanban' ? [['view', 'kanban']] : [],
    extraControls: lanesControl,
    resetHref,
  })}
  <div class="flash" id="flash" role="status" aria-live="polite" hidden></div>
  <div class="selbar" data-selbar data-shown="${o.items.length}" hidden>
    <span class="selbar__count"><strong data-sel-count>0</strong> selected</span>
    <span class="selbar__scope">of the ${o.items.length} stories shown</span>
    <button type="button" class="btn ghost small" data-sel-all>Select all ${o.items.length} shown</button>
    <button type="button" class="btn ghost small" data-sel-clear disabled>Clear selection</button>
    <button type="button" class="btn small" data-bulk-open disabled>Edit fields…</button>
  </div>
  ${o.view === 'kanban' && o.board ? kanbanView(o.board, milestoneTitle) : listView(o.items)}
  ${bulkDialog(o)}
</section>`;
}
