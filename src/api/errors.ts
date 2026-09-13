/**
 * Every error code the story API can return, with its HTTP status.
 *
 * This table is the contract: `/meta`, the OpenAPI document and the CLI exit
 * codes are all derived from it, so a code cannot exist in one and not another.
 * Codes are stable — add new ones, never rename or repurpose an existing one.
 */
export const ERROR_CODES = {
  MALFORMED_REQUEST: { status: 400, description: 'The request body or a parameter has the wrong shape (not JSON, not an object, wrong JSON type).' },
  INVALID_FILTER: { status: 400, description: 'A query parameter is unknown, or a filter value is not one the field can hold.' },
  INVALID_CURSOR: { status: 400, description: 'The pagination cursor is malformed or belongs to a different query or sort.' },
  INVALID_SORT: { status: 400, description: 'The sort field or order is not supported.' },
  INVALID_LIMIT: { status: 400, description: 'The page size is not an integer within the allowed range.' },
  UNAUTHORIZED: { status: 401, description: 'The server requires a bearer token and none, or the wrong one, was sent.' },
  FORBIDDEN: { status: 403, description: 'The request came from a host or origin this server does not serve, or writes are not permitted for it.' },
  READ_ONLY: { status: 403, description: 'The server was started read-only; mutations are disabled.' },
  STORY_NOT_FOUND: { status: 404, description: 'No work item claims the id.' },
  ROUTE_NOT_FOUND: { status: 404, description: 'No API route matches the method and path.' },
  REVISION_CONFLICT: { status: 409, description: 'The story changed since the revision the caller read. Refetch, reapply, retry.' },
  IDEMPOTENCY_KEY_REUSED: { status: 409, description: 'The Idempotency-Key was already used with a different request.' },
  UNSUPPORTED_MEDIA_TYPE: { status: 415, description: 'A mutation was sent without `Content-Type: application/json`.' },
  VALIDATION_ERROR: { status: 422, description: 'The request is well formed but not acceptable; `errors` lists every problem.' },
  INVALID_FIELD: { status: 422, description: 'The field does not exist on a story.' },
  FIELD_NOT_WRITABLE: { status: 422, description: 'The field exists but is derived or managed elsewhere, so it cannot be set.' },
  FIELD_NOT_NULLABLE: { status: 422, description: '`null` was sent for a field that cannot be cleared.' },
  REQUIRED_FIELD: { status: 422, description: 'A field required to create a story is missing.' },
  INVALID_VALUE: { status: 422, description: 'The value is malformed for its field (empty, multi-line, too long, bad characters).' },
  INVALID_STATUS: { status: 422, description: 'The status is not one of the project’s statuses.' },
  INVALID_TYPE: { status: 422, description: 'The type is not one of the project’s declared types.' },
  INVALID_PRIORITY: { status: 422, description: 'The priority is not a known value of the project’s priority scale (pass allowNewValues to introduce one).' },
  INVALID_BACKLOG_PRIORITY: { status: 422, description: 'The backlogPriority is not high, medium or low.' },
  INVALID_MILESTONE: { status: 422, description: 'No milestone has that id.' },
  INVALID_WSTATUS: { status: 422, description: 'The wstatus is not a known value (pass allowNewValues to introduce one).' },
  INVALID_WTYPE: { status: 422, description: 'The wtype is not a known value (pass allowNewValues to introduce one).' },
  INVALID_AREA: { status: 422, description: 'The area is not a known value (pass allowNewValues to introduce one).' },
  INVALID_OWNER: { status: 422, description: 'The owner is not a known value (pass allowNewValues to introduce one).' },
  INVALID_RISK: { status: 422, description: 'The risk is not a known value (pass allowNewValues to introduce one).' },
  INVALID_LABEL: { status: 422, description: 'A label is malformed.' },
  INVALID_DEPENDENCY: { status: 422, description: 'A dependency names no existing story, or names the story itself.' },
  CONFLICTING_CHANGES: { status: 422, description: 'Two parts of one request set the same thing, e.g. `owner` and an `owner:` label.' },
  CONFLICTING_LABELS: { status: 422, description: 'The result would carry two labels in one structured namespace, e.g. `risk:low` and `risk:high`.' },
  DUPLICATE_IDS: { status: 422, description: 'A bulk request names the same story more than once.' },
  BULK_LIMIT_EXCEEDED: { status: 422, description: 'A bulk request names more stories than the limit in `/meta`.' },
  BULK_VALIDATION_FAILED: { status: 422, description: 'At least one story in a bulk request failed; nothing was written. See `results`.' },
  UNSUPPORTED_BODY_LAYOUT: { status: 422, description: 'The work item file has no unambiguous place to write the body.' },
  WRITE_LOCK_TIMEOUT: { status: 503, description: 'Another writer held the backlog lock too long. Retry.' },
  WRITE_VERIFICATION_FAILED: { status: 500, description: 'The edit could not be proven to touch only the intended keys, so it was not written.' },
  INTERNAL_ERROR: { status: 500, description: 'An unexpected server failure.' },
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export interface ErrorDetail {
  code: ErrorCode;
  message: string;
  field?: string;
  value?: unknown;
  allowedValues?: unknown[];
  [extra: string]: unknown;
}

export class ApiError extends Error {
  readonly status: number;
  constructor(readonly detail: ErrorDetail, readonly extra: Record<string, unknown> = {}) {
    super(detail.message);
    this.name = 'ApiError';
    this.status = ERROR_CODES[detail.code].status;
  }

  get code(): ErrorCode {
    return this.detail.code;
  }

  toJSON(): Record<string, unknown> {
    return { error: this.detail, ...this.extra };
  }
}

export function apiError(code: ErrorCode, message: string, fields: Omit<ErrorDetail, 'code' | 'message'> = {}): ApiError {
  return new ApiError({ code, message, ...fields });
}

/** Several problems at once: the first is the headline, all are listed. */
export function validationErrors(problems: ErrorDetail[]): ApiError {
  if (problems.length === 1) return new ApiError(problems[0]);
  return new ApiError(
    { code: 'VALIDATION_ERROR', message: `${problems.length} problems: ${problems.map((p) => p.message).join('; ')}` },
    { errors: problems },
  );
}
