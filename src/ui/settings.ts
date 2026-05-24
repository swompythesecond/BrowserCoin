import { exportWalletJson, importWalletJson } from '../storage/wallet.js';
import { generateKeyPair } from '../crypto/keys.js';
import type { Node } from '../node.js';
import { cardHeader } from './info.js';
import { defaultServerLists, parseServerInput } from '../net/servers.js';
import { clearAll } from '../storage/idb.js';

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
  view.querySelector<HTMLElement>('[data-mount="servers"] [data-slot="header"]')!.replaceWith(cardHeader({
    title: 'Helper servers',
    info: {
      title: 'Helper servers',
      body: `BrowserCoin is end-to-end peer-to-peer — the chain doesn't live on any one server. Helper servers are optional accelerators that make joining easier:\n\n• API servers store a backup copy of the chain (so a fresh browser can catch up in one round-trip) and help new clients find existing peers.\n\n• Signaling servers broker the initial WebRTC handshake between two browsers so they can form a direct connection.\n\nClients try every server in the list. Writes fan out to all of them in parallel. As long as any one server is reachable, new browsers can join. Anyone can run a helper — the URLs are public.`,
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

  return () => { unsubNet(); };
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
