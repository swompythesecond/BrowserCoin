/**
 * Generates frozen Sandglass v3 PoW test vectors. Run:
 *   npx tsx scripts/gen-sandglass-vectors.mts
 * Writes src/crypto/sandglass.vectors.json. Every implementation of the hash
 * (browser, worker, any future port) MUST reproduce these exact digests — this
 * is the consensus-safety anchor for the fork. Regenerate ONLY if the algorithm
 * is intentionally changed (which is itself a consensus change).
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sandglassHash } from '../src/crypto/sandglass.js';
import { encodeHeader, type BlockHeader } from '../src/chain/block.js';
import { bytesToHex } from '../src/util/binary.js';

function header(over: Partial<BlockHeader>): BlockHeader {
  return {
    height: 40_000,
    prevHash: new Uint8Array(32).fill(0x11),
    txRoot: new Uint8Array(32).fill(0x22),
    stateRoot: new Uint8Array(32).fill(0x33),
    timestamp: 1_786_000_000,
    difficulty: 0x20020000,
    nonce: 0,
    miner: new Uint8Array(32).fill(0x44),
    ...over,
  };
}

const cases: BlockHeader[] = [
  header({}),
  header({ nonce: 1 }),
  header({ nonce: 2 }),
  header({ nonce: 0xffffffff }),
  header({ height: 40_001, nonce: 7 }),
  header({ height: 123_456, timestamp: 1_800_000_000, nonce: 99 }),
  header({ prevHash: new Uint8Array(32), miner: new Uint8Array(32), nonce: 3 }),
];

const vectors = cases.map((h) => {
  const bytes = encodeHeader(h);
  return { headerHex: bytesToHex(bytes), digestHex: bytesToHex(sandglassHash(bytes)) };
});

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'crypto', 'sandglass.vectors.json');
writeFileSync(out, JSON.stringify(vectors, null, 2) + '\n');
console.log(`wrote ${vectors.length} vectors to ${out}`);
for (const v of vectors) console.log(`  ${v.headerHex.slice(0, 16)}… -> ${v.digestHex}`);
