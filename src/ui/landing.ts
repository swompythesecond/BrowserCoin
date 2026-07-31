/**
 * Landing page — the front door at `/`.
 *
 * Deliberately a signpost, not a pitch: one sentence about what this is, and
 * two ways onward (read, or launch a node). The long-form case lives on
 * /about and the launch paper; nothing is duplicated here.
 *
 * This is the one view in the app that runs NO node. Nothing here constructs a
 * `Node`, generates a wallet, opens IndexedDB, dials WebRTC, spins a worker, or
 * makes a single network request. That is the entire point: the site's root URL
 * has to be readable by someone who just wants to know what BrowserCoin is
 * without a full-screen sync overlay in their face and without their CPU
 * spinning up. The node starts when they click Launch, and not before.
 */
import type { Router } from './router.js';
import { hasWallet } from '../storage/wallet.js';

export function mountLanding(host: HTMLElement, router: Router): () => void {
  // Someone who already has a wallet is coming back, not arriving.
  const returning = hasWallet();

  const view = document.createElement('div');
  view.className = 'view view-landing';
  view.innerHTML = `
    <section class="land-hero">
      <p class="land-kicker">Fully decentralized · no premine · no presale · no market</p>
      <h1 class="land-title">A cryptocurrency that lives in your browser.</h1>
      <p class="land-lead">
        BrowserCoin is a proof-of-work chain whose participants are browser
        tabs. Open the client and your browser becomes a full node: it verifies
        the chain itself, talks directly to other browsers, and can mine. The
        only way to get coins is to mine them or to be sent some by someone who
        did.
      </p>
      <div class="land-cta">
        <button class="land-cta-primary" data-w="launch">${returning ? 'Resume your node →' : 'Launch your node →'}</button>
        <a class="btn ghost" href="/about">What is this?</a>
        <a class="btn ghost" href="/about?tab=whitepaper">Read the launch paper</a>
      </div>
      <p class="land-quiet">${returning
        ? 'Your wallet is already saved in this browser. Nothing is running right now. Press Resume to start your node again.'
        : 'Reading this page runs nothing. No node starts, no wallet is created and your CPU stays idle until you press the button.'}</p>
    </section>
  `;
  host.appendChild(view);

  view.querySelector<HTMLButtonElement>('[data-w="launch"]')!
    .addEventListener('click', () => router.navigate('/app'));

  return () => { };
}
