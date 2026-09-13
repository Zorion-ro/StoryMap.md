import { readFileSync, statSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

/**
 * What a project's `backlog.config.yml` declares about its work items.
 *
 * Every entry is optional: a Markdown backlog without Backlog.md's config still
 * works, and the writer falls back to Backlog.md's own defaults or to what the
 * existing work items already use.
 */
export interface BacklogConventions {
  /** Declared workflow statuses in board order. Empty when none are declared. */
  statuses: string[];
  defaultStatus?: string;
  /** Declared `type` values. Empty when none are declared. */
  types: string[];
  /** Id prefix for new work items, e.g. `FW`. */
  taskPrefix?: string;
  /** Minimum digits of the numeric id tail, e.g. 3 for `FW-007`. */
  zeroPaddedIds?: number;
  /** Lines Backlog.md copies into a new work item's Definition of Done block. */
  definitionOfDone: string[];
}

export { BACKLOG_MD_DEFAULT_STATUSES } from './workflow';

/** Backlog.md's native priority scale. */
export const BACKLOG_MD_PRIORITIES = ['high', 'medium', 'low'];

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter(Boolean);
}

export function parseBacklogConventions(doc: Record<string, unknown>): BacklogConventions {
  const prefix = typeof doc.task_prefix === 'string' && doc.task_prefix.trim() ? doc.task_prefix.trim() : undefined;
  const padding = doc.zero_padded_ids;
  return {
    statuses: strings(doc.statuses),
    ...(typeof doc.default_status === 'string' && doc.default_status.trim()
      ? { defaultStatus: doc.default_status.trim() }
      : {}),
    types: strings(doc.types),
    ...(prefix ? { taskPrefix: prefix } : {}),
    ...(typeof padding === 'number' && Number.isInteger(padding) && padding > 0 ? { zeroPaddedIds: padding } : {}),
    definitionOfDone: strings(doc.definition_of_done),
  };
}

const EMPTY: BacklogConventions = { statuses: [], types: [], definitionOfDone: [] };

/**
 * Reads the conventions, re-reading only when the file changed. A missing or
 * unreadable config yields no conventions rather than an error: `doctor` is
 * the command that complains about config files.
 */
export class ConventionsReader {
  private stamp = '';
  private value: BacklogConventions = EMPTY;

  constructor(readonly configPath?: string) {}

  get(): BacklogConventions {
    if (!this.configPath) return EMPTY;
    let stamp: string;
    try {
      const s = statSync(this.configPath);
      stamp = `${s.size}:${s.mtimeMs}`;
    } catch {
      this.stamp = '';
      this.value = EMPTY;
      return EMPTY;
    }
    if (stamp === this.stamp) return this.value;
    try {
      const doc = parseYaml(readFileSync(this.configPath, 'utf8'));
      this.value = doc && typeof doc === 'object' && !Array.isArray(doc) ? parseBacklogConventions(doc as Record<string, unknown>) : EMPTY;
    } catch {
      this.value = EMPTY;
    }
    this.stamp = stamp;
    return this.value;
  }
}
