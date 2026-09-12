import { readFileSync } from 'node:fs';
import { ApiError, ERROR_CODES, FIELD_NAMES, FILTER_PARAMS, STORY_FIELDS, StoryService, buildOpenApi } from '../api';
import { ConfigError } from '../project/config';
import { UsageError, resolveProject } from '../cli';
import type { Args } from '../cli';

/**
 * `storymap list | get | create | update | bulk-update | meta | openapi`.
 *
 * The same StoryService the HTTP API calls, reached without a server. Every
 * command builds the request an HTTP client would send — query parameters or a
 * JSON body — so the rules, the results and the error codes are identical.
 *
 * With `--json`, stdout carries exactly one JSON document, success or failure,
 * and nothing else; anything meant for a person goes to stderr.
 */

export const API_COMMANDS = ['list', 'get', 'create', 'update', 'bulk-update', 'meta', 'openapi'] as const;

const kebab = (name: string) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** Scalar story fields settable from a flag of the same (kebab-case) name. */
const SETTERS = FIELD_NAMES.filter((n) => STORY_FIELDS[n].writable && STORY_FIELDS[n].type === 'string');

/** Filter flags: `--status Backlog,Ready`, `--status-not Done`. */
const FILTER_FLAGS = Object.keys(FILTER_PARAMS).flatMap((p) => [kebab(p), `${kebab(p)}-not`]);

/** Every option an API command reads a value from; the argument parser needs the list. */
export const API_VALUE_FLAGS = unique([
  ...FILTER_FLAGS,
  ...SETTERS.map(kebab),
  'text',
  'limit',
  'cursor',
  'sort',
  'order',
  'fields',
  'body-file',
  'data',
  'clear',
  'labels',
  'add-label',
  'remove-label',
  'add-dependency',
  'remove-dependency',
  'expected-revision',
]);

const COMMON = ['project', 'json', 'debug', 'help'];
const WRITE_BOOLEANS = ['dry-run', 'allow-new-values'];

const ALLOWED: Record<(typeof API_COMMANDS)[number], string[]> = {
  list: [...COMMON, ...FILTER_FLAGS, 'text', 'limit', 'cursor', 'sort', 'order', 'fields', 'all'],
  get: COMMON,
  meta: COMMON,
  openapi: COMMON,
  create: [...COMMON, ...WRITE_BOOLEANS, ...SETTERS.map(kebab), 'body-file', 'data', 'label', 'dependency'],
  update: [
    ...COMMON,
    ...WRITE_BOOLEANS,
    ...SETTERS.map(kebab),
    'body-file',
    'data',
    'clear',
    'labels',
    'add-label',
    'remove-label',
    'add-dependency',
    'remove-dependency',
    'expected-revision',
  ],
  'bulk-update': [
    ...COMMON,
    ...WRITE_BOOLEANS,
    ...SETTERS.map(kebab),
    'data',
    'clear',
    'labels',
    'add-label',
    'remove-label',
    'add-dependency',
    'remove-dependency',
  ],
};

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function all(args: Args, name: string): string[] {
  const values = args.lists?.get(name) ?? [];
  return values
    .flatMap((v) => {
      if (typeof v !== 'string') throw new UsageError(`--${name} needs a value`);
      return v.split(',');
    })
    .map((v) => v.trim())
    .filter(Boolean);
}

function one(args: Args, name: string): string | undefined {
  const value = args.flags.get(name);
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new UsageError(`--${name} needs a value`);
  return value;
}

function readInput(source: string): string {
  return source === '-' ? readFileSync(0, 'utf8') : readFileSync(source, 'utf8');
}

/** `--data '{"a":1}'`, `--data @file.json` or `--data -` (stdin). */
function data(args: Args): Record<string, unknown> | undefined {
  const raw = one(args, 'data');
  if (raw === undefined) return undefined;
  const text = raw === '-' ? readInput('-') : raw.startsWith('@') ? readInput(raw.slice(1)) : raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ApiError({ code: 'MALFORMED_REQUEST', message: `--data is not valid JSON: ${(error as Error).message}` });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ApiError({ code: 'MALFORMED_REQUEST', message: '--data must be a JSON object' });
  }
  return parsed as Record<string, unknown>;
}

/** The field changes the flags describe, exactly as a JSON body would carry them. */
function changesFromFlags(args: Args, mode: 'create' | 'update'): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of SETTERS) {
    const value = one(args, kebab(field));
    if (value !== undefined) out[field] = value;
  }
  const bodyFile = one(args, 'body-file');
  if (bodyFile !== undefined) {
    if (out.body !== undefined) throw new UsageError('give --body or --body-file, not both');
    out.body = readInput(bodyFile);
  }
  if (mode === 'create') {
    const labels = all(args, 'label');
    if (labels.length) out.labels = labels;
    const deps = all(args, 'dependency');
    if (deps.length) out.dependencies = deps;
    return out;
  }
  for (const field of all(args, 'clear')) {
    if (field in out) throw new UsageError(`--clear ${field} contradicts --${kebab(field)}`);
    out[field] = null;
  }
  const setOps = (field: 'labels' | 'dependencies', replace: string[] | undefined, add: string[], remove: string[]) => {
    if (replace && (add.length || remove.length)) throw new UsageError(`give --${field} or the add/remove options, not both`);
    if (replace) out[field] = replace;
    else if (add.length || remove.length) out[field] = { ...(add.length ? { add } : {}), ...(remove.length ? { remove } : {}) };
  };
  setOps('labels', args.flags.has('labels') ? all(args, 'labels') : undefined, all(args, 'add-label'), all(args, 'remove-label'));
  setOps('dependencies', undefined, all(args, 'add-dependency'), all(args, 'remove-dependency'));
  return out;
}

