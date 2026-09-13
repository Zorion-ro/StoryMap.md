import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { AcceptanceCriterion, BacklogReadResult, Milestone, ReadProblem, WorkItem } from './types';

/**
 * Reads Backlog.md work items straight off disk.
 *
 * Deliberately not the `backlog` CLI: Backlog.md excludes `completed/` from
 * ordinary list and search, and this tool must show delivered work in its
 * journey position. The Markdown is the canonical source anyway.
 *
 * This module never writes.
 */

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function markerBlock(text: string, marker: string): string | undefined {
  const begin = `<!-- ${marker}:BEGIN -->`;
  const end = `<!-- ${marker}:END -->`;
  const start = text.indexOf(begin);
  if (start === -1) return undefined;
  const stop = text.indexOf(end, start + begin.length);
  if (stop === -1) return undefined;
  return text.slice(start + begin.length, stop).replace(/^\r?\n/, '').replace(/\r?\n$/, '');
}

/** `- [x] #2 text` -> criterion. Tolerates a missing `#n`, which hand-edited files have. */
export function parseCriteria(block: string | undefined): AcceptanceCriterion[] {
  if (!block) return [];
  const out: AcceptanceCriterion[] = [];
  for (const line of block.split('\n')) {
    const m = /^\s*[-*]\s*\[( |x|X)\]\s*(?:#(\d+)\s*)?(.*)$/.exec(line);
    if (!m) continue;
    const text = m[3].trim();
    if (!text) continue;
    out.push({
      index: m[2] ? Number(m[2]) : out.length + 1,
      text,
      checked: m[1].toLowerCase() === 'x',
    });
  }
  return out;
}

/**
 * Pulls checkbox lines out of an "Acceptance criteria" heading inside the body.
 *
 * The migration left acceptance criteria as prose under numbered headings rather
 * than reflowing them into the native AC block, so for all but a handful of
 * stories this is where the criteria actually are.
 */
export function parseBodyAcceptanceCriteria(body: string): AcceptanceCriterion[] {
  const lines = body.split('\n');
  const collected: string[] = [];
  let inside = false;
  for (const line of lines) {
    const heading = /^#{2,4}\s+(?:\d+[.)]\s*)?(.+?)\s*$/.exec(line);
    if (heading) {
      const label = heading[1].replace(/[`*]/g, '').trim().toLowerCase();
      inside = label === 'acceptance criteria' || label === 'acceptance' || label === 'acceptance criteria (verifiable)';
      continue;
    }
    if (inside) collected.push(line);
  }
  return parseCriteria(collected.join('\n'));
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter(Boolean);
  }
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

/**
 * Optional label namespaces this tool understands as structured metadata.
 *
 * None of them is required. A project whose stories carry only Backlog.md's own
 * fields simply has these come back undefined, and the views omit them.
 */
const LABEL_NAMESPACES = ['area', 'owner', 'wtype', 'wstatus', 'priority', 'risk'] as const;

function splitLabels(labels: string[]) {
  const found: Partial<Record<(typeof LABEL_NAMESPACES)[number], string>> = {};
  const other: string[] = [];
  for (const label of labels) {
    const at = label.indexOf(':');
    const ns = at === -1 ? '' : label.slice(0, at);
    if (at !== -1 && (LABEL_NAMESPACES as readonly string[]).includes(ns)) {
      // First wins; a story carrying two values for one namespace keeps both visible
      // in `labels`, and the extra shows up as an "other" label rather than vanishing.
      const key = ns as (typeof LABEL_NAMESPACES)[number];
      if (found[key] === undefined) found[key] = label.slice(at + 1);
      else other.push(label);
    } else {
      other.push(label);
    }
  }
  return { found, other };
}

/**
 * The description of a file Backlog.md did not write.
 *
 * Backlog.md wraps the description in `SECTION:DESCRIPTION` markers, but a
 * hand-written or third-party work item may have none. Rather than show such a
 * story as empty, fall back to the Markdown after the front matter, minus any
 * marker blocks so the same text is not rendered twice. Headings are kept, so
 * a hand-written `## Acceptance criteria` list is still found by the body
 * criteria parser.
 */
function plainBody(rest: string): string {
  return rest
    .replace(/<!-- (?:AC|DOD|SECTION:[A-Z_]+):BEGIN -->[\s\S]*?<!-- (?:AC|DOD|SECTION:[A-Z_]+):END -->/g, '')
    .trim();
}

/**
/**
 * A fingerprint of a file's exact bytes. Two reads with the same revision saw
 * the same content, so a writer that names the revision it read can detect that
 * someone else changed the file in between.
 */
export function contentRevision(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 20);
}

/**
 * `archived` is the directory signal: the file lives in `completed/`.
 * `completedStatuses` adds the workflow signal, for projects whose delivered
 * work stays in `tasks/` and is marked by a terminal status instead. An item is
 * completed when either says so; neither alone is authoritative, because
 * Backlog.md archives by moving files and never reads `completed/` back.
 */
export function parseWorkItem(
  raw: string,
  sourcePath: string,
  archived: boolean,
  completedStatuses: readonly string[] = [],
): { item?: WorkItem; problems: ReadProblem[] } {
  const problems: ReadProblem[] = [];
  const match = FRONT_MATTER.exec(raw);
  if (!match) {
    return { problems: [{ sourcePath, kind: 'no_front_matter', detail: 'file does not start with a YAML front-matter block' }] };
  }

  let front: Record<string, unknown>;
  try {
    const parsed = parseYaml(match[1]);
    front = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch (error) {
    return {
      problems: [{ sourcePath, kind: 'unparseable_front_matter', detail: (error as Error).message }],
    };
  }

  const rest = raw.slice(match[0].length);
  const id = typeof front.id === 'string' ? front.id.trim() : '';
  const title = typeof front.title === 'string' ? front.title.trim() : '';
  const status = typeof front.status === 'string' ? front.status.trim() : '';
  if (!id) problems.push({ sourcePath, kind: 'missing_id', detail: 'front matter has no `id`' });
  if (!title) problems.push({ sourcePath, kind: 'missing_title', detail: 'front matter has no `title`' });
  if (!status) problems.push({ sourcePath, kind: 'missing_status', detail: 'front matter has no `status`' });
  if (!id) return { problems };

  const labels = stringList(front.labels);
  const { found, other } = splitLabels(labels);
  const body = markerBlock(rest, 'SECTION:DESCRIPTION') ?? plainBody(rest);

  const sections: Record<string, string> = {};
  for (const name of ['PLAN', 'NOTES', 'DECISIONS', 'FINAL_SUMMARY']) {
    const value = markerBlock(rest, `SECTION:${name}`);
    if (value !== undefined) sections[name] = value;
  }

  const item: WorkItem = {
    id,
    title: title || id,
    status: status || 'Unknown',
    type: typeof front.type === 'string' ? front.type : undefined,
    priority: typeof front.priority === 'string' ? front.priority : undefined,
    labels,
    dependencies: stringList(front.dependencies),
    documentation: stringList(front.documentation),
    acceptanceCriteria: parseCriteria(markerBlock(rest, 'AC')),
    bodyAcceptanceCriteria: parseBodyAcceptanceCriteria(body),
    definitionOfDone: parseCriteria(markerBlock(rest, 'DOD')),
    body,
    sections,
    frontmatter: front,
    milestone: typeof front.milestone === 'string' && front.milestone.trim() ? front.milestone.trim() : undefined,
    sourcePath,
    completed: archived || completedStatuses.includes(status),
    createdDate: typeof front.created_date === 'string' ? front.created_date : undefined,
    updatedDate: typeof front.updated_date === 'string' ? front.updated_date : undefined,
    revision: contentRevision(raw),
    area: found.area,
    owner: found.owner,
    wtype: found.wtype,
    wstatus: found.wstatus,
    priorityLabel: found.priority,
    risk: found.risk,
    otherLabels: other,
  };
  return { item, problems };
}

/**
 * Parsed files keyed by absolute path, reused while a file's size, mtime and
 * inode are unchanged — the same evidence the workspace fingerprint trusts.
 * It only saves re-parsing; the files stay the truth.
 */
export type ParseCache = Map<string, { stamp: string; result: ReturnType<typeof parseWorkItem> }>;

function readDir(
  dir: string,
  repoRoot: string,
  archived: boolean,
  out: BacklogReadResult,
  completedStatuses: readonly string[],
  cache?: { previous: ParseCache; next: ParseCache },
): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // a missing completed/ or tasks/ is not an error; the estate may not have one yet
  }
  for (const name of entries.sort()) {
    if (!name.endsWith('.md')) continue;
    const full = join(dir, name);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue; // raced with a concurrent rename; the next read settles it
    }
    if (!stat.isFile()) continue;
    const rel = relative(repoRoot, full);
    const stamp = `${archived}:${completedStatuses.join('|')}:${stat.size}:${stat.mtimeMs}:${stat.ino}`;
    const hit = cache?.previous.get(full);
    const parsed =
      hit && hit.stamp === stamp ? hit.result : parseWorkItem(readFileSync(full, 'utf8'), rel, archived, completedStatuses);
    cache?.next.set(full, { stamp, result: parsed });
    out.problems.push(...parsed.problems);
    if (parsed.item) out.items.push(parsed.item);
  }
}

export interface BacklogPaths {
  /** Absolute path of the project root everything else is relative to. */
  repoRoot: string;
  /** Absolute path of the Backlog.md directory holding `tasks/` and `completed/`. */
  backlogDir: string;
  /** Absolute path of the story-map YAML directory. */
  storyMapsDir: string;
  /**
   * Statuses that mean delivered. Empty (the default) leaves `completed/` as
   * the only completion signal, which is Backlog.md's own behaviour.
   */
  completedStatuses?: readonly string[];
}

/**
 * Turns a project root plus two project-relative directory names into absolute
 * paths. `backlogDirectory` normally comes from `backlog.config.yml`; the
 * story-map directory defaults to `story-maps` inside it.
 */
export function resolveBacklogPaths(
  repoRoot: string,
  backlogDirectory = 'backlog',
  storyMapsDirectory?: string,
  completedStatuses: readonly string[] = [],
): BacklogPaths {
  const backlogDir = join(repoRoot, backlogDirectory);
  return {
    repoRoot,
    backlogDir,
    storyMapsDir: storyMapsDirectory ? join(repoRoot, storyMapsDirectory) : join(backlogDir, 'story-maps'),
    completedStatuses,
  };
}

/**
 * Reads the milestone files Backlog.md keeps beside the tasks.
 *
 * A story names a milestone by id; this is how that id becomes a title a
 * person recognises. Archived milestones are read too, so a story pointing at
 * one still resolves rather than showing a bare `m-3`.
 */
export function readMilestones(paths: BacklogPaths): Milestone[] {
  const out: Milestone[] = [];
  for (const [dir, archived] of [
    [join(paths.backlogDir, 'milestones'), false],
    [join(paths.backlogDir, 'archive', 'milestones'), true],
  ] as [string, boolean][]) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries.sort()) {
      if (!name.endsWith('.md')) continue;
      const full = join(dir, name);
      if (!statSync(full).isFile()) continue;
      const raw = readFileSync(full, 'utf8');
      const match = FRONT_MATTER.exec(raw);
      if (!match) continue;
      let front: Record<string, unknown>;
      try {
        const parsed = parseYaml(match[1]);
        front = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
      } catch {
        continue; // a milestone we cannot read is not worth failing the estate over
      }
      const id = typeof front.id === 'string' ? front.id.trim() : '';
      if (!id) continue;
      out.push({
        id,
        title: typeof front.title === 'string' && front.title.trim() ? front.title.trim() : id,
        sourcePath: relative(paths.repoRoot, full),
        archived,
      });
    }
  }
  return out;
}

/** Reads `tasks/` and `completed/`. Problems are collected, never thrown. */
export function readBacklog(paths: BacklogPaths, cache?: ParseCache): BacklogReadResult {
  const result: BacklogReadResult = { items: [], problems: [] };
  const completedStatuses = paths.completedStatuses ?? [];
  // Parse into a fresh generation so files that disappeared fall out of the cache.
  const generation = cache && { previous: new Map(cache), next: cache };
  cache?.clear();
  readDir(join(paths.backlogDir, 'tasks'), paths.repoRoot, false, result, completedStatuses, generation);
  readDir(join(paths.backlogDir, 'completed'), paths.repoRoot, true, result, completedStatuses, generation);
  return result;
}
