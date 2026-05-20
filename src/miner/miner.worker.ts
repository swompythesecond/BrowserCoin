/// <reference lib="webworker" />
/**
 * Mining worker: grind nonces against a SHA-256 target.
 *
 * Lives in a Web Worker so the UI thread stays responsive. The main thread
 * sends a `start` message containing the encoded header bytes and target;
 * we mutate the nonce field in place (last 36 bytes before `miner` — see
 * encodeHeader layout) and report hashes/sec + solutions.
 *
 * Layout reminder (encodeHeader, big-endian):
 *   [0..4)    height
 *   [4..36)   prevHash
 *   [36..68)  txRoot
 *   [68..100) stateRoot
 *   [100..108) timestamp (u64)
 *   [108..112) difficulty (u32)
 *   [112..116) nonce (u32)         ← mutated here
 *   [116..148) miner (32)
 */

import { powHash } from '../crypto/pow.js';
import { hashMeetsTarget } from '../util/binary.js';

const NONCE_OFFSET = 112;
// Argon2id at 16 MB takes ~10-30 ms per hash, so each iteration is its own
// natural batch — no need to amortize loop overhead like we did with SHA-256.
const BATCH = 1;

type StartMsg = {
  type: 'start';
  headerBytes: Uint8Array;
  targetHex: string;     // hex of bigint target (256-bit)
  startNonce: number;    // typically 0
  /** 0..1 — fraction of wall time we mine vs sleep. 1 = full blast, 0.5 = half. */
  throttle: number;
};

type StopMsg = { type: 'stop' };
type Msg = StartMsg | StopMsg;

let mining = false;

self.onmessage = (e: MessageEvent<Msg>) => {
  const msg = e.data;
  if (msg.type === 'stop') {
    mining = false;
    return;
  }
  if (msg.type === 'start') {
    mining = true;
    void grind(msg);
  }
};

async function grind(msg: StartMsg): Promise<void> {
  const header = new Uint8Array(msg.headerBytes); // own copy; we mutate
  const target = BigInt('0x' + msg.targetHex);
  const throttle = clamp01(msg.throttle);

  let nonce = msg.startNonce >>> 0;
  let hashes = 0;
  let report = performance.now();
  let workWindowStart = report;

  while (mining) {
    for (let i = 0; i < BATCH; i++) {
      // Write u32 BE nonce into header.
      header[NONCE_OFFSET]     = (nonce >>> 24) & 0xff;
      header[NONCE_OFFSET + 1] = (nonce >>> 16) & 0xff;
      header[NONCE_OFFSET + 2] = (nonce >>> 8) & 0xff;
      header[NONCE_OFFSET + 3] = nonce & 0xff;

      const h = await powHash(header);
      if (hashMeetsTarget(h, target)) {
        (self as DedicatedWorkerGlobalScope).postMessage({
          type: 'solved',
          nonce,
          hash: h,
        });
        // After reporting, keep grinding in case the main thread wants more
        // candidates — but the main thread will normally send `stop` to swap
        // in a fresh template.
      }
      nonce = (nonce + 1) >>> 0;
      if (nonce === msg.startNonce) {
        // Wrapped through the whole 32-bit nonce space without a solution.
        // Ask main thread for a fresh template (different timestamp or txs).
        (self as DedicatedWorkerGlobalScope).postMessage({ type: 'exhausted' });
        return;
      }
    }
    hashes += BATCH;

    const now = performance.now();
    if (now - report >= 1000) {
      (self as DedicatedWorkerGlobalScope).postMessage({
        type: 'hashrate',
        hashesPerSecond: (hashes * 1000) / (now - report),
      });
      hashes = 0;
      report = now;
    }

    // Throttle by yielding the event loop proportionally.
    if (throttle < 1) {
      const workWindow = now - workWindowStart;
      // run:sleep ratio = throttle:(1-throttle)
      const sleepFor = throttle <= 0 ? 50 : (workWindow * (1 - throttle)) / throttle;
      if (sleepFor > 1) {
        await sleep(Math.min(sleepFor, 100));
        workWindowStart = performance.now();
      }
    } else {
      // Yield once per batch so the worker can receive stop messages.
      await sleep(0);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function clamp01(x: number): number {
  if (Number.isNaN(x)) return 1;
  return Math.max(0, Math.min(1, x));
}
