import {
  helperRecordHash,
  isHelperRecordUsable,
  type HelperRecord,
} from './helperRecords.js';
import { BROWSERCOIN_NETWORK } from './network.js';
import type { ProtoMsg } from './protocol.js';

export const HELPER_DISCOVERY_NETWORK = BROWSERCOIN_NETWORK;

const CACHE_KEY = 'browsercoin:helper-records';
const MAX_RECORDS = 200;
const MAX_RESPONSE_ITEMS = 1_000;
/**
 * Anti-flood caps applied when records enter the cache (not just at selection).
 * A single operator key or registrable domain may occupy at most this many of
 * the 200 cache slots, so one operator can't flood the cache and evict honest
 * records before selection ever runs. This is identity-neutral and therefore
 * bounded: an attacker who mints many operator keys across many domains still
 * defeats it — perfect Sybil resistance is impossible in a permissionless model
 * with free identities. Real safety rests on (a) every block being validated
 * locally regardless of which helper served it, and (b) the hardcoded seed
 * defaults always remaining in the selected set (see selectHelperServers).
 */
const MAX_CACHE_PER_OPERATOR = 8;
const MAX_CACHE_PER_DOMAIN = 8;

export interface MergeOptions {
  nowSeconds: number;
  network: string;
  source: string;
}

export interface MergeResult {
  records: HelperRecord[];
  rejected: Array<{ source: string; reason: string }>;
}

export interface SelectionOptions {
  nowSeconds: number;
  network: string;
  maxPerOperator?: number;
  maxPerDomain?: number;
  maxServers?: number;
  defaults?: { api: string[]; signaling: string[] };
}

export function mergeHelperRecords(existing: HelperRecord[], incoming: HelperRecord[], opts: MergeOptions): MergeResult {
  const byHash = new Map<string, HelperRecord>();
  const rejected: Array<{ source: string; reason: string }> = [];

  for (const rec of existing.slice(0, MAX_RECORDS)) {
    const err = isHelperRecordUsable(rec, { nowSeconds: opts.nowSeconds, network: opts.network });
    if (!err) byHash.set(helperRecordHash(rec), rec);
  }

  for (const rec of incoming.slice(0, MAX_RECORDS)) {
    const err = isHelperRecordUsable(rec, { nowSeconds: opts.nowSeconds, network: opts.network });
    if (err) {
      rejected.push({ source: opts.source, reason: err });
      continue;
    }
    byHash.set(helperRecordHash(rec), rec);
  }

  const capped = capConcentration(
    sortByHash([...byHash.values()]),
    MAX_CACHE_PER_OPERATOR,
    MAX_CACHE_PER_DOMAIN,
    MAX_RECORDS,
  );
  return { records: capped, rejected };
}

export function selectHelperServers(records: HelperRecord[], opts: SelectionOptions): { api: string[]; signaling: string[] } {
  const maxPerOperator = opts.maxPerOperator ?? 2;
  const maxPerDomain = opts.maxPerDomain ?? 2;
  const maxServers = opts.maxServers ?? 8;
  const operatorCount = new Map<string, number>();
  const apiDomainCount = new Map<string, number>();
  const signalingDomainCount = new Map<string, number>();
  const api: string[] = [];
  const signaling: string[] = [];
  const seenApi = new Set<string>();
  const seenSignaling = new Set<string>();

  for (const rec of sortByHash(records)) {
    const err = isHelperRecordUsable(rec, { nowSeconds: opts.nowSeconds, network: opts.network });
    if (err) continue;
    const hasApiRole = rec.roles.includes('api');
    const hasSignalingRole = rec.roles.includes('signaling');
    if ((operatorCount.get(rec.operator) ?? 0) >= maxPerOperator) continue;

    let selected = false;
    if (hasApiRole && rec.api && api.length < maxServers && !seenApi.has(rec.api)) {
      const domain = domainKey(rec.api);
      if ((apiDomainCount.get(domain) ?? 0) < maxPerDomain) {
        seenApi.add(rec.api);
        apiDomainCount.set(domain, (apiDomainCount.get(domain) ?? 0) + 1);
        api.push(rec.api);
        selected = true;
      }
    }
    if (hasSignalingRole && rec.signaling && signaling.length < maxServers && !seenSignaling.has(rec.signaling)) {
      const domain = domainKey(rec.signaling);
      if ((signalingDomainCount.get(domain) ?? 0) < maxPerDomain) {
        seenSignaling.add(rec.signaling);
        signalingDomainCount.set(domain, (signalingDomainCount.get(domain) ?? 0) + 1);
        signaling.push(rec.signaling);
        selected = true;
      }
    }
    if (!selected) continue;
    operatorCount.set(rec.operator, (operatorCount.get(rec.operator) ?? 0) + 1);
    if (api.length >= maxServers && signaling.length >= maxServers) break;
  }

  // Always keep the hardcoded seed defaults in the selected set — never just as
  // a fallback. This is the honest anchor that bounds the eclipse exposure of a
  // no-config client: even a fully poisoned cache cannot displace the project's
  // own seed servers, because they are unioned in first and discovered records
  // only fill the remaining slots. A user who wants to fully escape the seed
  // still can — manual server config opts out of discovery entirely.
  return {
    api: withSeedDefaults(opts.defaults?.api ?? [], api, maxServers),
    signaling: withSeedDefaults(opts.defaults?.signaling ?? [], signaling, maxServers),
  };
}

