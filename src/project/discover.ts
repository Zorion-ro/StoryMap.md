import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const STORYMAP_CONFIG_FILE = 'storymap.config.yml';
export const BACKLOG_CONFIG_FILE = 'backlog.config.yml';

export type DiscoveredVia = 'explicit' | 'storymap-config' | 'backlog-config' | 'git';

export interface Discovery {
  /** Absolute path of the directory treated as the project root. */
  root: string;
  /** Which marker decided the root. */
  via: DiscoveredVia;
  storymapConfigPath?: string;
  backlogConfigPath?: string;
  /** Nearest enclosing Git repository, when there is one. */
  gitRoot?: string;
}

interface Level {
  dir: string;
  storymap: boolean;
  backlog: boolean;
  git: boolean;
}

/** Every directory from `startDir` up to the filesystem root, nearest first. */
function levels(startDir: string): Level[] {
  const out: Level[] = [];
  let dir = resolve(startDir);
  for (;;) {
    out.push({
      dir,
      storymap: existsSync(join(dir, STORYMAP_CONFIG_FILE)),
      backlog: existsSync(join(dir, BACKLOG_CONFIG_FILE)),
      // `.git` is a directory in a normal clone and a file inside a worktree.
      git: existsSync(join(dir, '.git')),
    });
    const parent = dirname(dir);
    if (parent === dir) return out;
    dir = parent;
  }
}

/**
 * Finds the project a command should act on, by walking upward from `startDir`.
 *
 * The rules, in order:
 *
 *   1. the nearest enclosing Git repository is the ceiling — a config file
 *      above it (a stray one in `$HOME`, say) is never adopted;
 *   2. within that ceiling, the nearest `storymap.config.yml` wins;
 *   3. otherwise the nearest `backlog.config.yml` wins;
 *   4. otherwise the Git root itself is the project;
 *   5. otherwise there is no project, and the caller must say so.
 *
 * A config always beats a Git root, so starting deep inside a monorepo whose
 * sub-directory carries its own config selects that sub-project rather than the
 * repository around it.
 */
export function discoverProject(startDir: string): Discovery | undefined {
  const chain = levels(startDir);
  const gitIndex = chain.findIndex((l) => l.git);
  const ceiling = gitIndex === -1 ? chain.length : gitIndex + 1;
  const inside = chain.slice(0, ceiling);

  const storymap = inside.find((l) => l.storymap);
  const backlog = inside.find((l) => l.backlog);
  const gitRoot = gitIndex === -1 ? undefined : chain[gitIndex].dir;

  const withPaths = (root: string, via: DiscoveredVia): Discovery => ({
    root,
    via,
    ...(existsSync(join(root, STORYMAP_CONFIG_FILE)) ? { storymapConfigPath: join(root, STORYMAP_CONFIG_FILE) } : {}),
    ...(existsSync(join(root, BACKLOG_CONFIG_FILE)) ? { backlogConfigPath: join(root, BACKLOG_CONFIG_FILE) } : {}),
    ...(gitRoot ? { gitRoot } : {}),
  });

  if (storymap) return withPaths(storymap.dir, 'storymap-config');
  if (backlog) return withPaths(backlog.dir, 'backlog-config');
  if (gitRoot) return withPaths(gitRoot, 'git');
  return undefined;
}

/** The project at an explicitly named directory, with no upward search. */
export function projectAtExplicitRoot(dir: string): Discovery {
  const root = resolve(dir);
  const chain = levels(root);
  const gitIndex = chain.findIndex((l) => l.git);
  return {
    root,
    via: 'explicit',
    ...(existsSync(join(root, STORYMAP_CONFIG_FILE)) ? { storymapConfigPath: join(root, STORYMAP_CONFIG_FILE) } : {}),
    ...(existsSync(join(root, BACKLOG_CONFIG_FILE)) ? { backlogConfigPath: join(root, BACKLOG_CONFIG_FILE) } : {}),
    ...(gitIndex === -1 ? {} : { gitRoot: chain[gitIndex].dir }),
  };
}