/** Body = `--data`, or the flags; mixing them is refused rather than merged by guesswork. */
function requestBody(args: Args, flags: Record<string, unknown>): Record<string, unknown> {
  const given = data(args);
  if (given && Object.keys(flags).length > 0) throw new UsageError('give the request as --data or as field options, not both');
  const body = given ?? flags;
  if (args.flags.get('allow-new-values') === true) body.allowNewValues = true;
  return body;
}

/** CLI exit codes, from the HTTP status of the error. */
export function exitCodeFor(status: number): number {
  if (status === 400) return 2;
  if (status === 404) return 3;
  if (status === 422) return 4;
  if (status === 409) return 5;
  return 1;
}

export async function runApiCommand(args: Args, cwd: string): Promise<number> {
  const command = args.command as (typeof API_COMMANDS)[number];
  const json = args.flags.get('json') === true;
  const out = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  const fail = (code: string, message: string, status: number, body: unknown) => {
    if (json) out(body);
    process.stderr.write(`storymap ${command}: ${code}: ${message}\n`);
    return exitCodeFor(status);
  };

  try {
    const unknown = [...args.flags.keys()].filter((k) => !ALLOWED[command].includes(k));
    if (unknown.length > 0) throw new UsageError(`storymap ${command} does not take --${unknown.join(', --')}`);

    const positional = args.positional;
    const expectIds = (min: number, max: number) => {
      if (positional.length < min || positional.length > max) {
        throw new UsageError(
          min === max ? `storymap ${command} takes ${min === 1 ? 'one story id' : 'no arguments'}` : `storymap ${command} takes one or more story ids`,
        );
      }
    };

    const service = new StoryService(resolveProject(args, cwd));
    const dryRun = args.flags.get('dry-run') === true;

    switch (command) {
      case 'meta':
        expectIds(0, 0);
        out(service.meta());
        return 0;
      case 'openapi':
        expectIds(0, 0);
        out(buildOpenApi(service));
        return 0;
      case 'get':
        expectIds(1, 1);
        out(service.get(positional[0]));
        return 0;
      case 'list': {
        expectIds(0, 0);
        const params: Record<string, unknown> = {};
        for (const [param] of Object.entries(FILTER_PARAMS)) {
          for (const [flag, key] of [[kebab(param), param], [`${kebab(param)}-not`, `${param}_not`]]) {
            const values = all(args, flag);
            if (values.length) params[key] = values.join(',');
          }
        }
        for (const name of ['text', 'limit', 'cursor', 'sort', 'order', 'fields']) {
          const value = one(args, name);
          if (value !== undefined) params[name] = value;
        }
        let page = service.list(params) as { items: unknown[]; nextCursor: string | null; count: number };
        if (args.flags.get('all') === true) {
          const items = [...page.items];
          while (page.nextCursor) {
            page = service.list({ ...params, cursor: page.nextCursor }) as typeof page;
            items.push(...page.items);
          }
          page = { ...page, items, count: items.length, nextCursor: null };
        }
        if (json) out(page);
        else {
          for (const item of page.items as { id: string; status?: string; title?: string }[]) {
            process.stdout.write(`${item.id}\t${item.status ?? ''}\t${item.title ?? ''}\n`);
          }
          process.stderr.write(`${page.count} shown of ${(page as unknown as { total: number }).total}${page.nextCursor ? ` — next: --cursor ${page.nextCursor}` : ''}\n`);
        }
        return 0;
      }
      case 'create': {
        expectIds(0, 0);
        out(service.create(requestBody(args, changesFromFlags(args, 'create')), { dryRun }));
        return 0;
      }
      case 'update': {
        expectIds(1, 1);
        const body = requestBody(args, changesFromFlags(args, 'update'));
        const expected = one(args, 'expected-revision');
        if (expected !== undefined) body.expectedRevision = expected;
        out(service.patch(positional[0], body, { dryRun }));
        return 0;
      }
      case 'bulk-update': {
        if (positional.length === 0 && !args.flags.has('data')) expectIds(1, Infinity);
        const given = data(args);
        const flags = changesFromFlags(args, 'update');
        let body: Record<string, unknown>;
        if (given) {
          if (Object.keys(flags).length > 0) throw new UsageError('give the request as --data or as field options, not both');
          body = { ...given, ...(positional.length ? { ids: positional } : {}) };
        } else {
          body = { ids: positional, changes: flags };
        }
        if (args.flags.get('allow-new-values') === true) body.allowNewValues = true;
        out(service.bulkUpdate(body, { dryRun }));
        return 0;
      }
    }
  } catch (error) {
    if (error instanceof ApiError) return fail(error.code, error.message, error.status, error.toJSON());
    if (error instanceof UsageError) {
      return fail('USAGE_ERROR', error.message, 400, { error: { code: 'USAGE_ERROR', message: error.message } });
    }
    if (error instanceof ConfigError) {
      const message = error.where ? `${error.where}: ${error.message}` : error.message;
      return fail('CONFIG_ERROR', message, 500, { error: { code: 'CONFIG_ERROR', message } });
    }
    if (args.flags.get('debug') === true) process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
    const message = (error as Error).message ?? String(error);
    return fail('INTERNAL_ERROR', message, ERROR_CODES.INTERNAL_ERROR.status, { error: { code: 'INTERNAL_ERROR', message } });
  }
  return 1;
}
