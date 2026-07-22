import { Blockchain } from './chain/blockchain.js';
import { Mempool } from './chain/mempool.js';
import { signTx, signLock, lockIdOf, redeemSighash, TxKind, type Transaction } from './chain/transaction.js';
import { scriptHash } from './chain/script.js';
import { hashlockSigScript } from './chain/scriptBuild.js';
import { sign as signMessage } from './crypto/keys.js';
import { sha256 } from './crypto/hash.js';
import { type KeyPair } from './crypto/keys.js';
import { MinerController } from './miner/controller.js';
import { PeerNetwork } from './net/peer.js';
import { ServerSync } from './net/serverSync.js';
import { HistoryBackfill, type BackfillStatus } from './net/backfill.js';
import type { FastSyncPersistData } from './net/fastSync.js';
import { getExplorerIndex } from './ui/explorerIndex.js';
import { loadServerLists, saveServerLists, type ServerLists } from './net/servers.js';
import { BROWSERCOIN_NETWORK } from './net/network.js';
import { loadOrCreateWallet, saveWallet } from './storage/wallet.js';
import {
  deserializeState,
  getAccount,
  getLock,
  serializeState,
  serializeLocks,
  stateRoot,
  type StateRow,
  type LockRow,
} from './chain/state.js';
import { blockReward, COIN, SNAPSHOT_DEPTH } from './chain/genesis.js';
import { HEADER_LEN, decodeBlock, decodeHeader, encodeBlock, hashHeader, type Block } from './chain/block.js';
import { bytesToHex, hexToBytes, compareBytes } from './util/binary.js';
import { ActivityIndex } from './ui/activityIndex.js';
import {
  clearAll,
  delMeta,
  getAllBlocksOrdered,
  getMeta,
  listCachedPeers,
  putBlock,
  putMeta,
  recordPeerFailure,
  recordPeerSeen,
  type StoredBlock,
} from './storage/idb.js';

/**
 * Persisted state snapshot. A LOCAL, regenerable performance cache: the full
 * account state at a finalized block (SNAPSHOT_DEPTH below the tip) so a reopened
 * tab can jump straight to that state instead of replaying every block's txs from
 * genesis. Lives in the `meta` store (no DB schema bump). NOT a consensus
 * checkpoint — see SNAPSHOT_DEPTH.
 */
interface StateSnapshot {
  v: 1;
  chainVersion: string;
  finalizedHeight: number;
  finalizedHashHex: string;
  accounts: StateRow[]; // state AFTER the finalized block
  locks?: LockRow[];    // script locks live at the finalized block (omitted pre-fork / old snapshots)
}

/**
 * Persisted header prefix from a fast sync: the verified headers for heights
 * 1..anchorHeight, so a reload can rebuild the header-only chain without
 * re-downloading. Deleted once history backfill completes (the tab then holds
 * every full block and restores via the ordinary snapshot path). Lives next to
 * `stateSnapshot` in the meta store (no DB schema bump).
 */
interface HeaderChainMeta {
  v: 1;
  chainVersion: string;
  anchorHeight: number;
  anchorHashHex: string;
  /** encodeHeader() of heights 1..anchorHeight, concatenated (148 B each). */
  bytes: Uint8Array;
}

/**
 * Version tag tied to PoW params + chain genesis. When the network does a
 * hard-fork (e.g. salt bump in pow.ts), bump this so existing IDB caches are
 * cleared on next load — stops the browser from trying to restore blocks that
 * the new server will reject. Must stay in lock-step with server/api.ts.
 */
export const CHAIN_VERSION = BROWSERCOIN_NETWORK;

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

