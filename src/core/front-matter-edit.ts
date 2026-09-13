/**
 * Line-level edits to a Backlog.md front-matter block.
 *
 * A bulk edit must land as a small, reviewable Git diff, so nothing here
 * re-serialises YAML: it finds the top-level key being changed and rewrites
 * those lines only. Every other byte of the file — key order, quoting,
 * comments, the body — is left exactly as it was. The caller re-parses the
 * result and refuses to write unless it reads back as intended.
 */

const FRONT_MATTER = /^---(\r?\n)([\s\S]*?)\r?\n---(?:\r?\n|$)/;

export interface FrontMatterSplit {
  eol: string;
  lines: string[];
  /** Everything from the closing `---` onward, untouched. */
  tail: string;
}

export function splitFrontMatter(raw: string): FrontMatterSplit | undefined {
  const m = FRONT_MATTER.exec(raw);
  if (!m) return undefined;
  const eol = m[1];
  const tail = raw.slice(3 + eol.length + m[2].length).replace(/^\r?\n/, '');
  return { eol, lines: m[2].split(/\r?\n/), tail };
}

export function joinFrontMatter(split: FrontMatterSplit): string {
  return `---${split.eol}${split.lines.join(split.eol)}${split.eol}${split.tail}`;
}

const KEY_LINE = /^([A-Za-z_][\w-]*):(?:\s|$)/;

/** `[start, end)` line range of a top-level key, including its indented continuation. */
function keyRange(lines: string[], key: string): [number, number] | undefined {
  const start = lines.findIndex((l) => KEY_LINE.exec(l)?.[1] === key);
  if (start === -1) return undefined;
  let end = start + 1;
  while (end < lines.length && (/^\s/.test(lines[end]) || /^-(\s|$)/.test(lines[end]) || lines[end] === '')) end += 1;
  // Trailing blank lines belong to whatever follows, not to this key.
  while (end > start + 1 && lines[end - 1].trim() === '') end -= 1;
  return [start, end];
}

const YAML_RESERVED = /^(true|false|yes|no|on|off|null|~|y|n)$/i;

/** A scalar as YAML: plain when that is unambiguous, single-quoted otherwise. */
export function yamlScalar(value: string): string {
  const plainSafe =
    /^[A-Za-z0-9_][A-Za-z0-9_ .\/()+-]*$/.test(value) &&
    !/\s$/.test(value) &&
    !YAML_RESERVED.test(value) &&
    !/^[-+]?(\d[\d_]*)?(\.\d*)?([eE][-+]?\d+)?$/.test(value);
  return plainSafe ? value : singleQuoted(value);
}

/** `area:ci` is a valid plain YAML scalar: a colon only starts a mapping when a space follows it. */
function plainLabelSafe(label: string): boolean {
  return /^[A-Za-z0-9_][A-Za-z0-9_.\/()+:-]*$/.test(label) && label.includes(':') && !label.endsWith(':');
}

export function singleQuoted(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Sets `key: value`, replacing the key's lines or inserting after `after` (or at the end). */
export function setScalar(split: FrontMatterSplit, key: string, rendered: string, after: readonly string[] = []): void {
  setKeyLines(split, key, [`${key}: ${rendered}`], after);
}

/** Replaces a key's lines, or inserts them after the first `after` key present (or at the end). */
function setKeyLines(split: FrontMatterSplit, key: string, block: string[], after: readonly string[]): void {
  const range = keyRange(split.lines, key);
  if (range) {
    split.lines.splice(range[0], range[1] - range[0], ...block);
    return;
  }
  for (const anchor of after) {
    const r = keyRange(split.lines, anchor);
    if (r) {
      split.lines.splice(r[1], 0, ...block);
      return;
    }
  }
  split.lines.push(...block);
}

export function removeKey(split: FrontMatterSplit, key: string): void {
  const range = keyRange(split.lines, key);
  if (range) split.lines.splice(range[0], range[1] - range[0]);
}

const ITEM_LINE = /^(\s*)-\s+(.*?)\s*$/;

function unquote(token: string): string | undefined {
  if (token.startsWith("'") && token.endsWith("'") && token.length >= 2) return token.slice(1, -1).replace(/''/g, "'");
  if (token.startsWith('"') && token.endsWith('"') && token.length >= 2) {
    try {
      return JSON.parse(token) as string;
    } catch {
      return undefined;
    }
  }
  if (/^[^'"#\[\]{},&*!|>%@`]/.test(token) && !token.includes(' #')) return token;
  return undefined;
}

/**
 * Rewrites the `labels` list to `next`, keeping each surviving label's original
 * line and the list's own indentation and quoting style, so replacing one label
 * is a one-line diff.
 */
export function setLabels(split: FrontMatterSplit, current: readonly string[], next: readonly string[]): void {
  const range = keyRange(split.lines, 'labels');
  let indent = '  ';
  let quote: 'single' | 'double' | 'plain' = 'single';
  const kept = new Map<string, string>();

  if (range) {
    const items = split.lines.slice(range[0] + 1, range[1]);
    const parsed = items.map((l) => {
      const m = ITEM_LINE.exec(l);
      return m ? { line: l, indent: m[1], value: unquote(m[2]), token: m[2] } : undefined;
    });
    const first = parsed.find(Boolean);
    if (first) {
      indent = first.indent;
      quote = first.token.startsWith("'") ? 'single' : first.token.startsWith('"') ? 'double' : 'plain';
    }
    // Reuse original lines only when the block is a plain list we fully understand.
    const understood =
      parsed.length === current.length && parsed.every((p, i) => p && p.value === current[i]);
    if (understood) for (const p of parsed) kept.set(p!.value!, p!.line);
  }

  const render = (label: string) => {
    const existing = kept.get(label);
    if (existing !== undefined) return existing;
    const token =
      quote === 'double' ? JSON.stringify(label) : quote === 'plain' && plainLabelSafe(label) ? label : singleQuoted(label);
    return `${indent}- ${token}`;
  };

  const block = next.length ? ['labels:', ...next.map(render)] : ['labels: []'];
  setKeyLines(split, 'labels', block, ['updated_date', 'created_date', 'assignee', 'status']);
}

/** Backlog.md's `updated_date` format: UTC `YYYY-MM-DD HH:MM`. */
export function backlogTimestamp(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getUTCFullYear()}-${p(now.getUTCMonth() + 1)}-${p(now.getUTCDate())} ${p(now.getUTCHours())}:${p(now.getUTCMinutes())}`;
}
