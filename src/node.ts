import { Blockchain } from './chain/blockchain.js';
import { Mempool } from './chain/mempool.js';
import { signTx, type Transaction } from './chain/transaction.js';
import { type KeyPair } from './crypto/keys.js';
import { MinerController } from './miner/controller.js';
import { PeerNetwork } from './net/peer.js';
import { ServerSync } from './net/serverSync.js';
import { loadServerLists, saveServerLists, type ServerLists } from './net/servers.js';
import { loadOrCreateWallet, saveWallet } from './storage/wallet.js';
import { getAccount } from './chain/state.js';
import { blockReward, COIN } from './chain/genesis.js';
import { decodeBlock, encodeBlock, type Block } from './chain/block.js';
import { bytesToHex } from './util/binary.js';
import { ActivityIndex } from './ui/activityIndex.js';
import {
  clearAll,
  getAllBlocksOrdered,
  getMeta,
  listCachedPeers,
  putBlock,
  putMeta,
  recordPeerSeen,
} from './storage/idb.js';

/**
 * Version tag tied to PoW params + chain genesis. When the network does a
 * hard-fork (e.g. salt bump in pow.ts), bump this so existing IDB caches are
 * cleared on next load — stops the browser from trying to restore blocks that
 * the new server will reject. Must stay in lock-step with server/api.ts.
 */
export const CHAIN_VERSION = 'browsercoin-pow-v5';

/**
 * Show the sync overlay only when we're this many blocks behind a known tip.
 * Smaller backlogs verify in well under a second, so we let them happen in the
 * background with no overlay. A bigger gap means we either hit the startup race
 * (heartbeat marked a server reachable before its /tip arrived) or have been
 * idle long enough that surfacing progress is worthwhile. Keeping readiness
 * keyed on backlog size — not on a server confirming we're caught up — is what
 * keeps helper servers strictly helpers: a peer's reported height feeds the
 * same comparison, and if nobody answers we never declare ourselves behind.
 */
const SYNC_BACKLOG_BLOCKS = 50;

type ChainListener = () => void;

/** Detail of a locally-mined block — what the UI's "you found a block!" toast needs. */
export interface MinedBlockInfo {
  height: number;
  /** Coinbase subsidy at this height (wei). Excludes tx fees. */
  reward: bigint;
  /** Σ of tx fees in this block (wei). */
  fees: bigint;
  /** How many user txs landed in this block (excludes implicit coinbase). */
  txCount: number;
}

export interface SyncStatus {
  /** True until we've completed the first server bootstrap pull (or proved it failed). */
  syncing: boolean;
  /** Height the server told us about (or 0 if we never reached it). */
  targetHeight: number;
  /** Our local chain height. */
  localHeight: number;
  /** Phase label for the UI. */
  phase: 'restoring' | 'connecting' | 'fetching' | 'verifying' | 'ready' | 'offline';
  /**
   * True once we've waited long enough that the overlay should offer the user a
   * manual "Continue offline" escape hatch. Normal connections never see this —
   * they reach 'ready' first. Only set after a generous timeout so genuinely
   * offline users aren't stuck behind the overlay forever.
   */
  canDismiss: boolean;
  /**
   * True once the user clicked "Continue offline". Sticky for the session: the
   * overlay stays hidden even though `syncing` may still be true (and may bounce
   * back to true as `updateSyncReadiness` discovers fresh backlog). Mining stays
   * gated on `syncing`, not this — dismissing only hides the UI, it doesn't
   * declare the chain caught up.
   */
  dismissed: boolean;
}

/**
 * Façade tying chain + mempool + miner + network + wallet together. The UI
 * subscribes to high-level events ("chain changed", "wallet changed") rather
 * than reaching into individual subsystems.
 *
 * On `start()` the node auto-joins the P2P network and starts a polling sync
 * against the bootstrap server's chain replica — so a fresh tab catches up
 * with zero clicks, and a mined block always lands in at least one persistent
 * place (the server) even if no other browsers are online.
 */
