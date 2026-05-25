# Developer guide

How to read, write, and integrate against a BrowserCoin chain. The HTTP helper server (`server/api.ts`) is fully open — CORS `*`, no auth, no SLA. Build wallets, explorers, bots, alt-clients, anything.

> **Status:** v0.2. The chain works end-to-end but is not stable software. Wire format, consensus tweaks, and endpoint shapes may change without notice. There is no SemVer guarantee yet. The constants and code references below are the source of truth — if this doc and the code disagree, the code wins; please open an issue.

## 1. Network constants

| Constant | Value | Source |
|---|---|---|
| `CHAIN_ID` | `0xc01dfeed` | `src/chain/genesis.ts` |
| Smallest unit | 1 BRC = 10⁸ wei | `src/chain/genesis.ts` (`COIN`) |
| Max supply | 21 000 000 BRC | `src/chain/genesis.ts` (`MAX_MONEY`) |
| Target block time | 150 s (2.5 min) | `src/chain/genesis.ts` (`TARGET_BLOCK_TIME_S`) |
| Initial block reward | 50 BRC, halved every 210 000 blocks | `src/chain/genesis.ts` |
| Max block size | 256 KB | `src/chain/genesis.ts` (`MAX_BLOCK_BYTES`) |
| Min fee | 1 wei per byte (≥ 152 wei per tx) | `src/chain/genesis.ts` (`MIN_FEE_PER_BYTE`) |
| Future-time reject | > 30 min ahead of helper clock | `src/chain/genesis.ts` (`MAX_FUTURE_TIME_S`) |
| Default helper port | `9000` (API), `9001` (PeerJS signaling) | `server/api.ts`, `server/peerjs.ts` |

All integers on the wire are **big-endian**.

## 2. REST API

Base URL is whichever helper server you point at — local dev is `http://localhost:9000`, the canonical live helper is whatever is listed in the app's Settings → Helper servers (see `src/net/servers.ts`). All endpoints accept JSON and send `Access-Control-Allow-Origin: *`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/tip` | Latest height + tip hash |
| GET | `/blocks?fromHeight=&max=` | Canonical blocks oldest-first (max 200) |
| GET | `/stats` | Network aggregates |
| GET | `/peers` | Active peer IDs (for WebRTC dial) |
| GET | `/mempool` | Pending tx hex list |
| POST | `/block` | Submit a block |
| POST | `/txs` | Submit transactions |
| POST | `/heartbeat` | Browser keepalive (clients only) |

### GET `/tip`

```bash
curl http://localhost:9000/tip
# { "height": 12345, "tipHash": "a1b2…" }
```

### GET `/blocks?fromHeight=N&max=M`

Returns canonical blocks at heights ≥ `fromHeight`, oldest-first. `max` is clamped to `[1, 200]` (default 100). Each block is hex-encoded; see §4 for the binary layout.

```bash
curl 'http://localhost:9000/blocks?fromHeight=0&max=10'
# { "blocks": ["<hex of block 0>", "<hex of block 1>", …] }
```

To sync from scratch: poll `/tip`, then page through `/blocks` 200 at a time until `fromHeight > tip.height`.

### GET `/stats`

```bash
curl http://localhost:9000/stats
# {
#   "peerCount": 4,        // browsers currently registered via /heartbeat
#   "minersActive": 2,     // peers reporting mining=true within the last 90s
#   "serverHeight": 12345, // height of the helper's own chain copy
#   "serverTip": "a1b2…",  // hex
#   "latestHeight": 12347, // max of serverHeight and any reported peer height
#   "medianHeight": 12345, // median of reported peer heights
#   "serverTime": 1735689600000  // ms since epoch
# }
```

### GET `/peers`

Up to 64 active peer IDs (last seen ≤ 60s ago). Use these to dial directly over WebRTC via PeerJS — see §7.

```bash
curl http://localhost:9000/peers
# { "peers": ["peer-abc123", "peer-def456", …] }
```

### GET `/mempool`

```bash
curl http://localhost:9000/mempool
# { "txs": ["<hex of tx>", …] }
```

### POST `/txs`

Submit one or more transactions. Each tx is the 152-byte binary encoding (see §3) as a hex string.

```bash
curl -X POST http://localhost:9000/txs \
  -H 'content-type: application/json' \
  -d '{"txs":["<hex of tx>"]}'
# { "admitted": 1, "errors": [] }
# or
# { "admitted": 0, "errors": ["insufficient balance"] }
```

Possible per-tx error strings (from `Mempool.add` in `src/chain/mempool.ts`): `bad signature`, `fee too low`, `insufficient balance`, `nonce too low`, `nonce too far ahead`, `amount negative`, `self-send forbidden`, `tx has no value`, `mempool full`, `tx chain id mismatch`.

### POST `/block`

Submit a mined block (full block, hex-encoded — see §4).

