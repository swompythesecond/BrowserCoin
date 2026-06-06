/**
 * Wire protocol for peer-to-peer gossip. All messages are JSON-shaped with
 * binary fields encoded as hex — PeerJS DataConnection lets us send any
 * structured-clonable value, so we could send Uint8Array directly, but hex
 * makes debugging trivial (`JSON.stringify(msg)` is human-readable).
 */

import type { Block } from '../chain/block.js';
import type { Transaction } from '../chain/transaction.js';
import type { HelperRecord } from './helperRecords.js';
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
  // Range block sync — lets a fresh tab catch up from any peer without ever
  // touching the bootstrap server. Mirrors the server's /blocks endpoint.
  | { t: 'getBlocks'; fromHeight: number; max: number }
  | { t: 'blocks'; data: string[] /* hex of encodeBlock entries, height-ascending */ }
  // Peer-address gossip — turns "I know one peer" into "I can find the rest of
  // the mesh." Without this, /peers on the bootstrap server is the only way to
  // discover peer IDs.
  | { t: 'getAddrs'; max: number }
  | { t: 'addrs'; peers: string[] }
  // Helper-record gossip — spreads signed API/signaling helper candidates over
  // existing WebRTC links. Records remain candidates only; local validation in
  // helperDiscovery/helperRecords decides whether to cache them.
  | { t: 'getHelpers'; max: number }
  | { t: 'helpers'; records: HelperRecord[] }
  | { t: 'invBlock'; hash: string; height: number }
  | { t: 'invTx'; hash: string }
  // Batched tx-hash announcement (Bitcoin-style `inv`). Periodic re-broadcast
  // and on-connect sync send only hashes — peers reply `getTx` for the ones
  // they're missing, so steady-state traffic is ~32 B/tx instead of re-sending
  // full bodies forever. Old nodes ignore unknown `t` values, so adding this is
  // a safe rolling upgrade.
  | { t: 'invTxs'; hashes: string[] }
  // Request a full tx body by hash, in response to an inv we couldn't satisfy
  // from our own mempool.
  | { t: 'getTx'; hash: string }
  // Liveness probe. WebRTC's `close` event doesn't fire when a remote tab
  // vanishes (tab closed without graceful teardown, network dropped, browser
  // killed), so without an app-level keepalive the local `connections` map
  // accumulates zombie entries and the UI peer count never decreases. Any
  // incoming message refreshes a peer's freshness; ping is only sent when no
  // other traffic has flowed recently.
  | { t: 'ping' }
  | { t: 'pong' };

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