export function loadCachedHelperRecords(): HelperRecord[] {
  try {
    const storage = globalThis.localStorage;
    const raw = storage?.getItem(CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isHelperRecordShape).slice(0, MAX_RECORDS) : [];
  } catch {
    return [];
  }
}

export function saveCachedHelperRecords(records: HelperRecord[]): void {
  try {
    globalThis.localStorage?.setItem(CACHE_KEY, JSON.stringify(records.slice(0, MAX_RECORDS)));
  } catch {
    // localStorage can be unavailable or full; discovery still works from live sources.
  }
}

export function parseHelperResponse(value: unknown): HelperRecord[] {
  if (!value || typeof value !== 'object') return [];
  const helpers = (value as { helpers?: unknown }).helpers;
  if (!Array.isArray(helpers)) return [];
  const records: HelperRecord[] = [];
  for (const entry of helpers.slice(0, MAX_RESPONSE_ITEMS)) {
    if (!isHelperRecordShape(entry)) continue;
    records.push(entry);
    if (records.length >= MAX_RECORDS) break;
  }
  return records;
}

/**
 * Parse pasted text (from the Settings "advertise a helper" box) into shape-valid
 * helper records. Accepts either a single signed record object or a full
 * `{ "helpers": [...] }` blob (e.g. the contents of a .well-known file) — both are
 * what `scripts/sign-helper-record.ts` can emit. Returns `[]` on malformed JSON.
 * Full usability (signature/expiry/network/HTTPS) is checked separately by the
 * caller via isHelperRecordUsable, so it can surface a per-record reason.
 */
export function parseHelperRecordsInput(text: string): HelperRecord[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return [];
  }
  // A bare record object → normalize to the { helpers: [...] } shape.
  if (value && typeof value === 'object' && !Array.isArray(value) && !('helpers' in value)) {
    value = { helpers: [value] };
  }
  return parseHelperResponse(value);
}

export function encodeHelpersMsg(records: HelperRecord[]): Extract<ProtoMsg, { t: 'helpers' }> {
  return { t: 'helpers', records: records.slice(0, 50) };
}

export function decodeHelpersMsg(msg: Extract<ProtoMsg, { t: 'helpers' }>): HelperRecord[] {
  return msg.records.slice(0, 50).filter(isHelperRecordShape);
}

export function helperWellKnownUrl(href: string): string {
  const url = new URL(href);
  return `${url.origin}/.well-known/browsercoin/helpers.json`;
}

export function isHelperRecordShape(value: unknown): value is HelperRecord {
  if (!value || typeof value !== 'object') return false;
  const rec = value as Record<string, unknown>;
  return (
    rec.v === 1 &&
    typeof rec.network === 'string' &&
    Array.isArray(rec.roles) &&
    (typeof rec.api === 'string' || typeof rec.signaling === 'string') &&
    typeof rec.operator === 'string' &&
    typeof rec.validFrom === 'number' &&
    typeof rec.validUntil === 'number' &&
    typeof rec.sig === 'string'
  );
}

/**
 * Deterministic order that gives no record an inherent advantage. We sort by
 * signature hash only — deliberately NOT by `validUntil`, so an attacker can't
 * float their records to the top (and win cache/selection slots) just by always
 * issuing maximum-validity records. The hash is computed once per record here
 * rather than recomputed inside an O(n log n) comparator, and the input array is
 * not mutated.
 */
function sortByHash(records: HelperRecord[]): HelperRecord[] {
  return records
    .map((rec) => ({ rec, hash: helperRecordHash(rec) }))
    .sort((a, b) => a.hash.localeCompare(b.hash))
    .map((entry) => entry.rec);
}

/** Registrable domains a record points at (api and/or signaling), deduped. */
function recordDomains(rec: HelperRecord): string[] {
  const domains = new Set<string>();
  if (rec.api) domains.add(domainKey(rec.api));
  if (rec.signaling) domains.add(domainKey(rec.signaling));
  return [...domains];
}

/**
 * Keep at most `maxPerOperator` records per operator key and `maxPerDomain` per
 * registrable domain, up to `maxTotal` overall. Input must already be ordered;
 * records over a cap are dropped so no single operator/domain can monopolize the
 * cache.
 */
function capConcentration(
  records: HelperRecord[],
  maxPerOperator: number,
  maxPerDomain: number,
  maxTotal: number,
): HelperRecord[] {
  const operatorCount = new Map<string, number>();
  const domainCount = new Map<string, number>();
  const out: HelperRecord[] = [];
  for (const rec of records) {
    if (out.length >= maxTotal) break;
    if ((operatorCount.get(rec.operator) ?? 0) >= maxPerOperator) continue;
    const domains = recordDomains(rec);
    if (domains.some((d) => (domainCount.get(d) ?? 0) >= maxPerDomain)) continue;
    out.push(rec);
    operatorCount.set(rec.operator, (operatorCount.get(rec.operator) ?? 0) + 1);
    for (const d of domains) domainCount.set(d, (domainCount.get(d) ?? 0) + 1);
  }
  return out;
}

/**
 * Union the hardcoded seed `defaults` with `discovered` URLs, defaults first so
 * they are never sliced out, deduped and capped at `max`. Guarantees the honest
 * seed is always present in a no-config client's working set.
 */
function withSeedDefaults(defaults: string[], discovered: string[], max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const url of [...defaults, ...discovered]) {
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
    if (out.length >= max) break;
  }
  return out;
}

function domainKey(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const parts = host.split('.');
    return parts.length >= 2 ? parts.slice(-2).join('.') : host;
  } catch {
    return '';
  }
}
