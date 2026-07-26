/**
 * Changelog tab — renders patch notes mirrored from the Discord channel by the
 * /api/patchnotes Pages Function (see cloudflare/functions/api/patchnotes.js).
 *
 * The endpoint is same-origin and optional. Local dev, forks, and self-hosted
 * copies have no Function behind it, so every failure path — 404, unconfigured,
 * Discord down — collapses to the same friendly "read them on Discord" card
 * rather than an error. Nothing here can affect the node.
 *
 * All Discord content is untrusted input: it is HTML-escaped BEFORE any
 * markdown transformation, and link hrefs are protocol-checked. Never
 * reorder those two steps.
 */

const ENDPOINT = '/api/patchnotes';
const DISCORD_INVITE = 'https://discord.gg/xV3De6ErTr';

interface Entry {
  id: string;
  timestamp: string;
  edited: string | null;
  author: string | null;
  pinned: boolean;
  content: string;
  attachments: { url: string; width: number | null; height: number | null }[];
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Only http(s) links survive — blocks javascript:/data: smuggled through markdown. */
function safeHref(raw: string): string | null {
  const url = raw.replace(/&amp;/g, '&').trim();
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

function link(href: string, text: string): string {
  const safe = safeHref(href);
  if (!safe) return text;
  return `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
}

/** Inline formatting. Input is ALREADY html-escaped. */
function renderInline(s: string): string {
  // Discord's own angle-bracket syntax, now escaped to &lt;…&gt;.
  s = s.replace(/&lt;t:(\d+)(?::[tTdDfFR])?&gt;/g, (_m, unix: string) =>
    new Date(Number(unix) * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }));
  s = s.replace(/&lt;a?:(\w+):\d+&gt;/g, ':$1:');       // custom emoji → :name:
  s = s.replace(/&lt;@[!&amp;]?\d+&gt;/g, '@mention');
  s = s.replace(/&lt;#\d+&gt;/g, '#channel');
  // <https://…> — Discord's "no embed" wrapper.
  s = s.replace(/&lt;(https?:\/\/[^\s&]+)&gt;/g, (_m, u: string) => link(u, escapeHtml(u)));

  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, text: string, href: string) => link(href, text));
  // Bare URLs, skipping any already inside an href="…" or >…</a>.
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_m, pre: string, u: string) => `${pre}${link(u, escapeHtml(u))}`);

  s = s.replace(/~~([\s\S]+?)~~/g, '<s>$1</s>');
  s = s.replace(/\*\*([\s\S]+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([\s\S]+?)__/g, '<u>$1</u>');
  s = s.replace(/(^|[^*])\*(?!\s)([^*\n]+?)\*/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^\w_])_(?!\s)([^_\n]+?)_(?![\w_])/g, '$1<em>$2</em>');
  return s;
}

/**
 * Discord-flavoured markdown → HTML. Escapes first, then transforms, so no
 * author-supplied markup can survive. Code spans are pulled out before inline
 * formatting runs and restored afterwards, so their contents stay literal.
 */
export function renderMarkdown(src: string): string {
  const codes: string[] = [];
  // NUL sentinels, not spaces: a plain `3` placeholder would collide with
  // ordinary prose ("version 5 released") and swap real text for a code span.
  // Block-level stashes carry a `B` marker and are forced onto their own line
  // so the parser emits them standalone — a <pre> absorbed into a <p> is invalid
  // HTML, and browsers recover by splitting the paragraph around it.
  const stashBlock = (html: string): string => `\n\u0000B${codes.push(html) - 1}\u0000\n`;
  const stash = (html: string): string => `\u0000${codes.push(html) - 1}\u0000`;

  let text = escapeHtml(src);

  text = text.replace(/```(?:(\w+)\n)?([\s\S]*?)```/g, (_m, _lang: string, body: string) =>
    stashBlock(`<pre><code>${body.replace(/^\n/, '').replace(/\n$/, '')}</code></pre>`));
  text = text.replace(/`([^`\n]+)`/g, (_m, body: string) => stash(`<code>${body}</code>`));

  const out: string[] = [];
  let list: { type: 'ul' | 'ol'; items: string[] } | null = null;
  let para: string[] = [];
  let quote: string[] = [];

  const flushPara = (): void => {
    if (para.length) { out.push(`<p>${renderInline(para.join('<br>'))}</p>`); para = []; }
  };
  const flushList = (): void => {
    if (list) {
      out.push(`<${list.type}>${list.items.map((i) => `<li>${renderInline(i)}</li>`).join('')}</${list.type}>`);
      list = null;
    }
  };
  const flushQuote = (): void => {
    if (quote.length) { out.push(`<blockquote>${renderInline(quote.join('<br>'))}</blockquote>`); quote = []; }
  };
  const flushAll = (): void => { flushPara(); flushList(); flushQuote(); };

  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();

    if (!line.trim()) { flushAll(); continue; }

    const blockCode = /^\u0000B\d+\u0000$/.exec(line);
    if (blockCode) { flushAll(); out.push(line); continue; }

    const header = /^(#{1,3})\s+(.*)$/.exec(line);
    if (header) {
      flushAll();
      const tag = header[1]!.length >= 3 ? 'h6' : 'h5';
      out.push(`<${tag}>${renderInline(header[2]!)}</${tag}>`);
      continue;
    }

    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      flushPara(); flushQuote();
      if (list?.type !== 'ul') { flushList(); list = { type: 'ul', items: [] }; }
      list.items.push(bullet[1]!);
      continue;
    }

    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      flushPara(); flushQuote();
      if (list?.type !== 'ol') { flushList(); list = { type: 'ol', items: [] }; }
      list.items.push(numbered[1]!);
      continue;
    }

    const quoted = /^&gt;\s?(.*)$/.exec(line);
    if (quoted) { flushPara(); flushList(); quote.push(quoted[1]!); continue; }

    flushList(); flushQuote();
    para.push(line);
  }
  flushAll();

  return out.join('').replace(/\u0000B?(\d+)\u0000/g, (_m, i: string) => codes[Number(i)]!);
}

/** First line becomes the entry title, unless it reads like prose. */
export function splitTitle(content: string): { title: string | null; body: string } {
  const nl = content.indexOf('\n');
  const first = (nl === -1 ? content : content.slice(0, nl)).trim();
  const rest = nl === -1 ? '' : content.slice(nl + 1);

  const stripped = first.replace(/^#{1,3}\s+/, '').replace(/^\*\*([\s\S]+)\*\*$/, '$1').trim();
  const looksLikeHeading = /^#{1,3}\s/.test(first) || /^\*\*[\s\S]+\*\*$/.test(first);

  if (stripped && (looksLikeHeading || stripped.length <= 120)) {
    return { title: stripped, body: rest };
  }
  return { title: null, body: content };
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
}

function renderEntry(e: Entry): string {
  const { title, body } = splitTitle(e.content);
  const images = e.attachments
    .map((a) => `<img class="changelog-img" src="${escapeHtml(a.url)}" alt="" loading="lazy" />`)
    .join('');

  return `
    <section class="changelog-entry">
      <div class="changelog-meta">
        <time datetime="${escapeHtml(e.timestamp)}">${escapeHtml(formatDate(e.timestamp))}</time>
        ${e.pinned ? '<span class="changelog-pin">pinned</span>' : ''}
      </div>
      ${title ? `<h4 class="changelog-title">${renderInline(escapeHtml(title))}</h4>` : ''}
      ${renderMarkdown(body)}
      ${images}
    </section>
  `;
}

function fallbackCard(message: string): string {
  return `
    <div class="changelog-fallback">
      <p>${message}</p>
      <p>
        <a href="${DISCORD_INVITE}" target="_blank" rel="noopener noreferrer">Read the patch notes on Discord →</a>
      </p>
    </div>
  `;
}

/**
 * Renders into `mount` and returns a cleanup that cancels the in-flight fetch —
 * without it, switching tabs mid-request would write into a detached node.
 */
export function renderChangelog(mount: HTMLElement): () => void {
  const controller = new AbortController();

  mount.innerHTML = `
    <h3>Patch notes</h3>
    <p class="changelog-intro">
      Posted to <a href="${DISCORD_INVITE}" target="_blank" rel="noopener noreferrer">Discord</a>
      and mirrored here automatically.
    </p>
    <div class="changelog-loading muted">Loading…</div>
  `;
  const slot = mount.querySelector<HTMLElement>('.changelog-loading')!;

  fetch(ENDPOINT, { signal: controller.signal, headers: { accept: 'application/json' } })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((data: { ok?: boolean; entries?: Entry[] }) => {
      const entries = data.ok && Array.isArray(data.entries) ? data.entries : [];
      if (!data.ok) {
        slot.outerHTML = fallbackCard('The changelog mirror is not available right now.');
        return;
      }
      if (!entries.length) {
        slot.outerHTML = fallbackCard('No patch notes have been posted yet.');
        return;
      }
      slot.outerHTML = entries.map(renderEntry).join('');
    })
    .catch((err: unknown) => {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      slot.outerHTML = fallbackCard('The changelog mirror is not available right now.');
    });

  return () => controller.abort();
}
