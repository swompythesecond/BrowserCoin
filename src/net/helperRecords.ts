import { sign as edSign, verify as edVerify, type PrivateKey } from '../crypto/keys.js';
import { sha256 } from '../crypto/hash.js';
import { bytesToHex, hexToBytes } from '../util/binary.js';

export type HelperRole = 'api' | 'signaling';

export interface HelperRecordUnsigned {
  v: 1;
  network: string;
  roles: HelperRole[];
  api?: string;
  signaling?: string;
  operator: string;
  validFrom: number;
  validUntil: number;
}

export interface HelperRecord extends HelperRecordUnsigned {
  sig: string;
}

export interface HelperRecordCheck {
  nowSeconds: number;
  network: string;
  allowHttpLocalhost?: boolean;
}

const MAX_VALIDITY_SECONDS = 30 * 24 * 60 * 60;

export function canonicalHelperRecordPayload(rec: HelperRecordUnsigned): string {
  const roles = normalizeRoles(rec.roles);
  return JSON.stringify({
    api: rec.api ?? '',
    network: rec.network,
    operator: rec.operator,
    roles,
    signaling: rec.signaling ?? '',
    v: rec.v,
    validFrom: rec.validFrom,
    validUntil: rec.validUntil,
  });
}

export function signHelperRecord(rec: HelperRecordUnsigned, privateKey: PrivateKey): HelperRecord {
  const unsigned = { ...rec, roles: normalizeRoles(rec.roles) };
  const payload = new TextEncoder().encode(canonicalHelperRecordPayload(unsigned));
  return { ...unsigned, sig: bytesToHex(edSign(payload, privateKey)) };
}

export function verifyHelperRecord(rec: HelperRecord): boolean {
  try {
    const payload = new TextEncoder().encode(canonicalHelperRecordPayload(rec));
    return edVerify(hexToBytes(rec.sig), payload, hexToBytes(rec.operator));
  } catch {
    return false;
  }
}

export function helperRecordHash(rec: HelperRecord): string {
  return bytesToHex(sha256(new TextEncoder().encode(`${canonicalHelperRecordPayload(rec)}:${rec.sig}`)));
}

export function isHelperRecordUsable(rec: HelperRecord, check: HelperRecordCheck): string | null {
  if (rec.v !== 1) return 'helper record version unsupported';
  if (rec.network !== check.network) return 'helper record network mismatch';
  if (!Array.isArray(rec.roles) || rec.roles.length === 0) return 'helper record has no roles';
  for (const role of rec.roles) {
    if (role !== 'api' && role !== 'signaling') return 'helper role unsupported';
  }
  if (!Number.isInteger(rec.validFrom) || !Number.isInteger(rec.validUntil)) {
    return 'helper record validity invalid';
  }
  if (rec.validFrom > check.nowSeconds) return 'helper record not yet valid';
  if (rec.validUntil <= check.nowSeconds) return 'helper record expired';
  if (rec.validUntil - rec.validFrom > MAX_VALIDITY_SECONDS) return 'helper record validity too long';
  if (!/^[0-9a-f]{64}$/i.test(rec.operator)) return 'helper operator invalid';
  if (!/^[0-9a-f]{128}$/i.test(rec.sig)) return 'helper signature invalid';
  if (rec.roles.includes('api') && !rec.api) return 'helper api URL missing';
  if (rec.roles.includes('signaling') && !rec.signaling) return 'helper signaling URL missing';

  for (const [label, value] of [['api', rec.api], ['signaling', rec.signaling]] as const) {
    if (!value) continue;
    const err = validateHelperUrl(label, value, !!check.allowHttpLocalhost);
    if (err) return err;
  }

  if (!verifyHelperRecord(rec)) return 'helper signature verification failed';
  return null;
}

function normalizeRoles(roles: readonly HelperRole[]): HelperRole[] {
  return [...new Set(roles)].sort();
}

function validateHelperUrl(label: 'api' | 'signaling', value: string, allowHttpLocalhost: boolean): string | null {
  try {
    const u = new URL(value);
    if (u.username || u.password || u.hash) return `helper ${label} URL contains disallowed components`;
    const isLocal = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
    if (u.protocol === 'https:') return null;
    if (allowHttpLocalhost && u.protocol === 'http:' && isLocal) return null;
    return `helper ${label} URL must be https`;
  } catch {
    return `helper ${label} URL invalid`;
  }
}