```bash
curl -X POST http://localhost:9000/block \
  -H 'content-type: application/json' \
  -d '{"block":"<hex of block>"}'
# { "status": "added" }
# { "status": "orphan", "parentNeeded": "<parent hash hex>" }
# { "status": "invalid", "error": "<reason>" }
```

If `parentNeeded` is returned, fetch that parent (via `/blocks` or peer gossip) and resubmit — the helper caches up to 2048 orphans and drains them once the missing parent arrives.

### POST `/heartbeat`

Used by browser clients to register themselves in `/peers`. External clients don't normally call this unless you want to participate in peer discovery.

```bash
curl -X POST http://localhost:9000/heartbeat \
  -H 'content-type: application/json' \
  -d '{"id":"peer-xxx","height":12345,"mining":false}'
# { "ok": true }
```

Send every ≤ 30 s; entries are dropped after 60 s of silence.

## 3. Transaction wire format

A transaction is **152 bytes**, big-endian. See `src/chain/transaction.ts`.

| Offset | Length | Field | Notes |
|---|---|---|---|
| 0 | 4 | `chainId` | Always `0xc01dfeed`. Included in the signed preimage to block cross-chain replay. |
| 4 | 32 | `from` | Ed25519 public key. **This IS the address** — no separate hashing/derivation. |
| 36 | 32 | `to` | Ed25519 public key of recipient. |
| 68 | 8 | `amount` | u64 wei. Must be < MAX_MONEY. |
| 76 | 8 | `fee` | u64 wei. Must be ≥ 152 (1 wei × 152 bytes). |
| 84 | 4 | `nonce` | u32, per-sender. Must equal `state.nonce` (or up to `+16` ahead to queue). |
| **88** | 64 | `signature` | Ed25519 (RFC 8032) over bytes `[0, 88)`. |

**Signed preimage** = bytes `[0, 88)` — the entire tx minus the trailing 64-byte signature.

**Transaction ID** = `sha256(full 152-byte encoding)` — i.e. the signature IS part of the txid.

Validation rules a sender must respect:
- `amount ≥ 0`, `fee ≥ 0`, `amount + fee ≤ MAX_MONEY`, not both zero.
- `from ≠ to` (self-send rejected).
- Signature verifies under `from`.
- Sender's `state.nonce ≤ tx.nonce ≤ state.nonce + 16`.
- Sender's `balance ≥ amount + fee`.

(Source: `validateTxStructure` in `src/chain/transaction.ts` and `Mempool.add` in `src/chain/mempool.ts`.)

## 4. Block wire format

A block is `148 + 4 + 152·N` bytes: header, tx count (u32), N transactions. See `src/chain/block.ts`.

**Header (148 bytes):**

| Offset | Length | Field | Notes |
|---|---|---|---|
| 0 | 4 | `height` | u32. Genesis is 0. |
| 4 | 32 | `prevHash` | `sha256` of the parent's header bytes. |
| 36 | 32 | `txRoot` | Merkle root over `encodeTx(tx)` for each tx (see `src/util/merkle.ts`). |
| 68 | 32 | `stateRoot` | Root of the account-state tree after applying this block. |
| 100 | 8 | `timestamp` | u64 unix seconds. Must satisfy MTP rules and ≤ now + 2 h. |
| 108 | 4 | `difficulty` | u32 compact target — same shape as Bitcoin's `bits`. See `compactToTarget` in `src/util/binary.ts`. |
| 112 | 4 | `nonce` | u32 PoW nonce. Miner increments timestamp on overflow. |
| 116 | 32 | `miner` | Pubkey credited the block reward + tx fees. |

**Body:** `u32be(txCount)` followed by `txCount` consecutive 152-byte transactions.

**Block hash** = `sha256(header_bytes)` — header only, not the body.

**Genesis** is deterministic (`GENESIS` in `src/chain/genesis.ts`): height 0, all-zero hashes/miner, `timestamp = 1700000000`, `difficulty = 0x20400000`. No txs. Independent verifiers should treat any chain whose height-0 block differs from this as a different network.

## 5. Proof-of-Work

Memory-hard Argon2id over the 148-byte header bytes.

| Parameter | Value |
|---|---|
| Algorithm | Argon2id (RFC 9106) |
| Memory | 32 MiB (`memorySize: 32 * 1024` KiB) |
| Iterations | 1 |
| Parallelism | 1 |
| Output length | 32 bytes |
| Salt | UTF-8 of the literal string `browsercoin-pow-v2` |

Source: `POW_PARAMS` in `src/crypto/pow.ts`.

A header is valid when `bigEndianUint256(powHash(header_bytes)) < compactToTarget(header.difficulty)`. See `hashMeetsTarget` in `src/util/binary.ts`.

