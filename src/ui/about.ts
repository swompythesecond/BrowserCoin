/**
 * About page. Long-form vision content  written in a deliberately factual,
 * non-promotional voice. Structural facts are laid out; the reader does the
 * math themselves. No "this could be valuable", no roadmap, no pitch.
 */
export function mountAbout(host: HTMLElement): () => void {
  const view = document.createElement('div');
  view.className = 'view view-about';
  view.innerHTML = `
    <div class="view-header">
      <h2 class="view-title">About BrowserCoin</h2>
    </div>

    <article class="about-body">
      <h3>Why this exists</h3>

      <p>
        Crypto is a genuinely interesting piece of technology. A network of
        strangers who don't trust each other can agree on the state of a shared
        ledger, with no one in charge, using nothing but math and electricity.
        That's a real thing. It works.
      </p>

      <p>
        Somewhere along the way, the thing most people came to call "crypto"
        stopped being about that. It became a number that goes up or down on a
        chart. The technology became invisible to the people who own the asset.
        New coins kept getting launched that weren't even decentralized 
        controlled by a foundation, a multisig of insiders, a "DAO" nobody can
        vote against. Tokens with central authorities defeat the entire point
        of why this technology is interesting in the first place.
      </p>

      <p>
        I built BrowserCoin to go back to what crypto actually is, and to make
        it easy enough that anyone can be part of it. Open a webpage, you're
        in  no login, no signup, no nothing, because real crypto doesn't
        require any. It can be completely anonymous. Find a block on your
        laptop, see it appear in the explorer with your address on it. Send
        coins to a friend by showing them a QR code on your phone.
        <strong>There is no market where you can buy BRC with dollars.</strong>
        The only way to get coins is to mine them, or to have someone who
        already mined some send them to you. Nobody is selling you anything.<strong> This is not about making money this is about enjoying the technology.</strong>
      </p>

      <p>
        This is the participatory experiment. If a lot of people join in, the
        network gets harder to attack and the chain starts to mean something.
        If only a few do, it was still a fun experiment in seeing what's
        possible. The coin costs nothing to mine besides electricity. There is
        no version of this where someone gets hurt.
      </p>

      <p>
        Bitcoin in 2009 was a handful of people running a client on their
        personal computers, finding blocks, getting 50 BTC for their trouble.
        Nobody had bought any. There was no chart. They were there because the
        experiment was interesting. That moment is over for Bitcoin. It isn't
        over for new chains.
      </p>

      <p>
        Participating in Bitcoin back then was hard. This isn't. Everyone who
        opens the page takes part in the experiment and makes the network
        stronger. It has never been easier to be part of a crypto network and
        enjoy it for what it is  a fascinating technology. Not a
        get-rich-quick scheme.
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
        <li>Proof-of-work: <strong>memory-hard Argon2id (32 MB, 1 iteration)</strong>. Mineable on a laptop or phone. Hostile to GPUs and server farms.</li>
        <li>Account-model ledger, Ed25519 signatures, 256 KB block cap, per-byte minimum fee.</li>
      </ul>

      <p>
        If those numbers look familiar  yes, the monetary policy is the same
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
        The hash function is <strong>Argon2id</strong>, configured with 32 MB
        of memory and 1 iteration per attempt. Argon2id is <em>memory-hard</em>:
        every hash needs a large chunk of RAM, and the bottleneck is memory
        bandwidth, not raw compute. GPUs and custom hardware can't accelerate
        it the way they can accelerate SHA-256  they have plenty of compute
        but not enough memory bandwidth per core. The result: mining stays
        roughly fair across laptops, phones, and desktops. The gap between a
        $20k server and a $400 laptop is small enough that everyone has a
        real chance of finding blocks. The cost is that your laptop fan spins;
        that's the price of egalitarian mining.
      </p>

      <h4>Why the monetary policy is Bitcoin-shaped</h4>
      <p>
        21M cap, 50-coin reward, halving every 210,000 blocks. These numbers
        match Bitcoin's exactly. The supply schedule isn't being innovated on
        here  Bitcoin's monetary policy is widely understood, the math is
        well-known, and copying it makes BrowserCoin instantly legible to
        anyone who's looked at how Bitcoin works. The only deliberate
        difference is the block time (2.5 minutes vs 10), which is 4× faster.
      </p>

      <h4>Why 2.5-minute blocks</h4>
      <p>
        Fast enough that the experiment feels alive  you don't wait ten
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
        difficulty keeps the chain alive even at near-zero hashrate, and a
        two-interval emergency-drop rule (both the candidate's and the
        parent's intervals must exceed 6× target before it fires) catches
        the edge cases without giving a single miner a discount.
      </p>

      <h4>Why Ed25519 signatures</h4>
      <p>
        Fast, deterministic (no malleable signatures  every valid signature
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
        practice  making an attack expensive enough that nobody bothers 
        adapted to a network without ASICs and without a fiat price.
        Memory-hard PoW raises the per-hash cost; network scale raises the
        total cost; hardened retargeting closes the cheaper attack paths.
        It's an honest tradeoff.
      </p>

      <h4>Why the bootstrap server is replaceable</h4>
      <p>
        Peer discovery is the one part of a fully-decentralized browser
        network that needs a stable starting point  browsers can't dial each
        other without first knowing each other's WebRTC IDs. The bootstrap
        server provides that initial directory, and as a convenience also
        keeps a copy of the chain so a brand-new tab can catch up without
        waiting for peers to come online. Its role is purely informational.
        Swap it under Settings → Bootstrap server, or run your own.
      </p>

      <h3>How to take part</h3>

      <ol>
        <li>Open <strong>browsercoin.org</strong>. You'll get a wallet on first visit, stored in your browser. Back it up under Settings.</li>
        <li>Click <strong>Mine</strong>. Your CPU starts grinding Argon2id hashes. When one lands below the current difficulty target, you've found a block and earned 50 BRC.</li>
        <li>Show someone the <strong>QR code</strong> next to your address. They can scan it to send you coins.</li>
        <li>Tell a friend.</li>
        <li>And most importantly, have fun. Crypto is a neat technology  time to honor it by taking part. Not by trying to make profit.</li>
      </ol>

      <h3>The code</h3>

      <p>
        MIT-licensed. The full client, server, consensus rules, and tests
        live at
        <a href="https://github.com/swompythesecond/BrowserCoin" target="_blank" rel="noopener noreferrer">github.com/swompythesecond/BrowserCoin</a>.
        Small enough to actually read.
      </p>
    </article>
  `;
  host.appendChild(view);
  return () => { };
}
