/**
 * Signaling substrates.
 *
 * WebRTC cannot bootstrap itself: two browsers that have never met need a few
 * hundred bytes of SDP to reach each other before any direct link can exist.
 * That is a hard property of the browser sandbox — a tab has no listening
 * socket, and ICE refuses to answer a connectivity check until
 * `setRemoteDescription` has supplied the dialer's ufrag, password and DTLS
 * fingerprint. Something else always carries the first ~90 bytes.
 *
 * What we *can* choose is whether that something is a server we operate. Until
 * now it was: every dial went through PeerJS, so peer1+peer2 going down meant
 * no new connection could form anywhere on the network. A `SignalTransport` is
 * one interchangeable way to carry those bytes — PeerJS is now merely the first
 * implementation, sitting alongside substrates nobody has to keep alive for us
 * (public Nostr relays, public WebTorrent trackers).
 *
 * Several run concurrently and none is authoritative, exactly like the API
 * helper lists: a transport is a way to *find* the network, never a source of
 * truth about it. Every block that arrives over a link brokered this way is
 * still validated locally, so a hostile substrate can withhold peers but can
 * never make us accept a bad chain.
 *
 * ── The swarm model ────────────────────────────────────────────────────────
 * Both third-party substrates are natural fits for the same pattern, so the
 * interface is built around it rather than around directed dialing:
 *
 *   1. A node with spare peer slots publishes a batch of *open offers* — SDP
 *      offers addressed to nobody in particular, each with its own id and its
 *      own RTCPeerConnection.
 *   2. Any node that wants a peer picks one, publishes an answer addressed
 *      back at the offerer, and the two connect directly.
 *   3. Once connected, the substrate is irrelevant to that link forever.
 *
 * This is how WebTorrent trackers have always worked, and it maps cleanly onto
 * Nostr ephemeral events. It also means we never need a substrate to support
 * directed messaging or presence lists — the weakest possible requirement, so
 * the widest possible set of networks qualifies.
 *
 * Dialing a *specific* known peer stays on the paths that already handle it:
 * PeerJS, and `addrs` gossip over existing WebRTC links (which needs no
 * signaling substrate at all).
 *
 * ── Non-trickle, deliberately ──────────────────────────────────────────────
 * Offers and answers are published only after ICE gathering completes, so a
 * connection costs exactly two messages instead of a stream of trickled
 * candidates. That adds a second or two of setup latency, which is irrelevant
 * for a gossip mesh, and cuts substrate traffic by roughly an order of
 * magnitude — which matters a great deal when the substrate is somebody
 * else's free relay and we want to stay a polite guest on it.
 */

/** An SDP offer published to the swarm for anyone to pick up. */
export interface OpenOffer {
  /** Random per-offer id, so an offerer can match an answer to the right pc. */
  offerId: string;
  /** Full SDP, post-gathering. */
  sdp: string;
}

/** An answer aimed at one specific open offer. */
export interface SignalAnswer {
  /** Peer id that published the offer. */
  toPeer: string;
  offerId: string;
  sdp: string;
}

/**
 * Callbacks a transport uses to hand work back to the swarm dialer. A
 * transport never touches RTCPeerConnection itself — it only moves strings.
 */
export interface SignalContext {
  /** Our own peer id; shared with the PeerJS path so dedupe works across both. */
  selfId: string;
  /** A remote peer published an open offer we may answer. */
  onOffer(fromPeer: string, offerId: string, sdp: string): void;
  /** A remote peer answered one of the offers we published. */
  onAnswer(fromPeer: string, offerId: string, sdp: string): void;
}

export interface SignalTransport {
  /** Stable machine id, e.g. 'nostr'. Used as a settings key. */
  readonly id: string;
  /** Human label for the network status panel. */
  readonly label: string;
  /**
   * Bring the transport up. Should resolve once it is usable, and reject if it
   * definitively cannot start — callers race several and tolerate failures, so
   * rejecting is cheap and never fatal.
   */
  start(ctx: SignalContext): Promise<void>;
  stop(): void;
  /**
   * Publish (or re-publish) our current batch of open offers. Called on a
   * timer, so implementations should treat it as "this is the full current
   * set", not as an incremental append.
   */
  publishOffers(offers: OpenOffer[]): void;
  /** Publish one answer. Fire-and-forget; failures are logged, never thrown. */
  publishAnswer(answer: SignalAnswer): void;
  /**
   * Whether we currently want to hear about other people's offers.
   *
   * This is the main lever on how much load the network puts on substrates it
   * doesn't pay for, and it's what makes the design scale. In a healthy mesh
   * most nodes are at their peer target and want nothing — those nodes should
   * be silent *and* deaf, not quietly receiving every other node's offers
   * forever. Without it, inbound traffic per node grows linearly with network
   * size, which would both melt the tab and make us an obnoxious guest on free
   * public relays.
   */
  setActive(active: boolean): void;
  /** True when at least one underlying endpoint is connected. */
  isUp(): boolean;
  /** Per-endpoint liveness, for the network status panel. */
  endpoints(): SignalEndpointStatus[];
}

export interface SignalEndpointStatus {
  url: string;
  up: boolean;
}

/**
 * The subset of PeerJS's `DataConnection` that the gossip layer actually uses.
 * Declaring it here lets `peer.ts` accept connections from the swarm dialer and
 * from PeerJS interchangeably, without either knowing about the other.
 */
export interface PeerConn {
  readonly peer: string;
  send(data: unknown): void;
  close(): void;
  on(event: 'open', fn: () => void): void;
  on(event: 'data', fn: (data: unknown) => void): void;
  on(event: 'close', fn: () => void): void;
  on(event: 'error', fn: (err: { message: string }) => void): void;
}
