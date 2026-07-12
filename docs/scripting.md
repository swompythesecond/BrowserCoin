# BrowserCoin Script

BrowserCoin ships a small, non-Turing-complete **stack machine** for programmable
spend conditions — hash locks, time locks, multisig, escrow, atomic swaps, and
compositions of them. It is deliberately Bitcoin-Script-shaped: the opcode
numbers, the number encoding, the P2SH-style commit-then-reveal model, and the
limits all mirror Bitcoin so the mental model transfers directly. There is **no
wire compatibility** with Bitcoin, though — this is a separate chain.

This document is the guide to the *language*: how a script executes, what each
opcode does, and how to assemble the common templates. For the **transaction
wire formats** that carry scripts (Lock / Redeem byte layouts, sighash
construction, fork activation), see [`developers.md` §11](developers.md#11-script-transactions-lock--redeem).

> `src/chain/script.ts` is the **only** authority on what a script does. Where
> this doc and the code disagree, the code wins — please open an issue.

---

## 1. The mental model: lock by hash, spend by reveal

BrowserCoin uses a **P2SH-style** (pay-to-script-hash) model. Nothing about the
script is public when you fund it — only a commitment to it.

1. **Lock.** You send coins into an output committed to `scriptHash =
   sha256(redeemScript)`. The bytecode itself is *not* on-chain yet, only its
   32-byte hash. (`Lock` transaction — see `developers.md` §11.3.)
2. **Redeem.** To spend, you reveal the full `redeemScript` (the node checks it
   hashes to the committed `scriptHash`) plus a **witness** — an ordered list of
   data items (signatures, hash preimages, branch selectors). The witness is
   pushed onto the stack, then the script runs. (`Redeem` transaction — see
   `developers.md` §11.4.)

A lock is consumed exactly once; that single-shot consumption *is* the replay
protection for a Redeem (a Redeem has no nonce or signature of its own). A lock
is **not** spendable in the same block it was created in.

```
  Fund:   coins ──▶ sha256(redeemScript)          (only the hash is published)
  Spend:  reveal redeemScript + witness  ──▶  evalScript(...) must end truthy
```

---

## 2. How a script executes

The interpreter (`evalScript` in `src/chain/script.ts`) is a stack machine with a
main stack and a secondary **alt stack**. Execution goes:

1. **Seed the stack from the witness.** Each witness item is pushed as pure data,
   bottom-first. Witness items are *never executed as code* — this is what makes
   the reveal safe.
2. **Run the redeem script.** Bytes are read left-to-right. Push opcodes put data
   on the stack; other opcodes consume and produce stack items.
3. **Check the result.** The script succeeds **iff** execution finishes with a
   single truthy value on top of the stack (and IF/ENDIF are balanced, and no
   limit was exceeded).

Three properties are load-bearing and worth internalizing:

- **Determinism.** Every browser must agree on the result byte-for-byte. There
  are no floats, no wall-clock reads, and no iteration-order dependence. All
  notion of "time" comes from the block context passed in (`blockHeight`,
  `blockMtp`), never from `Date.now()`.
- **Guaranteed termination.** There are **no loops and no backward jumps** in the
  language. A script's cost is bounded by its length, so there is no "gas" and no
  DoS surface. Hard caps (§6) are belt-and-suspenders.
- **Fail closed.** Any opcode the engine doesn't recognize aborts the script.
  Non-minimal number encodings, over-long operands, and truncated pushes all
  fail rather than silently coerce.

### Truthiness

Any non-zero byte string is **true**, with one exception: *negative zero* (a lone
sign bit `0x80` on the most-significant byte) is **false**. Empty (`OP_0`) is
false. This is Bitcoin's `CastToBool`.

### Numbers (CScriptNum)

Arithmetic operands are **little-endian, sign-magnitude** integers (the high bit
of the most-significant byte is the sign). The empty array is `0`. Encoding must
be **minimal** — a non-minimal encoding is rejected, not normalized. Operands to
the arithmetic opcodes are capped at **4 bytes** (`MAX_NUM_BYTES`), matching
Bitcoin. `OP_CHECKLOCKTIMEVERIFY` reads up to **5 bytes** so it can express unix
timestamps.

Helpers: `encodeNum` / `encodeScriptNum` produce this encoding; the interpreter's
`decodeNum` consumes it.

---

## 3. Signatures and the sighash

`OP_CHECKSIG`, `OP_CHECKSIGVERIFY`, and `OP_CHECKMULTISIG` verify **Ed25519**
(RFC 8032) signatures over `ctx.sighash` — a 32-byte commitment to the *specific
spend* being authorized:

```
redeemSighash = sha256( tag ‖ chainId ‖ lockId ‖ to ‖ amount ‖ fee ‖ redeemScript )
```

Because the sighash commits to `to`, `amount`, and `fee`, a valid signature
**cannot be replayed to redirect the funds** — it only authorizes this exact
destination and value. This is the single most important property for writing
*safe* scripts (§7). A pubkey must be exactly 32 bytes and a signature exactly 64
bytes, or the check simply yields false. Source: `redeemSighash` in
`src/chain/transaction.ts`.

The interpreter receives everything it needs about the spend in a `ScriptContext`:

| Field | Meaning |
|---|---|
| `sighash` | 32-byte message the signature opcodes verify against |
| `blockHeight` | height of the block that would include the Redeem (for height-based CLTV) |
| `blockMtp` | median-time-past at that block (for timestamp-based CLTV) |

---

## 4. Opcodes

`src/chain/script.ts` is authoritative; `src/chain/opcodeRef.ts` holds these same
one-liners for the in-app Scripts tab. Semantics follow Bitcoin Script.

### Pushing data

Bytes `0x01`–`0x4b` are **not named opcodes** — each pushes that many literal
bytes directly onto the stack.

| Opcode | Hex | Effect |
|---|---|---|
| `OP_0` | `0x00` | Push an empty value (also the canonical "false"). |
| `OP_1` … `OP_16` | `0x51`–`0x60` | Push the small integer 1 through 16. |
| `OP_PUSHDATA1` | `0x4c` | Push N bytes; the next 1 byte is the length N. |
| `OP_PUSHDATA2` | `0x4d` | Push N bytes; the next 2 bytes (little-endian) are the length N. |

### Flow control

| Opcode | Hex | Effect |
|---|---|---|
| `OP_IF` | `0x63` | Pop the top value; run the following branch only if it is true. |
| `OP_ELSE` | `0x67` | The alternative branch for the matching `OP_IF`. |
| `OP_ENDIF` | `0x68` | Close an `OP_IF` / `OP_ELSE` block. |
| `OP_VERIFY` | `0x69` | Pop the top value; abort the whole script unless it is true. |

`IF`/`ELSE`/`ENDIF` may nest. Branches that aren't taken are parsed (to stay in
sync) but not executed. An unbalanced `IF`/`ENDIF` fails the script.

