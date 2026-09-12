import { createHash, randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { Scalar, parse as parseYaml, stringify } from 'yaml';

/**
 * The write side of a Backlog.md work item.
 *
 * Every edit is the smallest textual change that expresses it: only the front
 * matter keys that change are rewritten, in the shapes Backlog.md itself
 * writes, and every other byte of the file is left alone. The result is
 * re-parsed before it is written, and refused if anything other than the
 * intended keys would change — so a diff of the file shows the edit and nothing
 * else.
 */

export type FrontValue = string | string[];

const FRONT_MATTER = /^---(\r?\n)([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/** Keys whose values Backlog.md writes single-quoted. */
const QUOTED_SCALARS = new Set(['created_date', 'updated_date']);
const QUOTED_LIST_ITEMS = new Set(['labels']);

/** Backlog.md's key order, used only to decide where a newly added key goes. */
const KEY_ORDER = [
  'id',
  'title',
  'status',
  'assignee',
  'reporter',
  'created_date',
  'updated_date',
  'labels',
  'milestone',
  'dependencies',
  'references',
  'documentation',
  'parent_task_id',
  'subtasks',
  'priority',
  'ordinal',
  'type',
];

export class WorkItemWriteError extends Error {
  constructor(
    readonly code: 'NO_FRONT_MATTER' | 'UNSUPPORTED_BODY_LAYOUT' | 'WRITE_VERIFICATION_FAILED' | 'WRITE_LOCK_TIMEOUT' | 'FILE_EXISTS',
    message: string,
  ) {
    super(message);
    this.name = 'WorkItemWriteError';
  }
}

function quoteSingle(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function plainScalar(value: string): string {
  return stringify(new Scalar(value), { lineWidth: 0 }).replace(/\n$/, '');
}

function scalarText(key: string, value: string, listItem: boolean): string {
  if (listItem ? QUOTED_LIST_ITEMS.has(key) : QUOTED_SCALARS.has(key)) return quoteSingle(value);
  return plainScalar(value);
}

/** One key in Backlog.md's layout: `key: value`, `key: []`, or a block list. */
export function serializeKey(key: string, value: FrontValue): string[] {
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${key}: []`];
    return [`${key}:`, ...value.map((v) => `  - ${scalarText(key, v, true)}`)];
  }
  return [`${key}: ${scalarText(key, value, false)}`];
}

interface Block {
  key?: string;
  lines: string[];
}

/** Splits front matter into top-level key blocks, keeping every original line. */
function blocks(lines: string[]): Block[] {
  const out: Block[] = [{ lines: [] }];
  for (const line of lines) {
    const m = /^([A-Za-z_][\w.-]*)\s*:(?:\s|$)/.exec(line);
    if (m) out.push({ key: m[1], lines: [line] });
    else out[out.length - 1].lines.push(line);
  }
  return out;
}

/**
 * Applies key changes to a work item's front matter. A value of `undefined`
 * removes the key. Returns the whole new file.
 */
export function editFrontMatter(raw: string, changes: Record<string, FrontValue | undefined>): string {
  const match = FRONT_MATTER.exec(raw);
  if (!match) throw new WorkItemWriteError('NO_FRONT_MATTER', 'the file does not start with a YAML front-matter block');
  const eol = match[1];
  const parts = blocks(match[2].split(/\r?\n/));

  for (const [key, value] of Object.entries(changes)) {
    const at = parts.findIndex((b) => b.key === key);
    if (value === undefined) {
      if (at !== -1) parts.splice(at, 1);
      continue;
    }
    const lines = serializeKey(key, value);
    if (at !== -1) {
      // Keep comments and blank lines that trailed the old value.
      const trailing: string[] = [];
      const old = parts[at].lines;
      for (let i = old.length - 1; i > 0 && /^(#.*)?\s*$/.test(old[i]); i -= 1) {
        trailing.unshift(old[i]);
      }
      parts[at] = { key, lines: [...lines, ...trailing] };
      continue;
    }
    const rank = KEY_ORDER.indexOf(key);
    let insertAt = parts.length;
    if (rank !== -1) {
      // After the last present key that Backlog.md orders before this one.
      let after = -1;
      parts.forEach((b, i) => {
        const r = b.key ? KEY_ORDER.indexOf(b.key) : -1;
        if (r !== -1 && r < rank) after = i;
      });
      if (after !== -1) insertAt = after + 1;
    }
    parts.splice(insertAt, 0, { key, lines });
  }

  const front = parts.flatMap((b) => b.lines);
  const rest = raw.slice(match[0].length);
  return `---${eol}${front.join(eol)}${eol}---${eol}${rest}`;
}

const DESCRIPTION_BEGIN = '<!-- SECTION:DESCRIPTION:BEGIN -->';
const DESCRIPTION_END = '<!-- SECTION:DESCRIPTION:END -->';
const ANY_MARKER = /<!-- (?:AC|DOD|SECTION:[A-Z_]+):BEGIN -->/;

/**
 * Replaces the description. Inside Backlog.md's `SECTION:DESCRIPTION` markers
 * when they exist; otherwise the whole Markdown after the front matter, which
 * is exactly what the reader shows as the body of a file with no markers. A file
 * with other marker blocks but no description block is refused, because there
 * is no unambiguous place to put the text.
 */
export function replaceDescription(raw: string, body: string): string {
  const match = FRONT_MATTER.exec(raw);
  if (!match) throw new WorkItemWriteError('NO_FRONT_MATTER', 'the file does not start with a YAML front-matter block');
  const eol = match[1];
  const head = raw.slice(0, match[0].length);
  const rest = raw.slice(match[0].length);
  const text = body.replace(/\r?\n/g, eol);
  const start = rest.indexOf(DESCRIPTION_BEGIN);
  const stop = start === -1 ? -1 : rest.indexOf(DESCRIPTION_END, start + DESCRIPTION_BEGIN.length);
  if (start !== -1 && stop !== -1) {
    return `${head}${rest.slice(0, start + DESCRIPTION_BEGIN.length)}${eol}${text}${eol}${rest.slice(stop)}`;
  }
  if (ANY_MARKER.test(rest)) {
    throw new WorkItemWriteError(
      'UNSUPPORTED_BODY_LAYOUT',
      'the file has Backlog.md marker blocks but no SECTION:DESCRIPTION block, so there is no unambiguous place for the body',
    );
  }
  return `${head}${eol}${text.trim()}${eol}`;
}

/**
 * Proves an edit touched only what it meant to: every front matter key outside
 * `changed` parses to the same value as before, and every changed key parses to
 * its intended value.
 */
export function verifyFrontMatterEdit(before: string, after: string, changes: Record<string, FrontValue | undefined>): void {
  const parse = (raw: string) => {
    const m = FRONT_MATTER.exec(raw);
    if (!m) throw new WorkItemWriteError('WRITE_VERIFICATION_FAILED', 'the edited file lost its front matter');
    const doc = parseYaml(m[2]);
    return (doc && typeof doc === 'object' ? doc : {}) as Record<string, unknown>;
  };
  let old: Record<string, unknown>;
  let next: Record<string, unknown>;
  try {
    old = parse(before);
    next = parse(after);
  } catch (error) {
    if (error instanceof WorkItemWriteError) throw error;
    throw new WorkItemWriteError('WRITE_VERIFICATION_FAILED', `the edited front matter does not parse: ${(error as Error).message}`);
  }
  for (const key of new Set([...Object.keys(old), ...Object.keys(next)])) {
    const expected = key in changes ? changes[key] : old[key];
    if (!isDeepStrictEqual(next[key], expected)) {
      throw new WorkItemWriteError(
        'WRITE_VERIFICATION_FAILED',
        `the edit would change front matter key "${key}" to ${JSON.stringify(next[key])}, expected ${JSON.stringify(expected)}`,
      );
    }
  }
}

// ------------------------------------------------------------- new work items

export interface NewWorkItem {
  id: string;
  title: string;
  status: string;
  createdDate: string;
  labels: string[];
  milestone?: string;
  dependencies: string[];
  priority?: string;
  type?: string;
  body: string;
  definitionOfDone: string[];
}

/** A new work item in the layout Backlog.md writes. */
export function renderNewWorkItem(item: NewWorkItem): string {
  const front = [
    ...serializeKey('id', item.id),
    ...serializeKey('title', item.title),
    ...serializeKey('status', item.status),
    ...serializeKey('assignee', []),
    ...serializeKey('created_date', item.createdDate),
    ...serializeKey('labels', item.labels),
    ...(item.milestone ? serializeKey('milestone', item.milestone) : []),
    ...serializeKey('dependencies', item.dependencies),
    ...(item.priority ? serializeKey('priority', item.priority) : []),
    ...(item.type ? serializeKey('type', item.type) : []),
  ];
  const out = ['---', ...front, '---', '', '## Description', '', DESCRIPTION_BEGIN, item.body, DESCRIPTION_END];
  if (item.definitionOfDone.length > 0) {
    out.push('', '## Definition of Done', '<!-- DOD:BEGIN -->');
    item.definitionOfDone.forEach((line, i) => out.push(`- [ ] #${i + 1} ${line}`));
    out.push('<!-- DOD:END -->');
  }
  return `${out.join('\n')}\n`;
}

/** Backlog.md's filename for a work item: `<id lower> - <Title-With-Dashes>.md`. */
export function workItemFileName(id: string, title: string): string {
  const slug = title
    .replace(/[<>:"/\\|?*'`#%{}^~[\]]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100)
    .replace(/-$/, '');
  return `${id.toLowerCase()} - ${slug || 'untitled'}.md`;
}

/** `yyyy-mm-dd HH:MM` in UTC, exactly as Backlog.md stamps `created_date` and `updated_date`. */
export function backlogTimestamp(now = new Date()): string {
  return now.toISOString().slice(0, 16).replace('T', ' ');
}

// ------------------------------------------------------------------ disk writes

function tempPathFor(target: string): string {
  return join(dirname(target), `.${basename(target)}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`);
}

function writeTemp(target: string, content: string): string {
  const temp = tempPathFor(target);
  const fd = openSync(temp, 'wx', 0o644);
  try {
    writeSync(fd, content, null, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return temp;
}

/**
 * Replaces a file atomically: readers see the old bytes or the new ones, never
 * a torn write. When `expected` is given, the file must still hold exactly
 * those bytes at the moment of the swap; otherwise nothing is written and
 * `false` is returned.
 */
export function replaceFileAtomic(target: string, content: string, expected?: string): boolean {
  const temp = writeTemp(target, content);
  try {
    if (expected !== undefined && readFileSync(target, 'utf8') !== expected) {
      unlinkSync(temp);
      return false;
    }
    renameSync(temp, target);
    return true;
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      /* already renamed or never created */
    }
    throw error;
  }
}

/** Creates a file atomically and never overwrites one that exists. */
export function createFileExclusive(target: string, content: string): void {
  const temp = writeTemp(target, content);
  try {
    linkSync(temp, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new WorkItemWriteError('FILE_EXISTS', `${basename(target)} already exists`);
    }
    throw error;
  } finally {
    unlinkSync(temp);
  }
}

// ------------------------------------------------------------------ write lock

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Where the lock for one backlog lives: outside the repository, so it never shows in a diff. */
export function lockPathFor(backlogDir: string): string {
  let real = backlogDir;
  try {
    real = realpathSync(backlogDir);
  } catch {
    /* not created yet; the literal path identifies it well enough */
  }
  return join(tmpdir(), `storymap-${createHash('sha256').update(real).digest('hex').slice(0, 16)}.lock`);
}

/**
 * Serialises writers to one backlog across processes — a browser server, a
 * CLI call and a script can all write safely. The lock is a file created
 * exclusively; one left by a dead process, or older than `staleMs`, is taken
 * over. Everything inside `fn` must be synchronous.
 */
export function withBacklogLock<T>(backlogDir: string, fn: () => T, opts: { timeoutMs?: number; staleMs?: number } = {}): T {
  const path = lockPathFor(backlogDir);
  const timeoutMs = opts.timeoutMs ?? 5000;
  const staleMs = opts.staleMs ?? 30000;
  const deadline = Date.now() + timeoutMs;
  let fd: number | undefined;
  while (fd === undefined) {
    try {
      fd = openSync(path, 'wx', 0o600);
      writeSync(fd, `${process.pid}\n${Date.now()}\n`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const [pid, at] = readFileSync(path, 'utf8').split('\n').map(Number);
        if ((Number.isInteger(pid) && pid > 0 && !alive(pid)) || !Number.isFinite(at) || Date.now() - at > staleMs) {
          unlinkSync(path);
          continue;
        }
      } catch {
        continue; // released between our open and our read
      }
      if (Date.now() > deadline) {
        throw new WorkItemWriteError('WRITE_LOCK_TIMEOUT', `another writer has held the backlog lock for over ${timeoutMs}ms`);
      }
      sleepSync(20);
    }
  }
  try {
    return fn();
  } finally {
    closeSync(fd);
    try {
      unlinkSync(path);
    } catch {
      /* taken over as stale; nothing to release */
    }
  }
}
