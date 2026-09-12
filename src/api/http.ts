import { createHash, timingSafeEqual } from 'node:crypto';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { ApiError, apiError } from './errors';
import { buildOpenApi } from './openapi';
import { StoryService } from './story-service';

/**
 * `/api/v1/storymap` over HTTP. Handlers only translate: parameters in, one
 * StoryService call, JSON out. Every rule lives in the service.
 */

export const API_BASE = '/api/v1/storymap';

export interface ApiAccess {
  /** The address the server is bound to; decides what "local" means. */
  bindHost?: string;
  /** When set, every request except discovery must send `Authorization: Bearer <token>`. */
  token?: string;
  /** Refuse every mutation. */
  readOnly?: boolean;
}

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function isLoopbackHost(host: string | undefined): boolean {
  return host === undefined || LOOPBACK_NAMES.has(host) || /^127\./.test(host);
}

function hostname(hostHeader: string | undefined): string | undefined {
  if (!hostHeader) return undefined;
  const m = /^(\[[^\]]+\]|[^:]+)(?::\d+)?$/.exec(hostHeader.trim().toLowerCase());
  return m?.[1];
}

function tokenMatches(sent: string, expected: string): boolean {
  const a = createHash('sha256').update(sent).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * The API's authorization, which is the browser's: the same local process
 * serves both. With no token the API answers only requests addressed to a
 * loopback name (which also defeats DNS rebinding) and refuses cross-origin
 * browser requests, so a web page the user happens to visit cannot drive it.
 * A token turns that into bearer authentication for use beyond loopback.
 */
function guard(access: ApiAccess) {
  // Discovery and the schema are safe to hand out; they reveal no story data.
  const open = new Set(['/', '/openapi.json']);
  return (req: Request, _res: Response, next: NextFunction) => {
    const name = hostname(req.headers.host);
    const origin = req.headers.origin;
    if (origin !== undefined) {
      let originHost: string | undefined;
      try {
        originHost = new URL(origin).host.toLowerCase();
      } catch {
        originHost = undefined;
      }
      if (originHost !== req.headers.host?.toLowerCase()) {
        return next(apiError('FORBIDDEN', 'cross-origin requests are not served'));
      }
    }
    const mutating = req.method !== 'GET' && req.method !== 'HEAD';
    if (access.token) {
      const header = req.headers.authorization ?? '';
      const m = /^Bearer\s+(.+)$/i.exec(header);
      if (!open.has(req.path) && !(m && tokenMatches(m[1].trim(), access.token))) {
        return next(apiError('UNAUTHORIZED', 'send Authorization: Bearer <token> (the token the server was started with)'));
      }
    } else {
      const allowed = isLoopbackHost(name) || (access.bindHost !== undefined && name === access.bindHost.toLowerCase());
      if (!allowed) return next(apiError('FORBIDDEN', `requests for host "${name ?? ''}" are not served without an API token`));
      if (mutating && !isLoopbackHost(access.bindHost)) {
        return next(apiError('FORBIDDEN', 'the server is bound beyond loopback; start it with --api-token to allow writes'));
      }
    }
    if (mutating && access.readOnly) return next(apiError('READ_ONLY', 'the server was started read-only'));
    if (mutating && !req.is('application/json')) {
      return next(apiError('UNSUPPORTED_MEDIA_TYPE', 'send the request body as JSON with Content-Type: application/json'));
    }
    next();
  };
}

function flag(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === 'true' || value === '1' || value === '') return true;
  if (value === 'false' || value === '0') return false;
  throw apiError('MALFORMED_REQUEST', `${name} must be true or false`, { field: name, value });
}

interface Remembered {
  fingerprint: string;
  status: number;
  body: unknown;
  headers: Record<string, string>;
  at: number;
}

/**
 * `Idempotency-Key` for create and bulk update: a retried request returns the
 * first response instead of doing the work twice. Held in this process only —
 * a retry after a server restart is not deduplicated.
 */
class IdempotencyStore {
  private readonly entries = new Map<string, Remembered>();
  constructor(
    private readonly ttlMs = 24 * 60 * 60 * 1000,
    private readonly max = 1000,
  ) {}

