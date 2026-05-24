/**
 * Developers page. In-browser overview of the public HTTP/wire surface for
 * anyone building wallets, explorers, bots, or alt-clients. Mirrors and links
 * out to the full spec at docs/developers.md on GitHub.
 *
 * Source-of-truth references (kept here so the page is easy to update when
 * constants move): see server/api.ts, src/chain/transaction.ts,
 * src/chain/block.ts, src/chain/genesis.ts, src/crypto/pow.ts.
 */
export function mountDevelopers(host: HTMLElement): () => void {
  const view = document.createElement('div');
  view.className = 'view view-about';
  view.innerHTML = `
    <div class="view-header">
      <h2 class="view-title">For developers</h2>
    </div>

    <article class="about-body">
      <p class="lead">
        BrowserCoin's helper servers expose a fully open HTTP API — no auth,
         CORS <code>*</code>. Anyone can build a wallet, block
        explorer, mining bot, or alternative client against the chain. The
        wire format is documented end-to-end so you don't need to read the
        TypeScript source to integrate.
      </p>

      <p>
        Full spec with curl examples and field-level tables:
        <a href="https://github.com/swompythesecond/BrowserCoin/blob/main/docs/developers.md" target="_blank" rel="noopener noreferrer">docs/developers.md</a>.
        Runnable Node example that signs and submits a transaction:
        <a href="https://github.com/swompythesecond/BrowserCoin/blob/main/examples/send-tx.mjs" target="_blank" rel="noopener noreferrer">examples/send-tx.mjs</a>.
      </p>

      <h3>Network constants</h3>
      <table>
        <tbody>
          <tr><td><code>CHAIN_ID</code></td><td><code>0xc01dfeed</code> — baked into every tx signature; cross-chain replay is rejected at signature-verify time.</td></tr>
          <tr><td>Smallest unit</td><td>1 BRC = 10⁸ wei</td></tr>
          <tr><td>Max supply</td><td>21,000,000 BRC</td></tr>
          <tr><td>Target block time</td><td>150 s (2.5 min)</td></tr>
          <tr><td>Max block size</td><td>256 KB</td></tr>
          <tr><td>Min fee</td><td>1 wei per byte (≥ 152 wei per tx)</td></tr>
          <tr><td>Default helper port</td><td><code>9000</code> (HTTP API), <code>9001</code> (PeerJS signaling)</td></tr>
        </tbody>
      </table>

      <h3>REST API</h3>
      <p>
        Base URL is whichever helper server you point at. Run your own with
        <code>npm run server:api</code> or add a URL under
        <strong>Settings → Helper servers</strong>. All integers on the wire
        are big-endian.
      </p>
      <table>
        <thead><tr><th>Method</th><th>Path</th><th>Purpose</th></tr></thead>
        <tbody>
          <tr><td>GET</td><td><code>/tip</code></td><td>Latest height + tip hash</td></tr>
          <tr><td>GET</td><td><code>/blocks?fromHeight=&amp;max=</code></td><td>Canonical blocks oldest-first (max 200)</td></tr>
          <tr><td>GET</td><td><code>/stats</code></td><td>Peer count, miners active, server height, etc.</td></tr>
          <tr><td>GET</td><td><code>/peers</code></td><td>Active peer IDs (for direct WebRTC dial)</td></tr>
          <tr><td>GET</td><td><code>/mempool</code></td><td>Pending tx hex list</td></tr>
          <tr><td>POST</td><td><code>/block</code></td><td>Submit a mined block</td></tr>
          <tr><td>POST</td><td><code>/txs</code></td><td>Submit transactions</td></tr>
          <tr><td>POST</td><td><code>/heartbeat</code></td><td>Browser keepalive (clients only)</td></tr>
        </tbody>
      </table>

      <p>The quickest possible smoke test:</p>
      <pre><code>curl http://localhost:9000/tip
# { "height": 12345, "tipHash": "a1b2…" }</code></pre>

      <h3>Transaction wire format</h3>
      <p>
        152 bytes total, big-endian. The first 88 bytes are the signed preimage;
        the trailing 64 bytes are an Ed25519 signature over them.
      </p>
      <table>
        <thead><tr><th>Offset</th><th>Length</th><th>Field</th></tr></thead>
        <tbody>
          <tr><td>0</td><td>4</td><td><code>chainId</code> — always <code>0xc01dfeed</code></td></tr>
          <tr><td>4</td><td>32</td><td><code>from</code> — Ed25519 pubkey. <strong>This is the address</strong> — no hashing, no checksum.</td></tr>
          <tr><td>36</td><td>32</td><td><code>to</code> — Ed25519 pubkey of recipient</td></tr>
          <tr><td>68</td><td>8</td><td><code>amount</code> (u64 wei)</td></tr>
          <tr><td>76</td><td>8</td><td><code>fee</code> (u64 wei)</td></tr>
          <tr><td>84</td><td>4</td><td><code>nonce</code> (u32, per-sender, must equal <code>state.nonce</code> .. <code>state.nonce+16</code>)</td></tr>
          <tr><td><strong>88</strong></td><td>64</td><td><code>signature</code> — Ed25519 (RFC 8032) over bytes <code>[0, 88)</code></td></tr>
        </tbody>
      </table>
      <p>
        Transaction ID = <code>sha256</code> of the full 152-byte encoding
        (signature included).
      </p>

      <h3>Block wire format</h3>
      <p>
        148-byte header + 4-byte tx count + N × 152-byte transactions.
        Block hash = <code>sha256</code> of header bytes (body excluded).
      </p>
      <table>
        <thead><tr><th>Offset</th><th>Length</th><th>Field</th></tr></thead>
        <tbody>
          <tr><td>0</td><td>4</td><td><code>height</code> (u32; genesis is 0)</td></tr>
          <tr><td>4</td><td>32</td><td><code>prevHash</code> — sha256 of parent header</td></tr>
          <tr><td>36</td><td>32</td><td><code>txRoot</code> — Merkle root over <code>encodeTx(tx)</code></td></tr>
          <tr><td>68</td><td>32</td><td><code>stateRoot</code> — account-tree root after applying this block</td></tr>
          <tr><td>100</td><td>8</td><td><code>timestamp</code> (u64 unix seconds)</td></tr>
          <tr><td>108</td><td>4</td><td><code>difficulty</code> — compact target (Bitcoin-style "bits")</td></tr>
          <tr><td>112</td><td>4</td><td><code>nonce</code> (u32)</td></tr>
          <tr><td>116</td><td>32</td><td><code>miner</code> — pubkey credited reward + fees</td></tr>
        </tbody>
      </table>

      <h3>Proof-of-Work</h3>
      <p>
        Memory-hard Argon2id over the 148-byte header. A header is valid when
        the hash, interpreted as a big-endian uint256, is less than the
        compact target.
      </p>
      <table>
        <tbody>
          <tr><td>Algorithm</td><td>Argon2id (RFC 9106)</td></tr>
          <tr><td>Memory</td><td>32 MiB</td></tr>
          <tr><td>Iterations</td><td>1</td></tr>
          <tr><td>Parallelism</td><td>1</td></tr>
          <tr><td>Output length</td><td>32 bytes</td></tr>
          <tr><td>Salt</td><td>UTF-8 of the literal string <code>browsercoin-pow-v2</code></td></tr>
        </tbody>
      </table>

      <h3>Signing a transaction</h3>
      <p>
        Ed25519 (RFC 8032) over the 88-byte preimage. Any conformant library
        works; the in-browser node uses <code>@noble/ed25519</code>.
      </p>
      <pre><code>import * as ed from '@noble/ed25519';

// 88 bytes: chainId(4) ‖ from(32) ‖ to(32) ‖ amount(8) ‖ fee(8) ‖ nonce(4)
const preimage = txPreimage({ from, to, amount, fee, nonce });
const signature = await ed.signAsync(preimage, privKey);  // 64 bytes
const txBytes = concat(preimage, signature);              // 152 bytes total
const txHex = toHex(txBytes);

await fetch(API_BASE + '/txs', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ txs: [txHex] }),
});</code></pre>

      <p>
        Complete runnable script (key generation, tip fetch, signing, submit):
        <a href="https://github.com/swompythesecond/BrowserCoin/blob/main/examples/send-tx.mjs" target="_blank" rel="noopener noreferrer">examples/send-tx.mjs</a>.
      </p>

      <h3>Run your own helper</h3>
      <p>
        The helpers are pluggable and plural. None of them is an authority —
        every block they accept is validated locally exactly like a
        peer-relayed block, and browsers verify everything themselves anyway.
        A malicious helper can withhold blocks but cannot trick clients into
        accepting invalid ones.
      </p>
      <pre><code>git clone https://github.com/swompythesecond/BrowserCoin
cd BrowserCoin
npm install
npm run server:api      # → :9000
npm run server:peerjs   # → :9001 (independent process)</code></pre>
      <p>
        Add your URL under <strong>Settings → Helper servers</strong>. The
        browser app fans out reads/writes across every configured helper, so
        more helpers = a more resilient network.
      </p>

      <h3>Stability</h3>
      <p>
        This is v0.2. Expect breakage — wire format, endpoint shapes, and
        consensus tweaks may change. There is no API versioning header. The
        <code>CHAIN_ID</code> is the only fork-resistant identifier, and the
        PoW salt's <code>-v2</code> suffix exists so a future hard fork can
        bump to <code>-v3</code> and cleanly invalidate the old chain.
      </p>

      <h3>The code</h3>
      <p>
        MIT-licensed. Read it, run it, fork it:
        <a href="https://github.com/swompythesecond/BrowserCoin" target="_blank" rel="noopener noreferrer">github.com/swompythesecond/BrowserCoin</a>.
      </p>
    </article>
  `;
  host.appendChild(view);
  return () => { };
}
