import { describe, it, expect } from 'vitest';
import { renderMarkdown, splitTitle } from './changelog.js';

/**
 * The changelog renders text written in Discord by whoever can post in the
 * channel, so `renderMarkdown` is an untrusted-input boundary. The escaping
 * tests below are the important ones — the formatting tests exist mostly to
 * catch a regression that breaks escaping while "fixing" markdown.
 */
describe('renderMarkdown — escaping', () => {
  it('neutralises script tags', () => {
    const out = renderMarkdown('<script>alert(1)</script>');
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
  });

  // The payload text survives as inert character data — that's fine and
  // expected. What must never happen is it becoming a *tag*, so assert on the
  // markup, not on the substring.
  it('renders attribute-based payloads as inert text, never as a tag', () => {
    const out = renderMarkdown('<img src=x onerror=alert(1)>');
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('refuses javascript: links but keeps the text', () => {
    const out = renderMarkdown('[click me](javascript:alert(1))');
    expect(out).not.toContain('<a ');
    expect(out).toContain('click me');
  });

  it('only ever emits http(s) anchors', () => {
    const hostile = [
      '[a](javascript:alert(1))',
      '[b](data:text/html,<script>alert(1)</script>)',
      '[c](vbscript:msgbox(1))',
      '[d](file:///etc/passwd)',
      '<javascript:alert(1)>',
    ].join('\n\n');
    for (const href of renderMarkdown(hostile).matchAll(/<a href="([^"]*)"/g)) {
      expect(href[1]).toMatch(/^https?:\/\//);
    }
  });

  it('refuses data: links', () => {
    const out = renderMarkdown('[x](data:text/html;base64,PHNjcmlwdD4=)');
    expect(out).not.toContain('<a href="data:');
  });

  it('escapes quotes so link text cannot break out of an attribute', () => {
    const out = renderMarkdown('[a" onmouseover="alert(1)](https://example.com)');
    expect(out).not.toContain('onmouseover="alert');
  });

  it('does not let a code span smuggle markup', () => {
    const out = renderMarkdown('`<b>not bold</b>`');
    expect(out).toContain('<code>&lt;b&gt;not bold&lt;/b&gt;</code>');
  });
});

describe('renderMarkdown — formatting', () => {
  it('renders bold, italic, underline and strike', () => {
    expect(renderMarkdown('**b**')).toContain('<strong>b</strong>');
    expect(renderMarkdown('*i*')).toContain('<em>i</em>');
    expect(renderMarkdown('__u__')).toContain('<u>u</u>');
    expect(renderMarkdown('~~s~~')).toContain('<s>s</s>');
  });

  it('renders headings at h5/h6 so they nest under the entry title', () => {
    expect(renderMarkdown('# One')).toContain('<h5>One</h5>');
    expect(renderMarkdown('### Three')).toContain('<h6>Three</h6>');
  });

  it('renders bullet and numbered lists', () => {
    expect(renderMarkdown('- a\n- b')).toContain('<ul><li>a</li><li>b</li></ul>');
    expect(renderMarkdown('1. a\n2. b')).toContain('<ol><li>a</li><li>b</li></ol>');
  });

  it('renders block quotes', () => {
    expect(renderMarkdown('> quoted')).toContain('<blockquote>quoted</blockquote>');
  });

  it('keeps fenced code literal instead of parsing it as markdown', () => {
    const out = renderMarkdown('```\n- not a list\n**not bold**\n```');
    expect(out).toContain('<pre><code>');
    expect(out).not.toContain('<li>');
    expect(out).not.toContain('<strong>');
  });

  /**
   * Regression: the fence was stashed as a one-line placeholder, so the
   * line-based parser folded it into the surrounding paragraph and emitted
   * <p>…<pre>…</pre>…</p>. That is invalid HTML — browsers close the <p> early
   * and the trailing prose escapes the paragraph.
   */
  it('emits fenced code as a standalone block, never inside a paragraph', () => {
    const out = renderMarkdown('intro line\n```\ncode\n```\ntrailing line');
    expect(out).not.toMatch(/<p>(?:(?!<\/p>)[\s\S])*<pre>/);
    expect(out).toBe('<p>intro line</p><pre><code>code</code></pre><p>trailing line</p>');
  });

  it('strips the fence language tag without eating the first code line', () => {
    expect(renderMarkdown('```js\nconst a = 1;\n```')).toBe('<pre><code>const a = 1;</code></pre>');
  });

  it('linkifies bare and bracketed urls', () => {
    expect(renderMarkdown('see https://browsercoin.org now'))
      .toContain('<a href="https://browsercoin.org/"');
    expect(renderMarkdown('[site](https://browsercoin.org)'))
      .toContain('>site</a>');
  });

  it('splits paragraphs on blank lines and keeps single breaks inside one', () => {
    const out = renderMarkdown('one\ntwo\n\nthree');
    expect(out).toBe('<p>one<br>two</p><p>three</p>');
  });

  it('degrades discord-only syntax to plain text', () => {
    expect(renderMarkdown('<:tada:123>')).toContain(':tada:');
    expect(renderMarkdown('<@123456>')).toContain('@mention');
    expect(renderMarkdown('<#123456>')).toContain('#channel');
  });

  /**
   * Regression: code spans are stashed behind numeric placeholders while inline
   * formatting runs. With space delimiters, prose like "version 5 released"
   * matched the restore pattern and got swapped for a stray code span.
   */
  it('does not mistake bare digits in prose for a stashed code span', () => {
    const out = renderMarkdown('shipped version 5 released today');
    expect(out).toBe('<p>shipped version 5 released today</p>');
  });

  it('restores multiple code spans in the right order', () => {
    const out = renderMarkdown('`first` then `second`');
    expect(out).toBe('<p><code>first</code> then <code>second</code></p>');
  });
});

describe('splitTitle', () => {
  it('treats a markdown heading as the title', () => {
    expect(splitTitle('# Fork #3\nbody text')).toEqual({ title: 'Fork #3', body: 'body text' });
  });

  it('treats a fully bold first line as the title', () => {
    expect(splitTitle('**Fork #3**\nbody')).toEqual({ title: 'Fork #3', body: 'body' });
  });

  it('treats a short plain first line as the title', () => {
    expect(splitTitle('Difficulty repair\nbody')).toEqual({ title: 'Difficulty repair', body: 'body' });
  });

  it('leaves long prose as body with no title', () => {
    const long = 'x'.repeat(200);
    expect(splitTitle(long)).toEqual({ title: null, body: long });
  });
});
