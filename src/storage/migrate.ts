/**
 * Migrate legacy `wwwcoin:*` localStorage keys to `browsercoin:*` on first
 * run. Idempotent: once the new keys exist, the old ones are removed and the
 * function is a no-op on subsequent calls.
 *
 * Why migrate at all: the rebrand from wwwCoin → BrowserCoin is purely
 * cosmetic, but settings/wallet/miner config live under the old prefix in
 * users' browsers. Without migration, returning users would lose their wallet
 * and have to re-enter their bootstrap URL.
 */
const KEY_PAIRS: Array<[string, string]> = [
  ['wwwcoin:wallet:v1', 'browsercoin:wallet:v1'],
  ['wwwcoin:bootstrap', 'browsercoin:bootstrap'],
  ['wwwcoin:miner-threads', 'browsercoin:miner-threads'],
];

export function migrateLocalStorage(): void {
  for (const [oldKey, newKey] of KEY_PAIRS) {
    if (localStorage.getItem(newKey) !== null) continue;
    const oldVal = localStorage.getItem(oldKey);
    if (oldVal !== null) {
      localStorage.setItem(newKey, oldVal);
      localStorage.removeItem(oldKey);
    }
  }
}
