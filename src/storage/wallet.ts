import { fromPrivateKey, generateKeyPair, type KeyPair } from '../crypto/keys.js';
import { bytesToHex, hexToBytes } from '../util/binary.js';

const WALLET_KEY = 'browsercoin:wallet:v1';

interface StoredWallet {
  v: 1;
  privateKeyHex: string;
}

/**
 * Load the user's wallet from localStorage. If none exists, generate a fresh
 * keypair, persist it, and return that. Idempotent — calling this on every
 * page load is the intended pattern.
 */
export function loadOrCreateWallet(): KeyPair {
  const existing = localStorage.getItem(WALLET_KEY);
  if (existing) {
    try {
      const parsed = JSON.parse(existing) as StoredWallet;
      if (parsed.v === 1 && parsed.privateKeyHex) {
        return fromPrivateKey(hexToBytes(parsed.privateKeyHex));
      }
    } catch {
      // fall through and regenerate — corruption shouldn't brick the wallet
    }
  }
  const kp = generateKeyPair();
  saveWallet(kp);
  return kp;
}

export function saveWallet(kp: KeyPair): void {
  const data: StoredWallet = { v: 1, privateKeyHex: bytesToHex(kp.privateKey) };
  localStorage.setItem(WALLET_KEY, JSON.stringify(data));
}

// Both `type` strings are accepted on import for backwards compatibility with
// wallet files exported by the old wwwCoin builds. We write the new tag.
const WALLET_FILE_TYPES = new Set(['browsercoin-wallet', 'wwwcoin-wallet']);

/** Serialize the wallet for export as a downloadable JSON file. */
export function exportWalletJson(kp: KeyPair): string {
  const out = {
    type: 'browsercoin-wallet',
    version: 1,
    address: kp.address,
    privateKeyHex: bytesToHex(kp.privateKey),
    warning: 'Anyone with the private key controls the wallet. Keep this safe.',
  };
  return JSON.stringify(out, null, 2);
}

/** Import from the file format produced by exportWalletJson. Throws on bad input. */
export function importWalletJson(text: string): KeyPair {
  const parsed = JSON.parse(text) as { type?: string; privateKeyHex?: string };
  if (!parsed.type || !WALLET_FILE_TYPES.has(parsed.type)) throw new Error('not a BrowserCoin wallet file');
  if (!parsed.privateKeyHex) throw new Error('missing privateKeyHex');
  const kp = fromPrivateKey(hexToBytes(parsed.privateKeyHex));
  saveWallet(kp);
  return kp;
}

/** Wipe the wallet — irreversible without an exported backup. */
export function deleteWallet(): void {
  localStorage.removeItem(WALLET_KEY);
}
