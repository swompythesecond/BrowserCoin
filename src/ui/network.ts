import type { Node } from '../node.js';
import { cardHeader } from './info.js';

export function mountNetwork(host: HTMLElement, node: Node): () => void {
  const view = document.createElement('div');
  view.className = 'view';
  view.innerHTML = `
    <div class="view-header">
      <h2 class="view-title">Network</h2>
      <span class="view-sub">Your tab is a full node. Here's how it sees the world.</span>
    </div>

    <div class="grid grid-2">
      <section class="card" data-mount="status">
        <div data-slot="header"></div>
        <div class="row" style="justify-content:space-between;">
          <span data-w="state" class="muted">connecting…</span>
          <button class="ghost small" data-w="toggle">Disconnect</button>
        </div>
        <dl class="kv mt-md">
          <dt>My peer ID</dt><dd data-w="id" class="mono">—</dd>
          <dt>Direct peers</dt><dd data-w="connected" class="mono">0</dd>
          <dt>Network size</dt><dd data-w="netsize" class="mono">—</dd>
          <dt>Pending txs</dt><dd data-w="mempool" class="mono">0</dd>
          <dt>Server</dt><dd data-w="server" class="mono">—</dd>
        </dl>
      </section>

      <section class="card" data-mount="how">
        <div data-slot="header"></div>
        <p class="text-sm muted" style="margin:0 0 8px;">
          BrowserCoin uses WebRTC to connect browsers directly. A bootstrap server helps each tab
          discover the others, then drops out of the way once peers are connected.
        </p>
        <p class="text-sm muted" style="margin:0 0 8px;">
          The same server keeps a backup copy of the chain, so a brand-new tab can catch up
          instantly even before peers are reachable.
        </p>
        <p class="text-sm muted" style="margin:0;">
          When you're offline or can't reach any peers, you'll see "server-only" — sync still
          works through the server, but you're not gossiping with other browsers.
        </p>
      </section>
    </div>
  `;
  host.appendChild(view);

  view.querySelector<HTMLElement>('[data-mount="status"] [data-slot="header"]')!.replaceWith(cardHeader({
    title: 'Connection',
    info: {
      title: 'Connection states',
      body: `Online: connected to one or more peer browsers via WebRTC.\n\nServer-only: peers aren't reachable, but the bootstrap server is — you're still receiving new blocks.\n\nOffline: no path to either. Mining still works locally; you'll catch up when you reconnect.`,
    },
  }));
  view.querySelector<HTMLElement>('[data-mount="how"] [data-slot="header"]')!.replaceWith(cardHeader({
    title: 'How the network works',
    info: {
      title: 'Peer-to-peer architecture',
      body: `There's no master node. Every browser holds the full chain and validates every block. The bootstrap server is just for discovery and a chain backup.`,
    },
  }));

  const toggle = view.querySelector<HTMLButtonElement>('[data-w="toggle"]')!;
  const stateEl = view.querySelector<HTMLElement>('[data-w="state"]')!;
  const idEl = view.querySelector<HTMLElement>('[data-w="id"]')!;
  const connEl = view.querySelector<HTMLElement>('[data-w="connected"]')!;
  const sizeEl = view.querySelector<HTMLElement>('[data-w="netsize"]')!;
  const mempoolEl = view.querySelector<HTMLElement>('[data-w="mempool"]')!;
  const serverEl = view.querySelector<HTMLElement>('[data-w="server"]')!;

  let netUnsub: (() => void) | null = null;
  let syncUnsub: (() => void) | null = null;

  toggle.addEventListener('click', async () => {
    if (node.network) {
      node.stopNetwork();
      netUnsub?.(); netUnsub = null;
      render();
    } else {
      toggle.disabled = true;
      stateEl.textContent = 'connecting…';
      await node.startNetwork();
      toggle.disabled = false;
      hookNetwork();
      render();
    }
  });

  function hookNetwork(): void { netUnsub?.(); netUnsub = node.network?.onStatus(render) ?? null; }
  function hookSync(): void { syncUnsub?.(); syncUnsub = node.serverSync?.onStatus(render) ?? null; }

  function render(): void {
    const ps = node.network?.getStatus();
    const ss = node.serverSync?.getStatus();

    toggle.textContent = node.network ? 'Disconnect' : 'Reconnect';
    if (ps?.myId) { stateEl.textContent = 'online'; stateEl.className = 'green'; }
    else if (ss?.reachable) { stateEl.textContent = 'server-only'; stateEl.className = 'muted'; }
    else { stateEl.textContent = 'offline'; stateEl.className = 'red'; }
    idEl.textContent = ps?.myId ?? '—';
    connEl.textContent = String(ps?.connected ?? 0);
    sizeEl.textContent = ps ? String(ps.serverPeerCount) : '—';
    mempoolEl.textContent = String(node.mempool.size());
    if (ss) {
      const lag = node.chain.height - ss.serverHeight;
      const tag = ss.reachable
        ? lag === 0 ? 'in sync' : lag > 0 ? `pushing (+${lag})` : `pulling (${-lag})`
        : 'unreachable';
      serverEl.textContent = `${tag} · height ${ss.serverHeight}`;
      serverEl.className = ss.reachable ? 'green mono' : 'red mono';
    } else {
      serverEl.textContent = '—';
    }
  }

  render();
  const unsubChain = node.onChain(render);
  hookNetwork();
  hookSync();
  const hookInterval = setInterval(() => {
    if (node.network && !netUnsub) hookNetwork();
    if (node.serverSync && !syncUnsub) { hookSync(); render(); }
    if (node.network && node.serverSync) clearInterval(hookInterval);
  }, 500);

  return () => {
    unsubChain();
    netUnsub?.();
    syncUnsub?.();
    clearInterval(hookInterval);
  };
}
