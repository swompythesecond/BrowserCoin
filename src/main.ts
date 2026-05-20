import { Node } from './node.js';
import { migrateLocalStorage } from './storage/migrate.js';
import { mountHome } from './ui/home.js';
import { mountWallet } from './ui/wallet.js';
import { mountMiner } from './ui/miner.js';
import { mountNetwork } from './ui/network.js';
import { mountExplorer } from './ui/explorer.js';
import { mountMempool } from './ui/mempool.js';
import { mountSettings } from './ui/settings.js';
import { compactToTarget } from './util/binary.js';
import { Router, wireNav } from './ui/router.js';

migrateLocalStorage();

const node = new Node();

// Console handle. `browsercoin` is the canonical name now; keep `wwwcoin`
// alias so any old console shortcuts users have memorized still work.
(window as unknown as { browsercoin: Node; wwwcoin: Node }).browsercoin = node;
(window as unknown as { browsercoin: Node; wwwcoin: Node }).wwwcoin = node;

void node.start();

const viewRoot = document.querySelector<HTMLElement>('[data-view-root]')!;
const router: Router = new Router(viewRoot);
router
  .route('/',         (host) => mountHome(host, node, router))
  .route('/wallet',   (host) => mountWallet(host, node))
  .route('/mine',     (host) => mountMiner(host, node))
  .route('/explorer', (host) => mountExplorer(host, node))
  .route('/mempool',  (host) => mountMempool(host, node))
  .route('/settings', (host) => mountSettings(host, node))
  .setFallback('/');
wireNav(router);
router.start();

// ============ Top-bar live stats ============

const stat = (k: string) => document.querySelector<HTMLElement>(`[data-stat="${k}"]`)!;
const netDot = document.querySelector<HTMLElement>('[data-stat-dot="net"]')!;

function refreshTopbar(): void {
  stat('height').textContent = `height ${node.chain.height}`;
  const peers = node.network?.getStatus().connected ?? 0;
  stat('peers').textContent = `peers ${peers}`;
  stat('mempool').textContent = `mempool ${node.mempool.size()}`;
  const bits = leadingZeroBits(node.chain.tipDifficulty);
  stat('difficulty').textContent = `diff ${bits} bits`;
  stat('difficulty').title = `compact 0x${node.chain.tipDifficulty.toString(16)} — hash must have ${bits} leading zero bits`;

  const ss = node.serverSync?.getStatus();
  if (node.network?.getStatus().myId) {
    netDot.className = 'stat-dot live';
  } else if (ss?.reachable) {
    netDot.className = 'stat-dot warn';
  } else {
    netDot.className = 'stat-dot off';
  }
}

function leadingZeroBits(compact: number): number {
  const target = compactToTarget(compact);
  if (target <= 0n) return 256;
  return 256 - target.toString(2).length;
}
node.onChain(refreshTopbar);
setInterval(refreshTopbar, 1500);
refreshTopbar();
