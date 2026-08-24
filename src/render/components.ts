import type { WorkItem } from '../core';
import { criteriaSummary } from '../core';
import { esc, q } from './html';

/** `To Do` -> `todo`, for a CSS hook. */
export function statusKey(status: string): string {
  return status.toLowerCase().replace(/[^a-z]+/g, '-');
}

export function statusPill(item: WorkItem): string {
  return `<span class="pill status s-${esc(statusKey(item.status))}">${esc(item.status)}</span>`;
}

/**
 * The richer delivery state. Rendered next to, never merged into, the coarse
 * status — the two are separate dimensions in this estate.
 */
export function wstatusPill(item: WorkItem): string {
  if (!item.wstatus) return '';
  return `<span class="pill wstatus w-${esc(item.wstatus)}">${esc(item.wstatus.replace(/_/g, ' '))}</span>`;
}

export function statePill(item: WorkItem): string {
  return item.completed
    ? '<span class="pill state completed">completed</span>'
    : '<span class="pill state active">active</span>';
}

export function priorityPill(item: WorkItem): string {
  const label = item.priorityLabel ? item.priorityLabel.toUpperCase() : item.priority;
  if (!label) return '';
  const key = (item.priorityLabel ?? item.priority ?? '').toLowerCase();
  return `<span class="pill prio p-${esc(key)}">${esc(label)}</span>`;
}

export function criteriaBadge(item: WorkItem): string {
  const s = criteriaSummary(item);
  if (s.total === 0) return '<span class="ac none" title="no checkbox acceptance criteria found">—</span>';
  const complete = s.checked === s.total;
  return `<span class="ac ${complete ? 'full' : ''}" title="acceptance criteria (${s.source === 'body' ? 'in body' : 'native block'})">${s.checked}/${s.total}</span>`;
}

/** A story card as it appears inside a story map cell. */
export function storyCard(item: WorkItem, opts: { supporting?: boolean; mapId?: string } = {}): string {
  const href = `/story/${q(item.id)}${opts.mapId ? `?from=${q(opts.mapId)}` : ''}`;
  return `<a class="card${item.completed ? ' completed' : ''}${opts.supporting ? ' supporting' : ''}"
   href="${href}"
   data-story-id="${esc(item.id)}"
   data-status="${esc(item.status)}"
   data-completed="${item.completed ? '1' : '0'}"
   data-wstatus="${esc(item.wstatus ?? '')}"
   title="${esc(item.title)}">
  <span class="card-id">${esc(item.id)}${opts.supporting ? '<span class="sup" title="supporting: this story serves the step without being owned by it">supports</span>' : ''}</span>
  <span class="card-title">${esc(item.title)}</span>
  <span class="card-foot">${statusPill(item)}${wstatusPill(item)}</span>
</a>`;
}

/** A reference a map makes to an id no work item claims. Shown, never dropped. */
export function missingCard(storyId: string): string {
  return `<div class="card missing" data-story-id="${esc(storyId)}" data-completed="0">
  <span class="card-id">${esc(storyId)}</span>
  <span class="card-title">unknown story — this id matches no active or completed work item</span>
</div>`;
}

export function labelChips(item: WorkItem): string {
  const chips: string[] = [];
  const add = (ns: string, value?: string) => {
    if (value) chips.push(`<a class="chip ns-${esc(ns)}" href="/?${ns}=${q(value)}">${esc(ns)}:${esc(value)}</a>`);
  };
  add('area', item.area);
  add('owner', item.owner);
  add('wtype', item.wtype);
  add('wstatus', item.wstatus);
  add('risk', item.risk);
  for (const other of item.otherLabels) chips.push(`<span class="chip">${esc(other)}</span>`);
  return chips.join('');
}
