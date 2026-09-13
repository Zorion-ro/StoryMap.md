import { ERROR_CODES } from './errors';
import { FIELD_NAMES, LIMITS, SORT_FIELDS, STORY_FIELDS } from './fields';
import type { FieldSpec } from './fields';
import { NONE } from '../core';
import { FILTER_PARAMS, TEXT_PARAMS } from './story-filter';
import { API_VERSION } from './story-service';
import type { StoryService } from './story-service';

/**
 * The OpenAPI 3.1 document, generated from the same field table, error table
 * and live vocabulary the server enforces. There is no hand-written schema to
 * fall out of step with the code.
 */

type Schema = Record<string, unknown>;

const criterion: Schema = {
  type: 'object',
  required: ['index', 'text', 'checked'],
  properties: { index: { type: 'integer' }, text: { type: 'string' }, checked: { type: 'boolean' } },
};

function valueSchema(name: string, spec: FieldSpec, values: string[] | undefined, closed: boolean): Schema {
  let schema: Schema;
  switch (spec.type) {
    case 'string':
      schema = { type: 'string', ...(values && closed ? { enum: values } : {}), ...(values && !closed ? { examples: values.slice(0, 20) } : {}) };
      break;
    case 'string[]':
      schema = { type: 'array', items: { type: 'string' } };
      break;
    case 'object':
      schema = { type: 'object', additionalProperties: { type: 'string' } };
      break;
    case 'object[]':
      schema =
        name === 'maps'
          ? {
              type: 'array',
              items: {
                type: 'object',
                required: ['id', 'role'],
                properties: { id: { type: 'string' }, role: { type: 'string', enum: ['primary', 'supporting'] } },
              },
            }
          : { type: 'array', items: criterion };
      break;
  }
  if (spec.nullable) {
    schema = { ...schema, type: [schema.type as string, 'null'] };
    if (Array.isArray(schema.enum)) schema.enum = [...(schema.enum as string[]), null];
  }
  return schema;
}

