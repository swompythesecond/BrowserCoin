import { Blockchain } from './chain/blockchain.js';
import { Mempool } from './chain/mempool.js';
import { signTx, type Transaction } from './chain/transaction.js';
import { type KeyPair } from './crypto/keys.js';
import { MinerController } from './miner/controller.js';
import { PeerNetwork } from './net/peer.js';
import { ServerSync } from './net/serverSync.js';
import { loadOrCreateWallet, saveWallet } from './storage/wallet.js';
import { getAccount } from './chain/state.js';
import { COIN } from './chain/genesis.js';

const DEFAULT_BOOTSTRAP = 'http://localhost:9000';

type ChainListener = () => void;

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
  readonly miner: MinerController;
  network: PeerNetwork | null = null;
  serverSync: ServerSync | null = null;
  bootstrapUrl: string;

  private chainListeners = new Set<ChainListener>();
  private walletListeners = new Set<ChainListener>();

  constructor() {
    this.wallet = loadOrCreateWallet();
    this.bootstrapUrl =
      localStorage.getItem('browsercoin:bootstrap') || DEFAULT_BOOTSTRAP;

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
        this.mempool.removeMany(block.transactions);
        this.miner.refresh();
        this.network?.broadcastBlock();
        this.serverSync?.kick();
        this.emitChain();
      },
    );
  }

  /**
   * One-call setup: subscribe to the server, dial P2P. Idempotent — calling
   * twice has no effect. UI calls this once on page load.
   */
  async start(): Promise<void> {
    // Start the server sync first — it works even when WebRTC fails (firewalls,
    // odd network setups). This means a brand-new tab always catches up.
    this.serverSync = new ServerSync(this.chain, this.mempool, this.bootstrapUrl, () => {
      this.miner.refresh();
      this.emitChain();
    });
    void this.serverSync.start();

    // Then dial peers. Failure here is non-fatal — server sync alone is enough
    // to be a functional node, P2P just adds liveness.
    await this.startNetwork();
  }

  async startNetwork(): Promise<void> {
    if (this.network) return;
    this.network = new PeerNetwork(
      this.chain,
      this.mempool,
      this.bootstrapUrl,
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
    try {
      await this.network.start();
      // Keep ServerSync informed about connectivity so it can switch off when
      // P2P is healthy and resume a slow safety poll only if we go isolated.
      this.network.onStatus((s) => this.serverSync?.setPeerCount(s.connected));
      this.serverSync?.setPeerCount(this.network.getStatus().connected);
    } catch (e) {
      console.warn('[node] network start failed', (e as Error).message);
      this.network = null;
    }
  }

  stopNetwork(): void {
    this.network?.stop();
    this.network = null;
  }

  setBootstrapUrl(url: string): void {
    this.bootstrapUrl = url;
    localStorage.setItem('browsercoin:bootstrap', url);
    this.serverSync?.setServerUrl(url);
    if (this.network) {
      this.stopNetwork();
      void this.startNetwork();
    }
  }

  setWallet(kp: KeyPair): void {
    this.wallet = kp;
    saveWallet(kp);
    this.miner.setMinerAddress(kp.publicKey);
    this.emitWallet();
    this.emitChain();
  }

  myBalance(): bigint {
    return getAccount(this.chain.tipState, this.wallet.address).balance;
  }

  myNonce(): number {
    return getAccount(this.chain.tipState, this.wallet.address).nonce;
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

  private emitChain(): void {
    for (const fn of this.chainListeners) fn();
  }

  private emitWallet(): void {
    for (const fn of this.walletListeners) fn();
  }
}

/** Parse a user-entered BROWSER amount ("12.5") into wei (bigint). */
export function parseAmount(input: string): bigint {
  const s = input.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error('amount must be a positive number');
  const [whole, frac = ''] = s.split('.');
  const fracPadded = (frac + '00000000').slice(0, 8);
  return BigInt(whole!) * COIN + BigInt(fracPadded);
}

/** Format wei to a human-friendly BROWSER amount with up to 8 decimals. */
export function formatAmount(wei: bigint): string {
  const neg = wei < 0n;
  const abs = neg ? -wei : wei;
  const whole = abs / COIN;
  const frac = abs % COIN;
  const fracStr = frac.toString().padStart(8, '0').replace(/0+$/, '');
  const body = fracStr ? `${whole}.${fracStr}` : `${whole}`;
  return (neg ? '-' : '') + body;
}
