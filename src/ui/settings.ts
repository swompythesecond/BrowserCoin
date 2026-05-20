import { exportWalletJson, importWalletJson } from '../storage/wallet.js';
import { generateKeyPair } from '../crypto/keys.js';
import type { Node } from '../node.js';
import { cardHeader } from './info.js';

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

      <section class="card" data-mount="bootstrap">
        <div data-slot="header"></div>
        <label>Bootstrap server</label>
        <div class="row">
          <input data-w="bootstrap" />
          <button class="ghost" data-w="save-bootstrap">Save</button>
        </div>
        <p class="text-sm muted mt-md" style="margin:0;">
          Used for peer discovery and chain backup. Defaults to <code>http://localhost:9000</code>
          for local development. Change this if you're running your own bootstrap node.
        </p>
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
  view.querySelector<HTMLElement>('[data-mount="bootstrap"] [data-slot="header"]')!.replaceWith(cardHeader({
    title: 'Network',
    info: {
      title: 'Bootstrap server',
      body: `A small server that helps your browser find peers and offers a backup of the chain so you can catch up instantly on first load. The chain itself is still held by every browser — the server is just a convenience.`,
    },
  }));

  const bootstrap = view.querySelector<HTMLInputElement>('[data-w="bootstrap"]')!;
  const saveBootstrap = view.querySelector<HTMLButtonElement>('[data-w="save-bootstrap"]')!;
  const exportBtn = view.querySelector<HTMLButtonElement>('[data-w="export"]')!;
  const importBtn = view.querySelector<HTMLButtonElement>('[data-w="import"]')!;
  const importFile = view.querySelector<HTMLInputElement>('[data-w="import-file"]')!;
  const newKeyBtn = view.querySelector<HTMLButtonElement>('[data-w="newkey"]')!;
  const msg = view.querySelector<HTMLElement>('[data-w="msg"]')!;

  bootstrap.value = node.bootstrapUrl;
  saveBootstrap.addEventListener('click', () => {
    node.setBootstrapUrl(bootstrap.value.trim());
    flash(msg, 'Saved — network will reconnect if running.', 'green');
  });

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

  return () => { /* no subscriptions */ };
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
