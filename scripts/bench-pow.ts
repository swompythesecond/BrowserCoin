import { powHash } from '../src/crypto/pow.js';

async function main(): Promise<void> {
  // Warm-up: first call lazily initializes the WASM module.
  const sample = new Uint8Array(148);
  await powHash(sample);

  const N = 20;
  const start = performance.now();
  for (let i = 0; i < N; i++) {
    sample[0] = i;
    await powHash(sample);
  }
  const elapsed = performance.now() - start;
  const perHash = elapsed / N;
  const hps = 1000 / perHash;
  console.log(`Argon2id (16 MB, 1 iter, 1 lane): ${perHash.toFixed(1)} ms/hash, ${hps.toFixed(1)} h/s`);
  console.log(`At GENESIS_DIFFICULTY_COMPACT=0x1f00ffff (~65k expected hashes): ${(65536 * perHash / 1000 / 60).toFixed(1)} min per block`);
  console.log(`At target = 2^254 (~4 expected hashes): ${(4 * perHash).toFixed(0)} ms per block`);
}

void main();
