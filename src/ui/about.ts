/**
 * About page. Long-form vision content — written in a deliberately factual,
 * non-promotional voice. Structural facts are laid out; the reader does the
 * math themselves. No "this could be valuable", no roadmap, no pitch.
 *
 * Two documents behind one nav tab, switched by `?tab=`:
 *   • (default)     — what the chain is and what rules it runs under TODAY.
 *     Every technical claim here must track the code; when a fork changes a
 *     rule, this is the file that gets corrected.
 *   • ?tab=whitepaper — the original launch paper, frozen (see whitepaper.ts).
 *     Never sync that file to reality; the divergence is the point.
 */
import type { Router } from './router.js';
import { WHITEPAPER_HTML } from './whitepaper.js';
import { renderChangelog } from './changelog.js';

const ABOUT_HTML = `
  <h3>Why this exists</h3>

  <p>
    Crypto is a genuinely interesting piece of technology. A network of
    strangers who don't trust each other can agree on the state of a shared
    ledger, with no one in charge, using nothing but math and electricity.
    Somewhere along the way, the thing most people came to call "crypto"
    stopped being about that and became a number on a chart, usually attached
    to a coin that isn't decentralized at all — controlled by a foundation, a
    multisig of insiders, a "DAO" nobody can vote against.
  </p>

  <p>
    BrowserCoin goes back to what crypto actually is, and makes it easy enough
    that anyone can be part of it. Open a webpage, you're in — no login, no
    signup, because real crypto doesn't require any.
    <strong>There is no market where you can buy BRC with dollars.</strong>
    The only way to get coins is to mine them, or to have someone who already
    mined some send them to you. Nobody is selling you anything.
    <strong> This is not about making money — this is about enjoying the
    technology.</strong>
  </p>

  <p>
    The full argument for the project is in
    <a href="/about?tab=whitepaper">the launch paper</a>, kept unedited from
    the day the chain went live. This page is the current state of the machine.
  </p>

  <h3>Fully decentralized</h3>

  <p>This isn't a marketing line. It's a constraint the code enforces:</p>

  <ul>
    <li>No founder allocation. No presale. No team tokens. No premine. Coins exist only because someone mined them.</li>
    <li>No central authority signs blocks. No multisig of insiders can override consensus. No "DAO" votes on the chain.</li>
    <li>No checkpoint server that can rewrite history.</li>
    <li>
      The helper servers are tiny optional services — one brokers the
      initial WebRTC handshake, another keeps a backup copy of the chain
      and helps new browsers find peers. Neither can sign blocks, override
      consensus, or mint coins. Run multiple of either; the client tries
      them all and fans out writes. Don't trust the defaults? Add your own
      under Settings, or run <code>npm run server:api</code> /
      <code>npm run server:peerjs</code>.
    </li>
  </ul>

  <p>
    The code is open source under MIT. Read it. Run it. Fork it. The math
    doesn't care who you are.
  </p>

  <h3>The rules</h3>

  <ul>
    <li>Total supply: <strong>21,000,000 BRC</strong>, ever.</li>
    <li>Block reward: <strong>50 BRC</strong>, halving every 210,000 blocks (~1 year at target pace).</li>
    <li>Target block time: <strong>2.5 minutes</strong>.</li>
    <li>Proof-of-work: <strong>Sandglass v3</strong> — memory-<em>latency</em>-hard, 512 KiB × 2,097,152 dependent steps. Mineable on a laptop or phone; a high-end GPU gets no meaningful edge.</li>
    <li>Difficulty: <strong>ASERT</strong>, retargeted every block, 10-minute half-life.</li>
    <li>Account-model ledger, Ed25519 signatures, 256 KB block cap, per-byte minimum fee.</li>
  </ul>

  <p>
    If those numbers look familiar — yes, the monetary policy is the same
    shape as Bitcoin's. Same supply, same halving schedule, four times the
    throughput. That's intentional. An homage to Bitcoin if you want, but
    more importantly, it's a set of parameters that are widely understood
    and that work well for a chain of this scale. And it's not a trillion
    coins in circulation like some of the copycats. The supply is scarce
    enough that it can be meaningful to own some, but not so scarce that
    you have to worry about dust or microtransactions.
  </p>

  <h3>Design decisions</h3>

  <p>
    None of the technical choices in BrowserCoin are arbitrary. The small
    things have reasons.
  </p>

  <h4>Why mining uses your CPU, not a GPU or ASIC</h4>
  <p>
    The hash function is <strong>Sandglass v3</strong>. It is
    <em>memory-latency</em>-hard: a 512 KiB buffer is filled from the block
    header, then walked by 2,097,152 read-modify-write steps. Each step's
    address depends on the value the previous step just read, so the work is a
    serial pointer chase — you cannot start step <em>n+1</em> until step
    <em>n</em> has come back from memory. Throwing more cores at one hash
    doesn't help, because the dependency is in the data, not in the schedule.
  </p>
  <p>
    The walk runs as 4 interleaved chains, and that number is the whole trick.
    An out-of-order CPU core can keep roughly four cache misses in flight at
    once, so 4 chains saturate one ordinary core. A GPU is <em>already</em>
    hiding latency across thousands of lanes; giving it four chains hands it
    nothing it wasn't doing anyway. Measured across 90+ devices, a browser tab
    lands within about 10% of a hand-optimized native miner <em>and</em> of an
    RTX 5090, and beats every GPU tested on hashes per joule.
  </p>
  <p>
    This replaced <strong>Argon2id</strong>, which the chain launched with.
    Argon2id is memory-<em>capacity</em>-hard — 32 MB per hash — and the theory
    was that GPUs couldn't feed that many parallel instances. In practice they
    could: GPU memory bandwidth is enormous, and farms were out-hashing
    browsers by 10–30×. That is the opposite of the goal, so the algorithm was
    replaced (fork #2, below). Latency, unlike bandwidth, is not something you
    can buy your way out of.
  </p>

  <h4>Why the monetary policy is Bitcoin-shaped</h4>
  <p>
    21M cap, 50-coin reward, halving every 210,000 blocks. These numbers
    match Bitcoin's exactly. The supply schedule isn't being innovated on
    here — Bitcoin's monetary policy is widely understood, the math is
    well-known, and copying it makes BrowserCoin instantly legible to
    anyone who's looked at how Bitcoin works. The only deliberate
    difference is the block time (2.5 minutes vs 10), which is 4× faster.
  </p>

  <h4>Why 2.5-minute blocks</h4>
  <p>
    Fast enough that the experiment feels alive — you don't wait ten
    minutes after starting to mine to find out whether anything is
    happening. Slow enough that block propagation across a peer-to-peer
    WebRTC network doesn't cause widespread orphaning. The 4× speedup
    keeps the network feeling responsive without breaking consensus.
  </p>

  <h4>Why ASERT difficulty retargeting</h4>
  <p>
    Bitcoin retargets every 2,016 blocks (~2 weeks) because its hashrate
    is enormous and stable. A browser network's hashrate can swing 100×
    when a few tabs open or close, so BrowserCoin retargets every block.
    The algorithm is ASERT — the same anchor-based exponential rule
    Bitcoin Cash adopted in 2020 — with target = anchor_target × 2^((Δt
    − n × T) / halflife). Equilibrium is a mathematical fixed point at
    any hashrate scale, so the chain converges smoothly whether one tab
    is mining or thousands are. The half-life is 10 minutes (4 target
    block-times), tuned to track minute-scale hashrate swings without
    reacting to single-block noise. A hard floor at the genesis
    difficulty keeps the chain alive even at near-zero hashrate.
  </p>
  <p>
    "Anchor-based" means every block's difficulty is derived from one fixed
    reference block rather than from a rolling window — which is what makes it
    immune to the clustering pathologies that plague sliding-window rules, and
    what makes single-block timestamp manipulation pointless. The anchor is
    currently block <strong>35,550</strong>, and the important detail is that
    both of its inputs — its timestamp and its difficulty — are <em>read from
    the chain</em> rather than hardcoded. An anchor that states something the
    chain didn't actually do is the one way this algorithm fails badly, which
    is not a hypothetical; see fork #3.
  </p>

  <h4>Why Ed25519 signatures</h4>
  <p>
    Fast, deterministic (no malleable signatures — every valid signature
    for a given message is identical), well-audited, and the library is
    small enough to load in a browser without slowing the page. Bitcoin
    uses ECDSA which works but is slower and historically had
    signature-malleability bugs that took years to clean up. Ed25519 was
    the right call for a new chain in 2025.
  </p>

  <h4>Why an account model, not UTXO</h4>
  <p>
    Ethereum-style <code>{balance, nonce}</code> per address rather than
    Bitcoin's unspent-transaction-output model. State is smaller, simpler
    to implement, and easier for a browser to keep in memory. The
    downside is that account models have slightly worse privacy properties
    than UTXO; for an experiment with no fiat market, that tradeoff is
    fine.
  </p>

  <h4>Why money is <code>bigint</code> everywhere</h4>
  <p>
    JavaScript's <code>Number</code> only has 53 bits of integer precision
    and overflows silently. The famous Bitcoin 2010 value-overflow bug
    (CVE-2010-5139) was an integer wrap in a signed 64-bit accumulator
    that briefly let someone create 184 billion BTC out of nothing.
    BrowserCoin uses native <code>bigint</code> for every balance, amount,
    fee, and intermediate sum. The bug class is structurally impossible.
    Defense in depth on top of that: transactions explicitly reject any
    amount or fee greater than <code>MAX_MONEY</code> (21M BRC).
  </p>

  <h4>Why no central authority and no checkpoint server</h4>
  <p>
    Some chains defend against 51% attacks by running a "soft checkpoint"
    service: a trusted operator signs the chain tip every few minutes,
    and clients refuse reorgs that bury a signed checkpoint. It works,
    but it defeats the entire point of having a permissionless consensus
    system. BrowserCoin explicitly does not take that path. The defense
    against attacks is the same one Bitcoin actually relies on in
    practice — making an attack expensive enough that nobody bothers —
    adapted to a network without ASICs and without a fiat price.
    Latency-hard PoW denies an attacker cheap parallel hashrate; network
    scale raises the total cost; per-block retargeting closes the cheaper
    attack paths. It's an honest tradeoff.
  </p>

  <h4>Why the bootstrap server is replaceable</h4>
  <p>
    Peer discovery is the one part of a fully-decentralized browser
    network that needs a stable starting point — browsers can't dial each
    other without first knowing each other's WebRTC IDs. The bootstrap
    server provides that initial directory, and as a convenience also
    keeps a copy of the chain so a brand-new tab can catch up without
    waiting for peers to come online. Its role is purely informational:
    everything it serves is re-verified locally against consensus rules
    before your node believes any of it. Swap it under
    Settings → Bootstrap server, or run your own.
  </p>

  <h3>Fork history</h3>

  <p>
    Consensus rules have changed three times. Each fork is listed with what
    actually happened, including the one that was a mistake.
  </p>

  <h4>Fork #1 — scripts · 2026-07-05</h4>
  <p>
    Added the on-chain script system: spend conditions beyond a plain
    signature, including hash-time-locked contracts. Activation was gated on
    median-time-past rather than a wall clock, so every node flipped at the
    same block rather than whenever its own machine thought the date had
    arrived.
  </p>

  <h4>Fork #2 — Sandglass proof-of-work · block 33,550</h4>
  <p>
    Replaced Argon2id with Sandglass v3 for the reason described above: GPU
    farms had a 10–30× edge under Argon2id and the point of the chain is that
    they shouldn't. Because the two algorithms measure work in incomparable
    units, the fork also reset difficulty to a fixed starting point and
    re-anchored ASERT there.
  </p>

  <h4>Fork #3 — difficulty repair · block 35,550</h4>
  <p>
    Fork #2's re-anchor used a <em>hardcoded estimate</em> of when the chain
    would reach the fork height, written three days in advance. Anchor-based
    ASERT amplifies anchor-time error exponentially, so a wrong guess could
    have exploded difficulty on its own. The mitigation shipped alongside it
    was a clamp holding the target within 4× of the reset for 2,000 blocks —
    and the clamp was the actual bug.
  </p>
  <p>
    ASERT derives its target from the <em>total</em> drift accumulated since
    the anchor: it is an integrator. Bounding its output while the drift keeps
    accumulating behind it is textbook integral windup. The reset landed about
    10× too easy, difficulty pinned at the clamp ceiling from roughly block
    33,600, blocks ran ~60s instead of 150s, and by block 34,039 the drift had
    wound up to −12.4 hours — an unclamped demand of some 2.6 × 10²² times the
    reset difficulty. At block 35,550 the clamp was due to expire and discharge
    all of it in a single retarget, making the next block unmineable. The chain
    would have stopped, permanently, and the emergency-drop rule could not have
    rescued it: its gate reads frozen history that no future block can change.
  </p>
  <p>
    The fix was not a new mechanism but the removal of one. From block 35,551
    on, difficulty is plain, unbounded ASERT re-anchored on the <em>real</em>
    header of block 35,550 — its actual mined timestamp and its actual
    difficulty, both read from the chain, neither guessed. A truthful anchor has
    nothing to contain, so there is no clamp, no settling window, no expiry, and
    no future cliff. That is the same property that let the original
    genesis-anchored rule hold 149.2 s/block across 33,000 blocks, and it is
    exactly what fork #2 gave away.
  </p>

  <h3>How to take part</h3>

  <ol>
    <li>Open <strong>browsercoin.org</strong>. You'll get a wallet on first visit, stored in your browser. Back it up under Settings.</li>
    <li>Click <strong>Mine</strong>. Your CPU starts grinding Sandglass hashes. When one lands below the current difficulty target, you've found a block and earned 50 BRC.</li>
    <li>Show someone the <strong>QR code</strong> next to your address. They can scan it to send you coins.</li>
    <li>Tell a friend.</li>
    <li>And most importantly, have fun. Crypto is a neat technology — time to honor it by taking part. Not by trying to make profit.</li>
  </ol>

  <h3>The code</h3>

  <p>
    MIT-licensed. The full client, server, consensus rules, and tests
    live at
    <a href="https://github.com/swompythesecond/BrowserCoin" target="_blank" rel="noopener noreferrer">github.com/swompythesecond/BrowserCoin</a>.
    Small enough to actually read.
  </p>
`;

