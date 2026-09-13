import type { Facets, FieldFilter, FilterField, StoryQuery } from '../core';
import { NONE } from '../core';
import { esc } from './html';

/**
 * The Stories filter bar: search plus one compact include/exclude control per
 * categorical field.
 *
 * Each control is a `<details>` disclosure holding an is / is not choice and a
 * checkbox per value, all plain form fields — so the bar still submits a
 * correct query with no JavaScript. The closed control reads as a sentence
 * (`status is not Done, Cancelled`) so the operator and the active values are
 * visible without opening it.
 */

export interface FilterOption {
  value: string;
  label: string;
  count?: number;
}

export interface FilterBarOptions {
  query: StoryQuery;
  facets: Facets;
  maps: { id: string; title: string; count: number }[];
  milestones: { id: string; title: string }[];
  stateCounts: { active: number; completed: number };
  noMapCount: number;
  /** Carried through Apply so filtering never changes the view. */
  hidden: [string, string][];
  resetHref: string;
  /** More controls for the current view, such as the Kanban lane selector. */
  extraControls?: string;
}

function optionLabel(options: FilterOption[], value: string): string {
  return options.find((o) => o.value === value)?.label ?? value;
}

export function multiFilter(field: FilterField, filter: FieldFilter | undefined, given: FilterOption[]): string {
  const values = filter?.values ?? [];
  const op = filter?.op ?? 'in';
  // A value named in the URL but absent from the estate stays visible and checked.
  const options = [...given];
  for (const v of values) if (!options.some((o) => o.value === v)) options.push({ value: v, label: v, count: 0 });

  const active = values.length > 0;
  const summaryValues = active
    ? values.length <= 2
      ? values.map((v) => esc(optionLabel(options, v))).join(', ')
      : `${esc(optionLabel(options, values[0]))}, ${esc(optionLabel(options, values[1]))} <span class="mf__more">+${values.length - 2}</span>`
    : '<span class="mf__any">any</span>';
  const opWord = active ? `<span class="mf__op">${op === 'not' ? 'is not' : 'is'}</span>` : '';
  const id = `mf-${field}`;

  return `<details class="mf${active ? ` mf--active mf--${op}` : ''}" data-field="${esc(field)}">
  <summary class="mf__sum" aria-label="${esc(field)} filter">
    <span class="mf__name">${esc(field)}</span>${opWord}<span class="mf__vals">${summaryValues}</span>
  </summary>
  <div class="mf__pop" role="group" aria-labelledby="${id}-legend">
    <div class="mf__head">
      <span id="${id}-legend" class="mf__legend">${esc(field)}</span>
      <span class="mf__ops" role="radiogroup" aria-label="Include or exclude">
        <label class="mf__opt"><input type="radio" name="${esc(field)}.op" value="in"${op === 'in' ? ' checked' : ''} /><span>is</span></label>
        <label class="mf__opt mf__opt--not"><input type="radio" name="${esc(field)}.op" value="not"${op === 'not' ? ' checked' : ''} /><span>is not</span></label>
      </span>
    </div>
    ${options.length > 8 ? `<input type="search" class="mf__find" placeholder="find a value…" aria-label="Find a ${esc(field)} value" />` : ''}
    <div class="mf__list">${options
      .map(
        (o) => `<label class="mf__item"><input type="checkbox" name="${esc(field)}" value="${esc(o.value)}"${values.includes(o.value) ? ' checked' : ''} /><span class="mf__label">${esc(o.label)}</span>${o.count !== undefined ? `<span class="mf__n">${o.count}</span>` : ''}</label>`,
      )
      .join('')}</div>
    <div class="mf__foot">
      <button type="button" class="btn ghost small" data-mf-clear>Clear</button>
      <button type="submit" class="btn small">Apply</button>
    </div>
  </div>
</details>`;
}

function facetOptions(facet: { value: string; count: number }[], noneCount: number | undefined, noneLabel = '(none)'): FilterOption[] {
  return [
    ...facet.map((f) => ({ value: f.value, label: f.value, count: f.count })),
    ...(noneCount !== undefined ? [{ value: NONE, label: noneLabel, count: noneCount }] : []),
  ];
}

export function filterBar(o: FilterBarOptions & { noneCounts: Partial<Record<FilterField, number>> }): string {
  const { query, facets } = o;
  const f = (field: FilterField, options: FilterOption[]) => multiFilter(field, query.fields[field], options);
  return `<form class="filters story-filters" method="get" action="/" data-story-filters>
  ${o.hidden.map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}" />`).join('')}
  <label class="f grow"><span>search</span><input type="search" name="text" value="${esc(query.text ?? '')}" placeholder="id, title, label or body…" /></label>
  <div class="mf-row">
    ${f('state', [
      { value: 'active', label: 'active', count: o.stateCounts.active },
      { value: 'completed', label: 'completed', count: o.stateCounts.completed },
    ])}
    ${f('status', facetOptions(facets.status, undefined))}
    ${f('wstatus', facetOptions(facets.wstatus, o.noneCounts.wstatus))}
    ${f('area', facetOptions(facets.area, o.noneCounts.area))}
    ${f('owner', facetOptions(facets.owner, o.noneCounts.owner))}
    ${f('priority', facetOptions(facets.priority, o.noneCounts.priority))}
    ${f('wtype', facetOptions(facets.wtype, o.noneCounts.wtype))}
    ${f('map', [
      { value: NONE, label: 'not on any map', count: o.noMapCount },
      ...o.maps.map((m) => ({ value: m.id, label: m.title, count: m.count })),
    ])}
    ${f('milestone', [
      { value: NONE, label: 'no milestone', count: o.noneCounts.milestone },
      ...o.milestones.map((m) => ({ value: m.id, label: m.title, count: facets.milestone.find((x) => x.value === m.id)?.count ?? 0 })),
    ])}
  </div>
  <div class="filters__actions">
    ${o.extraControls ?? ''}
    <button type="submit" class="btn">Apply</button>
    <a class="btn ghost" href="${esc(o.resetHref)}">Reset</a>
  </div>
</form>`;
}
