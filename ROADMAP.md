# Roadmap

## Where 0.1.0 got to

```text
read  ->  visualise  ->  validate
```

StoryMap.md reads Backlog.md work items and hand-written map YAML, draws the
wall, and tells you when the two have drifted apart. It writes nothing except
its own config file.

That is useful and it is half a tool. Every structural change — a new activity,
a story moved from one step to another, a slice renamed — is a text edit someone
makes by hand in a YAML file, in a different window from the picture they are
looking at.

## Where 0.2.0 goes

```text
create  ->  curate  ->  visualise  ->  validate
```

Authoring, from the wall you are already looking at.

### The invariant that makes it safe

```text
UI operation
     |
     v
StoryMap core operation
     |
     v
deterministic minimal YAML edit
     |
     v
Git diff
```

Never:

```text
UI operation  ->  hidden canonical state in a database or a browser tab
```

Every edit must land in the repository as a small, readable, reviewable diff,
and the file on disk must remain the only truth. If a change cannot be expressed
as a minimal YAML edit, it does not belong in the UI.

### Scope

**Map structure**

- create a new map
- add, edit and remove activities
- reorder activities
- add, edit and remove steps
- reorder steps
- add, edit and remove release / product slices

**Story placement**

- place an existing work item into a step and slice
- move a story between cells
- reorder stories within a cell, where that ordering carries meaning
- add and remove supporting-story references

**Writing safely**

- deterministic YAML serialisation — the same model always produces the same
  bytes, so a diff shows the change and nothing else
- minimal file diffs: touch the lines that changed and no others, preserving key
  order and comments where the format allows
- validate before every write, never after
- conflict detection when the file changed on disk since it was read, with the
  edit refused rather than merged blindly
- filesystem hot reload, already present for reads, extended to writes
- an invalid or unparseable map file degrades to read-only with an explanation
  instead of being overwritten
- undo and recovery for the last operation
- Backlog.md work items are never modified — placement changes the map, not the
  story. Editing a work item stays out of scope until it is asked for explicitly

### Possible prerequisite

A supported public core API, if downstream consumers need one to build map YAML
programmatically. This exists today only as internal modules under `dist/core`,
which nothing outside this package should import. If a real consumer needs it,
it gets designed, documented and versioned first.

### Explicit non-goals for 0.2.0

Not "later" — deliberately not this tool:

- a hosted service or SaaS offering
- authentication, accounts or user identity
- hosted storage of maps or stories
- a database as canonical state
- realtime collaborative editing (CRDT, operational transform)
- comments, mentions or notifications
- GitHub Projects synchronisation
- Jira synchronisation
- enterprise permissions or roles

Local files, a local process and a browser. That is the whole product.

## Suggested issues

- `feat(core): deterministic YAML serialiser with minimal diffs`
- `feat(core): write path with validate-before-write and conflict detection`
- `feat(ui): create a map from the browser`
- `feat(ui): add, rename, remove and reorder activities`
- `feat(ui): add, rename, remove and reorder steps`
- `feat(ui): add, rename and remove release slices`
- `feat(ui): place a work item into a cell`
- `feat(ui): drag a story between cells`
- `feat(ui): add and remove supporting-story references`
- `feat(ui): undo the last authoring operation`
- `feat(core): degrade to read-only on an unparseable map`
- `docs: authoring guide for the 0.2.0 workflow`
- `feat(core): supported public API for building map YAML` (only if a consumer needs it)