### Stack

| Opcode | Hex | Effect |
|---|---|---|
| `OP_DUP` | `0x76` | Duplicate the top item. |
| `OP_DROP` | `0x75` | Remove the top item. |
| `OP_SWAP` | `0x7c` | Swap the top two items. |
| `OP_OVER` | `0x78` | Copy the second-from-top item to the top. |
| `OP_ROT` | `0x7b` | Rotate the top three items. |
| `OP_TUCK` | `0x7d` | Copy the top item to just below the second. |
| `OP_NIP` | `0x77` | Remove the second-from-top item. |
| `OP_IFDUP` | `0x73` | Duplicate the top item only if it is non-zero. |
| `OP_2DUP` | `0x6e` | Duplicate the top two items. |
| `OP_DEPTH` | `0x74` | Push the current number of items on the stack. |
| `OP_PICK` | `0x79` | Copy the Nth-from-top item to the top (N popped from the stack). |
| `OP_ROLL` | `0x7a` | Move the Nth-from-top item to the top (N popped from the stack). |
| `OP_TOALTSTACK` | `0x6b` | Move the top item onto the alt stack. |
| `OP_FROMALTSTACK` | `0x6c` | Move the top alt-stack item back onto the main stack. |
| `OP_SIZE` | `0x82` | Push the byte length of the top item (without removing it). |

### Comparison & arithmetic

Numeric operands are limited to 4 bytes. `OP_MUL` / `OP_DIV` / `OP_MOD` are
disabled, exactly as in Bitcoin.

