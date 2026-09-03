import { BROWSERCOIN_NETWORK } from '../network.js';
import { DEFAULT_NOSTR_RELAYS, NostrTransport } from './nostr.js';
import type { SignalTransport } from './types.js';

/**
 * Which signaling substrates a node uses, and how they're configured.
 *
 * This is the settings-level counterpart to `servers.ts`: the same "plural,
 * user-replaceable, no single authority" model, applied to the layer that
 * introduces peers to each other rather than the layer that backs up chain
 * data. The two are deliberately independent — a node can run on Nostr alone
 * with every helper API server unreachable, or vice versa.
 *
 * The distinction that matters: PeerJS servers are infrastructure *this
 * project* operates, so if they are the only substrate then the network's
 * survival is tied to one person continuing to pay for and maintain two
 * hosts. Nostr relays are infrastructure that already exists for unrelated
 * reasons and will keep existing whether or not anyone here stays interested.
 * Running both means the network degrades gracefully instead of stopping.
 */

export const KEY_SUBSTRATES = 'browsercoin:signal-substrates';

export interface SubstrateConfig {
  /** PeerJS signaling servers. Empty list disables the PeerJS path entirely. */
  peerjs: string[];
  /** Nostr relay URLs. Empty list disables the Nostr path. */
  nostr: string[];
  /** Master switch for the Nostr path, so it can be off without losing the list. */
  nostrEnabled: boolean;
}

export function defaultSubstrateConfig(peerjsServers: string[]): SubstrateConfig {
  return {
    peerjs: [...peerjsServers],
    nostr: [...DEFAULT_NOSTR_RELAYS],
    nostrEnabled: true,
  };
}

export function loadSubstrateConfig(peerjsServers: string[]): SubstrateConfig {
  const fallback = defaultSubstrateConfig(peerjsServers);
  try {
    const raw = globalThis.localStorage?.getItem(KEY_SUBSTRATES);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return fallback;
    const p = parsed as Record<string, unknown>;
    return {
      // PeerJS URLs stay owned by `servers.ts` — that list is edited in its own
      // settings card and migrated from the legacy bootstrap key, so reading it
      // from two places would let them silently diverge.
      peerjs: [...peerjsServers],
      nostr: cleanUrls(p.nostr) ?? fallback.nostr,
      nostrEnabled: typeof p.nostrEnabled === 'boolean' ? p.nostrEnabled : true,
    };
  } catch {
    return fallback;
  }
}

export function saveSubstrateConfig(cfg: SubstrateConfig): void {
  try {
    globalThis.localStorage?.setItem(
      KEY_SUBSTRATES,
      JSON.stringify({ nostr: cfg.nostr, nostrEnabled: cfg.nostrEnabled }),
    );
  } catch {
    // Storage full or unavailable — the config still applies for this session.
  }
}

/**
 * Build the transport instances for a config. PeerJS is deliberately absent
 * here: it predates this abstraction and is still driven directly by
 * `PeerNetwork` (it owns peer IDs, inbound dials and its own reconnect logic,
 * none of which fit the swarm model). It runs alongside these, not through
 * them.
 */
export function buildTransports(cfg: SubstrateConfig): SignalTransport[] {
  const out: SignalTransport[] = [];
  if (cfg.nostrEnabled && cfg.nostr.length > 0) {
    out.push(new NostrTransport(cfg.nostr, BROWSERCOIN_NETWORK));
  }
  return out;
}

function cleanUrls(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    try {
      const u = new URL(trimmed);
      if (u.protocol !== 'wss:' && u.protocol !== 'ws:') continue;
      out.push(trimmed);
    } catch {
      // Not a URL — skip. The settings UI validates and warns separately.
    }
  }
  return out;
}

/** Parse the Settings textarea into relay URLs, one per line. */
export function parseRelayInput(text: string): string[] {
  return cleanUrls(text.split(/\r?\n/)) ?? [];
}
