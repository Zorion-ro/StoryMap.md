#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { discoverProject, projectAtExplicitRoot } from './project/discover';
import { ConfigError, loadProject } from './project/config';
import type { Project } from './project/config';
import { runInit } from './commands/init';
import { runBrowser } from './commands/browser';
import { runValidate } from './commands/validate';
import { runDoctor } from './commands/doctor';
import { API_VALUE_FLAGS, runApiCommand } from './commands/api';

/**
 * The `storymap` executable.
 *
 * Every command works on a *project* discovered from the working directory;
 * the package's own files are found relative to this module. Keeping those two
 * apart is what lets a globally installed copy browse any repository.
 */

export const VERSION: string = (() => {
  try {
    return String(JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')).version ?? '0.0.0');
  } catch {
    return '0.0.0';
  }
})();

const USAGE = `StoryMap.md — user story maps from the Markdown already in your repository

  storymap <command> [options]

Commands
  init        write storymap.config.yml for this project
  browser     start the local story-map browser
  validate    check work items and story maps; exits non-zero on errors
  doctor      diagnose this project and this environment

Story commands (the machine API, without a server; see docs/storymap-api.md)
  meta                     fields, valid values, limits and error codes
  list                     filter, sort and page stories
  get <id>                 one story
  create                   create a story; the id is allocated
  update <id>              change some fields of one story
  bulk-update <id>...      change the same fields on many stories, all or nothing
  openapi                  the OpenAPI document

Options
  --project <dir>   act on this directory instead of searching upward
  -h, --help        show this help
  -v, --version     show the version
  --debug           print stack traces instead of short messages

Browser options
  --port <number>   listen on this port (default 6480, or browser.port in config)
  --host <address>  bind address (default 127.0.0.1; local-only by design)
  --no-open         do not open a web browser
  --read-only       refuse every mutation through the JSON API
  --api-token <t>   require Authorization: Bearer <t> on the JSON API
                    (or set STORYMAP_API_TOKEN); needed to write beyond loopback

Story command options
  --json                    print exactly one JSON document on stdout
  --status Backlog,Ready    include (any filterable field: --owner, --wtype, --map ...)
  --status-not Done         exclude; "none" means no value
  --text <s>  --sort <field>  --order asc|desc  --limit <n>  --cursor <c>  --all
  --<field> <value>         set a field (--status, --owner, --priority, --milestone ...)
  --clear <field>           set a nullable field to null
  --add-label / --remove-label / --labels a,b
  --add-dependency / --remove-dependency
  --body-file <path|->      read the body from a file or stdin
  --data <json|@file|->     send the exact JSON request body instead of field options
  --expected-revision <r>   refuse to overwrite a newer edit (exit 5)
  --dry-run                 validate and report; write nothing
  --allow-new-values        accept a value not yet used for an open field

Exit codes
  0 success · 1 unexpected · 2 usage or malformed request · 3 not found
  4 validation failed · 5 revision conflict

Init options
  --force              overwrite an existing storymap.config.yml
  --backlog-dir <dir>  folder of work items, when there is no backlog.config.yml
  --maps-dir <dir>     story-map directory, relative to the project root

Files
  backlog.config.yml    where Backlog.md keeps its work items
  storymap.config.yml   what StoryMap.md adds on top
`;

export interface Args {
  command?: string;
  /** Last value of each option. */
  flags: Map<string, string | boolean>;
  /** Every value of each option, for options that may repeat. */
  lists?: Map<string, (string | boolean)[]>;
  positional: string[];
}

/** A tiny long-option parser: `--flag`, `--no-flag`, `--key value`, `--key=value`. */
export function parseArgs(argv: readonly string[]): Args {
  const flags = new Map<string, string | boolean>();
  const lists = new Map<string, (string | boolean)[]>();
  const positional: string[] = [];
  const takesValue = new Set(['project', 'port', 'host', 'maps-dir', 'backlog-dir', 'api-token', ...API_VALUE_FLAGS]);
  const set = (name: string, value: string | boolean) => {
    flags.set(name, value);
    lists.set(name, [...(lists.get(name) ?? []), value]);
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '-h') {
      set('help', true);
      continue;
    }
    if (token === '-v') {
      set('version', true);
      continue;
    }
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const body = token.slice(2);
    const eq = body.indexOf('=');
    if (eq !== -1) {
      set(body.slice(0, eq), body.slice(eq + 1));
      continue;
    }
    if (body.startsWith('no-')) {
      set(body.slice(3), false);
      continue;
    }
    if (takesValue.has(body)) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new UsageError(`--${body} needs a value`);
      }
      set(body, next);
      i += 1;
      continue;
    }
    set(body, true);
  }
  return { command: positional[0], flags, lists, positional: positional.slice(1) };
}

export class UsageError extends Error {}

function flagString(args: Args, name: string): string | undefined {
  const value = args.flags.get(name);
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new UsageError(`--${name} needs a value`);
  return value;
}

/**
 * Finds the project for a command, or explains what to do instead.
 *
 * `--project` skips the upward search entirely, which is what automation wants.
 */
export function resolveProject(args: Args, cwd: string): Project {
  const explicit = flagString(args, 'project');
  if (explicit) return loadProject(projectAtExplicitRoot(explicit));

  const found = discoverProject(cwd);
  if (!found) {
    throw new ConfigError(
      [
        'StoryMap.md could not find storymap.config.yml or backlog.config.yml,',
        'and this directory is not inside a Git repository.',
        '',
        'Run:',
        '  storymap init',
        '',
        'from your project, or point at it with --project <dir>.',
      ].join('\n'),
    );
  }
  return loadProject(found);
}

export async function main(argv: readonly string[], cwd = process.cwd()): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\nTry: storymap --help\n`);
    return 2;
  }

  if (args.flags.get('version') === true) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (args.command === undefined || args.flags.get('help') === true || args.command === 'help') {
    process.stdout.write(USAGE);
    return args.command === undefined && args.flags.get('help') !== true ? 0 : 0;
  }

  const debug = args.flags.get('debug') === true;
  try {
    switch (args.command) {
      case 'init':
        return await runInit(args, cwd);
      case 'browser':
        return await runBrowser(args, cwd);
      case 'validate':
        return await runValidate(args, cwd);
      case 'doctor':
        return await runDoctor(args, cwd);
      case 'list':
      case 'get':
      case 'create':
      case 'update':
      case 'bulk-update':
      case 'meta':
      case 'openapi':
        return await runApiCommand(args, cwd);
      default:
        process.stderr.write(`unknown command "${args.command}"\n\n${USAGE}`);
        return 2;
    }
  } catch (error) {
    if (debug) {
      process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
      return 1;
    }
    if (error instanceof ConfigError) {
      process.stderr.write(error.where ? `${error.where}\n  ${error.message}\n` : `${error.message}\n`);
      return 1;
    }
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n\nTry: storymap --help\n`);
      return 2;
    }
    process.stderr.write(`${(error as Error).message}\n\nRun again with --debug for the stack trace.\n`);
    return 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => {
      if (code !== 0) process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
