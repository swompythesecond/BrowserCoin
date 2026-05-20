import { sha256 } from '../crypto/hash.js';
import { concat } from './binary.js';

/**
 * Compute a Merkle root by hashing pairs upward. Odd nodes are duplicated
 * (Bitcoin-style) — known to allow a CVE-style ambiguity in some contexts,
 * but acceptable here because txRoot and stateRoot inputs are both
 * length-prefixed in the block header anyway.
 */
export function merkleRoot(leaves: Uint8Array[]): Uint8Array {
  if (leaves.length === 0) return new Uint8Array(32);
  if (leaves.length === 1) return sha256(leaves[0]!);

  let layer = leaves.map((l) => sha256(l));
  while (layer.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < layer.length; i += 2) {
      const left = layer[i]!;
      const right = i + 1 < layer.length ? layer[i + 1]! : layer[i]!;
      next.push(sha256(concat(left, right)));
    }
    layer = next;
  }
  return layer[0]!;
}
