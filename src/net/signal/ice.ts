/**
 * Public STUN servers used to discover our reflexive (NAT-mapped) address.
 *
 * Without these, a browser behind almost any NAT only knows its RFC1918 LAN
 * address, which is useless to a remote peer. STUN lifts the easy-NAT majority
 * into the direct-connect path; the residual (symmetric NAT on both ends, very
 * roughly 10–15% of pairs) is expected to fall back to the manual peer-ID
 * handshake rather than a TURN relay — the project deliberately avoids
 * centralized relay infrastructure, which would both cost money and put a
 * machine in the middle of real traffic.
 *
 * That residual matters much less here than it would for a video call: a
 * gossip mesh doesn't need every pair to connect, only enough pairs for the
 * graph to stay connected. A 15% pair-failure rate barely dents that.
 *
 * The list is long on purpose. These are stateless, they never see or carry
 * chain data, and they're operated by many unrelated organizations — so
 * depending on "some STUN server, any STUN server" is a materially different
 * kind of dependency from depending on one project's signaling host. Browsers
 * race them and use whichever answers first.
 *
 * Note on a road not taken: an already-connected peer cannot substitute for
 * STUN by reporting the address it observes. Chromium redacts
 * `remote-candidate.address` in `getStats()`, so the mesh cannot learn its own
 * reflexive addresses from itself (measured 2026-08-11). STUN stays.
 */
export const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:global.stun.twilio.com:3478' },
  { urls: 'stun:stun.nextcloud.com:3478' },
  { urls: 'stun:stun.stunprotocol.org:3478' },
  { urls: 'stun:stun.sipgate.net:3478' },
];