export class Node {
  readonly chain = new Blockchain();
  readonly mempool = new Mempool();
  wallet: KeyPair;
  /**
   * Incremental index of the wallet's confirmed + mined activity, fed by
   * canonical-tip moves so the UI never rescans the chain. Built during IDB
   * replay for free (we visit every tx to rebuild tip state anyway).
   */
  readonly activityIndex: ActivityIndex;
  readonly miner: MinerController;
  network: PeerNetwork | null = null;
  serverSync: ServerSync | null = null;
  serverLists: ServerLists;

  private chainListeners = new Set<ChainListener>();
  private walletListeners = new Set<ChainListener>();
  private syncListeners = new Set<(s: SyncStatus) => void>();
  private blockMinedListeners = new Set<(info: MinedBlockInfo) => void>();
  private syncStatus: SyncStatus = {
    syncing: true,
    targetHeight: 0,
    localHeight: 0,
    phase: 'restoring',
    canDismiss: false,
    dismissed: false,
  };

  constructor() {
    this.wallet = loadOrCreateWallet();
    this.activityIndex = new ActivityIndex(this.wallet.address);
    this.serverLists = loadServerLists();

    // Persist every accepted block to IDB so the next page load can fast-restore.
    // Best-effort: failures here don't block consensus.
    this.chain.onBlockAdded((cb) => {
      if (cb.block.header.height === 0) return; // genesis is hardcoded
      const hashHex = bytesToHex(cb.hash);
      void putBlock(hashHex, cb.block.header.height, encodeBlock(cb.block))
        .catch((e) => console.warn('[node] idb persist failed:', (e as Error).message));
    });

    // Single source of truth for mempool ↔ chain reconciliation: a tx only
    // leaves the mempool when it confirms on the canonical chain, and txs
    // displaced by a reorg are put back so they can be re-mined. Restored txs
    // are re-validated against the new tip state by `add` (rejections ignored).
    this.chain.onTipChanged((delta) => {
      // Keep the activity index in lock-step with the canonical tip: add rows
      // for connected blocks, drop them for reorg-displaced ones.
      this.activityIndex.apply(delta);
      for (const tx of delta.restored) this.mempool.add(tx, this.chain.tipState);
      this.mempool.removeMany(delta.confirmed);
      // Evict txs whose nonce slot was just taken by a confirmed tx — they can
      // never be mined now, so they shouldn't keep showing as pending or block
      // the per-sender nonce walk in selectForBlock.
      this.mempool.pruneStale(this.chain.tipState);
      this.miner.refresh();
      this.emitChain();
    });

    this.miner = new MinerController(
      this.chain,
      this.mempool,
      this.wallet.publicKey,
      async (block) => {
        const err = await this.chain.addBlock(block);
        if (err) {
          console.warn('[node] mined block rejected:', err);
          this.miner.refresh();
          return;
        }
        // Mempool eviction + miner re-template happen in the onTipChanged
        // handler that addBlock just fired. We only need to propagate + notify.
        this.network?.broadcastBlock();
        this.serverSync?.kick();
        this.emitChain();
        this.emitBlockMined(block);
      },
    );

    // Refuse to mine while we're still syncing — mining on a stale tip just
    // produces orphans that the server + peers will reject.
    this.miner.setStartGate(() => {
      if (this.syncStatus.syncing) return 'syncing — wait until the chain is caught up';
      return null;
    });
  }

  getSyncStatus(): SyncStatus {
    return { ...this.syncStatus };
  }

  onSync(fn: (s: SyncStatus) => void): () => void {
    this.syncListeners.add(fn);
    return () => this.syncListeners.delete(fn);
  }

  private emitSync(patch: Partial<SyncStatus>): void {
    this.syncStatus = { ...this.syncStatus, ...patch, localHeight: this.chain.height };
    const snap = { ...this.syncStatus };
    for (const fn of this.syncListeners) fn(snap);
  }

