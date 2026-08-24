# Contributing to StoryMap.md

Thanks for looking. This is a small tool with a firm shape, and the shape is the
point — most of this document is about what not to add.

## Getting started

Node 20 or newer.

```bash
git clone https://github.com/Zorion-ro/StoryMap.md.git
cd StoryMap.md

npm ci
npm test          # tsx --test over tests/ and src/core/
npm run typecheck
npm run build     # tsc -> dist/, then copy the browser assets
npm pack          # inspect what would ship
```

`npm run dev` starts the browser against whatever repository you run it from,
which is usually the fastest way to see a change.

## The principle

```text
Markdown work items  =  canonical stories
story-map YAML       =  canonical map structure
browser / UI         =  a projection of those two
```

Files on disk are the truth. Everything the tool holds in memory is rebuilt from
them and thrown away. A change that makes the UI easier by making the files less
authoritative is going the wrong way.

Concretely, please do not introduce:

- **a database, or any canonical state outside the repository** — including a
  cache that has to be invalidated to stay correct;
- **a hosted service dependency** — no accounts, no sync, no telemetry, no
  update check. The tool makes no network calls at all;
- **writes to work items.** StoryMap.md reads Backlog.md files and never edits
  them. `storymap init` writing `storymap.config.yml` is the single exception;
- **assumptions from one product.** No hard-coded directory layout, id prefix,
  label vocabulary or workflow. Every one of those is a project's own choice, and
  a project that uses none of the optional `wtype:` / `wstatus:` / `area:` labels
  must lose nothing but those filters.

## Layout

```text
src/
├── cli.ts            the `storymap` executable (the shebang lives here)
├── commands/         init · browser · validate · doctor
├── project/          discovery and storymap.config.yml
├── core/             reader · index · map parser · resolver · validator
├── server.ts         Express routes
├── render/           server-rendered HTML — no bundler, no framework
└── static/           app.css, app.js — the only files served from disk
tests/                app and CLI tests
```

`src/core/*.test.ts` sit beside the code they test; everything else is in
`tests/`. Both are excluded from the build and from the published tarball.

The browser resolves its assets from `__dirname`, never from `process.cwd()`.
`process.cwd()` is the *user's project*; the two have nothing to do with each
other once the package is installed globally. Keeping them apart is what makes a
global install work at all, so please preserve it.

## Pull requests

- One change per pull request, with a title that says what it does.
- Tests for behaviour, not for implementation detail. If a bug reached you, the
  test should be the one that would have caught it.
- `npm test`, `npm run typecheck` and `npm run build` must pass. CI runs all
  three on Node 20 and 22.
- No new runtime dependencies without a reason in the pull request description.
  There are currently two, and that is a feature.

## Releasing

Maintainers only.

1. `npm test && npm run typecheck && npm run build`
2. `npm pack` and check the tarball contents — it should be `LICENSE`,
   `README.md`, `package.json` and `dist/**`, nothing else.
3. Install that tarball into a clean directory outside this repository and run
   `storymap doctor`, `validate` and `browser --no-open` against a scratch
   Backlog.md project.
4. Bump the version in `package.json` — `storymap --version` reads it, so there
   is nothing else to change.
5. Tag the tested commit and push the tag.
6. `npm publish` (requires an account with rights to the name; npm asks for
   two-factor authentication by default).

## Licence

By contributing you agree that your contributions are licensed under the MIT
Licence, the same terms that cover the rest of the project.
