import { describe, expect, it } from 'vitest';
import type { DataConnection } from 'peerjs';
import type { Blockchain } from '../chain/blockchain.js';
import { decodeBlock, encodeBlock, hashHeader, type Block } from '../chain/block.js';
import { CHAIN_ID } from '../chain/genesis.js';
import { Mempool } from '../chain/mempool.js';
import { bytesToHex, hexToBytes } from '../util/binary.js';
import { PeerNetwork } from './peer.js';
import type { ProtoMsg } from './protocol.js';
import type { ServerSync } from './serverSync.js';

// Exercise the actual wire codecs and PeerNetwork handlers with deterministic
// chain/transport doubles. Consensus and proof-of-work have their own tests;
// these fixtures isolate range selection and pagination without mining blocks.
function block(height: number): Block {
  return {
    header: {
      height, prevHash: new Uint8Array(32), txRoot: new Uint8Array(32),
      stateRoot: new Uint8Array(32), timestamp: height, difficulty: 0,
      nonce: 0, miner: new Uint8Array(32),
    },
    transactions: [],
  };
}

function fixture(height: number, bodylessHeight = -1) {
  const blocks = Array.from({ length: height + 1 }, (_, h) => block(h));
  const chain = {
    height,
    tipState: new Map(),
    hasBlock: () => false,
    *iterateCanonical() {
      for (let h = blocks.length - 1; h >= 0; h--) {
        yield { block: blocks[h], hasBody: h !== bodylessHeight };
      }
    },
    async addBlock(incoming: Block) {
      if (incoming.header.height !== this.height + 1) return 'unexpected height';
      this.height++;
      return null;
    },
  };
  const network = new PeerNetwork(
    chain as unknown as Blockchain, new Mempool(), [], {} as ServerSync, () => {},
  );
  const sent: ProtoMsg[] = [];
  const conn = { peer: 'browsercoin-test', send: (msg: ProtoMsg) => sent.push(msg) };
  const receive = (msg: ProtoMsg) => {
    (network as unknown as {
      onIncoming(conn: DataConnection, msg: ProtoMsg): void;
    }).onIncoming(conn as unknown as DataConnection, msg);
  };
  return { chain, network, sent, receive };
}

function heights(msg: ProtoMsg): number[] {
  if (msg.t !== 'blocks') throw new Error(`Expected blocks, got ${msg.t}`);
  return msg.data.map(hex => decodeBlock(hexToBytes(hex)).header.height);
}

// Drain the bounded async block-handler loop without timing-dependent sleeps.
async function settle() {
  for (let i = 0; i < 1024; i++) await Promise.resolve();
}

function hello(height: number): ProtoMsg {
  return { t: 'hello', height, chainId: CHAIN_ID, tipHash: bytesToHex(hashHeader(block(height).header)) };
}

describe('P2P block range sync', () => {
  it('serves the requested early range even when the tip is far ahead', () => {
    const peer = fixture(200);
    peer.receive({ t: 'getBlocks', fromHeight: 1, max: 64 });
    expect(peer.sent).toHaveLength(1);
    expect(heights(peer.sent[0])).toEqual(Array.from({ length: 64 }, (_, i) => i + 1));
  });

  it('honors smaller ranges and caps oversized requests at 64 blocks', () => {
    const peer = fixture(200);
    peer.receive({ t: 'getBlocks', fromHeight: 10, max: 2 });
    peer.receive({ t: 'getBlocks', fromHeight: 10, max: 1000 });
    expect(heights(peer.sent[0])).toEqual([10, 11]);
    expect(heights(peer.sent[1])).toEqual(Array.from({ length: 64 }, (_, i) => i + 10));
  });

  it('serves a short final range and nothing beyond the tip', () => {
    const peer = fixture(82);
    peer.receive({ t: 'getBlocks', fromHeight: 80, max: 64 });
    peer.receive({ t: 'getBlocks', fromHeight: 83, max: 64 });
    expect(peer.sent).toHaveLength(1);
    expect(heights(peer.sent[0])).toEqual([80, 81, 82]);
  });

  it('does not encode a bodyless fast-sync entry', () => {
    const peer = fixture(82, 80);
    peer.receive({ t: 'getBlocks', fromHeight: 80, max: 64 });
    expect(heights(peer.sent[0])).toEqual([81, 82]);
  });

  it.each([82, 200])('syncs to height %i using successive range responses', async height => {
    const server = fixture(height);
    const client = fixture(0);
    client.receive(hello(height));
    const requests: number[] = [];
    // Bound the pump so a pagination loop fails instead of hanging the test.
    for (let rounds = 0; rounds < 10 && client.sent.length; rounds++) {
      const request = client.sent.shift()!;
      expect(request.t).toBe('getBlocks');
      if (request.t === 'getBlocks') requests.push(request.fromHeight);
      server.receive(request);
      for (const response of server.sent.splice(0)) client.receive(response);
      await settle();
    }
    expect(client.chain.height).toBe(height);
    expect(requests).toEqual(Array.from({ length: Math.ceil(height / 64) }, (_, i) => i * 64 + 1));
    expect(client.sent).toEqual([]);
  });

  it('does not immediately request again after an empty, malformed or duplicate batch', async () => {
    const client = fixture(64);
    client.receive(hello(82));
    client.sent.length = 0;
    for (const data of [[], ['00'], [bytesToHex(encodeBlock(block(64)))]]) {
      // Known blocks return without calling chain.addBlock.
      client.chain.hasBlock = () => true;
      client.receive({ t: 'blocks', data });
      await settle();
      expect(client.sent).toEqual([]);
    }
  });
});
