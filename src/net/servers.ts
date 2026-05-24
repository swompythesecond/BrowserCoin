/**
 * Multi-server helper configuration. Replaces the legacy single-bootstrap-URL
 * model with two independent lists:
 *
 *   • API servers       — HTTP endpoints for chain backup, peer discovery,
 *                         heartbeat, stats. Clients try them in health order
 *                         for reads and fan out writes to every reachable one.
 *
 *   • Signaling servers — WebSocket endpoints for PeerJS. Clients register on
 *                         every one in parallel, so an inbound dial can reach
 *                         them via whichever signaling server is alive. Once a
 *                         WebRTC connection is established it's independent of
 *                         the signaling server that brokered it.
 *
 * An operator can run either, both, or neither — the two lists are completely
 * independent. The chain itself is end-to-end peer-to-peer; these servers are
 * helpers, not authorities.
 */

const PROD_HELPER = 'https://browsercoin.pauledevelopment.com';

/**
 * The hardcoded defaults are intentionally short. They're the seed set — once
 * the community runs more helpers, add them here via a PR. Per the project's
 * "no authority" framing, distribution is via repo + release rather than an
 * inter-server gossip protocol (which would need a trust model).
 */
const PROD_API_SERVERS: string[] = [
  PROD_HELPER,
];

const PROD_SIGNALING_SERVERS: string[] = [
  PROD_HELPER,
];

/**
 * Dev defaults map to the split-helper layout:
 *
 *   npm run server:api      → API on :9000
 *   npm run server:peerjs   → signaling on :9001
 *
 * To exercise multi-server failover locally, add a second of either kind via
 * Settings (e.g. start `tsx server/api.ts --port 9002` and add it to the
 * API list, then kill :9000 and watch reads transparently fall over).
 */
const DEV_API_SERVERS: string[] = [
  'http://localhost:9000',
];

const DEV_SIGNALING_SERVERS: string[] = [
  'http://localhost:9001',
];

const KEY_API = 'browsercoin:api-servers';
const KEY_SIG = 'browsercoin:signaling-servers';
const LEGACY_KEY = 'browsercoin:bootstrap';

export interface ServerLists {
  api: string[];
  signaling: string[];
}

export function defaultServerLists(): ServerLists {
  const isDev = !!(import.meta as { env?: { DEV?: boolean } }).env?.DEV;
  return {
    api: isDev ? [...DEV_API_SERVERS] : [...PROD_API_SERVERS],
    signaling: isDev ? [...DEV_SIGNALING_SERVERS] : [...PROD_SIGNALING_SERVERS],
  };
}

/**
 * Load lists from localStorage, falling back to the hardcoded defaults. Also
 * performs a one-shot migration from the legacy `browsercoin:bootstrap`
 * single-URL key: if the new keys are absent but the legacy one exists, seed
 * both new lists with that one URL. The legacy key is left in place so a
 * downgrade to a previous build doesn't break.
 */
export function loadServerLists(): ServerLists {
  const fromLs = (key: string): string[] | null => {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return null;
      const cleaned = parsed
        .filter((s): s is string => typeof s === 'string')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      return cleaned;
    } catch {
      return null;
    }
  };

  const api = fromLs(KEY_API);
  const sig = fromLs(KEY_SIG);

  if (api && sig) return { api, signaling: sig };

  // Legacy migration — single URL → seed both lists with it.
  const legacy = localStorage.getItem(LEGACY_KEY)?.trim();
  if (legacy) {
    const lists: ServerLists = {
      api: api ?? [legacy],
      signaling: sig ?? [legacy],
    };
    saveServerLists(lists);
    return lists;
  }

  // No persisted config — fall back to hardcoded defaults.
  return {
    api: api ?? defaultServerLists().api,
    signaling: sig ?? defaultServerLists().signaling,
  };
}

export function saveServerLists(lists: ServerLists): void {
  const dedupe = (urls: string[]): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const u of urls) {
      const trimmed = u.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      out.push(trimmed);
    }
    return out;
  };
  localStorage.setItem(KEY_API, JSON.stringify(dedupe(lists.api)));
  localStorage.setItem(KEY_SIG, JSON.stringify(dedupe(lists.signaling)));
}

/**
 * Best-effort URL validation. Accepts only http(s) URLs we can parse. Empty
 * strings are silently dropped (lets the Settings textarea have blank lines).
 */
export function parseServerInput(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    try {
      const u = new URL(trimmed);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
      // Strip trailing slash for canonical comparison.
      const canonical = u.origin + u.pathname.replace(/\/$/, '');
      out.push(canonical);
    } catch {
      // Invalid URL — skip silently. Settings UI can warn separately.
    }
  }
  return out;
}
