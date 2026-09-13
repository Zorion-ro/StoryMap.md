import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readBacklog, readMilestones, resolveBacklogPaths } from './backlog-reader';
import type { BacklogPaths, ParseCache } from './backlog-reader';
import { readStoryMaps } from './story-map-reader';
import type { StoryMapReadResult } from './story-map-reader';
import { primaryIds, resolveStoryMap, supportingIds } from './resolver';
import { normalizeId } from './work-item-index';
import { WorkItemIndex } from './work-item-index';
import type { BacklogReadResult, Milestone, ResolvedStoryMap, StoryMap } from './types';

/**
 * Everything the tool knows, rebuilt from the filesystem in one pass.
 *
 * This is the disposable in-memory index: it holds no state that cannot be
 * reconstructed from the repository, and it is thrown away and rebuilt whenever
 * a watched file changes. There is no database.
 */
export class Workspace {
  readonly read: BacklogReadResult;
  readonly index: WorkItemIndex;
  readonly mapRead: StoryMapReadResult;
  readonly maps: StoryMap[];
  /** Milestones Backlog.md keeps beside the tasks, active first then archived. */
  readonly milestones: Milestone[];
  readonly loadedAt: Date;
  private readonly resolved = new Map<string, ResolvedStoryMap>();
  private placementsMemo?: Map<string, { mapId: string; role: 'primary' | 'supporting' }[]>;

  private constructor(
    readonly paths: BacklogPaths,
    read: BacklogReadResult,
    mapRead: StoryMapReadResult,
    milestones: Milestone[],
    loadedAt: Date,
  ) {
    this.read = read;
    this.index = new WorkItemIndex(read);
    this.mapRead = mapRead;
    this.maps = mapRead.maps;
    this.milestones = milestones;
    this.loadedAt = loadedAt;
    for (const map of this.maps) this.resolved.set(map.id, resolveStoryMap(map, this.index));
  }

  get repoRoot(): string {
    return this.paths.repoRoot;
  }

  /** Absolute path of the Backlog.md directory this workspace read. */
  get backlogDir(): string {
    return this.paths.backlogDir;
  }

  /** Absolute path of the story-map directory this workspace read. */
  get storyMapsDir(): string {
    return this.paths.storyMapsDir;
  }

  static load(
    repoRoot: string,
    backlogDirectory = DEFAULT_BACKLOG_DIRECTORY,
    now = new Date(),
    storyMapsDirectory?: string,
    completedStatuses: readonly string[] = [],
    cache?: ParseCache,
  ): Workspace {
    const paths = resolveBacklogPaths(repoRoot, backlogDirectory, storyMapsDirectory, completedStatuses);
    return new Workspace(paths, readBacklog(paths, cache), readStoryMaps(paths), readMilestones(paths), now);
  }

  /**
   * `normalizedStoryId -> the maps that place it`, in map order, primary before
   * supporting. Computed once per workspace, which is rebuilt whenever a file
   * changes, so repeated queries never rescan every map.
   */
  get placements(): Map<string, { mapId: string; role: 'primary' | 'supporting' }[]> {
    if (this.placementsMemo) return this.placementsMemo;
    const out = new Map<string, { mapId: string; role: 'primary' | 'supporting' }[]>();
    const add = (id: string, mapId: string, role: 'primary' | 'supporting') => {
      const key = normalizeId(id);
      const list = out.get(key) ?? [];
      if (!list.some((p) => p.mapId === mapId && p.role === role)) list.push({ mapId, role });
      out.set(key, list);
    };
    for (const map of this.maps) {
      for (const id of primaryIds(map)) add(id, map.id, 'primary');
    }
    for (const map of this.maps) {
      for (const id of supportingIds(map)) add(id, map.id, 'supporting');
    }
    this.placementsMemo = out;
    return out;
  }

  /** Milestone title for an id, or the id itself when nothing declares it. */
  milestoneTitle(id: string | undefined): string | undefined {
    if (!id) return undefined;
    return this.milestones.find((m) => m.id === id)?.title ?? id;
  }

  resolve(mapId: string): ResolvedStoryMap | undefined {
    return this.resolved.get(mapId);
  }