| Opcode | Hex | Effect |
|---|---|---|
| `OP_EQUAL` | `0x87` | Push 1 if the top two items are byte-equal, else 0. |
| `OP_EQUALVERIFY` | `0x88` | `OP_EQUAL` then `OP_VERIFY`. |
| `OP_ADD` | `0x93` | Add the top two numbers. |
| `OP_SUB` | `0x94` | Subtract the top number from the one below it. |
| `OP_1ADD` | `0x8b` | Add 1 to the top number. |
| `OP_1SUB` | `0x8c` | Subtract 1 from the top number. |
| `OP_NEGATE` | `0x8f` | Flip the sign of the top number. |
| `OP_ABS` | `0x90` | Absolute value of the top number. |
| `OP_NOT` | `0x91` | Push 1 if the input is 0, else 0. |
| `OP_0NOTEQUAL` | `0x92` | Push 1 if the input is non-zero, else 0. |
| `OP_BOOLAND` | `0x9a` | Push 1 if both inputs are non-zero. |
| `OP_BOOLOR` | `0x9b` | Push 1 if either input is non-zero. |
| `OP_NUMEQUAL` | `0x9c` | Push 1 if the two numbers are equal. |
| `OP_NUMEQUALVERIFY` | `0x9d` | `OP_NUMEQUAL` then `OP_VERIFY`. |
| `OP_NUMNOTEQUAL` | `0x9e` | Push 1 if the two numbers differ. |
| `OP_LESSTHAN` | `0x9f` | Push 1 if the second number is less than the top. |
| `OP_GREATERTHAN` | `0xa0` | Push 1 if the second number is greater than the top. |
| `OP_LESSTHANOREQUAL` | `0xa1` | Push 1 if the second number is ≤ the top. |
| `OP_GREATERTHANOREQUAL` | `0xa2` | Push 1 if the second number is ≥ the top. |
| `OP_MIN` | `0xa3` | Push the smaller of the two numbers. |
| `OP_MAX` | `0xa4` | Push the larger of the two numbers. |
| `OP_WITHIN` | `0xa5` | Push 1 if a number is within the range `[min, max)`. |

### Crypto & hashing

| Opcode | Hex | Effect |
|---|---|---|
| `OP_SHA256` | `0xa8` | Replace the top item with its SHA-256 hash. |
| `OP_HASH256` | `0xaa` | Replace the top item with its double-SHA-256 hash. |
| `OP_RIPEMD160` | `0xa6` | Replace the top item with its RIPEMD-160 hash. |
| `OP_HASH160` | `0xa9` | RIPEMD-160 of the SHA-256 of the top item. |
| `OP_CHECKSIG` | `0xac` | Verify an Ed25519 signature against a pubkey over the redeem sighash; push 1/0. |
| `OP_CHECKSIGVERIFY` | `0xad` | `OP_CHECKSIG` then `OP_VERIFY`. |
| `OP_CHECKMULTISIG` | `0xae` | Verify M valid signatures against N listed public keys (§7.4). |

### Time locks

| Opcode | Hex | Effect |
|---|---|---|
| `OP_CHECKLOCKTIMEVERIFY` | `0xb1` | Abort unless the block height / time has reached the given locktime. Values **< 500,000,000** are block heights; **≥** are unix timestamps. Leaves the operand on the stack (BIP65 semantics — scripts usually `OP_DROP` it next). |

### Reserved no-ops

`OP_NOP` (`0x61`), `OP_NOP1` (`0xb0`), and `OP_NOP3`–`OP_NOP10` (`0xb2`–`0xb9`) do
**nothing** today, on purpose. Reserving them means a future upgrade can give one
a `VERIFY`-style meaning as a **soft fork**: old nodes keep treating it as a
no-op and accept the spend, new nodes enforce the added check (which can only
abort a spend, never enable one) — exactly how Bitcoin shipped CLTV and CSV.
`OP_NOP3` is earmarked for a future relative-timelock (CSV-style) rule. Any
opcode *not* in this engine fails closed, so genuinely-unknown bytecode is never
accepted.

---

## 5. Why the value opcodes are all shipped up front

Adding a value-*producing* opcode (one that can put a new truthy result on the
stack) is a **hard fork**: old nodes would reject a spend new nodes accept. So
the full classic menu — arithmetic, hashing, multisig, all the stack ops — is
shipped now, in one activation, to avoid a hard fork every time someone wants an
everyday opcode. Future *checks* (which can only ever abort a spend) ride the
reserved `OP_NOP` slots as soft forks instead.

---

## 6. Limits

Chosen to match Bitcoin so that **raising** any of them later would be a hard
fork (old nodes reject a script new nodes accept) while **lowering** them stays a
soft fork. They're set generously up front. Source: constants at the top of
`src/chain/script.ts`.