Per-verify cost on a typical laptop CPU: roughly 40–125 ms. JS reference implementation uses [`openpgpjs/argon2id`](https://github.com/openpgpjs/argon2id) (wasm with JS-managed memory — one allocation per worker, reused forever, avoids the per-call WASM OOM other libraries hit under heavy contention). Any RFC 9106 conformant Argon2id implementation produces the same hash for the same parameters.

> Verifiers must match the constants in `POW_PARAMS` above exactly. The same params are restated in the README and About page for humans; the authoritative source is always `src/crypto/pow.ts`.

## 6. Signing rules

- **Curve:** Ed25519 (RFC 8032), pure variant (no context, no hash-then-sign — sign the raw 88-byte preimage).
- **Address = pubkey.** No keccak/sha hash, no checksum encoding. The 32-byte pubkey IS the on-chain identifier; UIs display it as 64-char hex.
- **Library:** the in-browser node uses `@noble/ed25519`; any RFC 8032 implementation will produce verifying signatures.

```js
import * as ed from '@noble/ed25519';

const preimage = txPreimage({ from, to, amount, fee, nonce }); // 88 bytes
const signature = await ed.signAsync(preimage, privKey);       // 64 bytes
// txBytes = preimage ‖ signature  (152 bytes total)
```

A complete working example lives at [`examples/send-tx.mjs`](../examples/send-tx.mjs).

## 7. P2P protocol (advanced)

You don't need this if you only talk to helper servers over HTTP. If you want to gossip directly with browsers (skip the helpers entirely once bootstrapped), here's the wire protocol.

**Transport:** PeerJS over WebRTC `DataConnection`s. Messages are JSON-shaped (binary fields hex-encoded). Signaling server runs `peerjs-server` (default `http://localhost:9001`); STUN/TURN handled by PeerJS defaults plus Cloudflare/Google ICE.

**Discovery flow:**
1. Register with the PeerJS signaling server to get a peer ID.
2. `GET /peers` from one or more helper servers.
3. Dial each peer ID (reliable=true DataChannel).
4. On open: send `hello`, then `getAddrs` to learn other peers from the mesh.

**Messages** (envelope: `{ t: '<type>', ... }`). See `ProtoMsg` in `src/net/protocol.ts`.

| Type | Direction | Payload |
|---|---|---|
| `hello` | initial | `{ height, tipHash, chainId }` |
| `tx` | gossip | `{ data: <tx hex> }` |
| `block` | gossip | `{ data: <block hex> }` — re-flood to other peers |
| `getBlock` | request | `{ hash }` |
| `getBlocks` | request | `{ fromHeight, max }` — mirrors `/blocks` endpoint |
| `blocks` | response | `{ data: [<hex>, …] }` (up to 64, height-ascending) |
| `getAddrs` | request | `{ max }` |
| `addrs` | response | `{ peers: [<peer-id>, …] }` |

`getHeaders` / `headers` / `invBlock` / `invTx` are reserved for future light-sync work and currently unused.

If the peer's `chainId` ≠ ours, the connection should be closed — that's a different network.

## 8. Run your own helper

The helpers are intentionally pluggable and plural. Run as many as you want; the browser app fans out reads/writes across all configured helpers.

```bash
git clone https://github.com/swompythesecond/BrowserCoin
cd BrowserCoin
npm install
npm run server:api      # → :9000
npm run server:peerjs   # → :9001 (independent process)
```

Both helpers persist per-port (`server/chain-9000.json`) — multiple instances on different ports don't clobber each other. Add your URL via the app's Settings → Helper servers. Defaults and validation live in `src/net/servers.ts`.

Neither helper is an authority. Every block they accept is validated by the local `Blockchain` exactly like a peer-relayed block; browsers verify everything themselves anyway. A malicious helper can withhold blocks or txs but cannot trick clients into accepting invalid ones.

## 9. Quickstart for the common cases

**Build a block explorer.** Poll `GET /tip` every few seconds; on height change, fetch the new blocks with `GET /blocks?fromHeight=`. Decode using the layout in §4. No write access needed.

**Build a wallet.** Generate an Ed25519 keypair with `@noble/ed25519`. The 32-byte pubkey is your address. To send: fetch your account's current nonce (replay the chain or query an explorer you trust), build the 88-byte preimage (§3), sign, concat signature, hex-encode, `POST /txs`.

**Mine externally.** Fetch the parent block, build a candidate header with your `miner` pubkey, grind `nonce` (and bump `timestamp` on u32 overflow) computing Argon2id with the params in §5 until the hash meets the target. `POST /block` to submit.

**Run a stats bot.** Just `GET /stats` on an interval.

## 10. Stability

- This is v0.2. Expect breakage. There is no API versioning header.
- The CHAIN_ID is the only fork-resistant identifier — any cross-network reuse is rejected at signature-verify time.
- Memory-hard PoW parameters (`POW_PARAMS.salt`) include a `-v2` suffix so a future hard fork can bump to `-v3` and cleanly invalidate the old chain.
- Helper URLs and peer IDs change. Don't hardcode them — load from the app's Settings or run your own.
