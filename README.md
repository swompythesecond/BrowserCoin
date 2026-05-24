# BrowserCoin

**A real cryptocurrency that lives entirely in your browser.** Open the page, get a wallet automatically, mine on your CPU, send coins to other browsers — all in one tab. No installs, no extensions, no native binary.

- 🌐 **Live demo:** [browsercoin.org](https://browsercoin.org)
- 💻 **Source:** [github.com/swompythesecond/BrowserCoin](https://github.com/swompythesecond/BrowserCoin)

> **Status:** v0.2 — full end-to-end implementation with a fresh UI. Memory-hard Argon2id PoW, MTP-derived asymmetric difficulty retargeting, no centralized checkpoints.

---

## What is it?

BrowserCoin is a from-scratch, account-model cryptocurrency whose **only client is the web browser**. The same page is the wallet, the miner, the block explorer, and the full node. Two tabs anywhere on the internet can find each other through a tiny PeerJS signaling server, gossip blocks over WebRTC, and form a network — no Docker, no `geth`, no Electron.

The chain rules are deliberately Bitcoin-shaped (fixed max supply, halving rewards, longest-chain PoW), just retuned for a network of laptops mining in a JS engine.

## Tokenomics — Bitcoin's monetary policy, 4× faster

| Parameter | BrowserCoin | Bitcoin |
|---|---|---|
| Target block time | **2.5 min** (150 s) | 10 min |
| Difficulty retarget | **every block** over a 50-block window, MTP-derived, asymmetric clamp (≤2× up, ≤4× down per block) + emergency drop | every 2 016 blocks |
| Initial block reward | **50 BRC** | 50 BTC |
| Halving interval | every **210 000 blocks** (~1 yr) | 210 000 blocks (~4 yr) |
| Max supply | **21 000 000 BRC** | 21 000 000 BTC |
| Smallest unit | 10⁻⁸ BRC | 10⁻⁸ BTC |

Per-block retargeting over a 50-block sliding window is what lets the chain self-calibrate to the very volatile aggregate hashrate of "however many browser tabs are open right now." The retarget uses median-time-past on both ends of the window (kills single-timestamp lies), an asymmetric step cap (≤2× harder, ≤4× easier per block — so attackers can't pin difficulty high after they leave), and an emergency-drop rule that halves difficulty if a block goes >6× target without being found (so the chain can't stall when a large miner suddenly disappears).

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
- **Argon2id PoW** (64 MB, 2 iterations, memory-hard) mined in a Web Worker so the UI stays smooth. RAM-bandwidth bottleneck — closest browser-friendly analogue to ASIC resistance.
- **PeerJS / WebRTC** peer-to-peer. Helper services are split: `server/api.ts` (chain backup + peer discovery) and `server/peerjs.ts` (signaling) run as independent processes so they can fail independently. Both lists are configurable in-app; anyone can run their own and add it.
- **IndexedDB** for chain state, **localStorage** for the wallet keypair.
- **Vanilla TypeScript + Vite** — no React, no framework runtime. Tiny bundle, hash-routed SPA shell.

## Quick start

```bash
# install once
npm install

# terminal 1 — HTTP API helper (chain backup, /peers, /heartbeat, /tip, …)
npm run server:api     # → http://localhost:9000

# terminal 2 — WebRTC signaling helper
npm run server:peerjs  # → http://localhost:9001

# terminal 3 — the browser app
npm run dev            # → http://localhost:5173
```

Open the URL. You'll get an auto-generated wallet, hit **Start mining** on the Mine tab, and watch blocks appear. Open the same URL in a second browser (or incognito) and they'll discover each other via the helper servers and start gossiping blocks.

The two helpers run as independent processes — kill one and the other keeps working. Either is optional: once two browsers have formed a direct WebRTC connection they keep gossiping even if both helpers die.

## Scripts

| Script | Description |
|---|---|
| `npm run dev` | Vite dev server with HMR |
| `npm run build` | Production build (typecheck + bundle) |
| `npm run preview` | Serve the production build |
| `npm test` | Run vitest unit tests |
| `npm run server:api` | HTTP API helper (chain backup, `/peers`, `/heartbeat`, `/tip`, …) |
| `npm run server:peerjs` | WebRTC signaling helper (`/peerjs` WebSocket) |

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
  net/            PeerJS gossip protocol + multi-server fan-out + sync
  ui/             vanilla-TS UI views + hash router + info-popovers
  util/           binary / merkle helpers
server/
  api.ts          HTTP API helper (chain backup, /peers, /heartbeat, /tip, …)
  peerjs.ts       WebRTC signaling helper (PeerJS WebSocket)
  lib/cli.ts      shared --port parser
public/           static assets (logo, styles.css)
```

## Security

Handled:

- **Double-spend / replay** — account nonces + chain-id baked into the signed preimage
- **Tx malleability** — Ed25519 deterministic signatures
- **Spam** — per-byte min fee, mempool cap, signature verify before relay
- **Timestamp warp** — median-time-past rule + 2 h future cap
- **Block size attacks** — 256 KB cap
- **Hashrate-gaming the difficulty algorithm** — MTP-derived intervals (single-timestamp lies move MTP by <1/11 of the lie), asymmetric step caps (attacker can't pin difficulty high after withdrawing hashrate), emergency drop (chain recovers from total hashrate collapse without stalling)

### On 51% — a deliberate design decision

A 51% attack from outside-browser hashpower is theoretically possible. BrowserCoin will **not**
defend against it with centralized soft checkpoints or any other federated signing scheme,
because that would defeat the entire point of building a fully-decentralized, in-browser
cryptocurrency. The defense BrowserCoin uses is the same one Bitcoin actually relies on in
practice — making the attack **expensive enough to deter rational attackers** — adapted to a
network with no ASIC moat and no fiat price.

The defense in depth:

1. **Memory-hard Argon2id (64 MB, 2 iterations).** RAM bandwidth dominates the per-hash cost, not raw compute. Server attackers can't cheaply scale memory bandwidth the way they can scale cores — cloud RAM is oversubscribed; bare-metal DDR5 channels cost real money. The gap between a $20k server's per-dollar hashrate and a laptop's is ~5–20× (vs ~10,000× for SHA-256 + ASIC).
2. **Network scale is the actual moat.** With enough participating browsers, the aggregate hashrate exceeds what an attacker can affordably match in bare-metal RAM bandwidth. Each new participant linearly raises the attacker's required investment.
3. **Hardened retargeting** (see above) makes hashrate-gaming impractical even before raw outpace becomes infeasible.

The bootstrap window — when the network is small — is genuinely the vulnerable phase, and that's
documented honestly. Don't put value on the chain until the network is large enough to defend
itself. There is no fiat market, no exchange listing, no economic skin in the game to attract
sophisticated attackers; this is an experiment in seeing how far truly decentralized
browser-native consensus can go.

## For developers

Build wallets, block explorers, or bots against any BrowserCoin helper server. The HTTP API is fully open (CORS `*`, no auth) and the wire format is documented end-to-end.

- 📘 **[`docs/developers.md`](docs/developers.md)** — REST endpoints, block/tx binary format, PoW parameters, signing rules, P2P protocol.
- 🛠️ **[`examples/send-tx.mjs`](examples/send-tx.mjs)** — runnable Node script that generates a key, signs a transaction, and submits it.

## Caveats

- **This is an experiment, not a financial instrument.** Don't put real value on the chain.
- BRC has no fiat market. The 21M-supply cap exists because the rules are Bitcoin-shaped, not because the token is scarce in any meaningful economic sense.
- **Helper servers are pluggable and plural.** Both the HTTP API and PeerJS signaling are independent services, each with its own URL list under **Settings → Helper servers**. Reads try every server in health order; writes fan out to all of them. As long as one of either kind is reachable, new browsers can join. Anyone can run their own with `npm run server:api` and/or `npm run server:peerjs` and add the URL to the list.

## License

MIT — see `LICENSE`.

---

Built by [@swompythesecond](https://github.com/swompythesecond) · [browsercoin.org](https://browsercoin.org) · [Source on GitHub](https://github.com/swompythesecond/BrowserCoin)
