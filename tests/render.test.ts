import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { esc, markdown } from '../src/render/html';

describe('esc', () => {
  test('escapes every character that could open a tag or attribute', () => {
    assert.equal(esc('<script>"x"&\'y\'</script>'), '&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;&lt;/script&gt;');
  });
  test('renders null and undefined as empty', () => {
    assert.equal(esc(undefined), '');
    assert.equal(esc(null), '');
  });
});

describe('markdown', () => {
  test('escapes HTML in a story body rather than rendering it', () => {
    const html = markdown('A body with <img src=x onerror=alert(1)> in it.');
    assert.ok(!html.includes('<img'));
    assert.ok(html.includes('&lt;img'));
  });

  test('renders headings demoted so they cannot fight the page h1', () => {
    assert.match(markdown('# Story title'), /<h2 class="md">Story title<\/h2>/);
    assert.match(markdown('## Section'), /<h3 class="md">Section<\/h3>/);
  });

  test('renders a fenced code block without interpreting its contents', () => {
    const html = markdown('```text\n- [ ] not a checkbox\n## not a heading\n```');
    assert.match(html, /<pre class="code" data-lang="text"><code>/);
    assert.ok(html.includes('- [ ] not a checkbox'));
    assert.ok(!html.includes('<h3'));
  });

  test('renders a table', () => {
    const html = markdown('| a | b |\n|---|---|\n| 1 | 2 |\n');
    assert.match(html, /<table><thead><tr><th>a<\/th><th>b<\/th><\/tr>/);
    assert.match(html, /<td>1<\/td><td>2<\/td>/);
  });

  test('renders task list items with their checked state and number', () => {
    const html = markdown('- [x] #1 done thing\n- [ ] #2 open thing');
    assert.match(html, /<li class="task done">/);
    assert.match(html, /<li class="task open">/);
    assert.ok(html.includes('#1'));
  });

  test('keeps a code span intact and does not confuse it with a stray number', () => {
    // The renderer swaps code spans for placeholders while it works; a bare
    // number in the surrounding prose must not be mistaken for one.
    const html = markdown('Set `RETRIES` to 3 and `TIMEOUT` to 5 seconds.');
    assert.ok(html.includes('<code>RETRIES</code>'));
    assert.ok(html.includes('<code>TIMEOUT</code>'));
    assert.ok(html.includes('to 3 and'));
    assert.ok(html.includes('to 5 seconds'));
  });

  test('renders a repo-relative link but refuses a javascript: URL', () => {
    assert.match(markdown('[doc](docs/planning/README.md)'), /<a href="docs\/planning\/README\.md"/);
    const bad = markdown('[click](javascript:alert(1))');
    assert.ok(!bad.includes('<a href'));
    assert.ok(bad.includes('click'));
  });

  test('renders a horizontal rule and a block quote', () => {
    assert.match(markdown('---'), /<hr \/>/);
    assert.match(markdown('> quoted line'), /<blockquote>/);
  });

  test('leaves a bare --- inside a story body from breaking the document', () => {
    const html = markdown('Para one.\n\n---\n\nPara two.');
    assert.ok(html.includes('Para one'));
    assert.ok(html.includes('Para two'));
  });
});
