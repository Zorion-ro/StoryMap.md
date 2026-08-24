import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, describe, before, after } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/server';
import { projectAt } from '../src/project/config';

const MAP = `schemaVersion: 1
id: demo-journey
title: Demo journey
kind: journey
summary: A demo journey.
personas:
  - seller
releaseSlices:
  - id: delivered
    title: Delivered
    order: 10
    expects: completed
  - id: planned
    title: Not yet delivered
    order: 20
    expects: active
activities:
  - id: gather
    title: Gather the thing
    steps:
      - id: first-step
        title: The first step
        slices:
          delivered:
            - STORY-001
          planned:
            - STORY-002
      - id: second-step
        title: The second step
        slices:
          planned:
            - STORY-003
        supporting:
          - STORY-004
  - id: finish
    title: Finish the thing
    steps:
      - id: last-step
        title: The last step
        slices:
          planned:
            - STORY-404
`;

function story(id: string, o: { status: string; completed: boolean; wstatus?: string; title?: string; wtype?: string; milestone?: string }): string {
  return `---
id: ${id}
title: ${o.title ?? `Story ${id}`}
status: ${o.status}
assignee: []
created_date: '2026-08-01 10:00'
labels:
  - 'area:demo'
  - 'priority:p0'
${o.wstatus ? `  - 'wstatus:${o.wstatus}'\n` : ''}${o.wtype ? `  - 'wtype:${o.wtype}'\n` : ''}dependencies: []
${o.milestone ? `milestone: ${o.milestone}` : ''}
priority: high
type: story
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Body of ${id}.
<!-- SECTION:DESCRIPTION:END -->
`;
}

let root: string;
let server: Server;
let base: string;

async function get(path: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.text() };
}