  /**
   * Load previously-accepted blocks from IndexedDB before contacting the
   * network. Restored blocks skip PoW + tx signature checks — they were
   * validated when first stored. This turns a "refresh = 45 s re-sync" into
   * "refresh = <1 s replay from disk".
   *
   * If the stored chain version doesn't match this build (e.g. hard-fork),
   * IDB is wiped first.
   */
  private async restoreFromIdb(): Promise<void> {
    this.emitSync({ phase: 'restoring' });
    try {
      const storedVersion = await getMeta<string>('chainVersion');
      if (storedVersion !== CHAIN_VERSION) {
        await clearAll();
        await putMeta('chainVersion', CHAIN_VERSION);
        return;
      }

      const stored = await getAllBlocksOrdered();
      // getAllBlocksOrdered uses the height index, so blocks already arrive
      // height-ascending.
      let restored = 0;
      for (const row of stored) {
        let block;
        try {
          block = decodeBlock(row.encoded);
        } catch (e) {
          console.warn('[node] idb decode failed at h=', row.height, (e as Error).message);
          continue;
        }
        const err = await this.chain.addValidatedBlock(block);
        if (err === null) restored++;
        else console.warn('[node] idb block rejected at h=', row.height, err);
      }
      if (restored > 0) {
        console.log(`[node] restored ${restored} blocks from idb; tip h=${this.chain.height}`);
        this.emitChain();
      }
    } catch (e) {
      console.warn('[node] idb restore failed:', (e as Error).message);
    }
  }

  /**
   * One-call setup: restore from IDB, subscribe to the server, dial P2P.
   * Idempotent — calling twice has no effect. UI calls this once on page load.
   *
   * The sync overlay watches `onSync` and clears once we're caught up to the
   * server (or we've proved the server is unreachable, in which case "ready"
   * also fires so the user isn't stuck behind the overlay forever).
   */
  async start(): Promise<void> {
    // 1. Fast-restore from IDB so the chain is as caught-up as it can be
    //    before we touch the network. This is the single biggest perf win.
    await this.restoreFromIdb();

    // 2. Server sync. Reports its own status; we use the first /tip response
    //    to set syncStatus.targetHeight and decide when to lower the overlay.
    this.emitSync({ phase: 'fetching' });
    this.serverSync = new ServerSync(
      this.chain,
      this.mempool,
      this.serverLists.api,
      () => {
        this.miner.refresh();
        this.emitChain();
        this.updateSyncReadiness();
      },
      () => this.miner.getStatus().running,
    );
    this.serverSync.onStatus((s) => {
      if (s.reachable > 0 && s.serverHeight > this.syncStatus.targetHeight) {
        this.emitSync({ targetHeight: s.serverHeight });
      }
      this.updateSyncReadiness();
    });

    // Kick off the first sync, but don't await — we want the UI overlay to
    // render its restored-from-IDB state immediately.
    void this.serverSync.start().then(() => this.updateSyncReadiness());

    // Safety net: if no network (server or P2P) responds within 12 s, mark the
    // overlay as user-dismissible and flip the phase to 'offline'. We don't
    // auto-drop — keep the overlay visible so the user knows we're stuck, and
    // let them choose to continue offline. This avoids the old failure mode
    // where the overlay disappeared while connectivity was still establishing,
    // briefly exposing stale balances and an "Offline" connStrip.
    setTimeout(() => {
      if (!this.syncStatus.syncing) return;
      const ss = this.serverSync?.getStatus();
      const ns = this.network?.getStatus();
      const connected = (ss?.reachable ?? 0) > 0 || (ns?.connected ?? 0) > 0;
      // Always offer an escape after the timeout so the user is never trapped.
      // Label it 'offline' only when truly unreachable; a reachable-but-not-yet-
      // caught-up server (e.g. heartbeats work but /tip keeps failing) keeps its
      // current phase but still gets a dismiss button.
      if (!connected) this.emitSync({ phase: 'offline', canDismiss: true });
      else this.emitSync({ canDismiss: true });
    }, 12000);

    // 3. P2P. Failure here is non-fatal — server sync alone is enough to be a
    //    functional node, P2P just adds liveness.
    await this.startNetwork();
  }

