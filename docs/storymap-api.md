# Storymap API for agents

Read, query and change Backlog.md work items as JSON — over HTTP from a running
`storymap browser`, or from the `storymap` CLI with no server at all. Both call
the same service, so the rules, results and error codes are identical.

The Markdown files stay the only store. Every change is a minimal edit to one
work-item file, visible in the browser and in `git diff` straight away.

> **Call `/meta` instead of assuming values.** Statuses, owners, types,
> milestones and the rest come from this project's config and files, and they
> change.

```text
GET    /api/v1/storymap                      discovery
GET    /api/v1/storymap/meta                 fields, valid values, limits, error codes
GET    /api/v1/storymap/openapi.json         OpenAPI 3.1, generated from the code
GET    /api/v1/storymap/stories              filter, sort, page
GET    /api/v1/storymap/stories/{id}         one story (ETag = revision)
POST   /api/v1/storymap/stories              create; id is allocated
PATCH  /api/v1/storymap/stories/{id}         change some fields
POST   /api/v1/storymap/stories/bulk-update  same change to many stories, all or nothing
```

## Start

```bash
storymap browser --no-open          # http://127.0.0.1:6480
B=http://127.0.0.1:6480/api/v1/storymap
curl -s $B | jq
```

Or skip the server: every example below has a CLI form. Add `--json` and stdout
carries exactly one JSON document — success or error — and nothing else;
messages go to stderr.

| Exit | Meaning |
|---|---|
| 0 | success |
| 1 | unexpected failure |
| 2 | usage error, malformed request or bad filter (HTTP 400) |
| 3 | not found (404) |
| 4 | validation failed (422) |
| 5 | revision conflict (409) |

## The story

```json
{
  "id": "FW-397",
  "title": "The dev app compose has no parity gate",
  "body": "…Markdown…",
  "state": "active",
  "status": "Done - Local",
  "type": "story",
  "backlogPriority": "medium",
  "priority": "p2",
  "wstatus": "done",
  "wtype": "defect",
  "area": "deployment",
  "owner": "platform",
  "risk": "medium",
  "milestone": "m-0",
  "labels": ["area:deployment", "owner:platform", "priority:p2", "risk:medium", "wstatus:done", "wtype:defect"],
  "dependencies": ["FW-393"],
  "dependents": ["FW-396"],
  "maps": [{ "id": "bidder-journey", "role": "primary" }],
  "documentation": [],
  "acceptanceCriteria": [{ "index": 1, "text": "…", "checked": true }],
  "bodyAcceptanceCriteria": [],
  "definitionOfDone": [],
  "sections": {},
  "createdAt": "2026-08-27T08:14:00Z",
  "updatedAt": null,
  "sourcePath": "docs/work/backlog/tasks/fw-397 - ….md",
  "revision": "7ab247d7666f2592860e"
}
```

- Every field is always present. A missing value is `null`; lists are arrays.
- `priority` is the project's `priority:` label scale — what Storymap shows.
  `backlogPriority` is Backlog.md's own `priority:` front-matter field
  (high | medium | low).
- `owner`, `area`, `wtype`, `wstatus`, `risk` and `priority` are stored as
  `ns:value` labels. Set the field and the label follows; you don't need to
  edit `labels` for them.
- Read-only: `id`, `state` (derived from the `completed/` directory),
  `dependents`, `maps` (placement lives in the map YAML), `documentation`,
  criteria, `sections`, timestamps, `sourcePath`, `revision`.
- Timestamps are UTC, as Backlog.md stamps them.

`/meta` → `fields.<name>` says `writable`, `nullable`, `vocabulary` and the
current `values`:

- `closed` (status, state, type when declared, backlogPriority): only listed
  values are accepted.
- `open` (owner, area, wtype, wstatus, risk, priority): listed values are
  accepted; a new one needs `"allowNewValues": true`, so a typo
  (`"platfrom"`) is refused instead of inventing a team.
- `reference` (milestone, dependencies): must name something that exists.

## Filters

```text
<field>=a,b         IN (a, b)        values in one parameter are ORed
<field>_not=a,b     NOT IN (a, b)
different fields    AND
none                the field has no value:  milestone=none, owner_not=none
text=… / q=…        substring of id, title, labels, body
```

Filter fields: `id state status type backlogPriority priority wstatus wtype area owner risk milestone map label dependency`.
Repeating a parameter adds values (`status=Ready&status=Review`). An unknown
parameter, or a value a closed field cannot hold (`status=Doing`), is
`400 INVALID_FILTER` with `allowedValues` — never an empty result.

Paging: `limit` (1–500, default 100), then pass `nextCursor` back as `cursor`
with the same filters until it is `null`. Sorting: `sort=<field>&order=asc|desc`
(nulls last ascending). `fields=title,status` trims each item to those fields
plus `id`.

## Changes

- **PATCH** changes only the fields you send. `null` clears a nullable field;
  `null` for `status` or `title` is `422 FIELD_NOT_NULLABLE`.
- **Labels and dependencies** take a whole array, or
  `{"add": [...], "remove": [...]}`. Adding a present label, or removing an
  absent one, is not an error.
- **Setting a value a story already has** writes nothing and returns
  `"changed": false`, so repeating a request is safe.
- **dryRun** (`?dryRun=true` or `"dryRun": true`) validates everything, reports
  `changes` as `{field: {from, to}}`, and writes nothing.
- **Revisions**: send the `revision` you read as `If-Match: "<rev>"` or
  `"expectedRevision"`. If the file changed since — by the API, the browser,
  `backlog`, or a human editor — the answer is `409 REVISION_CONFLICT` with
  `currentRevision`, and nothing is written.