/** fastSyncNote shown while a deep backlog syncs with zero reachable helpers. */
const HELPERS_UNREACHABLE_NOTE =
  'Helper servers unreachable from this device — pulling blocks from peers instead, which is much slower.';

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
  phase: 'restoring' | 'connecting' | 'fetching' | 'verifying' | 'headers' | 'snapshot' | 'ready' | 'offline';
  /**
   * Fine-grained progress for the fast-sync phases ('headers' | 'snapshot'),
   * where `localHeight` doesn't move (the chain stays at genesis until the
   * verified anchor is seeded in one step). Undefined elsewhere.
   */
  aux?: { done: number; total: number };
  /**
   * Human-readable explanation when the tab is NOT fast-syncing a deep backlog
   * (attempt failed, helpers too old, helpers unreachable). Undefined while
   * fast sync is working or unneeded. Exists so the sync overlay can say WHY
   * a sync is slow — phones have no devtools console to read the logs.
   */
  fastSyncNote?: string;
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
  private backfillListeners = new Set<(s: BackfillStatus) => void>();
  /** Background history backfill after a fast sync (null until started). */
  private backfill: HistoryBackfill | null = null;
  /** Debounce handle + last-written height for the persisted state snapshot. */
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSnapshotHeight = -1;
  /**
   * Tip hash hex we've most recently gossiped to WebRTC peers. Lets us re-gossip
   * a server-sourced block exactly once: an off-mesh ("server-only") miner's
   * block reaches us only via the bridge poll, so flooding it to peers makes the
   * whole mesh learn it in ms instead of each peer waiting out its own poll —
   * effective bridge delay becomes ~poll_interval / number-of-polling-peers and
   * shrinks as the network grows. Deduped so repeat syncs (mempool-only,
   * bootstrap multi-block, or a tip we already gossiped) don't re-broadcast.
   */
  private lastGossipedTipHex = '';
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
      // Evict txs that can't be mined against the new tip — a consumed nonce
      // slot, a nonce gap, or an overdraw — so they don't keep showing as
      // pending or wedge the per-sender walk in selectForBlock.
      this.mempool.pruneUnminable(this.chain.tipState);
      this.miner.refresh();
      this.emitChain();
      // Refresh the persisted state snapshot so the next page load is fast.
      this.scheduleSnapshot();
    });

    // A block arrived whose parent's state we no longer hold (pruned below the
    // SNAPSHOT_DEPTH window, or below a snapshot anchor). Drop the snapshot so
    // the next load replays from IDB blocks instead of trusting the anchor.
    // Note the rolling state pruner means a replay keeps only the same window —
    // a genuine reorg deeper than SNAPSHOT_DEPTH needs the Settings chain reset
    // (wipe + network re-sync of the new branch). Practically unreachable given
    // sync's 5-block overlap; stale fork blocks from peers land here too, and
    // for those dropping the regenerable snapshot is harmless.
    this.chain.onSnapshotInvalidated(() => {
      console.warn('[node] block references pruned state (reorg deeper than snapshot window?); clearing snapshot');
      void delMeta('stateSnapshot');
      void delMeta('headerChain'); // a fast-synced prefix anchors on the same snapshot
      this.lastSnapshotHeight = -1;
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
        this.gossipTipIfNew();
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
   * If a state snapshot is present (and valid for this build), we seed the
   * finalized account state directly and only replay the unfinalized tail above
   * the snapshot anchor — skipping the O(accounts)-per-block clone + apply for
   * the whole finalized prefix. The prefix blocks are still loaded into memory
   * (state left unmaterialized) so the explorer, P2P serving and wallet history
   * keep working. Any snapshot anomaly falls back to a clean full replay.
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

      // getAllBlocksOrdered uses the height index, so blocks arrive ascending.
      const stored = await getAllBlocksOrdered();
      const snap = await getMeta<StateSnapshot>('stateSnapshot');
      const snapValid = !!snap && snap.v === 1 && snap.chainVersion === CHAIN_VERSION && snap.finalizedHeight > 0;

      // A fast-synced tab persisted its verified header prefix — restore it
      // (with any already-backfilled real blocks layered in) even when the
      // blocks store alone can't reach the anchor. Deleted once backfill
      // completes, after which the ordinary snapshot path below takes over.
      const headerChain = await getMeta<HeaderChainMeta>('headerChain');
      if (
        headerChain && headerChain.v === 1 && headerChain.chainVersion === CHAIN_VERSION &&
        snapValid && snap.finalizedHeight === headerChain.anchorHeight && snap.finalizedHashHex === headerChain.anchorHashHex
      ) {
        try {
          await this.replayWithHeaderChain(stored, headerChain, snap);
          this.activityIndex.rebuild(this.wallet.address, this.chain.iterateCanonical());
          if (this.chain.height > 0) {
            console.log(`[node] restored to tip h=${this.chain.height} (header-chain fast-path)`);
            this.emitChain();
          }
          return;
        } catch (e) {
          console.warn('[node] header-chain restore failed; discarding fast-sync state:', (e as Error).message);
          this.chain.reset();
          void delMeta('headerChain');
          void delMeta('stateSnapshot');
          // Fall through to the ordinary paths over whatever full blocks exist.
        }
      }

      if (stored.length === 0) return;

      let usedSnapshot = false;
      if (snapValid) {
        try {
          await this.replayWithSnapshot(stored, snap);
          usedSnapshot = true;
        } catch (e) {
          // Any inconsistency → discard the partial seed + bad snapshot and replay
          // from scratch. A fresh snapshot is rewritten once we settle on a tip.
          console.warn('[node] snapshot restore failed; full replay:', (e as Error).message);
          this.chain.reset();
          void delMeta('stateSnapshot');
        }
      }
      if (!usedSnapshot) {
        await this.fullReplay(stored);
      } else {
        // Prefix blocks were seeded without firing tip events, so the activity
        // index missed them — rebuild it from the full in-memory canonical chain.
        this.activityIndex.rebuild(this.wallet.address, this.chain.iterateCanonical());
      }

      if (this.chain.height > 0) {
        console.log(
          `[node] restored to tip h=${this.chain.height}${usedSnapshot ? ' (snapshot fast-path)' : ''}`,
        );
        this.emitChain();
      } else {
        // Had blocks on disk but restored nothing — every one was orphaned. The
        // tab is about to re-download the whole chain, so say so rather than
        // silently bootstrapping and leaving the user to guess why.
        console.warn(
          `[node] restore recovered 0 blocks from ${stored.length} stored — prefix unreachable; re-syncing from the network`,
        );
      }
    } catch (e) {
      console.warn('[node] idb restore failed:', (e as Error).message);
    }
  }

  /** Replay every stored block with full per-block state apply (the slow path). */
  private async fullReplay(stored: StoredBlock[]): Promise<void> {
    for (const row of stored) {
      if (row.height === 0) continue; // genesis is hardcoded
      let block: Block;
      try {
        block = decodeBlock(row.encoded);
      } catch (e) {
        console.warn('[node] idb decode failed at h=', row.height, (e as Error).message);
        continue;
      }
      const err = await this.chain.addValidatedBlock(block);
      if (err) console.warn('[node] idb block rejected at h=', row.height, err);
    }
  }

  /**
   * Seed the chain from a state snapshot: prefix blocks (below the anchor) keep
   * their data but no materialized state; the anchor gets the snapshot state;
   * the tail above the anchor is replayed normally. Throws on any inconsistency
   * (decode failure, missing anchor, stateRoot mismatch) so the caller can fall
   * back to a clean full replay.
   */
  private async replayWithSnapshot(stored: StoredBlock[], snap: StateSnapshot): Promise<void> {
    const anchorState = deserializeState(snap.accounts, snap.locks ?? []);
    const finalizedHeight = snap.finalizedHeight;
    let anchorSeeded = false;

    for (const row of stored) {
      if (row.height === 0) continue; // genesis is hardcoded
      const block = decodeBlock(row.encoded); // throws → caller resets + full-replays
      const hashHex = bytesToHex(hashHeader(block.header));

      if (row.height < finalizedHeight) {
        const err = this.chain.seedHistoricalBlock(block, null);
        if (err) throw new Error(`seed h=${row.height}: ${err}`);
      } else if (row.height === finalizedHeight) {
        if (hashHex === snap.finalizedHashHex) {
          // Integrity: the snapshot state must hash to this block's stateRoot.
          if (compareBytes(stateRoot(anchorState), block.header.stateRoot) !== 0) {
            throw new Error('snapshot stateRoot mismatch');
          }
          const err = this.chain.seedHistoricalBlock(block, anchorState);
          if (err) throw new Error(`seed anchor: ${err}`);
          anchorSeeded = true;
        } else {
          // A non-canonical fork at the anchor height — keep it, no state.
          const err = this.chain.seedHistoricalBlock(block, null);
          if (err) throw new Error(`seed fork h=${row.height}: ${err}`);
        }
      } else {
        // Tail (above the anchor): replay with full state apply. The first tail
        // block's parent is the materialized anchor.
        const err = await this.chain.addValidatedBlock(block);
        if (err) throw new Error(`tail h=${row.height}: ${err}`);
      }
    }

    if (!anchorSeeded) throw new Error('snapshot anchor not found in idb');
  }

  /**
   * Restore a fast-synced tab: rebuild the header-only prefix from the
   * persisted header blob, preferring a stored REAL block at each height (from
   * partial backfill or the tail), verify the anchor state against its header's
   * stateRoot, then replay stored tail blocks above the anchor. Throws on any
   * inconsistency so the caller can discard the fast-sync state entirely.
   */
  private async replayWithHeaderChain(
    stored: StoredBlock[],
    hc: HeaderChainMeta,
    snap: StateSnapshot,
  ): Promise<void> {
    const bytes = hc.bytes;
    if (!(bytes instanceof Uint8Array) || bytes.length !== hc.anchorHeight * HEADER_LEN) {
      throw new Error('header blob length mismatch');
    }
    const anchorState = deserializeState(snap.accounts, snap.locks ?? []);
    const byHash = new Map<string, StoredBlock>();
    for (const row of stored) byHash.set(row.hash, row);

    for (let i = 0; i < hc.anchorHeight; i++) {
      const header = decodeHeader(bytes, i * HEADER_LEN);
      if (header.height !== i + 1) throw new Error(`header blob height sequence broken at ${i}`);
      const hashHex = bytesToHex(hashHeader(header));
      const isAnchor = header.height === hc.anchorHeight;
      const row = byHash.get(hashHex);

      if (isAnchor) {
        if (hashHex !== hc.anchorHashHex) throw new Error('anchor hash mismatch');
        if (compareBytes(stateRoot(anchorState), header.stateRoot) !== 0) {
          throw new Error('snapshot stateRoot mismatch');
        }
        const err = row
          ? this.chain.seedHistoricalBlock(decodeBlock(row.encoded), anchorState)
          : this.chain.seedAnchor(header, anchorState);
        if (err) throw new Error(`seed anchor: ${err}`);
      } else {
        const err = row
          ? this.chain.seedHistoricalBlock(decodeBlock(row.encoded), null)
          : this.chain.seedHeader(header);
        if (err) throw new Error(`seed h=${header.height}: ${err}`);
      }
    }

    // Tail above the anchor: ordinary validated replay (parents materialized).
    for (const row of stored) {
      if (row.height <= hc.anchorHeight) continue;
      const block = decodeBlock(row.encoded);
      const err = await this.chain.addValidatedBlock(block);
      if (err) throw new Error(`tail h=${row.height}: ${err}`);
    }
  }

  /**
   * Debounced refresh of the persisted state snapshot. Called on every canonical
   * tip move; coalesces bursts (e.g. a sync catch-up) into a single write a few
   * seconds after the chain settles.
   */
  private scheduleSnapshot(): void {
    if (this.snapshotTimer !== null) clearTimeout(this.snapshotTimer);
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = null;
      void this.writeSnapshot();
    }, 5000);
  }

  /**
   * Persist the account state at a finalized block (SNAPSHOT_DEPTH below the tip)
   * so the next page load can skip replaying the finalized prefix. Best-effort:
   * any failure just leaves the previous snapshot (or none) in place.
   *
   * Pinned to the anchor while a fast-synced header prefix is still in play —
   * see the `headerChain` guard below.
   */
  private async writeSnapshot(): Promise<void> {
    try {
      const finalizedHeight = this.chain.height - SNAPSHOT_DEPTH;
      if (finalizedHeight <= 0) return; // chain too short to finalize anything
      if (finalizedHeight === this.lastSnapshotHeight) return; // unchanged since last write

      // A fast-synced tab has no full blocks below its anchor; the ONLY thing
      // that can rebuild that prefix is the `headerChain` blob, and the sole
      // path that reads it (replayWithHeaderChain) requires the snapshot to sit
      // exactly ON the anchor. Advancing past the anchor therefore strands the
      // blob: restore falls through to replayWithSnapshot, which throws
      // 'parent block unknown' because the prefix was never seeded, and the tab
      // re-bootstraps the whole chain from the network. That took ~SNAPSHOT_DEPTH
      // blocks (~4 h) after any fast sync, and recurred on every later refresh.
      // So hold the snapshot at the anchor until backfill completes and deletes
      // the blob, after which this resumes tracking the tip normally.
      const hc = await getMeta<HeaderChainMeta>('headerChain');
      if (hc && hc.v === 1 && hc.chainVersion === CHAIN_VERSION && finalizedHeight > hc.anchorHeight) {
        return;
      }

      const at = this.chain.snapshotAt(finalizedHeight);
      if (!at) return; // target not reached or not materialized
      const snap: StateSnapshot = {
        v: 1,
        chainVersion: CHAIN_VERSION,
        finalizedHeight: at.height,
        finalizedHashHex: at.hashHex,
        accounts: serializeState(at.state),
        locks: serializeLocks(at.state),
      };
      await putMeta('stateSnapshot', snap);
      this.lastSnapshotHeight = finalizedHeight;
    } catch (e) {
      console.warn('[node] snapshot write failed:', (e as Error).message);
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
        // Re-gossip a server-sourced tip to our WebRTC peers. Off-mesh miners'
        // blocks only reach us via the bridge poll; flooding them over P2P lets
        // the whole mesh catch up in ms instead of each peer waiting its own
        // poll. Deduped by tip hash, so a mempool-only sync doesn't broadcast.
        this.gossipTipIfNew();
      },
      () => this.miner.getStatus().running,
      () => this.refreshServerListsFromDiscovery(),
    );
    // Fast sync (headers + verified snapshot) reports progress through the
    // sync overlay and persists its verified state for instant reloads.
    this.serverSync.setFastSyncHooks({
      onProgress: (p) => {
        this.emitSync({ syncing: true, phase: p.phase, aux: { done: p.done, total: p.total } });
      },
      persist: async (data: FastSyncPersistData) => {
        const headerChain: HeaderChainMeta = {
          v: 1,
          chainVersion: CHAIN_VERSION,
          anchorHeight: data.anchorHeight,
          anchorHashHex: data.anchorHashHex,
          bytes: data.headerBytes,
        };
        const snap: StateSnapshot = {
          v: 1,
          chainVersion: CHAIN_VERSION,
          finalizedHeight: data.anchorHeight,
          finalizedHashHex: data.anchorHashHex,
          accounts: data.accounts,
          locks: data.locks,
        };
        await putMeta('headerChain', headerChain);
        await putMeta('stateSnapshot', snap);
        this.lastSnapshotHeight = data.anchorHeight;
      },
      onOutcome: (o) => {
        const note = o.status === 'ok'
          ? undefined
          : o.status === 'unsupported'
            ? 'Fast sync unavailable: the helper servers don’t serve headers/snapshots — verifying every block instead.'
            : `Fast sync attempt ${o.attempt} failed (${o.reason})${o.willRetry ? ' — retrying…' : ' — verifying every block instead.'}`;
        this.emitSync({ fastSyncNote: note });
      },
    });
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
      // Fast-sync phases own the overlay while they run — don't clobber their
      // label with 'verifying' (their backlog is huge by design).
      const inFastSync = this.syncStatus.phase === 'headers' || this.syncStatus.phase === 'snapshot';
      // No reachable helper = fast sync can never even start (it needs their
      // /headers + /snapshot); the backlog is grinding in over P2P. Say so.
      // Only touch the note when it's ours — an attempt-failure note from
      // onOutcome is more specific and must not be overwritten.
      const serverUp = (this.serverSync?.getStatus().reachable ?? 0) > 0;
      const cur = this.syncStatus.fastSyncNote;
      const note = !serverUp && (cur === undefined || cur === HELPERS_UNREACHABLE_NOTE)
        ? HELPERS_UNREACHABLE_NOTE
        : serverUp && cur === HELPERS_UNREACHABLE_NOTE ? undefined : cur;
      this.emitSync({ syncing: true, phase: inFastSync ? this.syncStatus.phase : 'verifying', fastSyncNote: note });
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
      this.emitSync({ syncing: false, phase: 'ready', aux: undefined });
      // Fast-synced (or reloaded mid-backfill) tabs still miss historical tx
      // bodies — start/resume the background backfill now that we're caught up.
      this.maybeStartBackfill();
    } else if (serverUp || peerUp) {
      this.emitSync({ phase: 'fetching' });
    } else {
      this.emitSync({ phase: 'connecting' });
    }
  }

  /** Begin background history backfill if the chain has a bodyless prefix. */
  private maybeStartBackfill(): void {
    if (this.backfill || !this.serverSync) return;
    if (this.chain.bodylessCount === 0) return;
    const sync = this.serverSync;
    this.backfill = new HistoryBackfill({
      chain: this.chain,
      servers: () => sync.getApiServers(),
      fetchImpl: (url) => sync.fetchWithTimeout(url),
      verifier: sync.verifierPool(),
      persistBlock: (hashHex, height, encoded) => putBlock(hashHex, height, encoded),
      onProgress: (s) => this.emitBackfill(s),
      onComplete: async () => {
        // The tab is archival now — the ordinary block-store restore covers
        // reloads, so the header blob is dead weight.
        await delMeta('headerChain').catch(() => {});
        // Prefix bodies attached outside the tip-event stream: rebuild the
        // wallet history and flag the explorer index for its lazy rebuild.
        this.activityIndex.rebuild(this.wallet.address, this.chain.iterateCanonical());
        getExplorerIndex(this.chain).markStale();
        console.log('[node] history backfill complete — full block history available');
        this.emitBackfill(this.backfill!.getStatus());
        this.emitChain();
      },
      onFatal: (reason) => {
        console.error('[node] fast-sync prefix failed full verification:', reason);
        void this.discardChainAndResync();
      },
    });
    this.backfill.start();
    this.emitBackfill(this.backfill.getStatus());
  }

  getBackfillStatus(): BackfillStatus {
    if (this.backfill) return this.backfill.getStatus();
    const missing = this.chain.bodylessCount;
    return { total: missing, remaining: missing, running: false };
  }

  onBackfill(fn: (s: BackfillStatus) => void): () => void {
    this.backfillListeners.add(fn);
    return () => this.backfillListeners.delete(fn);
  }

  private emitBackfill(s: BackfillStatus): void {
    for (const fn of this.backfillListeners) fn(s);
  }

  /**
   * Nuclear option, reached only when the background PoW sweep proves the
   * fast-synced prefix forged (a helper fed us a chain that survived sampled
   * verification): stop mining, wipe every local artifact, and re-sync from
   * genesis through the normal fully-validating path. Fast sync stays off for
   * the rest of the session (ServerSync only ever tries it once).
   */
  private async discardChainAndResync(): Promise<void> {
    this.miner.stop();
    this.backfill?.stop();
    this.backfill = null;
    try {
      await clearAll();
      await putMeta('chainVersion', CHAIN_VERSION);
    } catch (e) {
      console.warn('[node] idb wipe failed:', (e as Error).message);
    }
    this.lastSnapshotHeight = -1;
    this.chain.reset();
    this.emitSync({ syncing: true, phase: 'fetching', aux: undefined });
    this.emitChain();
    this.serverSync?.kick();
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
        // peer.ts already re-gossips an accepted P2P block to our other peers,
        // so mark this tip as gossiped — a later server-sync mempool tick must
        // not redundantly re-broadcast a block the mesh already has.
        this.lastGossipedTipHex = bytesToHex(this.chain.tip.hash);
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

    // Tick up the failure count for dead IDs so they're evicted from the cache
    // after MAX_PEER_FAILURES instead of lingering and being re-dialed each load.
    this.network.onPeerFailed((id) => {
      void recordPeerFailure(id).catch((e) =>
        console.warn('[node] peer failure write failed:', (e as Error).message),
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

  /**
   * Apply newly cached helper records to live subsystems without saving them as
   * manual settings. Manual localStorage server lists still win in
   * loadServerLists(); this only refreshes default-derived sides.
   */
  refreshServerListsFromDiscovery(): void {
    const current = this.serverLists;
    const next = loadServerLists();
    const apiChanged = !sameStringList(current.api, next.api);
    const signalingChanged = !sameStringList(current.signaling, next.signaling);
    if (!apiChanged && !signalingChanged) return;

    this.serverLists = next;
    if (apiChanged) this.serverSync?.setApiServers(next.api);
    if (signalingChanged && this.network && this.network.getStatus().connected === 0) {
      void this.network.setSignalingServers(next.signaling);
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

  /** Shared broadcast tail for a built script tx. */
  private submit(tx: Transaction): string | null {
    const err = this.mempool.add(tx, this.chain.tipState);
    if (err) return err;
    this.network?.broadcastTx(tx);
    this.serverSync?.pushTx(tx);
    this.miner.refresh();
    this.emitChain();
    return null;
  }

  /**
   * Lock coins from the user's wallet under `redeemScript`. Only the script's
   * hash is published now; the script itself is revealed when redeemed. Returns
   * the new lock's id (hex) on success, or an error string.
   */
  lock(amountWww: string, feeWww: string, redeemScript: Uint8Array): { lockId: string } | string {
    if (!this.chain.nextBlockScriptContext().scriptsActive) {
      return 'scripts are not active yet — they activate at the fork date';
    }
    let amount: bigint;
    let fee: bigint;
    try {
      amount = parseAmount(amountWww);
      fee = parseAmount(feeWww);
    } catch (e) {
      return (e as Error).message;
    }
    const nonce = this.myNonce();
    const tx = signLock(
      { from: this.wallet.publicKey, to: new Uint8Array(32), amount, fee, nonce, scriptHash: scriptHash(redeemScript) },
      this.wallet.privateKey,
    );
    const err = this.submit(tx);
    if (err) return err;
    return { lockId: bytesToHex(lockIdOf(tx)) };
  }

  /**
   * Redeem an existing lock by revealing its `redeemScript` and supplying a
   * `witness` that satisfies it, paying the locked amount (minus `feeWww`) to
   * `toAddress`. The lock must already be confirmed on-chain.
   */
  redeem(lockIdHex: string, toAddress: Uint8Array, feeWww: string, redeemScript: Uint8Array, witness: Uint8Array[]): string | null {
    if (!this.chain.nextBlockScriptContext().scriptsActive) return 'scripts are not active yet — they activate at the fork date';
    const lock = getLock(this.chain.tipState, lockIdHex.toLowerCase());
    if (!lock) return 'lock not found (it must be confirmed on-chain and unspent)';
    if (compareBytes(scriptHash(redeemScript), lock.scriptHash) !== 0) return 'this script does not match the lock';
    let fee: bigint;
    try {
      fee = parseAmount(feeWww);
    } catch (e) {
      return (e as Error).message;
    }
    if (fee > lock.amount) return 'fee exceeds the locked amount';
    const tx: Transaction = {
      kind: TxKind.Redeem,
      from: new Uint8Array(32),
      to: toAddress,
      amount: lock.amount, // a redeem must claim exactly the locked amount
      fee,
      nonce: 0,
      signature: new Uint8Array(0),
      lockId: hexToBytes(lockIdHex.toLowerCase()),
      redeemScript,
      witness,
    };
    // redeemSighash is what a signature-based witness would sign over; surfaced
    // here so a future signed-template builder can reuse this path unchanged.
    void redeemSighash(tx);
    return this.submit(tx);
  }

  /**
   * Redeem a hash-locked PAYMENT (`OP_SHA256 <h> OP_EQUALVERIFY <pubkey>
   * OP_CHECKSIG`) addressed to this wallet's key. Reconstructs the script from
   * the secret `preimage` + our own pubkey, signs the spend (binding `to`,
   * amount and fee so it can't be front-run), and submits. The lock must have
   * been created for our key, or the script hash won't match.
   */
  redeemHashlock(lockIdHex: string, preimage: Uint8Array, toAddress: Uint8Array, feeWww: string): string | null {
    if (!this.chain.nextBlockScriptContext().scriptsActive) return 'scripts are not active yet — they activate at the fork date';
    const lock = getLock(this.chain.tipState, lockIdHex.toLowerCase());
    if (!lock) return 'lock not found (it must be confirmed on-chain and unspent)';
    const redeemScript = hashlockSigScript(sha256(preimage), this.wallet.publicKey);
    if (compareBytes(scriptHash(redeemScript), lock.scriptHash) !== 0) {
      return 'this lock is not payable to your key with that secret';
    }
    let fee: bigint;
    try {
      fee = parseAmount(feeWww);
    } catch (e) {
      return (e as Error).message;
    }
    if (fee > lock.amount) return 'fee exceeds the locked amount';
    const tx: Transaction = {
      kind: TxKind.Redeem,
      from: new Uint8Array(32),
      to: toAddress,
      amount: lock.amount,
      fee,
      nonce: 0,
      signature: new Uint8Array(0),
      lockId: hexToBytes(lockIdHex.toLowerCase()),
      redeemScript,
      witness: [],
    };
    // Sign the sighash (which commits to `to`/amount/fee), then witness = [sig, preimage].
    const sig = signMessage(redeemSighash(tx), this.wallet.privateKey);
    tx.witness = [sig, preimage];
    return this.submit(tx);
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

  /**
   * Re-broadcast the current tip to WebRTC peers unless we've already gossiped
   * it. Called after a local mine and after a server-sourced pull so off-mesh
   * blocks propagate across the mesh in ms; the tip-hash dedup keeps a
   * mempool-only sync, a bootstrap multi-block catch-up, or a tip peers already
   * have from re-sending. No-op when P2P isn't up yet (`network` undefined).
   */
  private gossipTipIfNew(): void {
    const tipHex = bytesToHex(this.chain.tip.hash);
    if (tipHex === this.lastGossipedTipHex) return;
    this.lastGossipedTipHex = tipHex;
    this.network?.broadcastBlock();
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

function sameStringList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
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
