import { parseStoryMap } from './story-map-reader';
import type { StoryMap } from './types';
import { normalizeId } from './work-item-index';

/**
 * Minimal line edits to a story-map YAML file: take a story out of the map,
 * or place it in one cell.
 *
 * As with work items, nothing is re-serialised. The scanner below understands
 * the block-style layout maps are written in; the caller checks every result by
 * parsing it and comparing it with the structure it expected, so a layout this
 * scanner misreads (a flow list, say) is refused rather than corrupted.
 */

interface Frame {
  indent: number;
  kind: 'key' | 'item';
  key: string;
  /** For a sequence item: the `id:` it declares, if any. */
  id?: string;
  /** For a sequence item: the key the sequence belongs to. */
  listKey?: string;
}

interface LineInfo {
  stack: Frame[];
  /** Set for a scalar sequence entry such as `- FW-001`. */
  entry?: { value: string; token: string; indent: number };
}

function scalarToken(rest: string): { value: string; token: string } | undefined {
  const token = rest.replace(/\s+#.*$/, '').trim();
  if (!token) return undefined;
  if (/^'.*'$/.test(token)) return { value: token.slice(1, -1).replace(/''/g, "'"), token };
  if (/^".*"$/.test(token)) {
    try {
      return { value: JSON.parse(token) as string, token };
    } catch {
      return undefined;
    }
  }
  if (/^[\[{&*!|>%@`]/.test(token) || /:(\s|$)/.test(token)) return undefined;
  return { value: token, token };
}

function scan(lines: string[]): LineInfo[] {
  const stack: Frame[] = [];
  return lines.map((line) => {
    if (line.trim() === '' || /^\s*#/.test(line)) return { stack: [...stack] };
    const indent = line.length - line.trimStart().length;
    const item = /^(\s*)-(?:\s+(.*))?$/.exec(line);
    if (item) {
      while (stack.length && (stack[stack.length - 1].indent > indent || (stack[stack.length - 1].indent === indent && stack[stack.length - 1].kind === 'item'))) stack.pop();
      const parentKey = [...stack].reverse().find((f) => f.kind === 'key')?.key;
      const frame: Frame = { indent, kind: 'item', key: '-', listKey: parentKey };
      stack.push(frame);
      const rest = item[2] ?? '';
      const kv = /^([A-Za-z_][\w-]*):(?:\s+(.*))?$/.exec(rest);
      if (kv) {
        if (kv[1] === 'id') frame.id = scalarToken(kv[2] ?? '')?.value;
        stack.push({ indent: indent + 2, kind: 'key', key: kv[1] });
        return { stack: [...stack] };
      }
      const scalar = scalarToken(rest);
      return { stack: [...stack], ...(scalar ? { entry: { ...scalar, indent } } : {}) };
    }
    const kv = /^(\s*)([A-Za-z_][\w-]*):(?:\s+(.*))?$/.exec(line);
    if (kv) {
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
      const owner = stack[stack.length - 1];
      if (kv[2] === 'id' && owner?.kind === 'item') owner.id = scalarToken(kv[3] ?? '')?.value;
      stack.push({ indent, kind: 'key', key: kv[2] });
    }
    return { stack: [...stack] };
  });
}

/** The activity and step items a line sits inside, and the list keys above it. */
function context(info: LineInfo) {
  const items = info.stack.filter((f) => f.kind === 'item');
  const activity = items.find((f) => f.listKey === 'activities');
  const step = items.find((f) => f.listKey === 'steps');
  const keys = info.stack.filter((f) => f.kind === 'key').map((f) => f.key);
  return { activity, step, keys };
}

type EntryRole = { role: 'primary'; slice: string } | { role: 'supporting' } | undefined;

function entryRole(info: LineInfo): EntryRole {
  if (!info.entry) return undefined;
  const { step, keys } = context(info);
  if (!step) return undefined;
  const last = keys[keys.length - 1];
  const before = keys[keys.length - 2];
  if (last === 'supporting') return { role: 'supporting' };
  if (before === 'slices' && last) return { role: 'primary', slice: last };
  return undefined;
}

function splitLines(raw: string): { eol: string; lines: string[]; trailing: boolean } {
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const trailing = /\r?\n$/.test(raw);
  const body = trailing ? raw.replace(/\r?\n$/, '') : raw;
  return { eol, lines: body.split(/\r?\n/), trailing };
}

function join(parts: { eol: string; lines: string[]; trailing: boolean }): string {
  return parts.lines.join(parts.eol) + (parts.trailing ? parts.eol : '');
}

/** Removes a story's entries; `supporting: false` keeps its supporting references. */
export function removeStoryFromMapText(raw: string, storyId: string, opts: { supporting: boolean }): string {
  const parts = splitLines(raw);
  const infos = scan(parts.lines);
  const key = normalizeId(storyId);
  const drop = new Set<number>();
  infos.forEach((info, i) => {
    const role = entryRole(info);
    if (!role || !info.entry || normalizeId(info.entry.value) !== key) return;
    if (role.role === 'supporting' && !opts.supporting) return;
    drop.add(i);
  });
  if (drop.size === 0) return raw;

  // A list emptied by the removal becomes `key: []`, never a YAML null.
  const emptied = new Set<number>();
  for (const i of drop) {
    const listFrame = [...infos[i].stack].reverse().find((f) => f.kind === 'key');
    const keyLine = infos.findIndex((inf, j) => j < i && inf.stack[inf.stack.length - 1] === listFrame);
    if (keyLine === -1) continue;
    const survivors = infos.some((inf, j) => j > keyLine && !drop.has(j) && inf.entry && inf.stack.includes(listFrame!));
    if (!survivors) emptied.add(keyLine);
  }
  const out: string[] = [];
  parts.lines.forEach((line, i) => {
    if (drop.has(i)) return;
    out.push(emptied.has(i) && /:\s*$/.test(line) ? `${line.replace(/\s*$/, '')} []` : line);
  });
  return join({ ...parts, lines: out });
}

/** Appends a story to one cell, creating the `slices:` and slice keys when absent. */
export function addStoryToCellText(raw: string, target: { activity: string; step: string; slice: string }, storyId: string): string {
  const parts = splitLines(raw);
  const infos = scan(parts.lines);
  const inStep = (info: LineInfo) => {
    const c = context(info);
    return c.activity?.id === target.activity && c.step?.id === target.step;
  };
  const stepLines = infos.map((info, i) => (inStep(info) ? i : -1)).filter((i) => i >= 0);
  if (stepLines.length === 0) throw new Error(`step "${target.activity}/${target.step}" was not found in the map file`);
  const stepFrame = context(infos[stepLines[0]]).step!;
  const lastOf = (pred: (info: LineInfo) => boolean) => {
    let last = -1;
    infos.forEach((info, i) => {
      if (pred(info) && parts.lines[i].trim() !== '' && !/^\s*#/.test(parts.lines[i])) last = i;
    });
    return last;
  };

  const entries = stepLines.filter((i) => {
    const role = entryRole(infos[i]);
    return role?.role === 'primary' && role.slice === target.slice;
  });
  const lines = [...parts.lines];
  if (entries.length) {
    const lastEntry = entries[entries.length - 1];
    const sample = infos[lastEntry].entry!;
    const token = sample.token.startsWith("'") ? `'${storyId}'` : sample.token.startsWith('"') ? `"${storyId}"` : storyId;
    lines.splice(lastEntry + 1, 0, `${' '.repeat(sample.indent)}- ${token}`);
    return join({ ...parts, lines });
  }

  const keyLineOf = (name: string, parentKey?: string) =>
    stepLines.find((i) => {
      const top = infos[i].stack[infos[i].stack.length - 1];
      const keys = context(infos[i]).keys;
      return top?.kind === 'key' && top.key === name && (parentKey === undefined || keys[keys.length - 2] === parentKey) && !infos[i].entry;
    });

  const sliceKeyLine = keyLineOf(target.slice, 'slices');
  if (sliceKeyLine !== undefined) {
    const indent = infos[sliceKeyLine].stack[infos[sliceKeyLine].stack.length - 1].indent;
    lines[sliceKeyLine] = lines[sliceKeyLine].replace(/:\s*(\[\s*\])?\s*$/, ':');
    lines.splice(sliceKeyLine + 1, 0, `${' '.repeat(indent + 2)}- ${storyId}`);
    return join({ ...parts, lines });
  }

  const slicesLine = keyLineOf('slices');
  if (slicesLine !== undefined) {
    const slicesFrame = infos[slicesLine].stack[infos[slicesLine].stack.length - 1];
    const end = lastOf((info) => info.stack.includes(slicesFrame));
    lines[slicesLine] = lines[slicesLine].replace(/:\s*(\{\s*\})?\s*$/, ':');
    lines.splice(end + 1, 0, `${' '.repeat(slicesFrame.indent + 2)}${target.slice}:`, `${' '.repeat(slicesFrame.indent + 4)}- ${storyId}`);
    return join({ ...parts, lines });
  }

  const end = lastOf((info) => info.stack.includes(stepFrame));
  const keyIndent = stepFrame.indent + 2;
  lines.splice(
    end + 1,
    0,
    `${' '.repeat(keyIndent)}slices:`,
    `${' '.repeat(keyIndent + 2)}${target.slice}:`,
    `${' '.repeat(keyIndent + 4)}- ${storyId}`,
  );
  return join({ ...parts, lines });
}

/** The comparable structure of a parsed map: everything but its source path. */
export function mapShape(map: StoryMap): string {
  const { sourcePath: _ignored, ...rest } = map;
  return JSON.stringify(rest);
}

/** The structure a removal should produce, computed on the parsed model. */
export function expectRemoval(map: StoryMap, storyId: string, opts: { supporting: boolean }): StoryMap {
  const key = normalizeId(storyId);
  const keep = (ids: string[]) => ids.filter((id) => normalizeId(id) !== key);
  return {
    ...map,
    activities: map.activities.map((a) => ({
      ...a,
      steps: a.steps.map((s) => ({
        ...s,
        slices: Object.fromEntries(Object.entries(s.slices).map(([k, v]) => [k, keep(v)])),
        supporting: opts.supporting ? keep(s.supporting ?? []) : s.supporting,
      })),
    })),
  };
}

export function expectPlacement(map: StoryMap, target: { activity: string; step: string; slice: string }, storyId: string): StoryMap {
  return {
    ...map,
    activities: map.activities.map((a) =>
      a.id !== target.activity
        ? a
        : {
            ...a,
            steps: a.steps.map((s) =>
              s.id !== target.step ? s : { ...s, slices: { ...s.slices, [target.slice]: [...(s.slices[target.slice] ?? []), storyId] } },
            ),
          },
    ),
  };
}

/** Parses edited map text and confirms it has exactly the expected structure. */
export function verifyMapEdit(text: string, sourcePath: string, expected: StoryMap): string | undefined {
  const { map, issues } = parseStoryMap(text, sourcePath);
  if (!map) return `the edited map would not parse (${issues.map((i) => i.message).join('; ')})`;
  if (mapShape(map) !== mapShape(expected)) return 'this map file uses a layout StoryMap.md cannot edit line by line';
  return undefined;
}
