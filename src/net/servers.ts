import {
  HELPER_DISCOVERY_NETWORK,
  loadCachedHelperRecords,
  selectHelperServers,
} from './helperDiscovery.js';

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

/**
 * The hardcoded defaults are intentionally short. They're the seed set — once
 * the community runs more helpers, add them here via a PR. Per the project's
 * "no authority" framing, distribution is via repo + release rather than an
 * inter-server gossip protocol (which would need a trust model).
 *
 * Two independent hosts on each side so a single-machine outage doesn't take
 * out new-client bootstrap. Signaling URLs are https; PeerJS upgrades to wss
 * internally (see `src/net/peer.ts:spawnPeer`).
 */
const PROD_API_SERVERS: string[] = [
  'https://api1.browsercoin.org',
  'https://api2.browsercoin.org',
];

const PROD_SIGNALING_SERVERS: string[] = [
  'https://peer1.browsercoin.org',
  'https://peer2.browsercoin.org',
];

/**
 * Local helper layout, used only when you opt in with `npm run dev:local`
 * (which sets VITE_HELPERS=local) and are running the split helpers yourself:
 *
 *   npm run server:api      → API on :9000
 *   npm run server:peerjs   → signaling on :9001
 *
 * Plain `npm run dev` joins the live browsercoin.org network instead, so the UI
 * works against real peers without standing up local servers. To exercise
 * multi-server failover locally, add a second of either kind via Settings.
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
  // Default to the live (prod) helpers everywhere, including `npm run dev`, so a
  // dev build joins the real network out of the box. Opt into local helpers with
  // `npm run dev:local` (sets VITE_HELPERS=local) when running server:api/peerjs.
  const useLocal = (import.meta as { env?: { VITE_HELPERS?: string } }).env?.VITE_HELPERS === 'local';
  return {
    api: useLocal ? [...DEV_API_SERVERS] : [...PROD_API_SERVERS],
    signaling: useLocal ? [...DEV_SIGNALING_SERVERS] : [...PROD_SIGNALING_SERVERS],
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

  // No complete persisted config — try dynamic helper records before hardcoded defaults.
  const discovered = selectHelperServers(loadCachedHelperRecords(), {
    nowSeconds: Math.floor(Date.now() / 1000),
    network: HELPER_DISCOVERY_NETWORK,
    defaults: defaultServerLists(),
  });
  return {
    api: api ?? discovered.api,
    signaling: sig ?? discovered.signaling,
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