  get(key: string): Remembered | undefined {
    const hit = this.entries.get(key);
    if (hit && Date.now() - hit.at > this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return hit;
  }

  set(key: string, value: Remembered): void {
    this.entries.set(key, value);
    while (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value!);
  }
}

export function createApiRouter(service: StoryService, access: ApiAccess = {}) {
  const router = express.Router();
  const idempotency = new IdempotencyStore();

  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  router.use(guard(access));
  router.use(express.json({ limit: '2mb', type: 'application/json' }));

  const send = (res: Response, status: number, body: unknown, headers: Record<string, string> = {}) => {
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    res.status(status).type('application/json; charset=utf-8').send(JSON.stringify(body));
  };

  /** Runs a create or bulk update at most once per Idempotency-Key. */
  const once = (req: Request, res: Response, work: () => { status: number; body: unknown; headers?: Record<string, string> }) => {
    const key = req.get('Idempotency-Key');
    const dry = req.query.dryRun !== undefined || (req.body && req.body.dryRun === true);
    if (!key || dry) {
      const out = work();
      return send(res, out.status, out.body, out.headers);
    }
    const scoped = `${req.method} ${req.path} ${key}`;
    const fingerprint = createHash('sha256').update(JSON.stringify(req.body ?? null)).digest('hex');
    const hit = idempotency.get(scoped);
    if (hit) {
      if (hit.fingerprint !== fingerprint) {
        throw apiError('IDEMPOTENCY_KEY_REUSED', 'this Idempotency-Key was already used with a different request body');
      }
      return send(res, hit.status, hit.body, { ...hit.headers, 'Idempotent-Replayed': 'true' });
    }
    // Only successes are remembered: a refused request wrote nothing, so retrying it is safe.
    const out = work();
    idempotency.set(scoped, { fingerprint, status: out.status, body: out.body, headers: out.headers ?? {}, at: Date.now() });
    return send(res, out.status, out.body, out.headers);
  };

  router.get('/', (_req, res) => send(res, 200, service.discovery(API_BASE)));
  router.get('/meta', (_req, res) => send(res, 200, service.meta({ readOnly: access.readOnly })));
  router.get('/openapi.json', (_req, res) => send(res, 200, buildOpenApi(service, { tokenRequired: Boolean(access.token) })));

  router.get('/stories', (req, res) => send(res, 200, service.list(req.query as Record<string, unknown>)));

  router.get('/stories/:id', (req, res) => {
    const story = service.get(req.params.id);
    send(res, 200, story, { ETag: `"${story.revision}"` });
  });

  router.post('/stories/bulk-update', (req, res) =>
    once(req, res, () => {
      const result = service.bulkUpdate(req.body, { dryRun: flag(req.query.dryRun, 'dryRun') });
      return { status: 200, body: result };
    }),
  );

  router.post('/stories', (req, res) =>
    once(req, res, () => {
      const result = service.create(req.body, { dryRun: flag(req.query.dryRun, 'dryRun') });
      const location = `${API_BASE}/stories/${encodeURIComponent(result.story.id)}`;
      return result.dryRun
        ? { status: 200, body: result }
        : { status: 201, body: result, headers: { Location: location, ETag: `"${result.story.revision}"` } };
    }),
  );

  router.patch('/stories/:id', (req, res) => {
    const result = service.patch(req.params.id, req.body, {
      ifMatch: req.get('If-Match'),
      dryRun: flag(req.query.dryRun, 'dryRun'),
    });
    send(res, 200, result, { ETag: `"${result.story.revision}"` });
  });

  router.use((req, _res, next) => next(apiError('ROUTE_NOT_FOUND', `no API route for ${req.method} ${API_BASE}${req.path}`)));

  // Every failure leaves as the same JSON envelope, including a body that is not JSON.
  router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof ApiError) return send(res, error.status, error.toJSON());
    const e = error as { type?: string; status?: number; message?: string };
    if (e?.type === 'entity.parse.failed') {
      return send(res, 400, apiError('MALFORMED_REQUEST', `the request body is not valid JSON: ${e.message}`).toJSON());
    }
    if (e?.type === 'entity.too.large') {
      return send(res, 400, apiError('MALFORMED_REQUEST', 'the request body is too large').toJSON());
    }
    process.stderr.write(`storymap api: ${(error as Error)?.stack ?? String(error)}\n`);
    return send(res, 500, apiError('INTERNAL_ERROR', 'unexpected server error').toJSON());
  });

  return router;
}
