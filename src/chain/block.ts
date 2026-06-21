import { sha256 } from '../crypto/hash.js';
import { concat, u32be, u64be, readU32be, readU64be } from '../util/binary.js';
import { merkleRoot } from '../util/merkle.js';
import { decodeTx, encodeTx, encodedTxLen, type Transaction } from './transaction.js';

export interface BlockHeader {
  height: number;       // u32
  prevHash: Uint8Array; // 32
  txRoot: Uint8Array;   // 32
  stateRoot: Uint8Array;// 32
  timestamp: number;    // u64 (unix seconds)
  difficulty: number;   // u32 compact target
  nonce: number;        // u32 (sufficient — miner increments timestamp on overflow)
  miner: Uint8Array;    // 32-byte pubkey credited the coinbase
}

export const HEADER_LEN = 4 + 32 + 32 + 32 + 8 + 4 + 4 + 32; // = 148 bytes

export interface Block {
  header: BlockHeader;
  transactions: Transaction[];
}

export function encodeHeader(h: BlockHeader): Uint8Array {
  return concat(
    u32be(h.height),
    h.prevHash,
    h.txRoot,
    h.stateRoot,
    u64be(BigInt(h.timestamp)),
    u32be(h.difficulty),
    u32be(h.nonce),
    h.miner,
  );
}

export function decodeHeader(buf: Uint8Array, off = 0): BlockHeader {
  if (buf.length - off < HEADER_LEN) throw new Error('header truncated');
  let p = off;
  const height = readU32be(buf, p); p += 4;
  const prevHash = buf.slice(p, p + 32); p += 32;
  const txRoot = buf.slice(p, p + 32); p += 32;
  const stateRoot = buf.slice(p, p + 32); p += 32;
  const timestamp = Number(readU64be(buf, p)); p += 8;
  const difficulty = readU32be(buf, p); p += 4;
  const nonce = readU32be(buf, p); p += 4;
  const miner = buf.slice(p, p + 32); p += 32;
  return { height, prevHash, txRoot, stateRoot, timestamp, difficulty, nonce, miner };
}

export function hashHeader(h: BlockHeader): Uint8Array {
  return sha256(encodeHeader(h));
}

export function blockHashHex(h: BlockHeader): string {
  const bytes = hashHeader(h);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i]!.toString(16).padStart(2, '0');
  return s;
}

/** Compute txRoot from the block's tx list. Pure function. */
export function computeTxRoot(txs: Transaction[]): Uint8Array {
  return merkleRoot(txs.map((t) => encodeTx(t)));
}

export function encodeBlock(b: Block): Uint8Array {
  const txCount = b.transactions.length;
  const parts: Uint8Array[] = [encodeHeader(b.header), u32be(txCount)];
  for (const t of b.transactions) parts.push(encodeTx(t));
  return concat(...parts);
}

export function decodeBlock(buf: Uint8Array): Block {
  const header = decodeHeader(buf, 0);
  let p = HEADER_LEN;
  const txCount = readU32be(buf, p); p += 4;
  const transactions: Transaction[] = [];
  for (let i = 0; i < txCount; i++) {
    const { tx, next } = decodeTx(buf, p);
    transactions.push(tx);
    p = next;
  }
  if (p !== buf.length) throw new Error('trailing bytes in block');
  return { header, transactions };
}

/** Encoded block size in bytes — used to enforce MAX_BLOCK_BYTES. */
export function blockSize(b: Block): number {
  let txBytes = 0;
  for (const t of b.transactions) txBytes += encodedTxLen(t);
  return HEADER_LEN + 4 + txBytes;
}
