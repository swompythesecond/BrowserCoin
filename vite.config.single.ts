import { defineConfig } from 'vite';

/**
 * Build config for the single-file client.
 *
 * The normal build splits code so a browser can cache vendor chunks across
 * deploys. A file you download once and double-click has no cache to warm and
 * no server to fetch a second chunk from, so every one of those decisions
 * inverts: one chunk, no sourcemaps, no separate assets.
 *
 * The two Web Workers still come out as their own files, because Vite compiles
 * them through a separate pipeline. `scripts/build-single.mjs` folds those in
 * afterwards as blob URLs, which works only because each worker bundle is
 * self-contained (no imports to resolve at runtime).
 *
 * Kept apart from `vite.config.ts` rather than folded in behind a flag: the
 * hosted build is what almost everyone gets, and it should not carry the risk
 * of a conditional that only the offline path exercises.
 */
export default defineConfig({
  root: '.',
  publicDir: 'public',
  build: {
    target: 'es2022',
    outDir: 'dist-single',
    emptyOutDir: true,
    // Every byte ends up inside one HTML file, where a sourcemap comment
    // pointing at a file that will not be shipped is just dead weight.
    sourcemap: false,
    // Inlining is done by the post-build step, which needs to see real files.
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
        manualChunks: undefined,
      },
    },
  },
  worker: {
    /**
     * Classic workers, not ES modules, and this is load-bearing rather than a
     * preference. The single file turns each worker into a blob URL, and
     * Chromium refuses `new Worker(blobUrl, { type: 'module' })` from a
     * `file://` document: the page's origin is opaque, and a module worker
     * cannot be loaded into one. A classic worker from the same blob is fine.
     * Measured in Edge; `blob + module` was the only one of the four
     * combinations that failed.
     */
    format: 'iife',
  },
});
