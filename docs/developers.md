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
| GET | `/helpers` | Signed helper records for API/signaling discovery |
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

### GET `/helpers`

Returns up to 200 signed helper records loaded from the helper server's
`server/helpers-9000.json` file. Records are discovery hints only. Clients
verify signature, expiry, network, URL shape, and size bounds before caching or
using them.

```bash
curl http://localhost:9000/helpers
# { "helpers": [{ "v": 1, "network": "browsercoin-pow-v5", … }] }
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

> **This is the base Transfer.** **Lock** and **Redeem** (script) transactions use different, self-identifying, variable-length encodings and only become valid once the script hard-fork activates — see §11.

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

**Mempool eviction.** Admission is necessary but not sufficient to ever be mined. On every
tip change the pool runs `Mempool.pruneUnminable`, which discards txs that can't be mined
against the current tip: a consumed nonce slot, a **nonce gap** (a missing lower nonce blocks
the whole run), or an **overdraw** (a sender queues more than its balance can fund). Anything
older than `MEMPOOL_TX_TTL_MS` (30 min) is reaped as a backstop. So "pending" always means
"actually mineable." Batch senders (e.g. a faucet) must therefore assign **strictly sequential
nonces** — derive the next nonce from the on-chain nonce plus your own pending count, as
`Mempool.nextNonceFor` does (`src/chain/mempool.ts`) — and keep the funding account solvent for
the whole batch, or the tail will be evicted instead of mined.

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
4. On open: send `hello`, `getAddrs`, and `getHelpers` to learn peers and helper records from the mesh.

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
| `getHelpers` | request | `{ max }` (capped at 50) |
| `helpers` | response | `{ records: [<helper-record>, …] }` (capped at 50) |

`getHeaders` / `headers` / `invBlock` / `invTx` are reserved for future light-sync work and currently unused.

If the peer's `chainId` ≠ ours, the connection should be closed — that's a different network.

## 8. Dynamic helper discovery

BrowserCoin clients can learn API and PeerJS signaling helpers from signed
helper records. These records are discovery hints only. A helper can help a
client find peers and chain data, but it cannot make the browser accept an
invalid block because all blocks are still validated locally.

Helper records are distributed through layered bootstrap:

1. cached known-good records in the browser
2. same-origin `/.well-known/browsercoin/helpers.json`
3. `GET /helpers` from reachable API helpers
4. WebRTC peer gossip (`getHelpers` / `helpers`)
5. manual Settings fallback

Record shape:

```json
{
  "v": 1,
  "network": "browsercoin-pow-v5",
  "roles": ["api", "signaling"],
  "api": "https://api.example.org",
  "signaling": "https://peer.example.org",
  "operator": "<64-char-ed25519-public-key-hex>",
  "validFrom": 1780000000,
  "validUntil": 1782592000,
  "sig": "<128-char-ed25519-signature-hex>"
}
```

Operators should keep validity windows at or below 30 days, renew records
before expiry, and serve only HTTPS public URLs except for localhost
development. Clients reject expired, wrong-network, malformed, non-HTTPS,
invalid-signature, and oversized records (response bodies are byte-capped, and
peer `helpers` gossip is rate-limited per peer). Both the cache and selection
cap concentration by operator and registrable domain, and the hardcoded seed
defaults are always retained in the selected set.

**Trust model.** Discovery is permissionless: an operator is just an Ed25519
key, so a valid signature proves a record's origin, not that the operator is
trustworthy. Anyone can publish records. Sybil resistance is therefore
intentionally bounded — an attacker minting many keys across many domains can
still bias a no-config client's *helper* set. This is acceptable because helpers
are never authoritative: every block is validated locally regardless of which
helper served it, so the worst a hostile helper set can do is withhold/stale
data or eclipse a client, never forge balances or move coins. Users who want a
fixed set can pin servers in Settings, which opts out of discovery entirely.

To publish helper records from an API helper, place this JSON file beside the
server data files:

```json
{
  "helpers": [
    {
      "v": 1,
      "network": "browsercoin-pow-v5",
      "roles": ["api", "signaling"],
      "api": "https://api.example.org",
      "signaling": "https://peer.example.org",
      "operator": "<64-char-ed25519-public-key-hex>",
      "validFrom": 1780000000,
      "validUntil": 1782592000,
      "sig": "<128-char-ed25519-signature-hex>"
    }
  ]
}
```

For the default API port, the filename is `server/helpers-9000.json`. Static
sites can also publish the same JSON at
`/.well-known/browsercoin/helpers.json` — the recommended channel, since it
needs no helper-server restart (overwrite the file to renew).

Generate keys and sign records with `scripts/sign-helper-record.ts`:

```sh
# once: create an operator keypair (keep the private key safe)
tsx scripts/sign-helper-record.ts --genkey --key-file operator.key

