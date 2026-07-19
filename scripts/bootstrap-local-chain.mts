/**
 * Bootstrap the local api server (localhost:9000) with a few real mined blocks,
 * so a fresh browser tab can sync to a real tip (height > 0) and actually mine —
 * instead of getting stuck in "syncing" forever on a height-0 genesis network.
 *
 * Mines blocks BELOW the (temp) fork height so they're Argon2id, submits each to
 * POST /block (full server-side validation). Then the browser syncs, becomes
 * caught up, and mines the rest — crossing the fork live in the real app.
 *
 *   npx tsx scripts/bootstrap-local-chain.mts [count]
 */
import { Blockchain } from '../src/chain/blockchain.js';
import { emptyMine } from '../src/chain/testutil.js';
import { generateKeyPair } from '../src/crypto/keys.js';
import { encodeBlock } from '../src/chain/block.js';
import { bytesToHex } from '../src/util/binary.js';
import { SANDGLASS_FORK_HEIGHT } from '../src/chain/genesis.js';

const API = 'http://localhost:9000';
const count = Math.max(1, Number(process.argv[2]) || 2);

if (count >= SANDGLASS_FORK_HEIGHT) {
  console.error(`refuse: count ${count} >= fork height ${SANDGLASS_FORK_HEIGHT}; bootstrap only pre-fork (Argon2id) blocks`);
  process.exit(1);
}

const miner = generateKeyPair();
const chain = new Blockchain();
console.log(`fork height = ${SANDGLASS_FORK_HEIGHT}; mining ${count} Argon2id block(s) and submitting to ${API}`);

for (let h = 1; h <= count; h++) {
  process.stdout.write(`  mining block ${h}… `);
  const block = await emptyMine(chain, miner.publicKey);
  const err = await chain.addBlock(block);
  if (err) { console.error('local add failed:', err); process.exit(1); }

  const res = await fetch(`${API}/block`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ block: bytesToHex(encodeBlock(block)) }),
  });
  const out = await res.json().catch(() => ({}));
  console.log(`submitted → server: ${JSON.stringify(out)}`);
  if (!res.ok || (out.status && out.status !== 'added')) {
    console.error('server rejected the block — aborting');
    process.exit(1);
  }
}

const tip = await (await fetch(`${API}/tip`)).json();
console.log(`\n✓ api server now at height ${tip.height}. Reload the browser tab — it will sync to this tip, become "caught up", and let you mine across the fork at height ${SANDGLASS_FORK_HEIGHT}.`);
