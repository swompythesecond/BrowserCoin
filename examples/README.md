# BrowserCoin examples

Runnable starter scripts for developers integrating against a BrowserCoin helper server.

## send-tx.mjs

Sign and submit a transaction. Self-contained — only depends on `@noble/ed25519`.

```bash
npm install @noble/ed25519
node send-tx.mjs
```

The script generates an Ed25519 keypair on first run (saved to `key.json`), fetches the chain tip, signs a transaction, and POSTs it to `http://localhost:9000/txs`. A fresh key has zero balance so the first run will print `{ admitted: 0, errors: ['insufficient balance'] }` — expected, and proves your signature reached the validator. Mine a few blocks to the pubkey shown in the output and re-run to see `admitted: 1`.

Environment variables: `API_BASE`, `TO`, `AMOUNT`, `FEE`, `NONCE`.

See [`docs/developers.md`](../docs/developers.md) for the full spec.