export function buildOpenApi(service: StoryService, opts: { tokenRequired?: boolean } = {}): Schema {
  const meta = service.meta() as { fields: Record<string, { values?: string[]; vocabulary: string | null; writableValues?: string[] }> };
  const base = `/api/${API_VERSION}/storymap`;

  const storyProps: Record<string, Schema> = {};
  const createProps: Record<string, Schema> = {};
  const patchProps: Record<string, Schema> = {};
  for (const name of FIELD_NAMES) {
    const spec: FieldSpec = STORY_FIELDS[name];
    const live = meta.fields[name];
    const closed = live.vocabulary === 'closed';
    const described = { description: `${spec.description} Stored as: ${spec.storage}.`, ...(spec.example !== undefined ? { examples: [spec.example] } : {}) };
    storyProps[name] = { ...valueSchema(name, spec, live.values, closed), ...described };
    const writeValues = name === 'status' ? live.writableValues : live.values;
    const writeSchema: Schema = spec.setOperations
      ? {
          oneOf: [
            { type: 'array', items: { type: 'string' }, description: 'Replace the whole list.' },
            {
              type: 'object',
              additionalProperties: false,
              properties: { add: { type: 'array', items: { type: 'string' } }, remove: { type: 'array', items: { type: 'string' } } },
              description: 'Add and remove individual entries; both are idempotent.',
            },
          ],
        }
      : valueSchema(name, spec, writeValues, closed);
    if (spec.writable) patchProps[name] = { ...writeSchema, ...described };
    if (spec.creatable) createProps[name] = { ...writeSchema, ...described };
  }

  const errorSchema: Schema = {
    type: 'object',
    required: ['error'],
    properties: {
      error: {
        type: 'object',
        required: ['code', 'message'],
        properties: {
          code: { type: 'string', enum: Object.keys(ERROR_CODES), description: 'Stable; branch on this.' },
          message: { type: 'string', description: 'For people; may change.' },
          field: { type: 'string' },
          value: {},
          allowedValues: { type: 'array' },
          currentRevision: { type: 'string', description: 'On REVISION_CONFLICT: the revision to refetch.' },
          expectedRevision: { type: 'string' },
        },
      },
      errors: { type: 'array', items: { type: 'object' }, description: 'Every problem, when there was more than one.' },
      results: { type: 'array', items: { $ref: '#/components/schemas/BulkItemResult' }, description: 'On a refused bulk update.' },
    },
    examples: [
      {
        error: {
          code: 'INVALID_STATUS',
          message: '"Doing" is not a valid status',
          field: 'status',
          value: 'Doing',
          allowedValues: meta.fields.status.writableValues ?? [],
        },
      },
    ],
  };

  const errorResponses = (codes: (keyof typeof ERROR_CODES)[]) => {
    const byStatus = new Map<number, string[]>();
    for (const code of codes) byStatus.set(ERROR_CODES[code].status, [...(byStatus.get(ERROR_CODES[code].status) ?? []), code]);
    return Object.fromEntries(
      [...byStatus.entries()].map(([status, list]) => [
        String(status),
        { description: list.join(', '), content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      ]),
    );
  };
  const json = (ref: string, example?: unknown) => ({
    'application/json': { schema: { $ref: `#/components/schemas/${ref}` }, ...(example !== undefined ? { example } : {}) },
  });
  const common: (keyof typeof ERROR_CODES)[] = ['UNAUTHORIZED', 'FORBIDDEN', 'INTERNAL_ERROR'];
  const writeCommon: (keyof typeof ERROR_CODES)[] = [...common, 'MALFORMED_REQUEST', 'READ_ONLY', 'UNSUPPORTED_MEDIA_TYPE', 'WRITE_LOCK_TIMEOUT', 'WRITE_VERIFICATION_FAILED'];
  const fieldErrors = Object.keys(ERROR_CODES).filter((c) => c.startsWith('INVALID_') && ERROR_CODES[c as keyof typeof ERROR_CODES].status === 422) as (keyof typeof ERROR_CODES)[];
  const validation: (keyof typeof ERROR_CODES)[] = [
    'VALIDATION_ERROR',
    'FIELD_NOT_WRITABLE',
    'FIELD_NOT_NULLABLE',
    'CONFLICTING_CHANGES',
    'CONFLICTING_LABELS',
    'UNSUPPORTED_BODY_LAYOUT',
    ...fieldErrors,
  ];
  const dryRunParam = { name: 'dryRun', in: 'query', schema: { type: 'boolean' }, description: 'Validate and report what would change; write nothing.' };
  const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'string' }, example: 'FW-397' };
  const idempotencyParam = {
    name: 'Idempotency-Key',
    in: 'header',
    schema: { type: 'string' },
    description: 'A retry with the same key and body replays the first successful response instead of repeating the work.',
  };

  const filterParams = Object.entries(FILTER_PARAMS).flatMap(([param, field]) => {
    const live = meta.fields[field];
    const hint = live.values && live.values.length > 0 ? ` Known values: ${live.values.slice(0, 30).join(', ')}${live.values.length > 30 ? ', …' : ''}.` : '';
    return [
      {
        name: param,
        in: 'query',
        schema: { type: 'string' },
        style: 'form',
        explode: true,
        description: `${field} IN (comma-separated values; repeat the parameter to add more). \`${NONE}\` matches no value.${hint}`,
      },
      { name: `${param}_not`, in: 'query', schema: { type: 'string' }, description: `${field} NOT IN (comma-separated values). \`${NONE}\` excludes stories with no value.` },
    ];
  });

  return {
    openapi: '3.1.0',
    info: {
      title: 'Storymap API',
      version: API_VERSION,
      description: [
        'Read and change the Backlog.md work items StoryMap.md serves. The Markdown files stay the only store: every change is a minimal edit to one file.',
        '',
        'Call `GET /meta` for valid field values instead of assuming them. Values within one filter parameter are ORed, different parameters are ANDed.',
        'Mutations accept `dryRun`, and PATCH accepts `If-Match` or `expectedRevision` to refuse overwriting a newer edit (409 REVISION_CONFLICT).',
        'v1 is a contract: fields and codes may be added, never renamed or repurposed.',
      ].join('\n'),
    },
    servers: [{ url: '/' }],
    ...(opts.tokenRequired ? { security: [{ bearer: [] }] } : { security: [{}, { bearer: [] }] }),
    tags: [{ name: 'discovery' }, { name: 'stories' }],
    paths: {
      [base]: {
        get: {
          operationId: 'discover',
          tags: ['discovery'],
          security: [{}],
          summary: 'Links to the metadata, schema and stories endpoints.',
          responses: { '200': { description: 'Index', content: { 'application/json': { schema: { type: 'object' } } } } },
        },
      },
      [`${base}/meta`]: {
        get: {
          operationId: 'getMeta',
          tags: ['discovery'],
          summary: 'Fields, writable/nullable flags, current valid values, filter syntax, limits and error codes.',
          responses: { '200': { description: 'Metadata', content: { 'application/json': { schema: { type: 'object' } } } }, ...errorResponses(common) },
        },
      },
      [`${base}/openapi.json`]: {
        get: {
          operationId: 'getOpenApi',
          tags: ['discovery'],
          security: [{}],
          summary: 'This document.',
          responses: { '200': { description: 'OpenAPI 3.1', content: { 'application/json': { schema: { type: 'object' } } } } },
        },
      },
      [`${base}/stories`]: {
        get: {
          operationId: 'listStories',
          tags: ['stories'],
          summary: 'Filter, sort and page stories.',
          parameters: [
            ...filterParams,
            ...TEXT_PARAMS.map((name) => ({ name, in: 'query', schema: { type: 'string' }, description: 'Case-insensitive substring of id, title, labels or body.' })),
            { name: 'sort', in: 'query', schema: { type: 'string', enum: SORT_FIELDS, default: 'id' } },
            { name: 'order', in: 'query', schema: { type: 'string', enum: ['asc', 'desc'], default: 'asc' } },
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: LIMITS.maxPageSize, default: LIMITS.defaultPageSize } },
            { name: 'cursor', in: 'query', schema: { type: 'string' }, description: '`nextCursor` from the previous page, with the same filters, sort and order.' },
            { name: 'fields', in: 'query', schema: { type: 'string' }, description: 'Comma-separated fields to return; `id` is always included.' },
          ],
          responses: {
            '200': {
              description: 'A page of stories',
              content: json('StoryPage', { items: [], count: 0, total: 0, limit: 100, sort: 'id', order: 'asc', nextCursor: null }),
            },
            ...errorResponses([...common, 'INVALID_FILTER', 'INVALID_CURSOR', 'INVALID_SORT', 'INVALID_LIMIT', 'INVALID_FIELD', 'MALFORMED_REQUEST']),
          },
        },
        post: {
          operationId: 'createStory',
          tags: ['stories'],
          summary: 'Create a story. The id is allocated by the server.',
          parameters: [dryRunParam, idempotencyParam],
          requestBody: {
            required: true,
            content: json('StoryCreate', { title: 'Dealer rating support', body: '…', wtype: 'feature', priority: 'medium', owner: 'frontend', milestone: 'm-0' }),
          },
          responses: {
            '201': { description: 'Created; `Location` names the new story.', content: json('MutationResult') },
            '200': { description: 'Dry run: the story that would be created.', content: json('MutationResult') },
            ...errorResponses([...writeCommon, 'REQUIRED_FIELD', 'INVALID_FIELD', 'IDEMPOTENCY_KEY_REUSED', ...validation]),
          },
        },
      },
      [`${base}/stories/{id}`]: {
        get: {
          operationId: 'getStory',
          tags: ['stories'],
          parameters: [idParam],
          responses: {
            '200': { description: 'The story; `ETag` carries its revision.', content: json('Story') },
            ...errorResponses([...common, 'STORY_NOT_FOUND']),
          },
        },
        patch: {
          operationId: 'updateStory',
          tags: ['stories'],
          summary: 'Change some fields. Omitted fields are untouched; `null` clears a nullable field.',
          parameters: [
            idParam,
            dryRunParam,
            { name: 'If-Match', in: 'header', schema: { type: 'string' }, description: 'The revision you read; a mismatch is 409 REVISION_CONFLICT.' },
          ],
          requestBody: {
            required: true,
            content: json('StoryPatch', { status: 'In Progress', owner: 'platform', milestone: null, labels: { add: ['risk:high'], remove: ['risk:medium'] } }),
          },
          responses: {
            '200': { description: 'The story after the change (or as it would be, on a dry run).', content: json('MutationResult') },
            ...errorResponses([...writeCommon, 'STORY_NOT_FOUND', 'REVISION_CONFLICT', 'INVALID_FIELD', ...validation]),
          },
        },
      },
      [`${base}/stories/bulk-update`]: {
        post: {
          operationId: 'bulkUpdateStories',
          tags: ['stories'],
          summary: 'Apply the same changes to many stories. All are validated first; either every story is written or none is.',
          parameters: [dryRunParam, idempotencyParam],
          requestBody: {
            required: true,
            content: json('BulkUpdate', { ids: ['FW-101', 'FW-102'], changes: { owner: 'platform', priority: 'high' } }),
          },
          responses: {
            '200': { description: 'Every story validated; written unless dryRun.', content: json('BulkResult') },
            ...errorResponses([...writeCommon, 'REVISION_CONFLICT', 'BULK_LIMIT_EXCEEDED', 'BULK_VALIDATION_FAILED', 'DUPLICATE_IDS', 'INVALID_FIELD', 'IDEMPOTENCY_KEY_REUSED', ...validation]),
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearer: {
          type: 'http',
          scheme: 'bearer',
          description: opts.tokenRequired
            ? 'Required: this server was started with an API token.'
            : 'Not required on this server: it answers loopback requests only. Required when the server is started with --api-token.',
        },
      },
      schemas: {
        Story: { type: 'object', required: FIELD_NAMES, additionalProperties: false, properties: storyProps },
        StoryCreate: {
          type: 'object',
          required: ['title'],
          additionalProperties: false,
          properties: { ...createProps, allowNewValues: { type: 'boolean' }, dryRun: { type: 'boolean' } },
        },
        StoryPatch: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: {
            ...patchProps,
            expectedRevision: { type: 'string', description: 'Alternative to If-Match.' },
            allowNewValues: { type: 'boolean', description: 'Accept a value not yet used for an open-vocabulary field.' },
            dryRun: { type: 'boolean' },
          },
        },
        BulkUpdate: {
          type: 'object',
          required: ['ids', 'changes'],
          additionalProperties: false,
          properties: {
            ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: LIMITS.maxBulkIds, uniqueItems: true },
            changes: { type: 'object', additionalProperties: false, minProperties: 1, properties: patchProps },
            expectedRevisions: { type: 'object', additionalProperties: { type: 'string' } },
            allowNewValues: { type: 'boolean' },
            dryRun: { type: 'boolean' },
          },
        },
        FieldChange: { type: 'object', required: ['from', 'to'], properties: { from: {}, to: {} } },
        MutationResult: {
          type: 'object',
          required: ['dryRun', 'story'],
          properties: {
            dryRun: { type: 'boolean' },
            changed: { type: 'boolean', description: 'False when the story already had these values; nothing was written.' },
            changes: { type: 'object', additionalProperties: { $ref: '#/components/schemas/FieldChange' } },
            previousRevision: { type: 'string' },
            story: { $ref: '#/components/schemas/Story' },
          },
        },
        BulkItemResult: {
          type: 'object',
          required: ['id', 'ok'],
          properties: {
            id: { type: 'string' },
            ok: { type: 'boolean' },
            changed: { type: 'boolean' },
            changes: { type: 'object', additionalProperties: { $ref: '#/components/schemas/FieldChange' } },
            previousRevision: { type: 'string' },
            revision: { type: 'string' },
            story: { $ref: '#/components/schemas/Story' },
            error: { type: 'object' },
            errors: { type: 'array', items: { type: 'object' } },
          },
        },
        BulkResult: {
          type: 'object',
          required: ['dryRun', 'atomic', 'requested', 'matched', 'succeeded', 'failed', 'changed', 'unchanged', 'results'],
          properties: {
            dryRun: { type: 'boolean' },
            atomic: { type: 'boolean', const: true },
            requested: { type: 'integer' },
            matched: { type: 'integer' },
            succeeded: { type: 'integer' },
            failed: { type: 'integer' },
            changed: { type: 'integer' },
            wouldChange: { type: 'integer', description: 'Dry run only.' },
            unchanged: { type: 'integer' },
            changes: {
              type: 'object',
              additionalProperties: { type: 'object', properties: { from: { type: 'array' }, to: { type: 'array' } } },
              description: 'Per field, the distinct values before and after.',
            },
            results: { type: 'array', items: { $ref: '#/components/schemas/BulkItemResult' } },
          },
        },
        StoryPage: {
          type: 'object',
          required: ['items', 'count', 'total', 'limit', 'nextCursor'],
          properties: {
            items: { type: 'array', items: { $ref: '#/components/schemas/Story' } },
            count: { type: 'integer' },
            total: { type: 'integer', description: 'Stories matching the filter, across all pages.' },
            limit: { type: 'integer' },
            sort: { type: 'string' },
            order: { type: 'string' },
            nextCursor: { type: ['string', 'null'] },
          },
        },
        Error: errorSchema,
      },
    },
  };
}