- **Bulk update** validates every named story first. Either every story is
  written, or none is (`422 BULK_VALIDATION_FAILED` or `409 REVISION_CONFLICT`,
  with per-story `results`). At most 200 ids.
- **Idempotency-Key** on create and bulk update replays the first successful
  response for a retried request (kept in the server process for 24 hours).
- **Create** allocates the next id from `task_prefix`/`zero_padded_ids` in
  `backlog.config.yml`, writes Backlog.md's layout, and answers `201` with
  `Location`.

Errors always look like this. Branch on `code`; `message` is for people.

```json
{ "error": { "code": "INVALID_STATUS", "message": "\"Doing\" is not a valid status",
             "field": "status", "value": "Doing", "allowedValues": ["Backlog", "Ready", "In Progress"] } }
```

`/meta` → `errors` lists every code with its HTTP status.

## Workflows

### A. Unfinished defects

```bash
curl -s "$B/stories?wtype=defect&status_not=Done&fields=status,title" | jq -r '.items[] | "\(.id)\t\(.status)\t\(.title)"'
storymap list --wtype defect --status-not Done --json | jq '.total'
```

### B. Inspect one story

```bash
curl -s $B/stories/FW-397 | jq '{id, status, owner, milestone, revision}'
storymap get FW-397 --json
```

### C. Move a story to In Progress

```bash
curl -s -X PATCH $B/stories/FW-397 -H 'Content-Type: application/json' \
  -d '{"status": "In Progress"}' | jq '.changes'
storymap update FW-397 --status "In Progress" --json
```

### D. Change owner

```bash
curl -s -X PATCH $B/stories/FW-397 -H 'Content-Type: application/json' -d '{"owner": "platform"}'
storymap update FW-397 --owner platform --json
```

### E. Bulk-change priority

```bash
curl -s -X POST $B/stories/bulk-update -H 'Content-Type: application/json' \
  -d '{"ids": ["FW-101", "FW-102", "FW-103"], "changes": {"priority": "p1"}}' | jq '{succeeded, changed, unchanged}'
storymap bulk-update FW-101 FW-102 FW-103 --priority p1 --json
```

### F. Clear a milestone

```bash
curl -s -X PATCH $B/stories/FW-397 -H 'Content-Type: application/json' -d '{"milestone": null}'
storymap update FW-397 --clear milestone --json
```

### G. Dry-run a bulk update

```bash
curl -s -X POST "$B/stories/bulk-update?dryRun=true" -H 'Content-Type: application/json' \
  -d '{"ids": ["FW-101", "FW-102"], "changes": {"owner": "platform", "milestone": null}}' \
  | jq '{matched, wouldChange, unchanged, changes}'
storymap bulk-update FW-101 FW-102 --owner platform --clear milestone --dry-run --json
```

### H. Handle a 409 conflict

```python
import json, urllib.request, urllib.error

B = "http://127.0.0.1:6480/api/v1/storymap"

def call(method, path, body=None, headers=None):
    req = urllib.request.Request(B + path, method=method,
                                 data=None if body is None else json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        return e.code, json.load(e)

for attempt in range(3):
    _, story = call("GET", "/stories/FW-397")
    # decide from what you just read, then send the revision you read it at
    status, result = call("PATCH", "/stories/FW-397", {"risk": "high"},
                          {"If-Match": '"%s"' % story["revision"]})
    if status != 409:
        break          # 200, or a different error to handle
    # someone changed FW-397 since we read it: re-read, re-decide, retry
print(status, result.get("error", {}).get("code") or result["changes"])
```

CLI: `storymap update FW-397 --status Done --expected-revision <rev> --json`
exits 5 on a conflict.

### I. Discover valid statuses and owners

```bash
curl -s $B/meta | jq '{writableStatuses, owners, priorities, milestones: [.milestones[].id]}'
storymap meta --json | jq '.fields.owner | {vocabulary, values}'
```

### J. Pagination

```bash
cursor=""
while :; do
  page=$(curl -s "$B/stories?status_not=Done&limit=200${cursor:+&cursor=$cursor}")
  echo "$page" | jq -r '.items[].id'
  cursor=$(echo "$page" | jq -r '.nextCursor // empty')
  [ -z "$cursor" ] && break
done
storymap list --status-not Done --all --json | jq '.count'
```

### TypeScript

```ts
const B = 'http://127.0.0.1:6480/api/v1/storymap';
const res = await fetch(`${B}/stories/FW-397`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ status: 'In Progress', owner: 'platform' }),
});
const body = await res.json();
if (!res.ok) throw new Error(`${body.error.code}: ${body.error.message}`);
```

The CLI's `--data` takes the same JSON body as HTTP (`--data '{…}'`,
`--data @file.json`, `--data -` for stdin).

## Access

The API is served by the same local process as the browser, with the same
rules:

- By default it answers only requests addressed to `127.0.0.1` / `localhost`.
  It refuses requests carrying a foreign `Origin`, and mutations without
  `Content-Type: application/json`, so a web page open in your browser cannot
  drive it.
- `--api-token <token>` (or `STORYMAP_API_TOKEN`) requires
  `Authorization: Bearer <token>` on every request except discovery and the
  OpenAPI document. Without a token, a server bound beyond loopback refuses
  writes.
- `--read-only` refuses every mutation (`403 READ_ONLY`).
- The CLI acts on files directly, with the permissions of the user running it.

Writers are serialised by a lock outside the repository, so the server, the CLI
and scripts can write concurrently without losing updates.

## Stability

This is `v1`, and it is a contract. Fields, parameters and error codes may be
**added**; existing ones will not be renamed, removed or given a new meaning.
Tolerate unknown fields. A change that has to break this goes to `/api/v2`.
