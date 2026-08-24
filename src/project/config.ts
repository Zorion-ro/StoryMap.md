import { existsSync, readFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { DEFAULT_BACKLOG_DIRECTORY } from '../core';
import { BACKLOG_CONFIG_FILE, STORYMAP_CONFIG_FILE } from './discover';
import type { Discovery } from './discover';

/** The one schema version this release reads and writes. */
export const CONFIG_SCHEMA_VERSION = 1;

/** Where a project's browser listens unless it says otherwise. */
export const DEFAULT_PORT = 6480;

/** A project resolved from its config files. All paths are project-relative. */
export interface Project {
  /** Absolute path of the project root. */
  root: string;
  /** Project-relative Backlog.md directory, e.g. `backlog`. */
  backlogDirectory: string;
  /** Project-relative story-map directory. */
  storyMapsDirectory: string;
  /** Name shown in the browser header. */
  projectName: string;
  port: number;
  storymapConfigPath?: string;
  backlogConfigPath?: string;
  /** Nearest enclosing Git repository, when the project is inside one. */
  gitRoot?: string;
  discoveredVia: Discovery['via'];
}

/** A problem a user can act on; the CLI prints the message and no stack. */
export class ConfigError extends Error {
  constructor(
    message: string,
    readonly where?: string,
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

function readYamlFile(path: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    throw new ConfigError(`could not be read: ${(error as Error).message}`, path);
  }
  let doc: unknown;
  try {
    doc = parseYaml(raw);
  } catch (error) {
    throw new ConfigError(`is not valid YAML: ${(error as Error).message}`, path);
  }
  if (doc === null || doc === undefined) return {};
  if (typeof doc !== 'object' || Array.isArray(doc)) {
    throw new ConfigError('does not contain a YAML mapping', path);
  }
  return doc as Record<string, unknown>;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function section(doc: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = doc[key];
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * Keeps a configured directory inside the project.
 *
 * A config is repository data, so a value such as `../../etc` must not turn
 * into a reader of somebody else's files. Absolute paths and any path that
 * escapes the root are refused by name rather than silently clamped.
 */
export function containedDirectory(root: string, value: string, field: string, where?: string): string {
  if (isAbsolute(value)) {
    throw new ConfigError(`\`${field}\` must be a path inside the project, not an absolute path (${value})`, where);
  }
  const abs = resolve(root, value);
  const rel = relative(root, abs);
  if (rel === '' || rel.startsWith('..') || rel.split(sep).includes('..')) {
    throw new ConfigError(`\`${field}\` must stay inside the project; "${value}" points outside it`, where);
  }
  return rel.split(sep).join('/');
}

/** The Backlog.md directory a `backlog.config.yml` declares, if it declares one. */
export function backlogDirectoryFrom(doc: Record<string, unknown>): string | undefined {
  return str(doc.backlog_directory) ?? str(doc.backlogDirectory);
}

/**
 * Resolves a discovered project into the settings every command needs.
 *
 * `storymap.config.yml` is authoritative where it speaks. Everything it leaves
 * out is inferred: the backlog directory from `backlog.config.yml`, the
 * story-map directory from the backlog directory, the project name from
 * `backlog.config.yml` or the folder name.
 */
export function loadProject(discovery: Discovery): Project {
  const root = resolve(discovery.root);

  let backlogDoc: Record<string, unknown> = {};
  if (discovery.backlogConfigPath && existsSync(discovery.backlogConfigPath)) {
    backlogDoc = readYamlFile(discovery.backlogConfigPath);
  }

  let storymapDoc: Record<string, unknown> = {};
  if (discovery.storymapConfigPath && existsSync(discovery.storymapConfigPath)) {
    storymapDoc = readYamlFile(discovery.storymapConfigPath);
    const version = storymapDoc.schemaVersion;
    if (version === undefined) {
      throw new ConfigError('is missing `schemaVersion`', discovery.storymapConfigPath);
    }
    if (typeof version !== 'number' || version !== CONFIG_SCHEMA_VERSION) {
      throw new ConfigError(
        `declares schemaVersion ${JSON.stringify(version)}; this release reads ${CONFIG_SCHEMA_VERSION}`,
        discovery.storymapConfigPath,
      );
    }
  }

  const where = discovery.storymapConfigPath;
  const backlogSection = section(storymapDoc, 'backlog');
  const mapsSection = section(storymapDoc, 'storyMaps');
  const browserSection = section(storymapDoc, 'browser');

  const declaredBacklog = str(backlogSection.directory) ?? backlogDirectoryFrom(backlogDoc) ?? DEFAULT_BACKLOG_DIRECTORY;
  const backlogDirectory = containedDirectory(root, declaredBacklog, 'backlog.directory', where);

  const declaredMaps = str(mapsSection.directory) ?? `${backlogDirectory}/story-maps`;
  const storyMapsDirectory = containedDirectory(root, declaredMaps, 'storyMaps.directory', where);

  const rawPort = browserSection.port;
  if (rawPort !== undefined && (typeof rawPort !== 'number' || !Number.isInteger(rawPort) || rawPort < 1 || rawPort > 65535)) {
    throw new ConfigError(`\`browser.port\` must be an integer between 1 and 65535, got ${JSON.stringify(rawPort)}`, where);
  }

  return {
    root,
    backlogDirectory,
    storyMapsDirectory,
    projectName: str(storymapDoc.projectName) ?? str(backlogDoc.project_name) ?? basename(root),
    port: typeof rawPort === 'number' ? rawPort : DEFAULT_PORT,
    ...(discovery.storymapConfigPath ? { storymapConfigPath: discovery.storymapConfigPath } : {}),
    ...(discovery.backlogConfigPath ? { backlogConfigPath: discovery.backlogConfigPath } : {}),
    ...(discovery.gitRoot ? { gitRoot: discovery.gitRoot } : {}),
    discoveredVia: discovery.via,
  };
}

/**
 * A project rooted at a directory, reading whatever config files are there.
 * Convenience for tests and for callers that already know the root.
 */
export function projectAt(root: string, overrides: Partial<Project> = {}): Project {
  const abs = resolve(root);
  const base = loadProject({
    root: abs,
    via: 'explicit',
    ...(existsSync(join(abs, STORYMAP_CONFIG_FILE)) ? { storymapConfigPath: join(abs, STORYMAP_CONFIG_FILE) } : {}),
    ...(existsSync(join(abs, BACKLOG_CONFIG_FILE)) ? { backlogConfigPath: join(abs, BACKLOG_CONFIG_FILE) } : {}),
  });
  return { ...base, ...overrides };
}

/**
 * The `storymap.config.yml` `init` writes.
 *
 * Deliberately small: anything the tool can infer reliably is left out, so the
 * file records decisions rather than restating conventions.
 */
export function renderConfig(project: Pick<Project, 'backlogDirectory' | 'storyMapsDirectory'>, opts: { includeBacklogDirectory: boolean }): string {
  const lines = [`schemaVersion: ${CONFIG_SCHEMA_VERSION}`, ''];
  if (opts.includeBacklogDirectory) {
    lines.push('backlog:', `  directory: ${project.backlogDirectory}`, '');
  }
  lines.push('storyMaps:', `  directory: ${project.storyMapsDirectory}`, '');
  return lines.join('\n');
}
