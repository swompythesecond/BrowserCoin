import { exportWalletJson, importWalletJson } from '../storage/wallet.js';
import { generateKeyPair } from '../crypto/keys.js';
import { CHAIN_VERSION, type Node } from '../node.js';
import { cardHeader } from './info.js';
import { defaultServerLists, parseServerInput } from '../net/servers.js';
import {
  HELPER_DISCOVERY_NETWORK,
  loadCachedHelperRecords,
  parseHelperRecordsInput,
} from '../net/helperDiscovery.js';
import { isHelperRecordUsable, type HelperRecord } from '../net/helperRecords.js';
import { clearAll } from '../storage/idb.js';
import { encodeBlock } from '../chain/block.js';
import { bytesToHex } from '../util/binary.js';
import { VERIFY_CORES_KEY, maxVerifierCores, configuredVerifierCores } from '../chain/verifierPool.js';

export function mountSettings(host: HTMLElement, node: Node): () => void {
  const view = document.createElement('div');
  view.className = 'view';
  view.innerHTML = `
    <div class="view-header">
      <h2 class="view-title">Settings</h2>
      <span class="view-sub">Manage your wallet backup and network configuration.</span>
    </div>

    <div class="grid grid-2">
      <section class="card" data-mount="wallet">
        <div data-slot="header"></div>
        <p class="text-sm muted" style="margin:0 0 12px;">
          Your private key controls your coins. Export a backup before clearing browser data
          or switching machines — without it, the wallet is gone.
        </p>
        <div class="row">
          <button data-w="export">Export key…</button>
          <input type="file" data-w="import-file" style="display:none" />
          <button class="ghost" data-w="import">Import key…</button>
          <button class="ghost danger" data-w="newkey">Generate new wallet</button>
        </div>
      </section>

      <section class="card" data-mount="chain-backup">
        <div data-slot="header"></div>
        <p class="text-sm muted" style="margin:0 0 12px;">
          Save the canonical chain this tab currently sees to a file. Useful if
          you want to run your own helper server, archive the chain offline, or
          rebuild infrastructure on top of it — the file matches the format the
          BrowserCoin API server reads on startup.
        </p>
        <div class="row">
          <button data-w="export-chain">Export chain…</button>
          <span class="text-sm muted" data-w="chain-stats"></span>
        </div>
        <div class="text-sm mt-sm" data-w="chain-msg"></div>
      </section>

      <section class="card col-2" data-mount="servers">
        <div data-slot="header"></div>
        <p class="text-sm muted" style="margin:0 0 12px;">
          The chain is fully peer-to-peer. Helper servers are optional accelerators:
          API servers store backup copies and help new browsers find peers; signaling
          servers broker the initial WebRTC handshake. As long as <b>any one</b> server
          in either list is reachable, new browsers can still join the network.
          Anyone can run a helper — add their URL to the lists below.
        </p>
        <div class="grid grid-2">
          <div>
            <label>API servers <span class="muted" data-w="api-count"></span></label>
            <textarea data-w="api-list" rows="4" placeholder="https://server1.example
https://server2.example"></textarea>
            <div class="text-sm muted mt-sm">One URL per line. Used for chain backup, /peers, /heartbeat.</div>
          </div>
          <div>
            <label>Signaling servers <span class="muted" data-w="sig-count"></span></label>
            <textarea data-w="sig-list" rows="4" placeholder="https://server1.example
https://server2.example"></textarea>
            <div class="text-sm muted mt-sm">One URL per line. Used for WebRTC signaling (/peerjs).</div>
          </div>
        </div>
        <div class="row mt-md">
          <button data-w="save-servers">Save server lists</button>
          <button class="ghost" data-w="reset-servers">Reset to defaults</button>
        </div>
      </section>

      <section class="card col-2" data-mount="advertise">
        <div data-slot="header"></div>
        <p class="text-sm muted" style="margin:0 0 12px;">
          The list above is the servers <b>this browser</b> uses. This section is the other
          direction: helpers your client has <b>discovered</b> from peers, and a way to
          <b>advertise your own</b> so others discover it too — no gatekeeper, no redeploy.
          Records are signed by whoever runs the helper and are only hints; every block is
          still verified locally, so a bad helper can stall or withhold but never forge.
        </p>
        <label>Discovered helpers <span class="muted" data-w="helper-count"></span></label>
        <div data-w="helper-list" class="text-sm mt-sm"></div>
        <label class="mt-md">Advertise a helper</label>
        <textarea data-w="advertise-input" rows="5" placeholder='Paste a signed helper record, e.g.
{ "v":1, "network":"browsercoin-pow-v5", "roles":["api","signaling"], "api":"https://…", … }'></textarea>
        <div class="text-sm muted mt-sm">
          Run a helper, then sign a record with <code>scripts/sign-helper-record.ts</code> and
          paste it here. It is seeded locally and gossiped to peers while this tab is open.
        </div>
        <div class="row mt-md">
          <button data-w="advertise-btn">Advertise helper</button>
        </div>
        <div class="text-sm mt-sm" data-w="advertise-msg"></div>
      </section>

      <section class="card col-2" data-mount="verify">
        <div data-slot="header"></div>
        <details class="advanced">
          <summary>Advanced</summary>
          <p class="text-sm muted" style="margin:12px 0;">
            Catching up on the chain re-checks the proof-of-work on every block. That hashing
            is spread across CPU cores — more cores means faster initial sync, at the cost of
            more memory and CPU while syncing. The default of 4 is a safe balance; raise it
            toward your core count if you have headroom to spare.
          </p>
          <label style="margin:0;">Verification cores: <span data-w="vcores">4</span> <span class="muted">/ <span data-w="vmax">?</span> available</span></label>
          <input type="range" min="1" max="1" value="1" step="1" class="slider" data-w="vslider" />
        </details>
      </section>

      <section class="card col-2" data-mount="devtools">
        <div data-slot="header"></div>
        <p class="text-sm muted" style="margin:0 0 12px;">
          During development it's easy to forget what state this tab has cached.
          Clearing the chain cache wipes the locally-stored blocks (IndexedDB)
          so the next reload pulls a fresh chain from the helper servers.
          Your wallet, server lists, and other preferences are kept.
        </p>
        <div class="row">
          <button class="ghost danger" data-w="clear-cache">Clear chain cache and reload</button>
        </div>
        <div class="text-sm mt-sm" data-w="clear-msg"></div>
      </section>

      <section class="card col-2" data-mount="peerid">
        <div data-slot="header"></div>
        <p class="text-sm muted" style="margin:0 0 12px;">
          Your network ID is how other browsers reach you. Share it with a friend
          (Discord, Signal, anywhere) and they can paste it below to form a direct
          peer-to-peer link — useful when the bootstrap server is down or WebRTC
          can't find a route on its own.
        </p>
        <label>Your network ID</label>
        <div class="row">
          <input data-w="my-id" readonly value="(hidden — click reveal)" />
          <button class="ghost small" data-w="reveal-id">Reveal</button>
          <button class="ghost small" data-w="copy-id" disabled>Copy</button>
        </div>
        <label class="mt-md">Connect to a peer by ID</label>
        <div class="row">
          <input data-w="dial-id" placeholder="browsercoin-xxxxxxxxxx" />
          <button data-w="dial-btn">Connect</button>
        </div>
        <div class="text-sm mt-sm" data-w="dial-msg"></div>
      </section>

    </div>

    <div data-w="msg" class="text-sm muted mt-md"></div>
  `;
  host.appendChild(view);

  view.querySelector<HTMLElement>('[data-mount="wallet"] [data-slot="header"]')!.replaceWith(cardHeader({
    title: 'Wallet',
    info: {
      title: 'About your wallet',
      body: `Your wallet is just an Ed25519 keypair stored in this browser. Anyone holding the private key controls the coins — so treat the exported JSON like a password.\n\nGenerating a new wallet does not delete the old one from the chain — its balance still exists, you just lose access without a backup.`,
    },
  }));
  view.querySelector<HTMLElement>('[data-mount="chain-backup"] [data-slot="header"]')!.replaceWith(cardHeader({
    title: 'Chain backup',
    info: {
      title: 'Exporting the chain',
      body: `Every browser tab keeps its own validated copy of the chain, and helper API servers keep canonical backups on disk. Exporting from here grabs the canonical chain this tab currently sees as heaviest.\n\nThe file uses the same JSON layout the helper API server reads on startup ({ version: 1, blocks: [hex…] }, oldest-first, excluding genesis). To bootstrap your own helper, drop the file in place of the server's chain-9000.json and start the server — it will replay your blocks and serve them like any other node.\n\nNo trust is transferred. Anyone importing the file re-verifies every block against consensus rules, so a tampered export is just rejected.`,
    },
  }));
  view.querySelector<HTMLElement>('[data-mount="servers"] [data-slot="header"]')!.replaceWith(cardHeader({
    title: 'Helper servers',
    info: {
      title: 'Helper servers',
      body: `BrowserCoin is end-to-end peer-to-peer — the chain doesn't live on any one server. Helper servers are optional accelerators that make joining easier:\n\n• API servers store a backup copy of the chain (so a fresh browser can catch up in one round-trip) and help new clients find existing peers.\n\n• Signaling servers broker the initial WebRTC handshake between two browsers so they can form a direct connection.\n\nClients try every server in the list. Writes fan out to all of them in parallel. As long as any one server is reachable, new browsers can join. Anyone can run a helper — the URLs are public.`,
    },
  }));
  view.querySelector<HTMLElement>('[data-mount="advertise"] [data-slot="header"]')!.replaceWith(cardHeader({
    title: 'Advertise & discovered helpers',
    info: {
      title: 'Advertising a helper',
      body: `Helper discovery is permissionless — anyone can run an API or signaling helper and have it found, without asking the project. A helper announces itself with a small record signed by its operator key.\n\nThe signature proves who published the record, not that the helper is trustworthy: it can't make your client accept invalid blocks (those are always validated locally), so the worst a bad helper does is serve stale data or go offline. Your hardcoded seed helpers are always kept regardless.\n\nTo advertise: run your helper, generate a record with scripts/sign-helper-record.ts, and paste it here. Pasting seeds it into this client and gossips it to peers you connect to. To make it stick even when your tab is closed, also host the same JSON at your server's /helpers or at /.well-known/browsercoin/helpers.json.`,
    },
    link: { label: 'Refresh', onClick: () => renderHelperList() },
  }));
  view.querySelector<HTMLElement>('[data-mount="verify"] [data-slot="header"]')!.replaceWith(cardHeader({
    title: 'Chain verification',
    info: {
      title: 'Verification cores',
      body: `When this tab catches up on the chain, it re-verifies the Argon2id proof-of-work on every block — that's the slow part of syncing. The work is fanned out across this many Web Workers, one per CPU core.\n\nMore cores = faster initial sync, but each worker holds ~32 MB while hashing, so a high setting briefly uses more memory. The default of 4 keeps a fresh tab light; if your machine has cores to spare, raise it toward the maximum. Changes apply immediately and are remembered for next time.`,
    },
  }));
  view.querySelector<HTMLElement>('[data-mount="devtools"] [data-slot="header"]')!.replaceWith(cardHeader({
    title: 'Developer · reset',
    info: {
      title: 'Clearing the chain cache',
      body: `Drops every block this tab has stored in IndexedDB and reloads the page. On startup the node will pull the chain fresh from the helper servers, just like a brand-new browser would.\n\nUse this when you've changed something at the chain layer (consensus rules, genesis params, PoW salt) and want the local cache to stop replaying old blocks that the new code may reject.\n\nThis does NOT delete your wallet or server lists — those are stored in localStorage, not IndexedDB. To wipe the wallet too, use Export key above first, then clear browser site data manually.`,
    },
  }));
  view.querySelector<HTMLElement>('[data-mount="peerid"] [data-slot="header"]')!.replaceWith(cardHeader({
    title: 'Direct peer connect',
    info: {
      title: 'Manual peer-ID exchange',
      body: `Every running tab has a random network ID. When two browsers know each other's IDs, they can form a direct WebRTC link without any server in the middle.\n\nUse this to keep the chain alive when the bootstrap server is down, or to bring in a friend whose network can't reach the server. Once one peer is connected, they'll gossip you the rest of the mesh.`,
    },
  }));
  const apiList = view.querySelector<HTMLTextAreaElement>('[data-w="api-list"]')!;
  const sigList = view.querySelector<HTMLTextAreaElement>('[data-w="sig-list"]')!;
  const apiCount = view.querySelector<HTMLElement>('[data-w="api-count"]')!;
  const sigCount = view.querySelector<HTMLElement>('[data-w="sig-count"]')!;
  const saveServersBtn = view.querySelector<HTMLButtonElement>('[data-w="save-servers"]')!;
  const resetServersBtn = view.querySelector<HTMLButtonElement>('[data-w="reset-servers"]')!;
  const exportBtn = view.querySelector<HTMLButtonElement>('[data-w="export"]')!;
  const importBtn = view.querySelector<HTMLButtonElement>('[data-w="import"]')!;
  const importFile = view.querySelector<HTMLInputElement>('[data-w="import-file"]')!;
  const newKeyBtn = view.querySelector<HTMLButtonElement>('[data-w="newkey"]')!;
  const msg = view.querySelector<HTMLElement>('[data-w="msg"]')!;

  const myIdInput = view.querySelector<HTMLInputElement>('[data-w="my-id"]')!;
  const revealIdBtn = view.querySelector<HTMLButtonElement>('[data-w="reveal-id"]')!;
  const copyIdBtn = view.querySelector<HTMLButtonElement>('[data-w="copy-id"]')!;
  const dialIdInput = view.querySelector<HTMLInputElement>('[data-w="dial-id"]')!;
  const dialBtn = view.querySelector<HTMLButtonElement>('[data-w="dial-btn"]')!;
  const dialMsg = view.querySelector<HTMLElement>('[data-w="dial-msg"]')!;

  const renderServerLists = (): void => {
    apiList.value = node.serverLists.api.join('\n');
    sigList.value = node.serverLists.signaling.join('\n');
    apiCount.textContent = `(${node.serverLists.api.length})`;
    sigCount.textContent = `(${node.serverLists.signaling.length})`;
  };
  renderServerLists();

  saveServersBtn.addEventListener('click', () => {
    const api = parseServerInput(apiList.value);
    const signaling = parseServerInput(sigList.value);
    node.setServerLists({ api, signaling });
    renderServerLists();
    flash(msg, `Saved — ${api.length} API · ${signaling.length} signaling. Network reconnecting.`, 'green');
  });

  resetServersBtn.addEventListener('click', () => {
    if (!confirm('Reset both server lists to the defaults shipped with this build?')) return;
    node.setServerLists(defaultServerLists());
    renderServerLists();
    flash(msg, 'Server lists reset to defaults. Network reconnecting.', 'green');
  });

  // --- Advertise & discovered helpers -----------------------------------
  const helperCount = view.querySelector<HTMLElement>('[data-w="helper-count"]')!;
  const helperList = view.querySelector<HTMLElement>('[data-w="helper-list"]')!;
  const advertiseInput = view.querySelector<HTMLTextAreaElement>('[data-w="advertise-input"]')!;
  const advertiseBtn = view.querySelector<HTMLButtonElement>('[data-w="advertise-btn"]')!;
  const advertiseMsg = view.querySelector<HTMLElement>('[data-w="advertise-msg"]')!;

  const expiryLabel = (validUntil: number, now: number): string => {
    if (validUntil <= now) return 'expired';
    const days = Math.floor((validUntil - now) / 86400);
    return days >= 1 ? `expires in ${days}d` : 'expires in <1d';
  };

  // Build rows with textContent only — record fields are attacker-controlled
  // strings and must never be interpolated into HTML.
  const renderHelperList = (): void => {
    const records = loadCachedHelperRecords();
    helperCount.textContent = `(${records.length})`;
    helperList.replaceChildren();
    if (records.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'muted';
      empty.textContent = 'None yet. Helpers arrive from peers and configured API servers — or paste one below.';
      helperList.appendChild(empty);
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    for (const rec of records) {
      const row = document.createElement('div');
      row.style.cssText = 'padding:6px 0;border-top:1px solid rgba(127,127,127,0.18);';
      const urls = document.createElement('div');
      urls.textContent = [rec.api, rec.signaling].filter(Boolean).join('  ·  ');
      const meta = document.createElement('div');
      meta.className = 'muted';
      meta.textContent = `operator ${rec.operator.slice(0, 8)}… · ${expiryLabel(rec.validUntil, now)}`;
      row.appendChild(urls);
      row.appendChild(meta);
      helperList.appendChild(row);
    }
  };
  renderHelperList();

  advertiseBtn.addEventListener('click', () => {
    const text = advertiseInput.value.trim();
    if (!text) { flash(advertiseMsg, 'Paste a signed helper record first.', 'red'); return; }
    if (!node.serverSync) { flash(advertiseMsg, 'Network not ready yet — try again in a moment.', 'red'); return; }

    const parsed = parseHelperRecordsInput(text);
    if (parsed.length === 0) {
      flash(advertiseMsg, 'Could not read a helper record — expected the JSON from the signing tool.', 'red');
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    const usable: HelperRecord[] = [];
    const reasons: string[] = [];
    for (const rec of parsed) {
      const err = isHelperRecordUsable(rec, { nowSeconds: now, network: HELPER_DISCOVERY_NETWORK });
      if (err) reasons.push(err); else usable.push(rec);
    }

    if (usable.length === 0) {
      flash(advertiseMsg, `Rejected: ${reasons[0]}.`, 'red');
      return;
    }

    node.serverSync.ingestHelperRecords(usable, 'manual');
    advertiseInput.value = '';
    renderHelperList();
    const rejected = reasons.length ? ` · ${reasons.length} rejected (${reasons[0]})` : '';
    flash(advertiseMsg, `Advertised ${usable.length} helper${usable.length > 1 ? 's' : ''}${rejected}. Gossiping to peers.`, 'green');
  });

  // --- Network ID reveal/hide/copy --------------------------------------
  let revealed = false;
  const renderId = (): void => {
    const id = node.network?.getStatus().myId;
    if (revealed && id) {
      myIdInput.value = id;
      revealIdBtn.textContent = 'Hide';
      copyIdBtn.disabled = false;
    } else {
      myIdInput.value = id ? '(hidden — click reveal)' : '(connecting…)';
      revealIdBtn.textContent = 'Reveal';
      copyIdBtn.disabled = true;
    }
  };
  revealIdBtn.addEventListener('click', () => {
    revealed = !revealed;
    renderId();
  });
  copyIdBtn.addEventListener('click', () => {
    const id = node.network?.getStatus().myId;
    if (!id) return;
    navigator.clipboard.writeText(id).then(() => {
      copyIdBtn.textContent = 'Copied!';
      setTimeout(() => (copyIdBtn.textContent = 'Copy'), 1200);
    });
  });

  // --- Manual dial ------------------------------------------------------
  dialBtn.addEventListener('click', async () => {
    const id = dialIdInput.value.trim();
    if (!id) { flash(dialMsg, 'Paste a peer ID first.', 'red'); return; }
    if (!node.network) { flash(dialMsg, 'Network not running.', 'red'); return; }
    flash(dialMsg, 'Connecting…', 'muted');
    dialBtn.disabled = true;
    try {
      const ok = await node.network.dialPeer(id);
      if (ok) {
        flash(dialMsg, 'Connected ✓', 'green');
        dialIdInput.value = '';
      } else {
        flash(dialMsg, 'Could not reach that peer.', 'red');
      }
    } finally {
      dialBtn.disabled = false;
    }
  });

  renderId();
  const unsubNet = node.network?.onStatus(() => renderId()) ?? (() => {});

  exportBtn.addEventListener('click', () => {
    const json = exportWalletJson(node.wallet);
    const blob = new Blob([json], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `browsercoin-wallet-${node.wallet.address.slice(0, 8)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  importBtn.addEventListener('click', () => importFile.click());
  importFile.addEventListener('change', async () => {
    const file = importFile.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const kp = importWalletJson(text);
      node.setWallet(kp);
      flash(msg, 'Wallet imported.', 'green');
    } catch (e) {
      flash(msg, (e as Error).message, 'red');
    }
  });

  newKeyBtn.addEventListener('click', () => {
    if (!confirm('Generate a new wallet? You will lose access to the current one unless you exported it.')) return;
    const kp = generateKeyPair();
    node.setWallet(kp);
    flash(msg, 'New wallet generated.', 'green');
  });

  // --- Chain export -----------------------------------------------------
  const exportChainBtn = view.querySelector<HTMLButtonElement>('[data-w="export-chain"]')!;
  const chainStats = view.querySelector<HTMLElement>('[data-w="chain-stats"]')!;
  const chainMsg = view.querySelector<HTMLElement>('[data-w="chain-msg"]')!;
  const renderChainStats = (): void => {
    chainStats.textContent = `(tip height ${node.chain.height})`;
  };
  renderChainStats();
  const unsubChain = node.onChain(renderChainStats);

  exportChainBtn.addEventListener('click', () => {
    exportChainBtn.disabled = true;
    flash(chainMsg, 'Encoding blocks…', 'muted');
    try {
      // Match server/api.ts:saveChainToDiskNow exactly — oldest-first, genesis
      // omitted (the server's Blockchain constructor seeds genesis itself).
      const blocks: string[] = [];
      for (const cb of node.chain.iterateCanonical()) {
        if (cb.block.header.height > 0) blocks.unshift(bytesToHex(encodeBlock(cb.block)));
      }
      const payload = JSON.stringify({ version: 1, chainVersion: CHAIN_VERSION, blocks });
      const blob = new Blob([payload], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `browsercoin-chain-h${node.chain.height}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      flash(chainMsg, `Exported ${blocks.length} blocks (tip h=${node.chain.height}).`, 'green');
    } catch (e) {
      flash(chainMsg, `Failed: ${(e as Error).message}`, 'red');
    } finally {
      exportChainBtn.disabled = false;
    }
  });

  // --- Verification cores (advanced) ------------------------------------
  const vSlider = view.querySelector<HTMLInputElement>('[data-w="vslider"]')!;
  const vCoresEl = view.querySelector<HTMLElement>('[data-w="vcores"]')!;
  const vMaxEl = view.querySelector<HTMLElement>('[data-w="vmax"]')!;
  const maxV = maxVerifierCores();
  const savedV = configuredVerifierCores();
  vMaxEl.textContent = String(maxV);
  vSlider.max = String(maxV);
  vSlider.value = String(savedV);
  vCoresEl.textContent = String(savedV);
  if (maxV === 1) vSlider.disabled = true;
  vSlider.addEventListener('input', () => {
    const n = Math.max(1, Math.min(maxV, Math.floor(Number(vSlider.value)) || 1));
    vCoresEl.textContent = String(n);
    localStorage.setItem(VERIFY_CORES_KEY, String(n));
    node.serverSync?.setVerifierConcurrency(n);
  });

  const clearCacheBtn = view.querySelector<HTMLButtonElement>('[data-w="clear-cache"]')!;
  const clearMsg = view.querySelector<HTMLElement>('[data-w="clear-msg"]')!;
  clearCacheBtn.addEventListener('click', async () => {
    if (!confirm('Clear the local chain cache and reload? Your wallet stays, but every cached block will be re-pulled from the helper servers on next startup.')) return;
    clearCacheBtn.disabled = true;
    flash(clearMsg, 'Clearing IndexedDB…', 'muted');
    try {
      await clearAll();
      flash(clearMsg, 'Cache cleared. Reloading…', 'green');
      // Short pause so the user sees the confirmation before the reload.
      setTimeout(() => window.location.reload(), 400);
    } catch (e) {
      clearCacheBtn.disabled = false;
      flash(clearMsg, `Failed: ${(e as Error).message}`, 'red');
    }
  });

  return () => { unsubNet(); unsubChain(); };
}

function flash(el: HTMLElement, text: string, cls: 'green' | 'red' | 'muted'): void {
  el.textContent = text;
  el.className = `text-sm ${cls}`;
  setTimeout(() => {
    if (el.textContent === text) {
      el.textContent = '';
      el.className = 'text-sm muted';
    }
  }, 4000);
}
