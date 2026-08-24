/** HTML escaping and a small Markdown renderer for story bodies. */

export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function attr(value: unknown): string {
  return esc(value);
}

/** Percent-encodes a value for use inside a query string. */
export function q(value: string): string {
  return encodeURIComponent(value);
}

/**
 * Inline markdown, applied to already-escaped text.
 *
 * Order matters: code spans are extracted first so their contents are never
 * treated as emphasis or a link.
 */
function inline(escaped: string): string {
  const codes: string[] = [];
  // A NUL sentinel, which escaped text cannot contain, so restoring a code span
  // can never collide with a legitimate number that happens to sit between spaces.
  const MARK = "\u0000";
  let out = escaped.replace(/`([^`]+)`/g, (_m, code: string) => {
    codes.push("<code>" + code + "</code>");
    return MARK + String(codes.length - 1) + MARK;
  });
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text: string, href: string) => {
    // Only http(s) and repo-relative links; anything else renders as plain text
    // so a story body can never inject a javascript: URL into the tool.
    if (/^(https?:)?\/\//.test(href) || /^[\w./#-]+$/.test(href)) {
      return '<a href="' + href + '" rel="noreferrer">' + text + "</a>";
    }
    return text;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>");
  return out.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => codes[Number(i)]);
}

/**
 * Renders the subset of Markdown that work-item bodies actually use:
 * ATX headings, fenced code, tables, bullet and numbered lists, task lists,
 * block quotes, horizontal rules and paragraphs.
 *
 * Everything is escaped before any markup is added, so a story body cannot
 * inject HTML into the tool.
 */
export function markdown(source: string): string {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;

  const flushParagraph = (buf: string[]) => {
    if (buf.length === 0) return;
    out.push(`<p>${inline(esc(buf.join('\n')))}</p>`);
    buf.length = 0;
  };

  const paragraph: string[] = [];

  while (i < lines.length) {
    const line = lines[i];

    // fenced code
    const fence = /^\s*```(\S*)\s*$/.exec(line);
    if (fence) {
      flushParagraph(paragraph);
      const lang = fence[1];
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1;
      out.push(`<pre class="code"${lang ? ` data-lang="${attr(lang)}"` : ''}><code>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }

    // heading
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph(paragraph);
      const level = Math.min(6, heading[1].length + 1); // demote: story h1 must not fight the page h1
      out.push(`<h${level} class="md">${inline(esc(heading[2].trim()))}</h${level}>`);
      i += 1;
      continue;
    }

    // horizontal rule
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushParagraph(paragraph);
      out.push('<hr />');
      i += 1;
      continue;
    }

    // table: a header row followed by a separator row
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|?\s*$/.test(lines[i + 1])) {
      flushParagraph(paragraph);
      const cells = (row: string) =>
        row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      const header = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        rows.push(cells(lines[i]));
        i += 1;
      }
      out.push(
        `<div class="table-scroll"><table><thead><tr>${header
          .map((c) => `<th>${inline(esc(c))}</th>`)
          .join('')}</tr></thead><tbody>${rows
          .map((r) => `<tr>${r.map((c) => `<td>${inline(esc(c))}</td>`).join('')}</tr>`)
          .join('')}</tbody></table></div>`,
      );
      continue;
    }

    // block quote
    if (/^\s*>\s?/.test(line)) {
      flushParagraph(paragraph);
      const body: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        body.push(lines[i].replace(/^\s*>\s?/, ''));
        i += 1;
      }
      out.push(`<blockquote>${markdown(body.join('\n'))}</blockquote>`);
      continue;
    }

    // list (bullet, numbered, or task)
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      flushParagraph(paragraph);
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length && (/^\s*([-*+]|\d+[.)])\s+/.test(lines[i]) || /^\s{2,}\S/.test(lines[i]))) {
        if (/^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, ''));
        } else if (items.length > 0) {
          items[items.length - 1] += `\n${lines[i].trim()}`; // continuation of a wrapped item
        }
        i += 1;
      }
      const rendered = items.map((raw) => {
        const task = /^\[( |x|X)\]\s*(?:#(\d+)\s+)?([\s\S]*)$/.exec(raw);
        if (task) {
          const done = task[1].toLowerCase() === 'x';
          const num = task[2] ? `<span class="ac-num">#${esc(task[2])}</span>` : '';
          return `<li class="task ${done ? 'done' : 'open'}"><span class="box">${done ? '✓' : ''}</span>${num}<span>${inline(esc(task[3]))}</span></li>`;
        }
        return `<li>${inline(esc(raw))}</li>`;
      });
      out.push(`<${ordered ? 'ol' : 'ul'}>${rendered.join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }

    if (line.trim() === '') {
      flushParagraph(paragraph);
      i += 1;
      continue;
    }

    paragraph.push(line);
    i += 1;
  }
  flushParagraph(paragraph);
  return out.join('\n');
}