type Tab = '' | 'whitepaper' | 'changelog';

const SUBTITLE: Record<Tab, string> = {
  '': 'What the chain is, and the rules it runs under today.',
  whitepaper: 'The original launch paper, preserved as written.',
  changelog: 'Every change since launch, straight from Discord.',
};

export function mountAbout(host: HTMLElement, params: URLSearchParams, router: Router): () => void {
  const raw = params.get('tab');
  const tab: Tab = raw === 'whitepaper' || raw === 'changelog' ? raw : '';

  const view = document.createElement('div');
  view.className = 'view view-about';
  view.innerHTML = `
    <div class="view-header">
      <h2 class="view-title">About BrowserCoin</h2>
      <span class="view-sub">${SUBTITLE[tab]}</span>
    </div>

    <div class="row about-tabs">
      <div class="chips" data-w="tabs">
        <button type="button" class="chip${tab === '' ? ' active' : ''}" data-tab="">About</button>
        <button type="button" class="chip${tab === 'whitepaper' ? ' active' : ''}" data-tab="whitepaper">Launch paper</button>
        <button type="button" class="chip${tab === 'changelog' ? ' active' : ''}" data-tab="changelog">Changelog</button>
      </div>
    </div>

    <article class="about-body${tab === 'whitepaper' ? ' paper' : ''}" data-w="doc">
      ${tab === 'whitepaper' ? WHITEPAPER_HTML : tab === 'changelog' ? '' : ABOUT_HTML}
    </article>
  `;
  host.appendChild(view);

  view.querySelectorAll<HTMLButtonElement>('[data-w="tabs"] .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const t = chip.dataset['tab'];
      router.navigate(t ? `/about?tab=${t}` : '/about');
    });
  });

  // The changelog is the only tab that loads anything; its cleanup aborts the
  // in-flight fetch so navigating away mid-request can't write into a detached
  // node. The other two are static strings.
  if (tab === 'changelog') {
    return renderChangelog(view.querySelector<HTMLElement>('[data-w="doc"]')!);
  }
  return () => { };
}
