/**
 * Tiny shared CLI helpers for the server entry points. Lives in its own
 * module so both `server/api.ts` and `server/peerjs.ts` can parse the same
 * flags identically.
 */

/**
 * Resolve a port number, in priority order:
 *   1. `--port <N>` on the argv
 *   2. `PORT` env var
 *   3. The caller-supplied default
 *
 * Each role has its own sensible default (api → 9000, peerjs → 9001) so a
 * zero-config local dev `tsx server/api.ts && tsx server/peerjs.ts` works.
 */
export function parsePort(defaultPort: number): number {
  const argv = process.argv;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port' && i + 1 < argv.length) {
      const n = Number(argv[i + 1]);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  const env = Number(process.env.PORT);
  if (Number.isFinite(env) && env > 0) return env;
  return defaultPort;
}
