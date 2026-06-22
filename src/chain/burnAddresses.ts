/**
 * Registry of known burn addresses: destinations whose coins are permanently and
 * provably unspendable. The explorer uses this to label them so a large balance
 * sitting at one is understood as removed from circulation, not as a whale.
 *
 * The "dead" address below is NOT a valid Ed25519 public key — it does not decode
 * to a point on the signature curve — so verification can never succeed for it
 * and no private key for it can exist. That makes it a true burn. (Note: the
 * all-zeros address is the opposite, a degenerate low-order point that an empty
 * signature can satisfy, so it is spendable and must never be used as a burn.)
 */
export interface BurnAddressInfo {
  address: string;
  label: string;
  description: string;
}

/** 000…000dead — 60 zero nibbles followed by "dead" (64 hex chars). */
export const DEAD_BURN_ADDRESS = '0'.repeat(60) + 'dead';

export const BURN_ADDRESSES: Record<string, BurnAddressInfo> = {
  [DEAD_BURN_ADDRESS]: {
    address: DEAD_BURN_ADDRESS,
    label: 'Burn address',
    description:
      'Coins sent here are permanently destroyed. This address is not a valid public key '
      + '(it does not decode to a point on the signature curve), so no private key for it can '
      + 'exist and no signature can ever authorize spending from it. Funds parked here are '
      + 'removed from circulation forever. Anyone can verify this: any wallet rejects it as an '
      + 'invalid address, which is exactly why it is unspendable.',
  },
};

export function getBurnAddressInfo(addrHex: string): BurnAddressInfo | undefined {
  return BURN_ADDRESSES[addrHex.toLowerCase()];
}

export function isBurnAddress(addrHex: string): boolean {
  return addrHex.toLowerCase() in BURN_ADDRESSES;
}
