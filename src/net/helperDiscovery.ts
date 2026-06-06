import {
  helperRecordHash,
  isHelperRecordUsable,
  type HelperRecord,
} from './helperRecords.js';
import type { ProtoMsg } from './protocol.js';

export const HELPER_DISCOVERY_NETWORK = 'browsercoin-pow-v5';

const CACHE_KEY = 'browsercoin:helper-records';
const MAX_RECORDS = 200;

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
  const domainCount = new Map<string, number>();
  const api: string[] = [];
  const signaling: string[] = [];

  for (const rec of records.sort(compareRecords)) {
    const err = isHelperRecordUsable(rec, { nowSeconds: opts.nowSeconds, network: opts.network });
    if (err) continue;
    const domain = domainKey(rec.api ?? rec.signaling ?? '');
    if ((operatorCount.get(rec.operator) ?? 0) >= maxPerOperator) continue;
    if ((domainCount.get(domain) ?? 0) >= maxPerDomain) continue;

    operatorCount.set(rec.operator, (operatorCount.get(rec.operator) ?? 0) + 1);
    domainCount.set(domain, (domainCount.get(domain) ?? 0) + 1);
    if (rec.api && api.length < maxServers) api.push(rec.api);
    if (rec.signaling && signaling.length < maxServers) signaling.push(rec.signaling);
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
  return helpers.slice(0, MAX_RECORDS).filter(isHelperRecordShape);
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
