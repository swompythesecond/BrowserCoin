/**
 * Mint and sign BrowserCoin helper records for the `.well-known` discovery
 * channel. Helpers are non-authoritative — a signed record only tells clients
 * "this operator vouches for these API/signaling URLs"; every block is still
 * validated locally. See src/net/helperRecords.ts and docs/developers.md.
 *
 * Usage:
 *
 *   # 1. Generate an operator keypair (run once per operator; keep the key safe)
 *   tsx scripts/sign-helper-record.ts --genkey --key-file operator.key
 *
 *   # 2. Sign a record for a helper you run and append it to the published file
 *   tsx scripts/sign-helper-record.ts \
 *     --key-file operator.key \
 *     --roles api,signaling \
 *     --api https://api.example.org \
 *     --signaling https://peer.example.org \
 *     --days 14 \
 *     --out public/.well-known/browsercoin/helpers.json
 *
 * Renewal is the same step 2 — re-run before `validUntil` and overwrite the
 * published file (records validate for at most 30 days; 14 is a good default).
 * No server restart is involved: the file is served statically from the web
 * origin, and clients fetch /.well-known/browsercoin/helpers.json same-origin.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { fromPrivateKey, generateKeyPair } from '../src/crypto/keys.js';
import { bytesToHex, hexToBytes } from '../src/util/binary.js';
import { BROWSERCOIN_NETWORK } from '../src/net/network.js';
import {
  signHelperRecord,
  type HelperRecord,
  type HelperRole,
  type HelperRecordUnsigned,
} from '../src/net/helperRecords.js';

const MAX_DAYS = 30; // mirrors MAX_VALIDITY_SECONDS in helperRecords.ts

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function die(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function loadPrivateKeyHex(): string {
  const inline = arg('key');
  if (inline) return inline.trim();
  const file = arg('key-file');
  if (file) return readFileSync(file, 'utf-8').trim();
  return die('provide the operator private key via --key-file <path> or --key <hex>');
}

function genkey(): void {
  const kp = generateKeyPair();
  const privHex = bytesToHex(kp.privateKey);
  const outFile = arg('key-file');
  if (outFile) {
    if (existsSync(outFile)) die(`refusing to overwrite existing key file: ${outFile}`);
    writeFileSync(outFile, privHex, { encoding: 'utf-8', mode: 0o600 });
    console.log(`private key written to ${outFile} (mode 600 — keep it secret, back it up)`);
  } else {
    console.log(`private key (KEEP SECRET): ${privHex}`);
  }
  console.log(`operator  (public, share): ${kp.address}`);
}

function parseRoles(): HelperRole[] {
  const raw = arg('roles') ?? 'api,signaling';
  const roles = raw.split(',').map((r) => r.trim()).filter(Boolean);
  for (const r of roles) {
    if (r !== 'api' && r !== 'signaling') die(`unsupported role "${r}" (expected api and/or signaling)`);
  }
  if (roles.length === 0) die('at least one role is required');
  return roles as HelperRole[];
}

function requireHttps(label: string, url: string | undefined): string | undefined {
  if (!url) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return die(`${label} URL is not a valid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') {
    die(`${label} URL must be https (clients reject non-https except localhost): ${url}`);
  }
  return url;
}

function mergeIntoFile(record: HelperRecord, outPath: string): void {
  let helpers: HelperRecord[] = [];
  if (existsSync(outPath)) {
    try {
      const parsed = JSON.parse(readFileSync(outPath, 'utf-8')) as { helpers?: HelperRecord[] };
      if (Array.isArray(parsed.helpers)) helpers = parsed.helpers;
    } catch {
      die(`existing ${outPath} is not valid JSON — move it aside or fix it first`);
    }
  }
  // Replace any prior record for the same operator+URLs (a renewal), then append.
  helpers = helpers.filter(
    (h) => !(h.operator === record.operator && h.api === record.api && h.signaling === record.signaling),
  );
  helpers.push(record);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify({ helpers }, null, 2) + '\n', 'utf-8');
  console.log(`wrote ${helpers.length} record(s) to ${outPath}`);
}

function main(): void {
  if (flag('genkey')) {
    genkey();
    return;
  }

  const privHex = loadPrivateKeyHex();
  if (!/^[0-9a-f]{64}$/i.test(privHex)) die('private key must be 64 hex characters (32 bytes)');
  const kp = fromPrivateKey(hexToBytes(privHex));
  const roles = parseRoles();
  const api = requireHttps('api', arg('api'));
  const signaling = requireHttps('signaling', arg('signaling'));

  if (roles.includes('api') && !api) die('--api <url> is required when the api role is present');
  if (roles.includes('signaling') && !signaling) die('--signaling <url> is required when the signaling role is present');

  const days = Number(arg('days') ?? '14');
  if (!Number.isFinite(days) || days <= 0) die('--days must be a positive number');
  if (days > MAX_DAYS) die(`--days must be <= ${MAX_DAYS} (records validate for at most 30 days)`);

  const validFrom = Math.floor(Date.now() / 1000);
  const unsigned: HelperRecordUnsigned = {
    v: 1,
    network: BROWSERCOIN_NETWORK,
    roles,
    api,
    signaling,
    operator: kp.address,
    validFrom,
    validUntil: validFrom + Math.round(days * 86400),
  };
  const record = signHelperRecord(unsigned, kp.privateKey);

  const out = arg('out');
  if (out) mergeIntoFile(record, out);
  else console.log(JSON.stringify({ helpers: [record] }, null, 2));
}

main();