# sign/renew a record and append it to the published file
tsx scripts/sign-helper-record.ts --key-file operator.key \
  --roles api,signaling \
  --api https://api.example.org --signaling https://peer.example.org \
  --days 14 --out public/.well-known/browsercoin/helpers.json
```

## 9. Run your own helper

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

## 10. Quickstart for the common cases

**Build a block explorer.** Poll `GET /tip` every few seconds; on height change, fetch the new blocks with `GET /blocks?fromHeight=`. Decode using the layout in §4. No write access needed.

**Build a wallet.** Generate an Ed25519 keypair with `@noble/ed25519`. The 32-byte pubkey is your address. To send: fetch your account's current nonce (replay the chain or query an explorer you trust), build the 88-byte preimage (§3), sign, concat signature, hex-encode, `POST /txs`.

**Mine externally.** Fetch the parent block, build a candidate header with your `miner` pubkey, grind `nonce` (and bump `timestamp` on u32 overflow) computing Argon2id with the params in §5 until the hash meets the target. `POST /block` to submit.

**Run a stats bot.** Just `GET /stats` on an interval.

## 11. Script transactions (Lock / Redeem)

Two transaction kinds extend the base Transfer with programmable spend conditions: a **Lock** sends coins into a script-guarded output, and a **Redeem** spends it by satisfying that script. This is BrowserCoin's "programmable money" layer — hash locks, time locks, multisig, escrow. Source: `src/chain/transaction.ts`, `src/chain/script.ts`, `src/chain/state.ts`.

### 11.1 Activation

Script txs are a **time-gated rule extension on the same chain** — they do not reset balances or history. A Lock or Redeem is only valid in a block whose **median-time-past** (BIP113-style, computed from the chain itself, not a wall clock) has reached `FORK1_ACTIVATION_TIME` (`src/chain/genesis.ts`, unix seconds). Before activation both kinds are rejected (`lock tx before fork activation` / `redeem tx before fork activation`), so upgraded and non-upgraded nodes agree until the date, then flip together. The gate is `scriptsActiveForMtp` in `src/chain/fork.ts`.

### 11.2 The two-step model

1. **Lock** — `from` debits `amount + fee` and creates a lock holding `amount`, committed to `scriptHash = sha256(redeemScript)`. The script itself is *not* published yet, only its hash. Signed by `from`, ordered by `nonce` like a Transfer. The lock's id is the Lock's txid.
2. **Redeem** — reveals the full `redeemScript` (which must hash to the lock's `scriptHash`) plus a `witness` (the stack inputs that satisfy it), paying `amount − fee` to `to`. It has no `from` / `nonce` / `signature`; replay protection is the one-shot consumption of the lock. A lock is **not** spendable in the same block it was created.

### 11.3 Lock wire format (156 bytes)

Self-identifying tag `0x4c4f434b` ('LOCK'). Big-endian.

| Offset | Len | Field | Notes |
|---|---|---|---|
| 0 | 4 | tag | `0x4c4f434b` |
| 4 | 4 | chainId | `0xc01dfeed` |
| 8 | 32 | from | locker pubkey |
| 40 | 8 | amount | u64 wei locked |
| 48 | 8 | fee | u64 wei |
| 56 | 4 | nonce | u32, sender-ordered |
| 60 | 32 | scriptHash | `sha256(redeemScript)` |
| **92** | 64 | signature | Ed25519 over bytes `[0, 92)` |

Signed preimage = bytes `[0, 92)` (`lockPreimage`). **Lock id** = `sha256(full 156-byte encoding)`.

### 11.4 Redeem wire format (variable length)

Tag `0x52444d31` ('RDM1'). The wire encoding carries **no chainId** field, but the redeem sighash binds it (below).

| Offset | Len | Field | Notes |
|---|---|---|---|
| 0 | 4 | tag | `0x52444d31` |
| 4 | 32 | lockId | the lock being spent |
| 36 | 32 | to | recipient pubkey |
| 68 | 8 | amount | u64 — must equal the lock's amount exactly |
| 76 | 8 | fee | u64 — ≤ amount |
| 84 | 2 | scriptLen | u16 length of `redeemScript` |
| 86 | scriptLen | redeemScript | revealed bytecode |
| 86+scriptLen | 1 | witnessCount | u8 number of witness items |
| … | per item | witness | each: u16 length ‖ bytes |

**Redeem sighash** (what `OP_CHECKSIG`-style witnesses sign over) = `sha256(tag ‖ chainId ‖ lockId ‖ to ‖ amount ‖ fee ‖ redeemScript)`. It commits the destination and value, so a signature can't be replayed to redirect funds. See `redeemSighash` in `src/chain/transaction.ts`.

### 11.5 Redeem validation

A redeem is accepted only if (`applyRedeem` in `src/chain/state.ts`):

- the lock exists and is unspent (else `unknown or already-spent lock`);
- the lock was created in an **earlier** block (`lock not spendable in its creation block`);
- `sha256(redeemScript) == lock.scriptHash` (`redeem script does not match lock`);
- `amount == lock.amount` (`redeem amount mismatch`);
- `fee ≤ amount` (`redeem fee exceeds locked amount`);
- `evalScript(redeemScript, witness, ctx)` finishes with a truthy value on top of the stack.

`ctx` is `{ sighash, blockHeight, blockMtp }`; `blockHeight` and `blockMtp` feed `OP_CHECKLOCKTIMEVERIFY`.

### 11.6 Script engine & limits

The interpreter (`src/chain/script.ts`) is a stack machine: witness items load onto the stack first (pure data, never executed), then the redeem script runs. It succeeds if the top item is truthy at the end. There are no loops or backward jumps, so execution always terminates. Limits (chosen to match Bitcoin so raising them later stays a soft fork):

| Limit | Value |
|---|---|
| Max script size | 10 000 bytes |
| Max witness items | 100 |
| Max push / witness item | 520 bytes |
| Max stack (main + alt) | 1 000 |
| Max non-push ops | 201 |
| Max multisig keys | 20 |
| Max numeric operand | 4 bytes |
| Locktime height/time split | 500 000 000 |

### 11.7 Opcodes

`script.ts` is authoritative; the semantics below follow Bitcoin Script.

**Pushing data** — bytes `0x01`–`0x4b` push that many literal bytes directly.

| Opcode | Hex | Meaning |
|---|---|---|
| OP_0 | 0x00 | Push an empty value (canonical "false"). |
| OP_1 … OP_16 | 0x51–0x60 | Push the small integer 1 through 16. |
| OP_PUSHDATA1 | 0x4c | Push N bytes; next 1 byte is the length N. |
| OP_PUSHDATA2 | 0x4d | Push N bytes; next 2 bytes (little-endian) are the length N. |

**Flow control**

| Opcode | Hex | Meaning |
|---|---|---|
| OP_IF | 0x63 | Run the next branch if the top value is true. |
| OP_ELSE | 0x67 | Alternative branch for the matching OP_IF. |
| OP_ENDIF | 0x68 | Close an OP_IF / OP_ELSE block. |
| OP_VERIFY | 0x69 | Pop the top value; abort the script unless it is true. |

**Stack**

| Opcode | Hex | Meaning |
|---|---|---|
| OP_DUP | 0x76 | Duplicate the top item. |
| OP_DROP | 0x75 | Remove the top item. |
| OP_SWAP | 0x7c | Swap the top two items. |
| OP_OVER | 0x78 | Copy the second-from-top item to the top. |
| OP_ROT | 0x7b | Rotate the top three items. |
| OP_TUCK | 0x7d | Copy the top item to just below the second. |
| OP_NIP | 0x77 | Remove the second-from-top item. |
| OP_IFDUP | 0x73 | Duplicate the top item only if it is non-zero. |
| OP_2DUP | 0x6e | Duplicate the top two items. |
| OP_DEPTH | 0x74 | Push the current stack size. |
| OP_PICK | 0x79 | Copy the Nth-from-top item to the top (N from stack). |
| OP_ROLL | 0x7a | Move the Nth-from-top item to the top (N from stack). |
| OP_TOALTSTACK | 0x6b | Move the top item onto the alt stack. |
| OP_FROMALTSTACK | 0x6c | Move the top alt-stack item back. |
| OP_SIZE | 0x82 | Push the byte length of the top item (without removing it). |

**Comparison & arithmetic** — numeric operands are limited to 4 bytes.

| Opcode | Hex | Meaning |
|---|---|---|
| OP_EQUAL | 0x87 | Push 1 if the top two items are byte-equal, else 0. |
| OP_EQUALVERIFY | 0x88 | OP_EQUAL then OP_VERIFY. |
| OP_ADD | 0x93 | Add the top two numbers. |
| OP_SUB | 0x94 | Subtract the top number from the one below it. |
| OP_1ADD | 0x8b | Add 1. |
| OP_1SUB | 0x8c | Subtract 1. |
| OP_NEGATE | 0x8f | Flip the sign. |
| OP_ABS | 0x90 | Absolute value. |
| OP_NOT | 0x91 | Push 1 if the input is 0, else 0. |
| OP_0NOTEQUAL | 0x92 | Push 1 if the input is non-zero, else 0. |
| OP_BOOLAND | 0x9a | Push 1 if both inputs are non-zero. |
| OP_BOOLOR | 0x9b | Push 1 if either input is non-zero. |
| OP_NUMEQUAL | 0x9c | Push 1 if the two numbers are equal. |
| OP_NUMEQUALVERIFY | 0x9d | OP_NUMEQUAL then OP_VERIFY. |
| OP_NUMNOTEQUAL | 0x9e | Push 1 if the two numbers differ. |
| OP_LESSTHAN | 0x9f | Push 1 if second < top. |
| OP_GREATERTHAN | 0xa0 | Push 1 if second > top. |
| OP_LESSTHANOREQUAL | 0xa1 | Push 1 if second ≤ top. |
| OP_GREATERTHANOREQUAL | 0xa2 | Push 1 if second ≥ top. |
| OP_MIN | 0xa3 | Smaller of the two numbers. |
| OP_MAX | 0xa4 | Larger of the two numbers. |
| OP_WITHIN | 0xa5 | Push 1 if a number is within [min, max). |

**Crypto & hashing**

| Opcode | Hex | Meaning |
|---|---|---|
| OP_SHA256 | 0xa8 | Replace the top item with its SHA-256 hash. |
| OP_HASH256 | 0xaa | Replace the top item with its double-SHA-256 hash. |
| OP_RIPEMD160 | 0xa6 | Replace the top item with its RIPEMD-160 hash. |
| OP_HASH160 | 0xa9 | RIPEMD-160 of the SHA-256 of the top item. |
| OP_CHECKSIG | 0xac | Verify an Ed25519 signature against a pubkey over the redeem sighash; push 1/0. |
| OP_CHECKSIGVERIFY | 0xad | OP_CHECKSIG then OP_VERIFY. |
| OP_CHECKMULTISIG | 0xae | Verify M valid signatures against N listed public keys. |

**Time locks**

| Opcode | Hex | Meaning |
|---|---|---|
| OP_CHECKLOCKTIMEVERIFY | 0xb1 | Abort unless the block height / time has reached the given locktime (values < 500,000,000 are heights, ≥ are unix timestamps). |

**Reserved** — `OP_NOP` (0x61), `OP_NOP1` (0xb0), `OP_NOP3`–`OP_NOP10` (0xb2–0xb9) do nothing today. They are reserved so a future rule can give one meaning as a soft fork (old nodes keep accepting a spend, new nodes enforce the added check). Any opcode *not* in this engine fails closed.

### 11.8 Hash locks — safely

> **⚠ A *bare* hash lock is anyone-can-take.** `OP_SHA256 <h> OP_EQUAL` releases coins to whoever reveals a preimage of `h` — and a redeem reveals that preimage publicly in the mempool. A watcher can copy it into their own redeem, point it at their own address, and win by paying a higher fee (the pool keeps only the highest-fee redeem per lock, `mempool.ts`). **Never use a bare hash lock to pay a specific party.** It exists only as a teaching example (`hashlockScript` in `src/chain/scriptBuild.ts`, marked demonstration-only).

**Hash-locked payment (the safe form).** Bind the spend to the recipient's key. The signature commits to `to`/`amount`/`fee` via the redeem sighash (§11.4), so revealing the secret no longer lets anyone redirect the coins:

```
redeemScript: OP_SHA256 <h> OP_EQUALVERIFY <recipientPubkey> OP_CHECKSIG
witness:      [<signature over the redeem sighash>, <preimage>]
```

Stack walk: the witness seeds `[sig, preimage]` → `OP_SHA256` hashes the preimage → `<h> OP_EQUALVERIFY` aborts unless it matches → push `<recipientPubkey>` → `OP_CHECKSIG` verifies `sig` over `ctx.sighash`. A front-runner who copies the preimage still can't sign for a different `to` without the private key. Builder: `hashlockSigScript`; the in-app **Scripts** tab produces exactly this.

**Atomic swap (full HTLC).** Add a refund branch so the sender can reclaim after a timeout if the swap never completes. Builder: `htlcScript` in `src/chain/scriptBuild.ts`.

```
OP_IF
  OP_SHA256 <h> OP_EQUALVERIFY <recipientPubkey> OP_CHECKSIG     # claim: secret + recipient sig