  /**
   * Called whenever chain height, server status, or peer status changes.
   * Decides whether the sync overlay should drop. We're "ready" when either:
   *   - The server is reachable and we've caught up to its tip, or
   *   - The server is unreachable but we have at least one P2P peer — we'll
   *     trust gossip to keep us current.
   *
   * Until one of those happens, we leave the overlay up. This is the key fix
   * for the "I see Offline briefly on startup" issue: without explicit
   * connectivity, we don't expose the home UI.
   */
  private updateSyncReadiness(): void {
    const ss = this.serverSync?.getStatus();
    const ns = this.network?.getStatus();
    const local = this.chain.height;
    // Best height we've heard from ANYONE — a server's /tip or a peer's hello.
    // No single source is authoritative; we just take the max we've been told.
    const target = Math.max(ss?.serverHeight ?? 0, ns?.bestPeerHeight ?? 0);
    if (target > this.syncStatus.targetHeight) this.emitSync({ targetHeight: target });

    if (target - local > SYNC_BACKLOG_BLOCKS) {
      // A real backlog to pull — (re-)show the overlay while we verify it. This
      // is the key fix: even if we already dropped the overlay during the
      // heartbeat-before-tip race (server marked reachable while its serverHeight
      // was still 0), learning a far-ahead tip now puts the overlay back up.
      this.emitSync({ syncing: true, phase: 'verifying' });
      return;
    }
    if (!this.syncStatus.syncing) return; // within threshold and already caught up

    const serverUp = !!ss && ss.reachable > 0;
    const peerUp = !!ns && ns.connected > 0;
    // Only drop once we've actually heard a height from someone (target > 0) and
    // we're within the trivial-backlog window. Until then keep the overlay up so
    // we never expose a height-0 cached chain during the connect window. If no
    // one ever answers, target stays 0 and the 12s safety net handles it.
    if (target > 0 && (serverUp || peerUp)) {
      this.emitSync({ syncing: false, phase: 'ready' });
    } else if (serverUp || peerUp) {
      this.emitSync({ phase: 'fetching' });
    } else {
      this.emitSync({ phase: 'connecting' });
    }
  }

  /**
   * User clicked "Continue offline" on the sync overlay. Hides the overlay for
   * the rest of the session so they can interact with the app while sync
   * continues in the background. We deliberately do NOT flip `syncing` false:
   * the node really is still catching up, so mining stays gated and
   * `updateSyncReadiness` keeps tracking backlog — it just can't re-surface the
   * overlay, because the UI gates visibility on this sticky flag. Balances may
   * be stale until the chain catches up.
   */
  dismissSyncOverlay(): void {
    if (this.syncStatus.dismissed) return;
    this.emitSync({ dismissed: true });
  }

  async startNetwork(): Promise<void> {
    if (this.network) return;
    if (!this.serverSync) {
      console.warn('[node] startNetwork called before serverSync exists');
      return;
    }
    this.network = new PeerNetwork(
      this.chain,
      this.mempool,
      this.serverLists.signaling,
      this.serverSync,
      () => {
        // A peer-relayed block or tx — re-template the miner, refresh UI.
        // We do NOT push these to the server: the originating miner already
        // POSTed the block, and the originating sender already POSTed the tx.
        // Pushing again here would cause every connected tab to re-POST the
        // same block on every gossip, which is exactly the "server lag with
        // a lot of people" path we want to avoid.
        this.miner.refresh();
        this.emitChain();
      },
      () => this.miner.getStatus().running,
    );

    // Persist any peer we successfully see — both directly-connected peers and
    // peers we learn about via `addrs` gossip. The next page-load can then
    // dial these directly without waiting on the bootstrap server.
    this.network.onPeerSeen((id) => {
      void recordPeerSeen(id).catch((e) =>
        console.warn('[node] peer cache write failed:', (e as Error).message),
      );
    });

    // Seed the candidate pool from IDB before we start. If the bootstrap server
    // is down, these are our only way to reconnect to the existing mesh.
    try {
      const cached = await listCachedPeers();
      if (cached.length > 0) this.network.seedCandidates(cached);
    } catch (e) {
      console.warn('[node] peer cache read failed:', (e as Error).message);
    }

    try {
      await this.network.start();
      // Keep ServerSync informed about connectivity so it can switch off when
      // P2P is healthy and resume a slow safety poll only if we go isolated.
      this.network.onStatus((s) => {
        this.serverSync?.setPeerCount(s.connected);
        // A new peer counts as connectivity — drop the sync overlay if we were
        // waiting for any network at all.
        this.updateSyncReadiness();
      });
      this.serverSync?.setPeerCount(this.network.getStatus().connected);
      this.updateSyncReadiness();
    } catch (e) {
      console.warn('[node] network start failed', (e as Error).message);
      this.network = null;
    }
  }

