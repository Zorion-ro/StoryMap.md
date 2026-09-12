# StoryMap.md

A local, Git-native user story mapping tool for Markdown-based backlogs, with
first-class support for [Backlog.md](https://www.npmjs.com/package/backlog.md)
repositories.

StoryMap.md reads the work items already in your repository plus a little YAML
you write by hand, and serves a local browser: a story list, a story detail
page, and a spatial story-map wall with activities across the top and release or
workflow lanes down the side.

There is no database, no account and no server to deploy. Your files are the
truth; the tool reads them, and writes back only the edits you apply.

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

#### Stories: filters, bulk edit and Kanban

The Stories page filters every categorical field (`state`, `status`, `wstatus`,
`area`, `owner`, `priority`, `wtype`, `map`, `milestone`) with **is** or
**is not** and any number of values. Values inside one field are ORed, different
fields are ANDed, **is not** means NOT IN, and `none` means "no value":

```text
/?status=Backlog&status=Ready                    status IS Backlog OR Ready
/?status=Done&status=Cancelled&status.op=not     status NOT IN [Done, Cancelled]
/?wtype=defect&wtype=feature&owner=platform      ... AND owner IS platform
/?map=none                                       on no story map
```

Every filter is in the URL, so it bookmarks, survives a reload and works with
back and forward. Single-value URLs from earlier versions mean what they meant.
`priority` is the `priority:` label scale; Backlog.md's own `high`, `medium`
and `low` still match the native field.

`?view=kanban` shows the same filtered stories as a board grouped the way the
Backlog.md board groups them: one column per status in `backlog.config.yml`,
optional milestone lanes (`&lanes=milestone`), and cards ordered by `ordinal`,
then creation date. A status the config does not declare gets its own
read-only column rather than disappearing.

Select stories (click, Shift-click for a range, **Select all shown**, or
Ctrl/Cmd-click on the board) to edit `status`, `wstatus`, `area`, `owner`,
`priority`, `wtype`, `map` and `milestone` together. Fields left on
**No change** are not touched; **Clear** removes a label, the milestone, or the
story from every map. The review step says how many stories will change and to
what before anything is written. Dragging a card to another column changes its
status; dragging one of several selected cards moves them all, after the same
review.

Edits are the only writes the browser makes, and they are deliberately narrow:
the whole request is validated first (statuses from `backlog.config.yml`,
declared milestones, existing map cells), each file gets a minimal line edit
that is re-parsed and checked before it is written, a file changed on disk since
the review is a conflict, and a request is all-or-nothing. `map` changes edit the
map YAML, never the story.

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

Directories must stay inside the project; an absolute or escaping path is
refused by name rather than quietly clamped.

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

The browser can also lane by **workflow** instead of by release slice — Blocked,
In progress, To do, Backlog, Closed, Done — derived from each story's own state
rather than from the map. Done sits at the bottom, where finished work belongs.

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

Backlog.md Markdown remains the canonical work-item data. StoryMap.md reads it,
and changes it only when you apply a bulk edit or move a card on the Stories
board: then it rewrites exactly the front-matter lines for `status`, `milestone`,
the edited labels and `updated_date` (in Backlog.md's UTC `YYYY-MM-DD HH:MM`
form), validates statuses against `backlog.config.yml` as Backlog.md does, and
never renames a file or touches `backlog.config.yml`. `init` writes
`storymap.config.yml`.

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
- writes work items and maps only when you apply an edit in the browser, and
  `storymap.config.yml` only when you run `init`
- accepts an edit only as a same-origin JSON request to the address it was
  started on
- no telemetry, no update check, no network calls at all

## Develop

```bash
git clone https://github.com/Zorion-ro/StoryMap.md.git
cd StoryMap.md

npm ci
npm test          # 274 tests
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