OP_ELSE
  <locktime> OP_CHECKLOCKTIMEVERIFY OP_DROP <senderPubkey> OP_CHECKSIG   # refund: after timeout
OP_ENDIF
```

- **Claim** — `witness = [<recipientSig>, <preimage>, 1]` (the trailing `1` selects the `OP_IF` branch).
- **Refund** — `witness = [<senderSig>, <empty>]`; valid only once the block's height (`locktime < 500,000,000`) or median-time-past (`≥`) has reached `locktime`.

Sharing one `h` across two such locks on two chains is an atomic swap: claiming on one chain publishes the secret that unlocks the other, and the timeouts guarantee both parties can always either complete or refund. All three forms above are exercised in `src/chain/htlc.test.ts`. The explorer disassembles and explains any Lock/Redeem it renders, flagging bare hash locks as front-runnable and signature-gated ones as safe.

## 12. Stability

- This is v0.2. Expect breakage. There is no API versioning header.
- The CHAIN_ID is the only fork-resistant identifier — any cross-network reuse is rejected at signature-verify time.
- Memory-hard PoW parameters (`POW_PARAMS.salt`) include a `-v2` suffix so a future hard fork can bump to `-v3` and cleanly invalidate the old chain.
- Helper URLs and peer IDs change. Don't hardcode them — load from the app's Settings or run your own.
