/**
 * Cloudflare Pages Function — GET /api/patchnotes
 *
 * Mirrors a Discord patch-notes channel so the website can show the changelog
 * without anyone posting it twice. Discord has no public read API, so a bot
 * token is required; it lives here (server side, in a Pages env secret) because
 * it obviously cannot ship in browser JS.
 *
 * DEPLOYMENT: this file belongs in the BrowserCoin-Cloudflare repo, NOT in the
 * built bundle. It is copied there once and then left alone — the normal
 * frontend deploy only replaces index.html / assets / _redirects / logo.png, so
 * `functions/` survives every deploy untouched. This copy is the source of
 * truth; see cloudflare/README.md.
 *
 * Deliberately returns 200 with `ok:false` instead of an error status when
 * Discord is unreachable or unconfigured: the changelog is cosmetic, and the
 * client is expected to degrade to "read them on Discord" rather than surface a
 * failed request. Nothing about the chain depends on this endpoint.
 */

const DISCORD_API = 'https://discord.com/api/v10';
const MESSAGE_LIMIT = 50;
const CACHE_SECONDS = 300;

function json(body, { status = 200, cacheSeconds = 0 } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Cached at the edge so a burst of visitors costs one Discord call.
      'cache-control': cacheSeconds
        ? `public, max-age=${cacheSeconds}, s-maxage=${cacheSeconds}`
        : 'no-store',
      // The site is same-origin, but alt-clients and community explorers are
      // welcome to read this too.
      'access-control-allow-origin': '*',
    },
  });
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const token = env.DISCORD_BOT_TOKEN;
  const channelId = env.DISCORD_CHANNEL_ID;

  if (!token || !channelId) {
    // Name the missing variable(s). Reporting only "unconfigured" turns a typo
    // or a Preview-vs-Production mixup into a guessing game. Presence booleans
    // only — never echo the values back.
    const missing = [];
    if (!token) missing.push('DISCORD_BOT_TOKEN');
    if (!channelId) missing.push('DISCORD_CHANNEL_ID');
    return json({ ok: false, reason: 'unconfigured', missing, entries: [] });
  }

  // Serve from the edge cache when warm.
  const cache = caches.default;
  const cacheKey = new Request(new URL(request.url).toString(), { method: 'GET' });
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  let upstream;
  try {
    upstream = await fetch(
      `${DISCORD_API}/channels/${channelId}/messages?limit=${MESSAGE_LIMIT}`,
      {
        headers: {
          authorization: `Bot ${token}`,
          // Discord requires a descriptive UA on API requests.
          'user-agent': 'BrowserCoin-Changelog (https://browsercoin.org, 1.0)',
        },
      },
    );
  } catch {
    return json({ ok: false, reason: 'unreachable', entries: [] });
  }

  if (!upstream.ok) {
    // 401/403 = bad token or the bot lacks Read Message History on the channel.
    return json({
      ok: false,
      reason: upstream.status === 401 || upstream.status === 403 ? 'forbidden' : 'upstream',
      status: upstream.status,
      entries: [],
    });
  }

  const messages = await upstream.json();
  const all = Array.isArray(messages) ? messages : [];

  // Discord returns newest-first. Keep only messages with real text — a bare
  // image drop or a join notice isn't a patch note. Title/body parsing and
  // markdown rendering happen client-side so they can be iterated on with a
  // normal frontend deploy, without touching this Function.
  const withText = all.filter((m) => typeof m.content === 'string' && m.content.trim().length > 0);

  // Messages exist but every single `content` is empty → the app is missing the
  // MESSAGE CONTENT privileged intent. Discord applies that intent to REST
  // responses too, not just the gateway, and blanks the field rather than
  // erroring. Without this check the symptom is an empty changelog that looks
  // exactly like an empty channel. Enable it under Bot → Privileged Gateway
  // Intents (no app verification needed under 100 servers).
  if (all.length > 0 && withText.length === 0) {
    return json({ ok: false, reason: 'missing-message-content-intent', entries: [] });
  }

  const entries = withText
    .map((m) => ({
      id: m.id,
      timestamp: m.timestamp,
      edited: m.edited_timestamp ?? null,
      author: m.author?.global_name || m.author?.username || null,
      pinned: !!m.pinned,
      content: m.content,
      attachments: (m.attachments ?? [])
        .filter((a) => typeof a.content_type === 'string' && a.content_type.startsWith('image/'))
        .map((a) => ({ url: a.url, width: a.width ?? null, height: a.height ?? null })),
    }));

  const response = json({ ok: true, entries }, { cacheSeconds: CACHE_SECONDS });
  context.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}
