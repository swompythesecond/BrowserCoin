/**
 * Wire protocol for peer-to-peer gossip. All messages are JSON-shaped with
 * binary fields encoded as hex — PeerJS DataConnection lets us send any
 * structured-clonable value, so we could send Uint8Array directly, but hex
 * makes debugging trivial (`JSON.stringify(msg)` is human-readable).
 */

import type { Block } from '../chain/block.js';
import type { Transaction } from '../chain/transaction.js';
import { decodeBlock, encodeBlock } from '../chain/block.js';
import { decodeTx, encodeTx } from '../chain/transaction.js';
import { bytesToHex, hexToBytes } from '../util/binary.js';

export type ProtoMsg =
  | { t: 'hello'; height: number; tipHash: string; chainId: number }
  | { t: 'tx'; data: string /* hex of encodeTx */ }
  | { t: 'block'; data: string /* hex of encodeBlock */ }
  | { t: 'getHeaders'; fromHeight: number; max: number }
  | { t: 'headers'; data: string[] /* hex of encodeHeader entries */ }
  | { t: 'getBlock'; hash: string }
  | { t: 'invBlock'; hash: string; height: number }
  | { t: 'invTx'; hash: string };

export function encodeTxMsg(tx: Transaction): ProtoMsg {
  return { t: 'tx', data: bytesToHex(encodeTx(tx)) };
}

export function decodeTxMsg(m: Extract<ProtoMsg, { t: 'tx' }>): Transaction {
  return decodeTx(hexToBytes(m.data)).tx;
}

export function encodeBlockMsg(b: Block): ProtoMsg {
  return { t: 'block', data: bytesToHex(encodeBlock(b)) };
}

export function decodeBlockMsg(m: Extract<ProtoMsg, { t: 'block' }>): Block {
  return decodeBlock(hexToBytes(m.data));
}
