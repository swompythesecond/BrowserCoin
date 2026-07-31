import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

/**
 * The reading routes (`/`, `/about`, `/highlights`, `/developers`) exist so
 * that someone who was handed a link — a journalist, an exchange, a friend —
 * can find out what BrowserCoin is without their browser becoming a node. That
 * used to be impossible: the client booted a node on every page load and threw
 * a full-screen sync overlay over the text.
 *
 * The guarantee is structural, so the test is too. These modules must not
 * reach the node, the miner or the network layer through their import graph.
 * A stray `import { Node }` in a landing-page tweak would silently re-create
 * the original problem — start a chain sync, generate a wallet, spin up
 * workers — for a reader who only wanted to read, and nothing else in the
 * suite would notice.
 *
 * Type-only imports are ignored: they're erased before anything runs.
 */

const SRC = resolve(__dirname, '..');

const READING_ROUTE_ENTRIES = [
  'ui/landing.ts',
  'ui/about.ts',
  'ui/highlights.ts',
  'ui/developers.ts',
];

/**
 * Modules that make the browser a participant rather than a reader.
 * Note `net/network.ts` is deliberately absent — despite the name it holds
 * only the network-id string; `net/peer.ts` is the actual WebRTC layer.
 */
const NODE_MODULES = [
  'node.ts',
  'miner/controller.ts',
  'net/serverSync.ts',
  'net/peer.ts',
  'chain/verifierPool.ts',
  'storage/idb.ts',
];

/** Relative specifiers only — a bare package name isn't part of our graph. */
function localImportsOf(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  const out: string[] = [];
  // `import ... from '<spec>'`, `export ... from '<spec>'`, and `import('<spec>')`.
  const re = /(?:^|\n)\s*(?:import|export)(?!\s+type\b)\b[^;]*?from\s*['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)/g;
  for (const m of src.matchAll(re)) {
    const spec = m[1] ?? m[2];
    if (!spec) continue;
    // `import { type Foo, bar }` is still a runtime import of the module.
    out.push(spec);
  }
  return out;
}

/** Source files are authored as `.ts` but import each other as `.js`. */
function resolveSpec(fromFile: string, spec: string): string {
  const raw = join(dirname(fromFile), spec);
  return raw.endsWith('.js') ? `${raw.slice(0, -3)}.ts` : `${raw}.ts`;
}

function reachableFrom(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [resolve(SRC, entry)];
  while (queue.length > 0) {
    const file = queue.pop()!;
    const key = relative(SRC, file).replace(/\\/g, '/');
    if (seen.has(key)) continue;
    seen.add(key);
    for (const spec of localImportsOf(file)) queue.push(resolveSpec(file, spec));
  }
  return seen;
}

describe('reading routes stay node-free', () => {
  for (const entry of READING_ROUTE_ENTRIES) {
    it(`${entry} does not reach the node`, () => {
      const reached = reachableFrom(entry);
      const violations = NODE_MODULES.filter((m) => reached.has(m));
      expect(violations).toEqual([]);
    });
  }

  // Guards the guard: if the resolver silently stopped following imports, every
  // assertion above would pass vacuously.
  it('the import walker actually follows the graph', () => {
    expect(reachableFrom('ui/landing.ts').has('storage/wallet.ts')).toBe(true);
    expect(reachableFrom('ui/about.ts').has('ui/changelog.ts')).toBe(true);
    // ...and it does find the node when one is genuinely imported.
    expect(reachableFrom('ui/home.ts').size).toBeGreaterThan(1);
    expect(reachableFrom('ui/miner.ts').has('miner/controller.ts')).toBe(true);
  });
});
