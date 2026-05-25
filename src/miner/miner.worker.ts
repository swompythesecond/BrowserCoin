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
// Argon2id at 32 MB / 1 iter takes ~40-125 ms per hash, so each iteration is
// its own natural batch — no need to amortize loop overhead like we did with
// SHA-256.
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
// Generation counter: bumped on every start/stop. A running grind() captures
// its generation at entry and exits the moment the counter moves past it.
// Without this, a stop+start pair (which restartTemplate fires after every
// block we mine) can race with an in-flight `await powHash()`: by the time
// the old hash resolves, `mining` is true again so the old loop keeps going,
// stacking a second concurrent grind on top of the new one. After enough
// blocks the worker is running N stale grinds all hashing outdated templates
// and starving the live one of CPU + Argon2id memory — the "mining slows to
// a crawl after a few hours and a restart fixes it" symptom.
let generation = 0;

self.onmessage = (e: MessageEvent<Msg>) => {
  const msg = e.data;
  if (msg.type === 'stop') {
    mining = false;
    generation++;
    return;
  }
  if (msg.type === 'start') {
    mining = true;
    const myGen = ++generation;
    void grind(msg, myGen);
  }
};

async function grind(msg: StartMsg, myGen: number): Promise<void> {
  const header = new Uint8Array(msg.headerBytes); // own copy; we mutate
  const target = BigInt('0x' + msg.targetHex);
  const throttle = clamp01(msg.throttle);

  let nonce = msg.startNonce >>> 0;
  let hashes = 0;
  let report = performance.now();
  let workWindowStart = report;

  while (mining && myGen === generation) {
    let completed = 0;
    for (let i = 0; i < BATCH; i++) {
      // Write u32 BE nonce into header.
      header[NONCE_OFFSET]     = (nonce >>> 24) & 0xff;
      header[NONCE_OFFSET + 1] = (nonce >>> 16) & 0xff;
      header[NONCE_OFFSET + 2] = (nonce >>> 8) & 0xff;
      header[NONCE_OFFSET + 3] = nonce & 0xff;

      // Argon2id allocations are stable with the openpgpjs/argon2id lib —
      // one WebAssembly.Memory per worker at module load, reused forever.
      // This try/catch is a safety net: if the one-time 65 MB allocation
      // ever fails at startup, or some other unexpected error throws
      // inside powHash, telegraph it to the main thread (counted as oom),
      // back off briefly, and retry. An unhandled rejection would silently
      // kill the grind loop and leave the worker idle, so we always want
      // to catch.
      let h: Uint8Array;
      try {
        h = await powHash(header);
      } catch {
        (self as DedicatedWorkerGlobalScope).postMessage({ type: 'oom' });
        await sleep(500);
        break;
      }
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
      completed++;
      if (nonce === msg.startNonce) {
        // Wrapped through the whole 32-bit nonce space without a solution.
        // Ask main thread for a fresh template (different timestamp or txs).
        (self as DedicatedWorkerGlobalScope).postMessage({ type: 'exhausted' });
        return;
      }
    }
    hashes += completed;

    const now = performance.now();
    if (now - report >= 1000) {
      (self as DedicatedWorkerGlobalScope).postMessage({
        type: 'hashrate',
        hashesPerSecond: (hashes * 1000) / (now - report),
        deltaHashes: hashes,
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
