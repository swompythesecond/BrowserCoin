// Submit a transaction to a BrowserCoin helper server.
//
// Standalone — only depends on @noble/ed25519. Reimplements the 88-byte tx
// preimage encoder so it works as a copy-paste starter outside this repo.
//
// Usage:
//   npm install @noble/ed25519
//   node send-tx.mjs                                  # send 1 wei to a random addr
//   API_BASE=http://localhost:9000 node send-tx.mjs   # custom server
//   TO=<64-hex-pubkey> AMOUNT=100 node send-tx.mjs    # specific recipient + amount
//
// A freshly-generated key has zero balance, so the first run will normally
// print `{ admitted: 0, errors: ['insufficient balance'] }`. That's expected
// and proves the signature reached the validator. To get an admitted tx:
// open the browser app, mine a few blocks to the pubkey printed by this
// script (saved to key.json), then re-run.

import { readFile, writeFile } from 'node:fs/promises';
import * as ed from '@noble/ed25519';

const CHAIN_ID = 0xc01dfeed;
const API_BASE = process.env.API_BASE ?? 'http://localhost:9000';
const KEY_FILE = new URL('./key.json', import.meta.url);

const toHex = (b) => Buffer.from(b).toString('hex');
const fromHex = (s) => new Uint8Array(Buffer.from(s, 'hex'));

function u32be(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, false);
  return b;
}

function u64be(n) {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n), false);
  return b;
}

function concat(...parts) {
  const len = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

// 88 bytes: chainId(4) ‖ from(32) ‖ to(32) ‖ amount(8) ‖ fee(8) ‖ nonce(4)
function txPreimage({ from, to, amount, fee, nonce }) {
  return concat(u32be(CHAIN_ID), from, to, u64be(amount), u64be(fee), u32be(nonce));
}

async function loadOrCreateKey() {
  try {
    const { priv } = JSON.parse(await readFile(KEY_FILE, 'utf-8'));
    const privBytes = fromHex(priv);
    const pub = await ed.getPublicKeyAsync(privBytes);
    return { priv: privBytes, pub };
  } catch {
    const priv = ed.utils.randomPrivateKey();
    const pub = await ed.getPublicKeyAsync(priv);
    await writeFile(KEY_FILE, JSON.stringify({ priv: toHex(priv), pub: toHex(pub) }, null, 2));
    console.log(`generated new key, saved to ${KEY_FILE.pathname}`);
    return { priv, pub };
  }
}

async function main() {
  const { priv, pub } = await loadOrCreateKey();
  console.log(`our pubkey: ${toHex(pub)}`);

  const tipRes = await fetch(`${API_BASE}/tip`);
  if (!tipRes.ok) throw new Error(`GET /tip failed: ${tipRes.status}`);
  const tip = await tipRes.json();
  console.log(`server tip: height=${tip.height} hash=${tip.tipHash.slice(0, 16)}…`);

  const to = process.env.TO ? fromHex(process.env.TO) : ed.utils.randomPrivateKey().slice(0, 32);
  const unsigned = {
    from: pub,
    to,
    amount: BigInt(process.env.AMOUNT ?? 1),
    fee: BigInt(process.env.FEE ?? 200), // 152 wei min for a 152-byte tx
    nonce: Number(process.env.NONCE ?? 0),
  };

  const preimage = txPreimage(unsigned);
  const signature = await ed.signAsync(preimage, priv);
  const txBytes = concat(preimage, signature); // 152 bytes total
  const txHex = toHex(txBytes);

  const submit = await fetch(`${API_BASE}/txs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txs: [txHex] }),
  });
  const result = await submit.json();
  console.log('server response:', result);
}

main().catch((e) => { console.error(e); process.exit(1); });
