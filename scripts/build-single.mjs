/**
 * Fold the built client into one HTML file that runs from the filesystem.
 *
 * Why this exists: plural signalling means no server of ours is needed to find
 * peers, but if the client itself must be downloaded from browsercoin.org then
 * the single point of failure has only moved from the signalling host to the
 * web host. A client that is a file removes both. The domain becomes a
 * convenience for newcomers rather than a dependency of participants.
 *
 * A page loaded over `file://` is a complete runtime in current Chromium and
 * Firefox: secure context, WebCrypto, IndexedDB, localStorage, workers,
 * WebRTC, outbound WebSockets, and unrestricted cross-origin fetch. Everything
 * the node uses is present, so the only work here is removing the assumption
 * that a server is sitting there to hand out a second file.
 *
 * Four things have to be folded in:
 *
 *   1. The JS bundle and the stylesheet, which is just concatenation.
 *   2. The two Web Workers. These cannot stay as separate files, because
 *      `new URL('/assets/x.js', import.meta.url)` resolves to
 *      `file:///assets/x.js` and there is nothing there. Each worker bundle is
 *      self-contained, so it becomes a blob URL built at startup.
 *   3. The logo, as a data URI. The full-size one is 1.4 MB, which would be
 *      more than twice the weight of the entire application, so a 128px copy
 *      is used instead.
 *   4. `<link rel=icon>` and the social preview tags, which describe a page at
 *      a URL. This file has no URL.
 *
 * Run with `npm run build:single`.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'dist-single');
const assetsDir = path.join(outDir, 'assets');
const finalName = 'browsercoin.html';

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ── 1. Build ───────────────────────────────────────────────────────────────
console.log('building with vite.config.single.ts ...');
execFileSync('npx', ['vite', 'build', '--config', 'vite.config.single.ts'], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

let html = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
const assets = fs.readdirSync(assetsDir);

const findAsset = (pred, what) => {
  const hit = assets.find(pred);
  if (!hit) throw new Error(`could not find the ${what} in dist-single/assets`);
  return hit;
};

const jsName = findAsset((f) => /^index-.*\.js$/.test(f), 'main bundle');
const cssName = findAsset((f) => /^index-.*\.css$/.test(f), 'stylesheet');
const workerNames = assets.filter((f) => /\.worker-.*\.js$/.test(f));
if (workerNames.length === 0) {
  throw new Error('no worker bundles found; the inlining below would silently do nothing');
}

let js = fs.readFileSync(path.join(assetsDir, jsName), 'utf8');
const css = fs.readFileSync(path.join(assetsDir, cssName), 'utf8');

// ── 2. Workers become blob URLs ────────────────────────────────────────────
//
// Each worker's source is embedded as a string and turned into a blob at
// startup, then every `new URL('/assets/<worker>', import.meta.url)` in the
// bundle is rewritten to point at that blob instead.
const blobDecls = [];
let rewrites = 0;

workerNames.forEach((name, i) => {
  const src = fs.readFileSync(path.join(assetsDir, name), 'utf8');
  if (/(^|[^\w.])import\s*[({'"]/.test(src)) {
    // A worker that imports another chunk cannot become a blob: relative
    // specifiers resolve against the blob URL and there is nothing to resolve
    // them to. Better to fail the build than to ship a file whose miner dies.
    throw new Error(`worker ${name} has imports; it cannot be inlined as a blob`);
  }
  const varName = `__bcWorker${i}`;
  blobDecls.push(
    `const ${varName} = URL.createObjectURL(new Blob([${JSON.stringify(src)}], { type: 'text/javascript' }));`,
  );
  // The WHOLE `new Worker(...)` call is replaced, options included, because
  // the second argument has to go: the source asks for `{ type: 'module' }`,
  // and Chromium refuses a module worker from a blob inside a `file://`
  // document, whose origin is opaque. The bundles are built as classic IIFE
  // workers (see vite.config.single.ts) precisely so this call can drop it.
  // Anchored on the exact emitted asset path; matching loosely would risk
  // rewriting something else in a 550 KB bundle.
  const pattern = new RegExp(
    `new Worker\\(\\s*new URL\\(\\s*(["'])\\/assets\\/${escapeRe(name)}\\1\\s*,\\s*import\\.meta\\.url\\s*\\)\\s*(?:,\\s*\\{[^{}]*\\})?\\s*\\)`,
    'g',
  );
  const hits = (js.match(pattern) || []).length;
  if (hits === 0) {
    throw new Error(`worker ${name} was built but never referenced; refusing to ship a broken bundle`);
  }
  js = js.replace(pattern, () => `new Worker(${varName})`);
  rewrites += hits;
  console.log(`  inlined worker ${name} (${kb(src.length)}, ${hits} reference${hits === 1 ? '' : 's'})`);
});

js = `${blobDecls.join('\n')}\n${js}`;

// ── 3. Assets referenced from the HTML skeleton ────────────────────────────
const logoPath = path.join(outDir, 'logo-inline.png');
if (!fs.existsSync(logoPath)) {
  throw new Error('public/logo-inline.png is missing; the single file would have a broken logo');
}
const logoUri = `data:image/png;base64,${fs.readFileSync(logoPath).toString('base64')}`;

// Every absolute path would be a failed request against a filesystem root.
html = html.replace(/"\/logo(?:-inline)?\.png"/g, () => `"${logoUri}"`);
html = html.replace(/\s*<link rel="icon" type="image\/x-icon" href="\/favicon\.ico"\s*\/?>/g, '');
// Social preview tags describe a page at a URL. This file has no URL.
html = html.replace(/\s*<meta (?:property="og:|name="twitter:)[^>]*>/g, '');
// Preload hints point at files that will not exist.
html = html.replace(/\s*<link rel="modulepreload"[^>]*>/g, '');

// ── 4. Check for anything still expecting a server ─────────────────────────
//
// Deliberately done on the skeleton, BEFORE the bundle is folded in.
// Afterwards the page contains the whole application, which is full of in-app
// router links like `href="/about"` inside HTML template strings. Those are
// navigation targets handled by the SPA router, not files to fetch, and a
// check running after inlining cannot tell the two apart.
const stillRemote = [...html.matchAll(/(?:src|href)="(\/[^"]*)"/g)]
  .map((m) => m[1])
  .filter((p) => p !== `/assets/${jsName}` && p !== `/assets/${cssName}`);
if (stillRemote.length > 0) {
  throw new Error(
    `single file still requests server paths, which would 404 offline: ${stillRemote.join(', ')}`,
  );
}

// ── 5. Fold JS and CSS in ──────────────────────────────────────────────────
// A literal `</script>` inside the bundle would end the tag early. There are
// none today, but a future dependency could introduce one in a string.
const safeJs = js.replace(/<\/script/gi, '<\\/script');

// Replacement FUNCTIONS, not strings. A minified bundle contains `$&` and `$'`
// sequences, and as a replacement string those expand to the matched text,
// silently splicing the original <script src> tag back into the output.
html = html.replace(
  new RegExp(`\\s*<link rel="stylesheet"[^>]*href="\\/assets\\/${escapeRe(cssName)}"[^>]*>`),
  () => `\n    <style>\n${css}\n    </style>`,
);
html = html.replace(
  new RegExp(`\\s*<script type="module"[^>]*src="\\/assets\\/${escapeRe(jsName)}"[^>]*><\\/script>`),
  () => `\n    <script type="module">\n${safeJs}\n    </script>`,
);

// ── 6. Verify, then write ──────────────────────────────────────────────────
if (html.includes(`/assets/${jsName}`) || html.includes(`/assets/${cssName}`)) {
  throw new Error('the bundle or stylesheet tag survived inlining; the file would be blank offline');
}

const finalPath = path.join(outDir, finalName);
fs.writeFileSync(finalPath, html);

// Leave only the artefact, so what to ship is unambiguous.
for (const f of fs.readdirSync(outDir)) {
  if (f !== finalName) fs.rmSync(path.join(outDir, f), { recursive: true, force: true });
}

const size = fs.statSync(finalPath).size;
console.log(`\nwrote dist-single/${finalName}  ${kb(size)}`);
console.log(`  ${rewrites} worker reference${rewrites === 1 ? '' : 's'} rewritten to blob URLs`);
console.log('  open it directly from the filesystem; no server needed');