describe('visual story-map view', () => {
  before(async () => {
    root = mkdtempSync(join(tmpdir(), 'sm-vm-'));
    mkdirSync(join(root, 'backlog/tasks'), { recursive: true });
    mkdirSync(join(root, 'backlog/completed'), { recursive: true });
    mkdirSync(join(root, 'backlog/story-maps'), { recursive: true });
    writeFileSync(
      join(root, 'backlog/completed/1.md'),
      story('STORY-001', { status: 'Done', completed: true, wstatus: 'done', title: 'A delivered thing', wtype: 'fix' }),
    );
    writeFileSync(
      join(root, 'backlog/tasks/2.md'),
      story('STORY-002', { status: 'In Progress', completed: false, wstatus: 'in_progress', title: 'A current thing', wtype: 'bug', milestone: 'm-0' }),
    );
    writeFileSync(
      join(root, 'backlog/tasks/3.md'),
      story('STORY-003', { status: 'To Do', completed: false, wstatus: 'blocked', title: 'A blocked thing' }),
    );
    writeFileSync(
      join(root, 'backlog/completed/4.md'),
      story('STORY-004', { status: 'Done', completed: true, wstatus: 'done', title: 'A supporting thing', wtype: 'security' }),
    );
    mkdirSync(join(root, 'backlog/milestones'), { recursive: true });
    writeFileSync(
      join(root, 'backlog/milestones/m-0 - alfa.md'),
      '---\nid: m-0\ntitle: "Alfa Release 2.0"\n---\n\n## Description\n\nMilestone.\n',
    );
    writeFileSync(join(root, 'backlog/story-maps/demo.yaml'), MAP);

    const { app } = createApp(projectAt(root));
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  });

  test('the visual wall is the default map view', async () => {
    const { status, body } = await get('/maps/demo-journey');
    assert.equal(status, 200);
    assert.ok(body.includes('sm-wall'), 'renders the wall, not the older per-activity view');
    assert.ok(body.includes('class="sm-grid"'));
  });

  test('renders activity names spanning their own steps', async () => {
    const { body } = await get('/maps/demo-journey');
    assert.ok(body.includes('Gather the thing'));
    assert.ok(body.includes('Finish the thing'));
    // Two steps under `gather`, one under `finish`.
    assert.ok(body.includes('grid-column: span 2;'));
    assert.ok(body.includes('grid-column: span 1;'));
  });

  test('renders step names beneath the activities, numbered per activity', async () => {
    const { body } = await get('/maps/demo-journey');
    assert.ok(body.includes('The first step'));
    assert.ok(body.includes('The second step'));
    assert.ok(body.includes('The last step'));
    assert.ok(body.includes('data-step="first-step"'));
  });

  test('renders one lane per declared slice, with its own count', async () => {
    // A journey opens in workflow lanes now, so ask for the file's own slices.
    const { body } = await get('/maps/demo-journey?lanes=slices');
    assert.ok(body.includes('sm-lane-label--delivered'));
    assert.ok(body.includes('Delivered'));
    assert.ok(body.includes('Not yet delivered'));
    assert.ok(body.includes('1 story'), 'a lane with one story is not pluralised');
  });

  test('places cards in cells keyed by lane and step', async () => {
    const { body } = await get('/maps/demo-journey?lanes=slices');
    assert.ok(body.includes('data-lane="delivered" data-step="first-step"'));
    assert.ok(body.includes('data-lane="planned" data-step="second-step"'));
    assert.ok(body.includes('data-story="STORY-001"'));
    assert.ok(body.includes('A delivered thing'));
  });

  test('a completed card is visible and marked as such', async () => {
    const { body } = await get('/maps/demo-journey');
    assert.ok(body.includes('sm-card--done'));
    assert.ok(body.includes('data-completed="1"'));
  });

  test('status is carried as text, not colour alone', async () => {
    const { body } = await get('/maps/demo-journey');
    assert.ok(body.includes('>Done</span>'));
    assert.ok(body.includes('>In Progress</span>'));
    assert.ok(body.includes('>To Do</span>'));
  });

  test('a delivery label that merely restates the status is not repeated', async () => {
    const { body } = await get('/maps/demo-journey');
    assert.ok(!body.includes('sm-pill--soft">done<'), 'no "Done" + "done" on one card');
    assert.ok(body.includes('sm-pill--soft">blocked<'), 'a label that adds something is kept');
  });

  test('supporting stories render outside the grid, in their own region', async () => {
    const { body } = await get('/maps/demo-journey');
    const panelAt = body.indexOf('sm-supporting');
    const gridEnd = body.indexOf('</div>\n    </div>');
    assert.ok(panelAt > -1, 'the supporting region exists');
    assert.ok(body.includes('A supporting thing'));
    assert.ok(body.includes('sm-card--supporting'));
    // The supporting card must not also appear inside a grid cell.
    const grid = body.slice(body.indexOf('class="sm-grid"'), panelAt > gridEnd ? panelAt : body.length);
    assert.ok(!grid.includes('data-story="STORY-004"'), 'not mixed into the primary journey grid');
  });

  test('an unresolved reference is drawn as a broken card', async () => {
    const { body } = await get('/maps/demo-journey');
    assert.ok(body.includes('sm-card--missing'));
    assert.ok(body.includes('STORY-404'));
    assert.ok(body.includes('unresolved story reference'));
  });

  test('a card links to the canonical story detail, carrying the map back-link', async () => {
    const { body } = await get('/maps/demo-journey');
    assert.ok(body.includes('href="/story/STORY-001?from=demo-journey"'));
    const detail = await get('/story/STORY-001?from=demo-journey');
    assert.equal(detail.status, 200);
    assert.ok(detail.body.includes('A delivered thing'));
    assert.ok(detail.body.includes('href="/maps/demo-journey"'));
  });

  test('hide completed removes completed cards from the wall', async () => {
    const { body } = await get('/maps/demo-journey?completed=hide');
    assert.ok(!body.includes('data-story="STORY-001"'));
    assert.ok(body.includes('data-story="STORY-002"'));
    assert.ok(body.includes('hidden by filters'));
  });

  test('the highlight value round-trips so client script can act on it', async () => {
    const { body } = await get('/maps/demo-journey?highlight=STORY-002');
    assert.ok(body.includes('value="STORY-002"'));
  });

  test('focusing an activity narrows the wall and offers a way back', async () => {
    const { body } = await get('/maps/demo-journey?activity=finish');
    assert.ok(body.includes('Finish the thing'));
    assert.ok(!body.includes('Gather the thing'));
    assert.ok(body.includes('show all'));
  });

  test('derived delivery lanes are opt-in and say that they are derived', async () => {
    const plain = await get('/maps/demo-journey?lanes=slices');
    assert.ok(!plain.body.includes('derived from each story'));
    const derived = await get('/maps/demo-journey?lanes=delivery');
    assert.ok(derived.body.includes('derived from each story'));
    assert.ok(derived.body.includes('In progress'));
    assert.ok(derived.body.includes('Later'));
    assert.ok(derived.body.includes('Release slices'), 'names the way back to the file view');
  });

  test('density is a URL-addressable attribute, not client state', async () => {
    assert.ok((await get('/maps/demo-journey?density=compact')).body.includes('data-density="compact"'));
    assert.ok((await get('/maps/demo-journey')).body.includes('data-density="normal"'));
  });

  test('a status filter narrows the wall', async () => {
    const { body } = await get('/maps/demo-journey?status=In+Progress');
    assert.ok(body.includes('data-story="STORY-002"'));
    assert.ok(!body.includes('data-story="STORY-003"'));
  });

  test('the legend explains every colour it uses', async () => {
    const { body } = await get('/maps/demo-journey');
    assert.ok(body.includes('sm-legend'));
    assert.ok(body.includes('sm-swatch--blocked'));
    assert.ok(body.includes('Supporting / cross-cutting'));
  });

  test('the detailed view stays reachable and renders the older layout', async () => {
    const { status, body } = await get('/maps/demo-journey?view=detailed');
    assert.equal(status, 200);
    assert.ok(body.includes('map-grid-inner'), 'the earlier renderer');
    assert.ok(!body.includes('class="sm-grid"'));
    assert.ok(body.includes('data-story-id="STORY-001"'));
  });

  test('both views expose the map source path', async () => {
    assert.ok((await get('/maps/demo-journey')).body.includes('story-maps/demo.yaml'));
    assert.ok((await get('/maps/demo-journey?view=detailed')).body.includes('story-maps/demo.yaml'));
  });

  test('cards are anchors, so keyboard users can reach them', async () => {
    const { body } = await get('/maps/demo-journey');
    assert.ok(/<a class="sm-card[^"]*"\s+href="\/story\//.test(body));
  });

  test('the scroll region is labelled and focusable', async () => {
    const { body } = await get('/maps/demo-journey');
    assert.ok(body.includes('role="region"'));
    assert.ok(body.includes('aria-label="Story map, scrolls horizontally"'));
    assert.ok(body.includes('tabindex="0"'));
  });

  test('a malformed map still fails the same way it did before', async () => {
    writeFileSync(join(root, 'backlog/story-maps/broken.yaml'), 'schemaVersion: 9\nid: broken\ntitle: Broken\n');
    const { status } = await get('/maps/broken');
    assert.equal(status, 404, 'an unparsed map is not a map');
    const maps = await get('/maps');
    assert.ok(maps.body.includes('validation error'), 'and the overview says so');
    rmSync(join(root, 'backlog/story-maps/broken.yaml'));
  });

  test('an empty result explains itself instead of rendering a blank wall', async () => {
    const { body } = await get('/maps/demo-journey?status=Nonexistent');
    assert.ok(body.includes('No stories match these filters'));
  });

describe('workflow lanes, work type, legend and shell', () => {
  test('a journey opens in workflow lanes by default', async () => {
    const { body } = await get('/maps/demo-journey');
    assert.ok(body.includes('Workflow state (derived)'));
    assert.ok(body.includes("derived from each story's <strong>workflow state</strong>".replace(/<[^>]+>/g, '')) ||
      body.includes('workflow state'), 'the note names the mode it is actually in');
    assert.ok(body.includes('IN PROGRESS') || body.includes('In progress'));
  });

  test('Done is the bottom lane in the rendered wall', async () => {
    const { body } = await get('/maps/demo-journey?lanes=workflow');
    const laneOrder = [...body.matchAll(/sm-lane-label sm-lane-label--([a-z]+)"/g)].map((m) => m[1]);
    assert.ok(laneOrder.length > 1, 'more than one lane is rendered');
    assert.equal(laneOrder[laneOrder.length - 1], 'delivered', 'the Done lane renders last');
    assert.ok(laneOrder.indexOf('progress') < laneOrder.length - 1, 'unfinished work comes first');
  });

  test('every card shows its work type beside the id', async () => {
    const { body } = await get('/maps/demo-journey');
    assert.ok(body.includes('sm-card__type'));
    assert.ok(/sm-card__id">STORY-002<\/span>\s*<span class="sm-card__type">Bug<\/span>/.test(body) ||
      body.includes('>Bug</span>'), 'the normalised wtype is rendered');
  });

  test('a story without a wtype shows no type rather than a generic one', async () => {
    // STORY-003 carries no wtype label on purpose.
    const { body } = await get('/maps/demo-journey');
    assert.ok(!body.includes('sm-card__type">story<'), 'never the native type');
    assert.ok(!body.includes('sm-card__type">undefined<'));
  });

  test('the legend is visible without being opened and names the active lane mode', async () => {
    const workflow = await get('/maps/demo-journey?lanes=workflow');
    assert.ok(workflow.body.includes('<details class="sm-legend" id="sm-legend" open>'), 'open by default');
    assert.ok(workflow.body.includes('Card status'));
    for (const label of ['Done', 'In Progress', 'To Do', 'Backlog', 'Blocked']) {
      assert.ok(workflow.body.includes(`>${label}</span>`), `legend explains ${label}`);
    }
    assert.ok(workflow.body.includes('Workflow lanes (derived)'));

    const slices = await get('/maps/demo-journey?lanes=slices');
    assert.ok(slices.body.includes('Release slices (from the map file)'));
    assert.ok(slices.body.includes('Not yet delivered'), 'the file’s own slice names');
    assert.ok(!slices.body.includes('Workflow lanes (derived)'));
  });

  test('legend swatches reuse the same tone classes as the cards', async () => {
    const { body } = await get('/maps/demo-journey');
    // One tone model: the swatch class and the card class share their suffix.
    assert.ok(body.includes('sm-swatch--blocked') && body.includes('sm-card--blocked'));
    assert.ok(body.includes('sm-swatch--done') && body.includes('sm-card--done'));
  });

  test('highlight keeps the selected lane mode', async () => {
    const { body } = await get('/maps/demo-journey?lanes=workflow&highlight=STORY-003');
    assert.ok(body.includes('value="STORY-003"'));
    assert.ok(body.includes('Workflow state (derived)'));
    assert.ok(body.includes('name="lanes"'));
  });

  test('filters still narrow the wall in workflow mode', async () => {
    const { body } = await get('/maps/demo-journey?lanes=workflow&status=In+Progress');
    assert.ok(body.includes('data-story="STORY-002"'));
    assert.ok(!body.includes('data-story="STORY-003"'));
  });

  test('empty derived lanes collapse rather than sitting as blank bands', async () => {
    const { body } = await get('/maps/demo-journey?lanes=workflow&status=In+Progress');
    const lanes = [...body.matchAll(/sm-lane-label sm-lane-label--([a-z]+)"/g)].map((m) => m[1]);
    assert.equal(lanes.length, 1, 'only the lane that still has cards');
  });

  test('the shell names the tool and lists the maps, on every page', async () => {
    for (const path of ['/', '/maps/demo-journey', '/coverage']) {
      const { body } = await get(path);
      assert.ok(body.includes('StoryMap'), `${path} carries the brand`);
      assert.ok(body.includes('class="side"'), `${path} has the side panel`);
      assert.ok(body.includes('powered by <strong>StoryMap.md</strong>'));
      assert.ok(body.includes('Demo journey'), `${path} lists the map in the panel`);
    }
  });

  test('the side panel and theme can be toggled, and the map is marked active', async () => {
    const { body } = await get('/maps/demo-journey');
    assert.ok(body.includes('id="side-collapse"'));
    assert.ok(body.includes('id="side-reveal"'));
    assert.ok(body.includes('id="theme-toggle"'));
    assert.ok(body.includes('nav-item nav-item--sub on'), 'the open map is marked in the panel');
  });

  test('the toolbar offers a milestone filter, named and counted', async () => {
    const { body } = await get('/maps/demo-journey');
    assert.ok(body.includes('name="milestone"'), 'the map toolbar has the filter');
    assert.ok(body.includes('>Milestone<'), 'and it is labelled');
    assert.ok(body.includes('Alfa Release 2.0 (1)'), 'shown by title with a count, not a bare id');
    assert.ok(body.includes('>No milestone<'));
  });

  test('the milestone filter narrows the wall without changing placement', async () => {
    const all = await get('/maps/demo-journey');
    assert.ok(all.body.includes('data-story="STORY-002"'));
    assert.ok(all.body.includes('data-story="STORY-003"'));

    const only = await get('/maps/demo-journey?milestone=m-0');
    assert.ok(only.body.includes('data-story="STORY-002"'));
    assert.ok(!only.body.includes('data-story="STORY-003"'), 'a story in no milestone drops out');
    assert.ok(only.body.includes('The first step'), 'the journey structure is untouched');

    const none = await get('/maps/demo-journey?milestone=none');
    assert.ok(!none.body.includes('data-story="STORY-002"'));
    assert.ok(none.body.includes('data-story="STORY-003"'));
  });

  test('the stories page filters by milestone too', async () => {
    assert.match((await get('/?milestone=m-0')).body, /<strong>1<\/strong> shown of 4/);
    assert.match((await get('/?milestone=none')).body, /<strong>3<\/strong> shown of 4/);
    assert.ok((await get('/')).body.includes('any milestone'));
  });

  test('the story detail names its milestone and links back to the filter', async () => {
    const withOne = await get('/story/STORY-002');
    assert.ok(withOne.body.includes('Milestone'));
    assert.ok(withOne.body.includes('Alfa Release 2.0'));
    assert.ok(withOne.body.includes('href="/?milestone=m-0"'));

    const without = await get('/story/STORY-003');
    assert.ok(without.body.includes('>none</span>'), 'a story in no milestone says so');
  });

  test('the side panel lists the milestone with a done/total badge', async () => {
    const { body } = await get('/');
    assert.ok(body.includes('Milestones'));
    assert.ok(body.includes('title="Alfa Release 2.0"'));
    assert.ok(body.includes('href="/?milestone=m-0"'));
  });

  test('the theme is resolved before first paint', async () => {
    const { body } = await get('/');
    assert.ok(body.includes("localStorage.getItem('storymap.theme')"));
    assert.ok(body.indexOf('storymap.theme') < body.indexOf('<body'), 'the resolver runs in the head');
  });
});
});