| Limit | Value | Constant |
|---|---|---|
| Max script size | 10,000 bytes | `MAX_SCRIPT_BYTES` |
| Max witness items | 100 | `MAX_WITNESS_ITEMS` |
| Max push / witness item size | 520 bytes | `MAX_PUSH_BYTES` |
| Max stack depth (main + alt) | 1,000 | `MAX_STACK_SIZE` |
| Max non-push opcodes | 201 | `MAX_OPS` |
| Max multisig keys | 20 | `MAX_MULTISIG_KEYS` |
| Max numeric operand | 4 bytes | `MAX_NUM_BYTES` |
| Locktime height/time split | 500,000,000 | `LOCKTIME_THRESHOLD` |

---

## 7. Common patterns

Notation below: the **redeemScript** is the committed bytecode; the **witness**
is the ordered stack seed the redeemer supplies. `<x>` means "push x". Builders
live in `src/chain/scriptBuild.ts`; every pattern here is exercised in
`src/chain/htlc.test.ts`, `src/chain/scripttx.test.ts`, and
`src/chain/script.test.ts`.

### 7.1 Signature lock (pay to a single key)

The plain "only this key can spend" condition.

```
redeemScript:  <pubkey> OP_CHECKSIG
witness:       [ <signature over the redeem sighash> ]
```

Stack walk: witness seeds `[sig]` → `<pubkey>` pushes the key → `OP_CHECKSIG`
verifies `sig` against `pubkey` over `ctx.sighash` and leaves `1`. ✔

### 7.2 Hash-locked payment (safe HTLC leaf)

Spendable only by the holder of a key who **also** reveals a secret preimage. This
is the safe building block for atomic swaps. Builder: `hashlockSigScript`.

```
redeemScript:  OP_SHA256 <h> OP_EQUALVERIFY <recipientPubkey> OP_CHECKSIG
witness:       [ <signature>, <preimage> ]
```

Stack walk: witness seeds `[sig, preimage]` → `OP_SHA256` hashes the preimage →
`<h> OP_EQUALVERIFY` aborts unless it matches the committed hash → `<recipientPubkey>`
→ `OP_CHECKSIG` verifies the signature. Because the signature binds `to`/`amount`/`fee`
(§3), a front-runner who copies the revealed preimage still **cannot** redirect
the coins without the private key. ✔

> **⚠ Do not use a *bare* hash lock (`OP_SHA256 <h> OP_EQUAL`) to pay someone.**
> A redeem reveals the preimage publicly in the mempool; anyone can copy it into
> their own redeem, point it at their own address, and win by paying a higher fee
> (the mempool keeps only the highest-fee redeem per lock). The bare form
> (`hashlockScript`) exists **only** as a teaching example and is marked
> demonstration-only in the code. Always bind the spend to a key.

### 7.3 Atomic swap (full HTLC)

Add a refund branch so the sender can reclaim the coins after a timeout if the
swap never completes. Builder: `htlcScript`.

```
OP_IF
  OP_SHA256 <h> OP_EQUALVERIFY <recipientPubkey> OP_CHECKSIG      # claim: secret + recipient sig
OP_ELSE
  <locktime> OP_CHECKLOCKTIMEVERIFY OP_DROP <senderPubkey> OP_CHECKSIG   # refund: after timeout
OP_ENDIF
```

- **Claim** — `witness = [ <recipientSig>, <preimage>, 1 ]`. The trailing `1`
  selects the `OP_IF` branch.
- **Refund** — `witness = [ <senderSig>, <empty> ]`. The empty value selects the
  `OP_ELSE` branch; valid only once the block's height (`locktime < 500,000,000`)
  or median-time-past (`≥`) has reached `locktime`.

Sharing one `h` across two such locks on two chains gives an **atomic swap**:
claiming on one chain publishes the secret that unlocks the other, and the
timeouts guarantee both parties can always either complete or refund.

### 7.4 M-of-N multisig

Requires M valid signatures from a set of N listed keys — escrow, shared custody.
There is no dedicated builder; assemble it from pushes. The keys and the counts
live in the **redeemScript**; the signatures go in the **witness**.

```
redeemScript:  OP_2 <pubA> <pubB> <pubC> OP_3 OP_CHECKMULTISIG      # a 2-of-3
witness:       [ <sigA>, <sigB> ]                                   # signatures in key order
```

`OP_CHECKMULTISIG` consumes, top-to-bottom, the layout it expects on the stack:

```
<sig_1> ... <sig_m>  <m>  <pub_1> ... <pub_n>  <n>          (bottom → top)
```