  stopNetwork(): void {
    this.network?.stop();
    this.network = null;
  }

  /**
   * Replace the API + signaling server lists. Persists to localStorage and
   * pushes the new lists to ServerSync (live update — no restart needed) and
   * PeerNetwork (restart required because signaling-server changes mean new
   * PeerJS clients, which drops existing WebRTC connections).
   */
  setServerLists(lists: ServerLists): void {
    this.serverLists = lists;
    saveServerLists(lists);
    this.serverSync?.setApiServers(lists.api);
    if (this.network) {
      void this.network.setSignalingServers(lists.signaling);
    }
  }

  setWallet(kp: KeyPair): void {
    this.wallet = kp;
    saveWallet(kp);
    this.miner.setMinerAddress(kp.publicKey);
    // The activity index is address-specific — rebuild it for the new wallet
    // (one canonical pass over blocks already in memory).
    this.activityIndex.rebuild(kp.address, this.chain.iterateCanonical());
    this.emitWallet();
    this.emitChain();
  }

  myBalance(): bigint {
    return getAccount(this.chain.tipState, this.wallet.address).balance;
  }

  myNonce(): number {
    const onChain = getAccount(this.chain.tipState, this.wallet.address).nonce;
    // Account for our own txs already queued in the mempool so rapid sends get
    // sequential nonces (N, N+1, …) instead of all reusing the on-chain nonce.
    return this.mempool.nextNonceFor(this.wallet.address, onChain);
  }

  /** Build and submit a tx from the user's wallet. Returns null on success or an error. */
  send(toAddress: Uint8Array, amountWww: string, feeWww: string): string | null {
    let amount: bigint;
    let fee: bigint;
    try {
      amount = parseAmount(amountWww);
      fee = parseAmount(feeWww);
    } catch (e) {
      return (e as Error).message;
    }
    const nonce = this.myNonce();
    const tx: Transaction = signTx(
      { from: this.wallet.publicKey, to: toAddress, amount, fee, nonce, } as Omit<Transaction, 'signature'>,
      this.wallet.privateKey,
    );
    const err = this.mempool.add(tx, this.chain.tipState);
    if (err) return err;
    this.network?.broadcastTx(tx);
    this.serverSync?.pushTx(tx);
    this.miner.refresh();
    this.emitChain();
    return null;
  }

  onChain(fn: ChainListener): () => void {
    this.chainListeners.add(fn);
    return () => this.chainListeners.delete(fn);
  }

  onWallet(fn: ChainListener): () => void {
    this.walletListeners.add(fn);
    return () => this.walletListeners.delete(fn);
  }

  /** Fires only for blocks this tab mined and that the chain accepted. */
  onBlockMined(fn: (info: MinedBlockInfo) => void): () => void {
    this.blockMinedListeners.add(fn);
    return () => this.blockMinedListeners.delete(fn);
  }

  private emitChain(): void {
    for (const fn of this.chainListeners) fn();
  }

  private emitWallet(): void {
    for (const fn of this.walletListeners) fn();
  }

  private emitBlockMined(block: Block): void {
    let fees = 0n;
    for (const tx of block.transactions) fees += tx.fee;
    const info: MinedBlockInfo = {
      height: block.header.height,
      reward: blockReward(block.header.height),
      fees,
      txCount: block.transactions.length,
    };
    for (const fn of this.blockMinedListeners) fn(info);
  }
}

/** Parse a user-entered BRC amount ("12.5") into wei (bigint). */
export function parseAmount(input: string): bigint {
  const s = input.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error('amount must be a positive number');
  const [whole, frac = ''] = s.split('.');
  const fracPadded = (frac + '00000000').slice(0, 8);
  return BigInt(whole!) * COIN + BigInt(fracPadded);
}

/** Format wei to a human-friendly BRC amount with up to 8 decimals. */
export function formatAmount(wei: bigint): string {
  const neg = wei < 0n;
  const abs = neg ? -wei : wei;
  const whole = abs / COIN;
  const frac = abs % COIN;
  const fracStr = frac.toString().padStart(8, '0').replace(/0+$/, '');
  const body = fracStr ? `${whole}.${fracStr}` : `${whole}`;
  return (neg ? '-' : '') + body;
}
