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

  return { records: [...byHash.values()].sort(compareRecords).slice(0, MAX_RECORDS), rejected };
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

  for (const rec of records.sort(compareRecords)) {
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

  return {
    api: api.length > 0 ? api : (opts.defaults?.api ?? []),
    signaling: signaling.length > 0 ? signaling : (opts.defaults?.signaling ?? []),
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

function compareRecords(a: HelperRecord, b: HelperRecord): number {
  if (a.validUntil !== b.validUntil) return b.validUntil - a.validUntil;
  return helperRecordHash(a).localeCompare(helperRecordHash(b));
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