Two deviations from Bitcoin worth knowing:

- **No dummy element.** Bitcoin's `OP_CHECKMULTISIG` pops one extra unused item
  (the infamous off-by-one bug); BrowserCoin does **not**. Do not prepend a
  leading `OP_0`.
- **Signatures must be in key order.** Each signature is matched left-to-right
  against the remaining pubkeys; a later signature cannot reuse an earlier key.
  Provide your M signatures in the same order as their keys appear in the script.

### 7.5 Time lock / vault

Any script containing `OP_CHECKLOCKTIMEVERIFY` cannot be spent until a height or
timestamp is reached — the basis for vaults and vesting.

```
redeemScript:  <locktime> OP_CHECKLOCKTIMEVERIFY OP_DROP <pubkey> OP_CHECKSIG
witness:       [ <signature> ]
```

`OP_CHECKLOCKTIMEVERIFY` leaves its operand on the stack (BIP65), so the `OP_DROP`
clears it before the signature check. Remember the 500,000,000 split: below it the
`locktime` is compared against `blockHeight`, at or above it against `blockMtp`.

---

## 8. Building, reading, and testing scripts

**Assemble** redeem scripts with the pure byte helpers in
`src/chain/scriptBuild.ts`:

| Helper | Produces |
|---|---|
| `pushData(bytes)` | The smallest valid push for a data item |
| `encodeScriptNum(n)` | Minimal little-endian script-number (for locktimes, etc.) |
| `hashlockScript(h)` | Bare hash lock — **demonstration only** (§7.2) |
| `hashlockSigScript(h, pubkey)` | Safe hash-locked payment (§7.2) |
| `htlcScript(h, recipientPubkey, locktime, senderPubkey)` | Full atomic-swap HTLC (§7.3) |

**Read** raw bytecode with `src/chain/scriptDisasm.ts` (used by the explorer and
the in-app **Scripts** tab, never by consensus):

- `disassemble(script)` → assembly-style lines, e.g. `OP_SHA256`, `PUSH(32) d3cc9d…`.
- `explainScript(script)` → best-effort plain-English recognition of the common
  templates (hash lock, hash-locked payment, signature, timelock, multisig),
  which is how the explorer flags a bare hash lock as front-runnable and a
  signature-gated one as safe.

**In-app tooling.** The **Scripts** tab (`src/ui/scripts.ts`) builds these
templates interactively; the explorer disassembles and explains any Lock/Redeem
it renders (`src/ui/explorerScript.ts`).

**Tests** are the most precise spec of behavior — read them when in doubt:

| File | Covers |
|---|---|
| `src/chain/script.test.ts` | The interpreter: opcodes, limits, edge cases, encodings |
| `src/chain/htlc.test.ts` | Hash locks, hash-locked payments, full HTLC claim/refund |
| `src/chain/scripttx.test.ts` | End-to-end Lock/Redeem through the state machine |
| `src/chain/mempool.script.test.ts` | Mempool handling of script transactions |

---

## 9. Activation

Scripts are a **time-gated rule extension on the existing chain** — they don't
reset balances or history. A Lock or Redeem is only valid in a block whose
**median-time-past** (BIP113-style, derived from the chain itself, not a wall
clock) has reached `FORK1_ACTIVATION_TIME` (`src/chain/genesis.ts`, unix
seconds). Before activation both kinds are rejected, so upgraded and
non-upgraded nodes agree until the date and then flip together. The gate is
`scriptsActiveForMtp` in `src/chain/fork.ts`.

For the Lock / Redeem byte layouts, the sighash preimage, and the full
validation checklist, continue to
[`developers.md` §11](developers.md#11-script-transactions-lock--redeem).

---

## 10. Security checklist

- **Bind spends to a key.** A hash lock with no signature is anyone-can-take once
  redeemed (§7.2). The signature over the redeem sighash is what makes a payment
  safe to a *specific* party.
- **Signatures already commit to destination and value.** You don't need to
  re-check `to`/`amount`/`fee` in-script — the sighash covers them. You *can't*
  loosen that; it's structural.
- **Encodings are strict.** Non-minimal numbers, over-long operands, wrong-length
  keys/signatures, and truncated pushes all fail closed. Assemble with the
  builders rather than hand-rolling bytes.
- **Everything is validated locally.** Helper servers and peers can withhold or
  stale a Redeem but cannot make your node accept an invalid one — every script
  is re-evaluated against `src/chain/script.ts` on every node.
</content>
</invoke>
