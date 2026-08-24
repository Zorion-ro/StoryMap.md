import type { BacklogReadResult, ReadProblem, WorkItem } from './types';

/**
 * `WorkItemId -> WorkItem`, with the id normalisation Backlog.md itself applies.
 *
 * Identity is the `id` in front matter and nothing else. Backlog.md rewrites
 * filenames when a title changes, so nothing here may key off one.
 */
export class WorkItemIndex {
  private readonly byKey = new Map<string, WorkItem>();
  readonly items: readonly WorkItem[];
  readonly duplicates: ReadProblem[] = [];

  constructor(read: BacklogReadResult) {
    const kept: WorkItem[] = [];
    for (const item of read.items) {
      const key = normalizeId(item.id);
      const existing = this.byKey.get(key);
      if (existing) {
        this.duplicates.push({
          sourcePath: item.sourcePath,
          kind: 'duplicate_id',
          detail: `${item.id} is already claimed by ${existing.sourcePath}`,
        });
        continue;
      }
      this.byKey.set(key, item);
      kept.push(item);
    }
    this.items = kept;
  }

  /** Resolves `TASK-7`, `task-7` and `TASK-007` to the same item, as Backlog.md does. */
  get(id: string): WorkItem | undefined {
    return this.byKey.get(normalizeId(id));
  }

  has(id: string): boolean {
    return this.byKey.has(normalizeId(id));
  }

  get size(): number {
    return this.byKey.size;
  }

  get active(): WorkItem[] {
    return this.items.filter((i) => !i.completed);
  }

  get completed(): WorkItem[] {
    return this.items.filter((i) => i.completed);
  }
}

/**
 * Case-insensitive, and zero-padding-insensitive on a trailing numeric segment
 * so `TASK-38` and `TASK-038` are one identity. Composite ids such as
 * `AUC-SEC-02D` have no purely numeric tail and pass through upper-cased.
 */
export function normalizeId(id: string): string {
  const trimmed = id.trim().toUpperCase();
  const m = /^(.*?)-(\d+)$/.exec(trimmed);
  if (!m) return trimmed;
  return `${m[1]}-${String(Number(m[2]))}`;
}
