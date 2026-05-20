import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  publicDir: 'public',
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          noble: ['@noble/ed25519', '@noble/hashes/sha2', '@noble/hashes/utils'],
          peerjs: ['peerjs'],
        },
      },
    },
  },
  worker: {
    format: 'es',
  },
  server: {
    port: 5173,
    strictPort: false,
  },
});
