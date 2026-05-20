# BrowserCoin

**A real cryptocurrency that lives entirely in your browser.** Open the page, get a wallet automatically, mine on your CPU, send coins to other browsers — all in one tab. No installs, no extensions, no native binary.

- 🌐 **Live demo:** [browsercoin.org](https://browsercoin.org)
- 💻 **Source:** [github.com/swompythesecond/BrowserCoin](https://github.com/swompythesecond/BrowserCoin)

> **Status:** v0.2 — full end-to-end implementation with a fresh UI. Memory-hard Argon2id PoW; honest 51%-attack caveat applies (see [Security](#security)).

---

## What is it?

BrowserCoin is a from-scratch, account-model cryptocurrency whose **only client is the web browser**. The same page is the wallet, the miner, the block explorer, and the full node. Two tabs anywhere on the internet can find each other through a tiny PeerJS signaling server, gossip blocks over WebRTC, and form a network — no Docker, no `geth`, no Electron.

The chain rules are deliberately Bitcoin-shaped (fixed max supply, halving rewards, longest-chain PoW), just retuned for a network of laptops mining in a JS engine.

## Tokenomics — Bitcoin's monetary policy, 4× faster

| Parameter | BrowserCoin | Bitcoin |
|---|---|---|
| Target block time | **2.5 min** (150 s) | 10 min |
| Difficulty retarget | **every block** over a 20-block window | every 2 016 blocks |
| Initial block reward | **50 BROWSER** | 50 BTC |
| Halving interval | every **210 000 blocks** (~1 yr) | 210 000 blocks (~4 yr) |
| Max supply | **21 000 000 BROWSER** | 21 000 000 BTC |
| Smallest unit | 10⁻⁸ BROWSER | 10⁻⁸ BTC |

Per-block difficulty retargeting (over a sliding 20-block window) is what lets the chain self-calibrate to the very volatile aggregate hashrate of "however many browser tabs are open right now."

## Features

- **Auto-generated wallet** on first visit, Ed25519 keypair stored in `localStorage`. Export/import as a single JSON file.
- **In-browser miner** running in a Web Worker with a throttle slider — the UI never freezes while you mine.
- **Real P2P** over WebRTC via PeerJS, with a tiny bootstrap signaling server for peer discovery.
- **Block explorer** + **mempool view** + **send-coin** flow, all bundled in the same SPA.
- **IndexedDB** persists the full chain locally; **localStorage** holds the wallet keypair.
- **Live network stats** in the top bar: height, peers, mempool depth, current difficulty in bits.

## Architecture

- **Account model** (Ethereum-style: `{balance, nonce}` per address) — smaller state than UTXO, browser-friendly.
- **Ed25519** signatures (`@noble/ed25519`) — fast, deterministic, audited.
- **Argon2id PoW** (16 MB, memory-hard) mined in a Web Worker so the UI stays smooth and ASICs stay expensive.
- **PeerJS / WebRTC** peer-to-peer with a self-hosted signaling server (`server/index.ts`).
- **IndexedDB** for chain state, **localStorage** for the wallet keypair.
- **Vanilla TypeScript + Vite** — no React, no framework runtime. Tiny bundle, hash-routed SPA shell.

> The on-chain identifiers (PoW salt, peer prefix, IndexedDB name, wallet file `type`) still use the
> legacy `wwwcoin` form. They're part of the network protocol — changing them would fork the chain
> and orphan every existing wallet. The rebrand to "BrowserCoin" is intentionally cosmetic.

## Quick start

```bash
# install once
npm install

# terminal 1 — bootstrap server (peer signaling + /stats + /heartbeat)
npm run server         # → http://localhost:9000

# terminal 2 — the browser app
npm run dev            # → http://localhost:5173
```

Open the URL. You'll get an auto-generated wallet, hit **Start mining** on the Mine tab, and watch blocks appear. Open the same URL in a second browser (or incognito) and they'll discover each other via the bootstrap server and start gossiping blocks.

## Scripts

| Script | Description |
|---|---|
| `npm run dev` | Vite dev server with HMR |
| `npm run build` | Production build (typecheck + bundle) |
| `npm run preview` | Serve the production build |
| `npm test` | Run vitest unit tests |
| `npm run server` | Bootstrap server (PeerJS + `/stats` + `/heartbeat`) |

## Project layout

```
src/
  brand.ts        user-visible brand constants (name, ticker)
  main.ts         app bootstrap + router wiring
  node.ts         the in-browser "full node"
  crypto/         Ed25519 + memory-hard PoW primitives
  chain/          block, tx, state, mempool, blockchain, consensus, genesis
  storage/        IndexedDB + localStorage wallet + migration
  miner/          Web Worker nonce grinder + throttle slider
  net/            PeerJS gossip protocol + server sync
  ui/             vanilla-TS UI views + hash router + info-popovers
  util/           binary / merkle helpers
server/           bootstrap signaling + stats endpoint
public/           static assets (logo, styles.css)
```

## Security

Handled in v1:

- **Double-spend / replay** — account nonces + chain-id baked into the signed preimage
- **Tx malleability** — Ed25519 deterministic signatures
- **Spam** — per-byte min fee, mempool cap, signature verify before relay
- **Timestamp warp** — median-time-past rule + 2 h future cap
- **Block size attacks** — 256 KB cap

Not handled in v1 (documented honestly):

- **51% attack from outside-browser hashpower.** Argon2id-memory-hard PoW raises the bar
  considerably vs SHA-256, but a determined adversary with enough memory bandwidth could still
  out-mine the browser network. Mitigation path: federated "soft checkpoint" served by the
  bootstrap server (planned for v2 — endpoint stubbed). The consensus module is intentionally
  isolated.

## Caveats

- **This is an experiment, not a financial instrument.** Don't put real value on the chain.
- BROWSER has no fiat market. The 21M-supply cap exists because the rules are Bitcoin-shaped, not because the token is scarce in any meaningful economic sense.
- The bootstrap server is a single point of failure for *peer discovery*. The chain itself is decentralized; finding peers is not.

## License

MIT — see `LICENSE`.

---

Built by [@swompythesecond](https://github.com/swompythesecond) · [browsercoin.org](https://browsercoin.org) · [Source on GitHub](https://github.com/swompythesecond/BrowserCoin)