  get resolvedMaps(): ResolvedStoryMap[] {
    return this.maps.map((m) => this.resolved.get(m.id)!).filter(Boolean);
  }
}

/**
 * Backlog.md's own default folder name. A project that keeps its work items
 * somewhere else says so in `backlog.config.yml` or `storymap.config.yml`;
 * nothing in this package assumes a particular repository layout.
 */
export const DEFAULT_BACKLOG_DIRECTORY = 'backlog';

/**
 * A cheap fingerprint of every file the workspace reads: path, size and mtime.
 * Comparing two fingerprints tells us whether a reload is needed without
 * holding file contents in memory or depending on a watcher being reliable.
 */
export function fingerprint(
  repoRoot: string,
  backlogDirectory = DEFAULT_BACKLOG_DIRECTORY,
  storyMapsDirectory?: string,
): string {
  const paths = resolveBacklogPaths(repoRoot, backlogDirectory, storyMapsDirectory);
  const parts: string[] = [];
  const watched: [string, string][] = [
    ['tasks', join(paths.backlogDir, 'tasks')],
    ['completed', join(paths.backlogDir, 'completed')],
    ['milestones', join(paths.backlogDir, 'milestones')],
    ['archive/milestones', join(paths.backlogDir, 'archive', 'milestones')],
    ['story-maps', paths.storyMapsDir],
  ];
  for (const [label, dir] of watched) {
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      parts.push(`${label}:absent`);
      continue;
    }
    for (const name of entries) {
      if (!/\.(md|ya?ml)$/.test(name)) continue;
      try {
        const s = statSync(join(dir, name));
        parts.push(`${label}/${name}:${s.size}:${Math.floor(s.mtimeMs)}`);
      } catch {
        /* raced with a concurrent lane deleting or renaming; the next poll settles it */
      }
    }
  }
  return parts.join('|');
}

/**
 * Holds a Workspace and reloads it when the fingerprint changes.
 *
 * Polling rather than fs.watch: a repository may have several people or agents
 * writing concurrently, and fs.watch on Linux misses renames of the kind
 * `backlog task complete` performs. A stat sweep over a few hundred files costs
 * under a millisecond.
 */
export class WorkspaceHost {
  private current: Workspace;
  private stamp: string;
  private version = 0;
  private readonly cache: ParseCache = new Map();

  constructor(
    readonly repoRoot: string,
    readonly backlogDirectory = DEFAULT_BACKLOG_DIRECTORY,
    readonly storyMapsDirectory?: string,
    readonly completedStatuses: readonly string[] = [],
  ) {
    this.current = Workspace.load(repoRoot, backlogDirectory, new Date(), storyMapsDirectory, completedStatuses, this.cache);
    this.stamp = fingerprint(repoRoot, backlogDirectory, storyMapsDirectory);
  }

  /** Returns the workspace, reloading first if anything on disk changed. */
  get(): Workspace {
    const next = fingerprint(this.repoRoot, this.backlogDirectory, this.storyMapsDirectory);
    if (next !== this.stamp) {
      this.current = Workspace.load(
        this.repoRoot,
        this.backlogDirectory,
        new Date(),
        this.storyMapsDirectory,
        this.completedStatuses,
        this.cache,
      );
      this.stamp = next;
      this.version += 1;
    }
    return this.current;
  }

  /**
   * Forces the next `get()` to reload. A writer calls this after changing a
   * file, so its own edit is visible at once even when the change kept the
   * file's size and landed inside the same millisecond as the previous one.
   */
  invalidate(): void {
    this.stamp = '';
  }

  /**
   * Reloads now, whatever the fingerprint says. Called after this process writes:
   * a rewrite of the same size inside the same millisecond would otherwise look
   * unchanged.
   */
  refresh(): Workspace {
    this.current = Workspace.load(
      this.repoRoot,
      this.backlogDirectory,
      new Date(),
      this.storyMapsDirectory,
      this.completedStatuses,
      this.cache,
    );
    this.stamp = fingerprint(this.repoRoot, this.backlogDirectory, this.storyMapsDirectory);
    this.version += 1;
    return this.current;
  }

  /** Increments whenever a reload happened; the UI polls this to auto-refresh. */
  get revision(): number {
    return this.version;
  }
}
