/**
 * Community Highlights. A showcase of things the community has built around
 * BrowserCoin — pools, faucets, explorers, games. Curated by hand; the call
 * to action at the bottom points people at Discord to get their project added.
 */

interface Highlight {
  title: string;
  tag: string;
  description: string;
  url: string;
}

const HIGHLIGHTS: Highlight[] = [
  {
    title: 'Cryptec Pool',
    tag: 'Mining pool',
    description:
      'Pool your hashrate with other miners and share the block rewards, so payouts come in steadily instead of all-or-nothing.',
    url: 'https://brcpool.cryptec.tech/',
  },
  {
    title: 'Fulgur Pool',
    tag: 'Mining pool',
    description:
      'Another community-run mining pool — combine hashrate with other miners for steadier, shared payouts.',
    url: 'https://fulgurpool.xyz/',
  },
  {
    title: 'BrowserCoin Rush',
    tag: 'Faucet game',
    description:
      'A browser minigame that hands out BRC for playing — a fun way to pick up your first coins without mining.',
    url: 'https://browsercoinrush.cryptec.tech/',
  },
  {
    title: 'TabScope',
    tag: 'Explorer',
    description:
      'A community-built block explorer for browsing the chain — blocks, transactions, and addresses, with its own take on the UI.',
    url: 'https://tabscope.netlify.app/',
  },
  {
    title: 'Free BrowserCoins',
    tag: 'Faucet',
    description:
      'A faucet that drips free BRC to new addresses, so you can try sending and receiving before you have mined anything.',
    url: 'https://freebrowsercoins.uc.r.appspot.com/',
  },
  {
    title: 'BRC Dice',
    tag: 'On-chain game',
    description:
      'A SatoshiDice-inspired dice game played directly on the chain — send BRC to a game address to place a bet, and provably fair rolls pay winners straight back to their wallet.',
    url: 'https://brcdice.duckdns.org/',
  },
];

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export function mountHighlights(host: HTMLElement): () => void {
  const view = document.createElement('div');
  view.className = 'view';

  const cards = HIGHLIGHTS.map((h) => `
    <a class="highlight-card" href="${h.url}" target="_blank" rel="noopener noreferrer">
      <div class="highlight-card-top">
        <span class="highlight-tag">${h.tag}</span>
        <span class="highlight-arrow" aria-hidden="true">↗</span>
      </div>
      <h3 class="highlight-title">${h.title}</h3>
      <p class="highlight-desc">${h.description}</p>
      <span class="highlight-host">${hostname(h.url)}</span>
    </a>
  `).join('');

  view.innerHTML = `
    <div class="view-header">
      <h2 class="view-title">Community Highlights</h2>
      <span class="view-sub">Things people have built around BrowserCoin. Independent projects, not affiliated with the core client — use at your own discretion.</span>
    </div>

    <div class="grid grid-2 highlight-grid">
      ${cards}
    </div>

    <div class="highlight-cta">
      <div class="highlight-cta-body">
        <h3 class="highlight-cta-title">Built something cool for BRC?</h3>
        <p class="highlight-cta-text">
          Made a pool, a faucet, a game, an explorer, a bot — anything that
          touches BrowserCoin? Join the Discord and tell us about it, and we'll
          feature it right here.
        </p>
      </div>
      <a class="btn highlight-cta-btn" href="https://discord.gg/xV3De6ErTr" target="_blank" rel="noopener noreferrer">
        Join the Discord
      </a>
    </div>
  `;

  host.appendChild(view);
  return () => { };
}
