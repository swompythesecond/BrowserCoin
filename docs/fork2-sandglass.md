# Fork #2 — Sandglass v3 proof-of-work

Swaps the PoW hash from **Argon2id (32 MB)** to **Sandglass v3** at a fixed block
height. Same chain, same balances, same history — this is a rules change, not a
reset. It exists because Argon2id let GPU farms dominate (network went
~25 kH/s → ~2 MH/s in days while unique miners *shrank*), killing the "a browser
tab earns a meaningful share" property. Sandglass restores it: measured across
90+ devices, a browser tab matches a hand-optimized native miner and comes
within ~10 % of an RTX 5090 — and beats every GPU per joule.

This document is the design, the deploy checklist, and the test/rollout plan.

## What changes

| | Before fork | At/after fork |
|---|---|---|
| PoW hash | Argon2id 32 MB, 1 pass (`crypto/pow.ts`) | Sandglass v3 (`crypto/sandglass.ts`) |
| Gating | — | block **height** ≥ `SANDGLASS_FORK_HEIGHT` |
| Difficulty | ASERT anchored at genesis | reset at fork, ASERT re-anchored at fork |
| Balances / history / IDB | **unchanged** | **unchanged** |

Nothing else moves. Crucially, the **Argon2id path and its salt are untouched**,
so every pre-fork block still re-verifies bit-identically (full sync and history
backfill keep working across the boundary).

## Why height-gated, not time-gated

Fork #1 (Script) gated on median-time-past, which the full node computes from the
chain. PoW can't do that: the verifier worker (`chain/verifier.worker.ts`) is
**stateless** — it only receives the header bytes, never the surrounding chain,
so it can't compute MTP. Height is the header's first 4 bytes: deterministic,
in-band, and not manipulable by a single miner. So `powHash` reads the height and
picks the algorithm with **zero signature changes** across the miner, `checkPoW`,
and the verifier worker.

## The coordinated flag-day

Same UX as fork #1's date flip, keyed to height instead of time:

1. Set `SANDGLASS_FORK_HEIGHT` to `current tip + lead` (≈ 575 blocks/day).
2. Announce the height **and its estimated date**; deploy the new frontend.
3. Users auto-update on page load over the following days (Cloudflare deploy).
4. At the fork height the network flips together. Un-refreshed tabs try to
   Argon2id-verify a Sandglass block, fail, and stall until reloaded — exactly
   like fork #1. No chain split: old clients simply can't follow the new tip.

## The difficulty reset (and why the re-anchor is mandatory)

Switching algorithms changes attempts-per-second (GPU farms leave; browsers mine
Sandglass ~10× faster per core than Argon2id). The inherited Argon2id difficulty
would therefore be wrong — most likely too hard, giving a slow-block adjustment
period of an hour or more. So the first Sandglass block **resets** difficulty to
`SANDGLASS_ANCHOR_DIFFICULTY_COMPACT` (derived from expected honest hashrate), and
ASERT **re-anchors** at the fork block.

Both halves are required: a one-block reset *without* re-anchoring gets snapped
straight back, because the genesis-anchored ASERT schedule still "expects" the old
difficulty. The re-anchor uses hardcoded constants (`SANDGLASS_FORK_HEIGHT`,
`SANDGLASS_ANCHOR_TIMESTAMP`, `SANDGLASS_ANCHOR_TARGET`) so the anchor never has to
be fetched from the limited recent-header window — same trick genesis uses.

## Deploy checklist — set these three (in `chain/genesis.ts`)

All three are `PLACEHOLDER`s today:

1. **`SANDGLASS_FORK_HEIGHT`** — current tip + lead time for refresh. Announce it.
2. **`SANDGLASS_ANCHOR_TIMESTAMP`** — estimated unix time the chain reaches the
   fork height. A rough estimate is fine; ASERT absorbs a small offset within a
   halflife (600 s).
3. **`SANDGLASS_ANCHOR_ATTEMPTS`** — expected hash attempts per block right after
   the fork = `(honest Sandglass H/s) × 150`. **Err LOW (easier).** Too-easy
   self-corrects in minutes as ASERT ramps difficulty up; too-hard risks a
   slow-block stall. If unsure, estimate the honest hashrate from the current
   number of distinct non-farm miners × ~2 kH/s each and halve it.

Do **not** bump the PoW salt, `BROWSERCOIN_NETWORK`, or `CHAIN_VERSION` — those
wipe IndexedDB / invalidate history and would reset the chain.

## Test / rollout plan (staged — do not skip)

1. **Unit (done, in CI):**
   - `crypto/sandglass.test.ts` — frozen vectors (`sandglass.vectors.json`) +
     determinism. Any implementation drift fails loudly.
   - `chain/fork2.test.ts` — height gating (Sandglass at/after fork, Argon2id
     below) and difficulty (reset at fork, re-anchor holds on-pace, eases when
     slow, tightens when fast).
   - Full existing suite must stay green (pre-fork consensus unchanged).
2. **Cross-implementation vectors:** the browser and any worker build must
   reproduce `sandglass.vectors.json`. Regenerate ONLY on an intentional
   algorithm change (`npx tsx scripts/gen-sandglass-vectors.mts`).
3. **Local end-to-end across the boundary:** with a low test fork height, mine
   Argon2id blocks up to the fork, cross it, mine Sandglass blocks, and confirm a
   second node fast-syncs the mixed chain and reorgs correctly. (The `verify`
   skill drives this.)
4. **Testnet flag-day:** deploy with the real fork height on a testnet, let it
   cross the fork live, watch difficulty settle and blocks hold ~150 s for a day.
5. **Mainnet:** only after (4) is clean. Announce height + date, deploy frontend,
   let clients update, flip at height. Keep the current bench as a permanent
   regression check.

## Explicitly NOT in this fork

- **FruitChains / PPLNS reward smoothing.** Sandglass fixes the *price per joule*;
  the reward-variance fix (a browser tab earning a steady trickle) is a separate,
  larger, independently-tested later fork. Shipping them together would multiply
  risk on the most consensus-invasive change the project will make.
- **iOS/Safari.** Safari runs the walk slowly regardless of JS vs WASM (a Safari
  codegen/throttling limitation, not fixable from app code). iOS still earns
  proportionally under future PPLNS; it is a known-weak platform, not a blocker.

## Files

- `src/crypto/sandglass.ts` — the hash.
- `src/crypto/sandglass.vectors.json` — frozen test vectors.
- `src/crypto/pow.ts` — height gate in `powHash`.
- `src/chain/genesis.ts` — fork constants (the three placeholders).
- `src/chain/consensus.ts` — difficulty reset + ASERT re-anchor.
- `scripts/gen-sandglass-vectors.mts` — vector generator.
