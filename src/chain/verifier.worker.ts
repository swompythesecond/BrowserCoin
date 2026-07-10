/**
 * PoW verification worker. Runs the slow Argon2id hash off the main thread so
 * bulk sync can verify many blocks in parallel.
 *
 * Protocol:
 *   in  → { id: number, headerBytes: Uint8Array, targetHex: string }
 *   out → { id: number, ok: boolean }        verification COMPLETED
 *       | { id: number, err: true }          verification COULD NOT RUN
 *
 * The ok/err distinction matters: `ok: false` is a consensus verdict ("this
 * header's PoW is invalid") that callers may act on drastically — history
 * backfill treats it as evidence of a forged chain. A transient failure
 * (Argon2id's ~32 MB WASM allocation being rejected under memory pressure,
 * e.g. while the miner is saturating RAM) must therefore NOT masquerade as
 * a verdict; it reports `err: true` and the pool retries elsewhere.
 *
 * The worker is stateless — it doesn't know about the chain. The caller is
 * responsible for feeding results back into Blockchain.addBlockWithPow() in
 * order so state-dependent checks run sequentially.
 */

import { powHash } from '../crypto/pow.js';
import { hashMeetsTarget } from '../util/binary.js';

type Req = { id: number; headerBytes: Uint8Array; targetHex: string };
type Res = { id: number; ok: boolean } | { id: number; err: true };

self.onmessage = async (e: MessageEvent<Req>) => {
  const { id, headerBytes, targetHex } = e.data;
  try {
    const target = BigInt('0x' + targetHex);
    const h = await powHash(headerBytes);
    const ok = hashMeetsTarget(h, target);
    (self as unknown as Worker).postMessage({ id, ok } satisfies Res);
  } catch {
    (self as unknown as Worker).postMessage({ id, err: true } satisfies Res);
  }
};
