import express from 'express';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  WorkspaceHost,
  buildMapMembership,
  facets,
  filterStories,
  normalizeId,
  validate,
  buildVisualStoryMap,
} from './core';
import type { StoryFilter, WorkItem } from './core';
import { layout } from './render/layout';
import { visualMapView } from './render/visual-map';
import {
  bucketListView,
  coverageView,
  mapView,
  mapsIndexView,
  notFoundView,
  storiesView,
  storyDetailView,
} from './render/views';
import { computeCoverage } from './coverage';
import type { NavMap } from './render/layout';
import { esc } from './render/html';
import type { Project } from './project/config';

/**
 * Packaged browser assets, resolved against this module rather than the
 * process working directory: `process.cwd()` is the user's project, and after
 * a global install the two have nothing to do with each other.
 */
const STATIC_DIR = join(__dirname, 'static');

function str(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

export function createApp(project: Project) {
  const host = new WorkspaceHost(project.root, project.backlogDirectory, project.storyMapsDirectory);
  const app = express();
  app.disable('x-powered-by');

  /** Everything the persistent side panel needs, rebuilt per request. */
  const shell = (ws: ReturnType<WorkspaceHost['get']>) => ({
    version: APP_VERSION,
    projectName: project.projectName,
    counts: {
      active: ws.index.active.length,
      completed: ws.index.completed.length,
      total: ws.index.size,
    },
    // Backlog.md counts a milestone as `done/total`; mirror that.
    milestones: ws.milestones
      .filter((m) => !m.archived)
      .map((m) => {
        const inIt = ws.index.items.filter((i) => i.milestone === m.id);
        return {
          id: m.id,
          title: m.title,
          done: inIt.filter((i) => i.status === 'Done' || i.completed).length,
          total: inIt.length,
        };
      })
      .filter((m) => m.total > 0),
    maps: ws.maps.map((m): NavMap => ({
      id: m.id,
      title: m.title,
      kind: m.kind,
      stories: ws.resolve(m.id)?.counts.primary ?? 0,
    })),
    headerRight: countsBadge(ws.index.active.length, ws.index.completed.length),
  });

  app.get('/static/app.css', (_req, res) => {
    res.type('text/css').send(readFileSync(join(STATIC_DIR, 'app.css'), 'utf8'));
  });
  app.get('/static/app.js', (_req, res) => {
    res.type('text/javascript').send(readFileSync(join(STATIC_DIR, 'app.js'), 'utf8'));
  });

  /** Polled by the page so an edit by Claude or a peer lane shows up without a manual reload. */
  app.get('/api/revision', (_req, res) => {
    host.get();
    res.json({ revision: host.revision });
  });

  app.get('/api/stories', (_req, res) => {
    const ws = host.get();
    res.json({
      total: ws.index.size,
      active: ws.index.active.length,
      completed: ws.index.completed.length,
      items: ws.index.items.map((i) => ({
        id: i.id,
        title: i.title,
        status: i.status,
        completed: i.completed,
        area: i.area,
        owner: i.owner,
        wstatus: i.wstatus,
        wtype: i.wtype,
        priority: i.priority,
        dependencies: i.dependencies,
        sourcePath: i.sourcePath,
      })),
    });
  });

  app.get('/', (req, res) => {
    const ws = host.get();
    const query: Record<string, string | undefined> = {
      text: str(req.query.text),
      state: str(req.query.state),
      status: str(req.query.status),
      area: str(req.query.area),
      owner: str(req.query.owner),
      priority: str(req.query.priority),
      wstatus: str(req.query.wstatus),
      wtype: str(req.query.wtype),
      map: str(req.query.map),
      milestone: str(req.query.milestone),
    };
    const membership = buildMapMembership(ws);
    const filter: StoryFilter = query;
    const items = filterStories(ws, filter, membership).sort(compareStories);
    res.send(
      layout({
        title: 'Stories',
        nav: 'stories',
        revision: host.revision,
        ...shell(ws),
        body: storiesView({
          items,
          total: ws.index.size,
          facets: facets(ws.index.items),
          query,
          maps: ws.maps.map((m) => ({ id: m.id, title: m.title })),
          milestones: ws.milestones.map((m) => ({
            id: m.id,
            title: m.archived ? `${m.title} (archived)` : m.title,
          })),
          membership,
        }),
      }),
    );
  });

  app.get('/story/:id', (req, res) => {
    const ws = host.get();
    const item = ws.index.get(req.params.id);
    if (!item) {
      res
        .status(404)
        .send(
          layout({
            title: 'Not found',
            nav: 'stories',
            revision: host.revision,
            ...shell(ws),
            body: notFoundView(`No active or completed work item claims the id "${req.params.id}".`),
          }),
        );
      return;
    }
    const key = normalizeId(item.id);
    const memberOf: { id: string; title: string; role: 'primary' | 'supporting' }[] = [];
    const coverage = computeCoverage(ws);
    const entry = coverage.membership.get(key);
    for (const mapId of entry?.primary ?? []) {
      const map = ws.maps.find((m) => m.id === mapId);
      if (map) memberOf.push({ id: map.id, title: map.title, role: 'primary' });
    }
    for (const mapId of entry?.supporting ?? []) {
      const map = ws.maps.find((m) => m.id === mapId);
      if (map) memberOf.push({ id: map.id, title: map.title, role: 'supporting' });
    }
    const dependents = ws.index.items.filter((other) =>
      other.dependencies.some((d) => normalizeId(d) === key),
    );
    const from = str(req.query.from);
    res.send(
      layout({
        title: item.id,
        nav: from ? 'maps' : 'stories',
        revision: host.revision,
        ...shell(ws),
        body: storyDetailView(item, {
          memberOf,
          dependents,
          backHref: from ? `/maps/${encodeURIComponent(from)}` : '/',
          resolveDep: (id) => ws.index.get(id),
          milestoneTitle: ws.milestoneTitle(item.milestone),
        }),
      }),
    );
  });

  app.get('/maps', (req, res) => {
    const ws = host.get();
    res.send(
      layout({
        title: 'Story maps',
        nav: 'maps',
        revision: host.revision,
        ...shell(ws),
        body: mapsIndexView(ws.resolvedMaps, validate(ws), project.storyMapsDirectory),
      }),
    );
  });

  app.get('/maps/:id', (req, res) => {
    const ws = host.get();
    const resolved = ws.resolve(req.params.id);
    if (!resolved) {
      res
        .status(404)
        .send(
          layout({
            title: 'Not found',
            nav: 'maps',
            revision: host.revision,
            ...shell(ws),
            body: notFoundView(`No story map with id "${req.params.id}".`),
          }),
        );
      return;
    }
    const query: Record<string, string | undefined> = {
      view: str(req.query.view),
      activity: str(req.query.activity),
      completed: str(req.query.completed),
      highlight: str(req.query.highlight),
      status: str(req.query.status),
      wstatus: str(req.query.wstatus),
      lanes: str(req.query.lanes),
      density: str(req.query.density),
      milestone: str(req.query.milestone),
    };

    // The wall is the default. The earlier per-activity renderer stays reachable
    // at ?view=detailed, where its narrower columns suit dense capability maps.
    if (query.view === 'detailed') {
      res.send(
        layout({
          title: resolved.map.title,
          nav: 'maps',
          activeMapId: resolved.map.id,
          revision: host.revision,
          wide: true,
          ...shell(ws),
          body: mapView(resolved, query),
        }),
      );
      return;
    }

    // A journey is read for planning, so it opens in workflow lanes. A
    // capability map is read for coverage, where the file's own slices are the
    // more useful grouping. Either is one selector away.
    const defaultLanes = resolved.map.kind === 'journey' ? 'workflow' : 'slices';
    const laneMode =
      query.lanes === 'delivery' || query.lanes === 'workflow' || query.lanes === 'slices'
        ? query.lanes
        : defaultLanes;
    const model = buildVisualStoryMap(resolved, {
      hideCompleted: query.completed === 'hide',
      activity: query.activity,
      status: query.status,
      wstatus: query.wstatus,
      milestone: query.milestone,
      laneMode,
    });
    const onMap = new Set(resolved.referencedIds.map(normalizeId));
    const mapItems = ws.index.items.filter((i) => onMap.has(normalizeId(i.id)));
    const f = facets(mapItems);
    res.send(
      layout({
        title: resolved.map.title,
        nav: 'maps',
        activeMapId: resolved.map.id,
        revision: host.revision,
        wide: true,
        ...shell(ws),
        body: visualMapView(resolved, model, query, {
          facetStatuses: f.status.map((x) => x.value),
          facetWstatus: f.wstatus.map((x) => x.value),
          // Only milestones this map actually touches; an empty option is noise.
          milestones: ws.milestones
            .map((m) => ({
              id: m.id,
              title: m.archived ? `${m.title} (archived)` : m.title,
              count: f.milestone.find((x) => x.value === m.id)?.count ?? 0,
            }))
            .filter((m) => m.count > 0),
        }),
      }),
    );
  });

  app.get('/coverage', (req, res) => {
    const ws = host.get();
    res.send(
      layout({
        title: 'Coverage',
        nav: 'coverage',
        revision: host.revision,
        ...shell(ws),
        body: coverageView({ workspace: ws, report: validate(ws), buckets: computeCoverage(ws).buckets }),
      }),
    );
  });

  app.get('/coverage/:bucket', (req, res) => {
    const ws = host.get();
    const bucket = computeCoverage(ws).buckets.find((b) => b.key === req.params.bucket);
    if (!bucket) {
      res.status(404).send(
        layout({
          title: 'Not found',
          nav: 'coverage',
          revision: host.revision,
          ...shell(ws),
          body: notFoundView(`No coverage bucket "${req.params.bucket}".`),
        }),
      );
      return;
    }
    res.send(
      layout({
        title: bucket.label,
        nav: 'coverage',
        revision: host.revision,
        ...shell(ws),
        body: bucketListView(bucket.label, bucket.note, [...bucket.items].sort(compareStories)),
      }),
    );
  });

  app.use((_req, res) => {
    res.status(404).send(
      layout({
        title: 'Not found',
        nav: 'stories',
        revision: host.revision,
        ...shell(host.get()),
        body: notFoundView('No such page.'),
      }),
    );
  });

  return { app, host };
}

function countsBadge(active: number, completed: number): string {
  return `<span class="counts"><strong>${active}</strong> active · <strong>${completed}</strong> completed</span>`;
}

/** Version shown in the side panel, read from this app's own package.json. */
const APP_VERSION: string = (() => {
  try {
    return String(JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')).version ?? '0.0.0');
  } catch {
    return '0.0.0';
  }
})();

/**
 * Ids with the same prefix sort by their numeric tail, so `TASK-9` precedes
 * `TASK-10`. Prefixes sort against each other alphabetically, and ids with no
 * numeric tail (`AUC-SEC-02D`) sort after the numbered ones in their family.
 */
export function compareStories(a: WorkItem, b: WorkItem): number {
  const na = /^(.*?)-(\d+)$/.exec(a.id.toUpperCase());
  const nb = /^(.*?)-(\d+)$/.exec(b.id.toUpperCase());
  if (na && nb) {
    if (na[1] !== nb[1]) return na[1].localeCompare(nb[1]);
    return Number(na[2]) - Number(nb[2]);
  }
  if (na) return -1;
  if (nb) return 1;
  return a.id.localeCompare(b.id);
}

export { esc };
