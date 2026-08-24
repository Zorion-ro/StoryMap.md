import { esc, q } from './html';

/** One entry in the persistent left panel. */
export interface NavMap {
  id: string;
  title: string;
  kind: 'journey' | 'capability';
  stories: number;
}

export interface LayoutOptions {
  title: string;
  nav: 'stories' | 'maps' | 'coverage';
  /** Map id currently open, so the panel can mark it. */
  activeMapId?: string;
  revision: number;
  /** Rendered into the sticky header, right of the title. */
  headerRight?: string;
  body: string;
  wide?: boolean;
  maps?: NavMap[];
  milestones?: { id: string; title: string; done: number; total: number }[];
  counts?: { active: number; completed: number; total: number };
  /** The project being browsed, shown left of the tool name in the header. */
  projectName: string;
  version: string;
}

/**
 * The application shell: a persistent, collapsible left panel and a header,
 * in the manner of the Backlog.md browser this tool sits beside.
 *
 * The theme is resolved before first paint by a tiny inline script, so a dark
 * reader never gets a flash of the light palette.
 */
export function layout(o: LayoutOptions): string {
  const maps = o.maps ?? [];
  const journeys = maps.filter((m) => m.kind === 'journey');
  const capabilities = maps.filter((m) => m.kind === 'capability');

  const navItem = (href: string, key: LayoutOptions['nav'], label: string, icon: string, badge?: string) =>
    `<a class="nav-item${o.nav === key && !o.activeMapId ? ' on' : ''}" href="${href}">
       <span class="nav-item__icon" aria-hidden="true">${icon}</span>
       <span class="nav-item__label">${esc(label)}</span>
       ${badge ? `<span class="nav-item__badge">${esc(badge)}</span>` : ''}
     </a>`;

  const mapItem = (m: NavMap) =>
    `<a class="nav-item nav-item--sub${o.activeMapId === m.id ? ' on' : ''}" href="/maps/${q(m.id)}">
       <span class="nav-item__icon" aria-hidden="true">${m.kind === 'journey' ? '🧭' : '⚙️'}</span>
       <span class="nav-item__label" title="${esc(m.title)}">${esc(m.title)}</span>
       <span class="nav-item__badge">${m.stories}</span>
     </a>`;

  const section = (label: string, count: number, items: string) =>
    `<div class="nav-section">
       <div class="nav-section__head">${esc(label)} <span class="nav-section__count">${count}</span></div>
       ${items}
     </div>`;

  return `<!doctype html>
<html lang="en" data-revision="${o.revision}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(o.title)} · StoryMap.md</title>
<link rel="stylesheet" href="/static/app.css" />
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ctext y='13' font-size='13'%3E%F0%9F%97%BA%3C/text%3E%3C/svg%3E" />
<script>
/* Resolve the theme and the panel state before first paint, so neither flashes. */
(function () {
  try {
    var t = localStorage.getItem('storymap.theme');
    if (t === 'dark' || t === 'light') document.documentElement.setAttribute('data-theme', t);
    if (localStorage.getItem('storymap.sidebar') === 'hidden') {
      document.documentElement.setAttribute('data-sidebar', 'hidden');
    }
  } catch (e) { /* private mode: the media query still decides */ }
})();
</script>
</head>
<body class="${o.wide ? 'wide' : ''}">
<div class="shell">

  <aside class="side" id="side">
    <div class="side__brand">
      <span class="side__logo" aria-hidden="true">🗺</span>
      <span class="side__name">StoryMap<span class="side__dot">.md</span></span>
      <button type="button" class="side__collapse" id="side-collapse"
              aria-controls="side" aria-label="Hide the side panel" title="Hide the side panel">‹</button>
    </div>

    ${section(
      'Stories',
      o.counts?.total ?? 0,
      [
        navItem('/', 'stories', 'All stories', '☰', o.counts ? String(o.counts.total) : undefined),
        navItem('/?state=active', 'stories', 'Active', '◔', o.counts ? String(o.counts.active) : undefined),
        navItem('/?state=completed', 'stories', 'Completed', '✓', o.counts ? String(o.counts.completed) : undefined),
      ].join(''),
    )}

    ${section('Journeys', journeys.length, journeys.map(mapItem).join('') || '<p class="nav-empty">none</p>')}
    ${section('Capabilities', capabilities.length, capabilities.map(mapItem).join('') || '<p class="nav-empty">none</p>')}

    ${
      (o.milestones ?? []).length
        ? section(
            'Milestones',
            (o.milestones ?? []).length,
            (o.milestones ?? [])
              .map(
                (m) => `<a class="nav-item nav-item--sub" href="/?milestone=${q(m.id)}">
                   <span class="nav-item__icon" aria-hidden="true">◎</span>
                   <span class="nav-item__label" title="${esc(m.title)}">${esc(m.title)}</span>
                   <span class="nav-item__badge">${m.done}/${m.total}</span>
                 </a>`,
              )
              .join(''),
          )
        : ''
    }

    ${section('Reports', 1, navItem('/coverage', 'coverage', 'Coverage', '◫'))}

    <div class="side__foot">
      <a href="/maps">All maps</a>
      <span class="side__version">StoryMap.md — v${esc(o.version)}</span>
    </div>
  </aside>

  <div class="main">
    <header class="top">
      <button type="button" class="top__reveal" id="side-reveal" aria-controls="side" aria-label="Show the side panel" title="Show the side panel">›</button>
      <div class="top__brand">
        <span class="top__project">${esc(o.projectName)}</span>
        <span class="top__powered">powered by <strong>StoryMap.md</strong></span>
      </div>
      <div class="top__right">
        ${o.headerRight ?? ''}
        <button type="button" class="theme" id="theme-toggle" aria-label="Switch between light and dark" title="Switch between light and dark">
          <span class="theme__icon" aria-hidden="true"></span>
        </button>
      </div>
    </header>
    <main>${o.body}</main>
  </div>
</div>
<div id="reload-toast" hidden>Files changed on disk — <button type="button" id="reload-now">reload</button></div>
<script src="/static/app.js" defer></script>
</body>
</html>`;
}
