# StoryMap.md

A local, Git-native user story mapping tool for Markdown-based backlogs, with
first-class support for [Backlog.md](https://www.npmjs.com/package/backlog.md)
repositories.

StoryMap.md reads the work items already in your repository plus a little YAML
you write by hand, and serves a local browser: a story list, a story detail
page, and a spatial story-map wall with activities across the top and release or
workflow lanes down the side.

There is no database, no account and no server to deploy. Your files are the
truth. Coding agents and scripts can query and change the same work items
through a JSON API and CLI — see [docs/storymap-api.md](./docs/storymap-api.md).

```text
Markdown work items
       |
       v
StoryMap.md YAML
       |
       v
local CLI + browser
       |
       v
Git-versioned product map
```

[Install](#install) · [Use it](#use-it) · [The story-map model](#the-story-map-model) ·
[Config](#config) · [Develop](#develop) · [Licence](#licence)

## Install

```bash
npm install -g storymap.md
```

or without installing anything:

```bash
npx storymap.md --help
npx storymap.md browser
```

Requires Node 20 or newer.

## Use it

```bash
cd my-project

storymap init        # write storymap.config.yml
storymap doctor      # is this project healthy?
storymap validate    # structural check, for CI
storymap browser     # http://127.0.0.1:6480
```

Every command works from anywhere inside the project — StoryMap.md walks upward
to find it, the way `git` does.

### `storymap init`

```text
StoryMap.md initialization

  ✓ Git repository detected
  ✓ Backlog.md detected
  ✓ Backlog directory: backlog
  ✓ 42 work items found (30 active, 12 completed)

  Story-map directory:
  backlog/story-maps  (empty — add your first map here)

  Created:
  backlog/story-maps/
  storymap.config.yml
```

`init` writes one file and creates at most one empty directory. It never edits a
work item, never rewrites `backlog.config.yml`, and never invents a story map.

### `storymap browser`

```bash
storymap browser --port 7000     # somewhere else
storymap browser --no-open       # do not launch a web browser
storymap browser --host 127.0.0.1
```

The default bind address is `127.0.0.1` and it stays that way: the server reads
your working files and applies no authentication. If the port is busy the
command fails and says so rather than attaching to whatever is there.

### `storymap validate`

Exits non-zero when a map references a story that does not exist, two work items
claim one id, a map file is malformed, or a story is placed as primary in two
maps. Suitable for CI:

```bash
storymap validate || exit 1
```

### `storymap doctor`

Diagnoses the project rather than the data: Node version, Git, both config
files, the backlog and story-map directories, whether work items parse, whether
the map schema is supported. Exits non-zero when something essential is broken,
and says what to do about it.

## File layout

```text
my-project/
├── backlog.config.yml        # Backlog.md's own config
├── storymap.config.yml       # what StoryMap.md adds
└── backlog/
    ├── tasks/                # active work items
    ├── completed/            # delivered work items
    ├── milestones/           # optional
    └── story-maps/           # your maps
        └── checkout.yaml
```

Any layout works; the two config files say where things are.

## Config

`storymap.config.yml` is small on purpose. Everything it omits is inferred.

```yaml
schemaVersion: 1

storyMaps:
  directory: backlog/story-maps
```

| Key | Default |
|---|---|
| `backlog.directory` | `backlog_directory` from `backlog.config.yml`, else `backlog` |
| `storyMaps.directory` | `story-maps` inside the backlog directory |
| `browser.port` | `6480` |
| `projectName` | `project_name` from `backlog.config.yml`, else the folder name |
| `backlog.completedStatuses` | none — only `completed/` marks an item delivered |
| `workflow.laneOrder` | unfinished statuses most-advanced first, then the done statuses |
| `workflow.doneStatuses` | the last status in `backlog.config.yml` |
| `workflow.activeStatuses` | the status declared just before the first done status |

Directories must stay inside the project; an absolute or escaping path is
refused by name rather than quietly clamped.

### Workflow

Statuses are yours. StoryMap.md reads them from `statuses` and `default_status`
in `backlog.config.yml` — Backlog.md's `To Do`, `In Progress`, `Done` when the
project declares none — and never compares a status against a fixed word. The
`workflow` keys only say how to lane them. A project that tracks how far work has
shipped might write:

```yaml
backlog:
  completedStatuses: [Done - Production]   # terminal: drawn as delivered
workflow:
  laneOrder: [In Progress, Review, Ready, Backlog, Done - Local, Done - Integrated, Done - Production]
  doneStatuses: [Done - Local, Done - Integrated, Done - Production]
  activeStatuses: [In Progress, Review]
```

`laneOrder` must place every configured status exactly once, and every name in
these keys must be a configured status: a mismatch is refused by name when the
project loads, never drawn wrongly.

## The story-map model

Five ideas, and the YAML is the canonical structure for all of them.

| Term | What it is |
|---|---|
| **Activity** | A large thing a person does, running across the top of the wall. "Arrive", "Pay". |
| **Step** | A smaller thing inside an activity, forming a column. "Sign in", "See the total". |
| **Release slice** | A lane down the page grouping steps into what ships together. "First release", "Later". |
| **Story id** | The `id` of a work item, e.g. `STORY-001`. The map names ids and nothing else. |
| **Supporting story** | Work that enables a step without belonging to it — a shared capability referenced from the journeys it serves. |

A map holds structure and story ids — never a copy of a story's title, status or
body. Those come from the work item, so there is exactly one place a story can be
edited, and the map cannot drift out of date about its contents.

The browser can also lane by **workflow** instead of by release slice — one lane
per configured status, in the workflow's lane order, derived from each story's
own status rather than from the map. The done statuses sit at the bottom, where
finished work belongs. A `wstatus:` label only adds the exceptions a status
cannot say: *Blocked / needs decision* for unfinished work, and *Closed without
delivery* (`cancelled`, `superseded`) just above the done lanes. A status the
project does not declare gets an *Unknown status* lane rather than a guess.

## Writing a map

A map holds structure and story ids — never a copy of a story's title, status or
body. There is exactly one place a story can be edited, and it is the work item.

```yaml
schemaVersion: 1
id: checkout
title: Buying something
kind: journey          # or: capability
personas:
  - Customer

releaseSlices:
  - id: first
    title: First release
    order: 10
    expects: completed # optional: warn when the map rots
  - id: later
    title: Later
    order: 20

activities:
  - id: arrive
    title: Arrive
    steps:
      - id: sign-in
        title: Sign in
        slices:
          first:
            - STORY-001
          later:
            - STORY-002
        supporting:    # enables this step without belonging to it
          - PLATFORM-014
```

A story placed in a cell appears as a card there.

## Backlog.md compatibility

Backlog.md Markdown remains the canonical work-item data. The browser only
reads it. Work items are written only when you ask through the
[story API or CLI](./docs/storymap-api.md) (`update`, `bulk-update`, `create`),
and then as the smallest edit that expresses the change, in Backlog.md's own
layout: only the changed front-matter keys and `updated_date`, verified by
re-reading before the file is replaced. Nothing renames a work-item file or
touches `backlog.config.yml`; `init` writes `storymap.config.yml`.

Compatibility is a matter of file format. StoryMap.md is **not affiliated with,
endorsed by, or maintained by the Backlog.md project**, and contains none of its
code. Any Markdown backlog with the same shape works just as well.

## What StoryMap.md reads from a work item

Only Backlog.md's own fields are required:

```yaml
id: STORY-001
title: Sign in with an email code
status: To Do
priority: high
labels: []
dependencies: []
milestone: m-1
```

Optional `labels` in a namespace are shown as structured metadata when present
and ignored when absent — `area:`, `owner:`, `wtype:`, `wstatus:`, `risk:`,
`priority:`. A project that uses none of them loses nothing but those filters.

Ids are matched case-insensitively and ignore zero padding, so `TASK-7`,
`task-7` and `TASK-007` are one story. Identity is the `id` in front matter,
never the filename — Backlog.md rewrites filenames when a title changes.

Work items are read directly from disk rather than through the `backlog` CLI,
because Backlog.md excludes `completed/` from its list and search, and a story
map has to show delivered work in its journey position.

## Local only

- binds `127.0.0.1` unless you override it
- serves its own packaged CSS and JS, and nothing else from your disk
- writes `storymap.config.yml` on `init`, and work items only through the story
  API or CLI; the JSON API answers loopback requests only unless started with
  `--api-token`, and `--read-only` disables its writes
- no telemetry, no update check, no network calls at all

## Develop

```bash
git clone https://github.com/Zorion-ro/StoryMap.md.git
cd StoryMap.md

npm ci
npm test
npm run typecheck
npm run build
npm pack
```

Node 20 or newer. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the architectural
principles a change should respect.

- **Found a bug?** [Open an issue](https://github.com/Zorion-ro/StoryMap.md/issues).
- **Found a vulnerability?** Do not open a public issue — see [SECURITY.md](./SECURITY.md).

## Licence

StoryMap.md is released under the MIT Licence. See [LICENSE](./LICENSE).

Copyright (c) 2026 Zorion SRL.
