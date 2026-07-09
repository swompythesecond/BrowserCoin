/**
 * HTTP fan-out helpers shared by ServerSync (chain backup) and PeerNetwork
 * (heartbeat, /peers discovery). Implements the read/write asymmetry the
 * multi-server design needs:
 *
 *   • Reads are health-ordered + first-success. Servers that recently failed
 *     drop to the back of the queue so we don't keep hitting a dead box on
 *     every read. The first server to return a 2xx response wins.
 *
 *   • Writes are parallel fan-out via Promise.allSettled. We POST to every
 *     server simultaneously and report back how many ACK'd. A slow/dead server
 *     never blocks a write — we don't wait on it.
 *
 * Health state lives at module scope, keyed by URL, so ServerSync and
 * PeerNetwork share the same ordering signal. This keeps a dead server from
 * being tried first by one subsystem after another subsystem already proved
 * it's unreachable.
 */

interface ServerHealth {
  lastSuccessMs: number;
  lastFailureMs: number;
}

const HEALTH = new Map<string, ServerHealth>();
/**
 * After this much time, a previously-failed server is treated as "unknown"
 * again and tried before truly-failed ones. Prevents permanent demotion from
 * a transient blip.
 */
const FAIL_AMNESIA_MS = 60_000;

function markSuccess(url: string): void {
  const h = HEALTH.get(url) ?? { lastSuccessMs: 0, lastFailureMs: 0 };
  h.lastSuccessMs = Date.now();
  HEALTH.set(url, h);
}

function markFailure(url: string): void {
  const h = HEALTH.get(url) ?? { lastSuccessMs: 0, lastFailureMs: 0 };
  h.lastFailureMs = Date.now();
  HEALTH.set(url, h);
}

/**
 * Public mark helpers for callers that do their own `fetch` outside the
 * fan-out helpers (e.g. ServerSync.getServerTip parallel-races every /tip).
 * Without these, that first-contact request succeeds silently and the next
 * `reachableCount` still returns 0.
 */
export function noteSuccess(url: string): void { markSuccess(url); }
export function noteFailure(url: string): void { markFailure(url); }

/**
 * Order: recently-successful first (newest success first), then unknown
 * servers, then recently-failed (oldest failure first — most likely to be
 * recovered).
 */
function healthOrder(urls: string[]): string[] {
  const now = Date.now();
  return [...urls].sort((a, b) => score(b) - score(a));

  function score(url: string): number {
    const h = HEALTH.get(url);
    if (!h) return 0; // unknown — between fresh-fail and any success
    const recentFail = now - h.lastFailureMs < FAIL_AMNESIA_MS && h.lastFailureMs > h.lastSuccessMs;
    if (recentFail) {
      // Negative score; older failures less negative (more likely recovered).
      return -1 - (now - h.lastFailureMs) / 1000;
    }
    // Positive score; newer successes higher.
    return 1_000_000 - (now - h.lastSuccessMs) / 1000;
  }
}

export function reachableCount(urls: string[]): number {
  const now = Date.now();
  let n = 0;
  for (const u of urls) {
    const h = HEALTH.get(u);
    if (!h) continue;
    if (h.lastSuccessMs >= h.lastFailureMs) n++;
    else if (now - h.lastFailureMs > FAIL_AMNESIA_MS) n++;
  }
  return n;
}

/**
 * Walk the server list in health order, return the first one that responds
 * 2xx and whose `parse` succeeds. Returns null if every server fails.
 * Each per-server attempt is wrapped in try/catch so a network error on one
 * doesn't poison the iteration.
 */
export async function tryRead<T>(
  servers: string[],
  path: string,
  parse: (r: Response) => Promise<T>,
): Promise<T | null> {
  for (const base of healthOrder(servers)) {
    try {
      const r = await fetch(new URL(path, base).toString());
      if (!r.ok) { markFailure(base); continue; }
      const value = await parse(r);
      markSuccess(base);
      return value;
    } catch {
      markFailure(base);
    }
  }
  return null;
}

/**
 * POST to every server in parallel. Returns the number that ACK'd (status
 * 2xx). Never throws — individual failures are swallowed and counted as
 * "didn't ack." Slow servers don't slow down successful ones.
 */
export async function fanoutWrite(
  servers: string[],
  path: string,
  body: BodyInit | null,
  headers: HeadersInit = { 'Content-Type': 'application/json' },
): Promise<number> {
  const results = await Promise.allSettled(
    servers.map(async (base) => {
      try {
        const r = await fetch(new URL(path, base).toString(), {
          method: 'POST',
          headers,
          body,
        });
        if (r.ok) { markSuccess(base); return true; }
        markFailure(base);
        return false;
      } catch {
        markFailure(base);
        return false;
      }
    }),
  );
  return results.reduce(
    (acc, r) => acc + (r.status === 'fulfilled' && r.value ? 1 : 0),
    0,
  );
}

/**
 * Read a response body as JSON, aborting if it exceeds `maxBytes`. Unlike
 * `response.json()` — which buffers the entire body before we can react — this
 * streams and bails the moment the cap is crossed, so a hostile helper can't
 * OOM the tab with a giant payload. Falls back to `response.json()` when the
 * runtime has no streaming body (e.g. jsdom in tests).
 */
export async function readJsonCapped(response: Response, maxBytes: number): Promise<unknown> {
  const body = response.body;
  if (!body || typeof body.getReader !== 'function') return response.json();

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) throw new Error('helper response too large');
      chunks.push(value);
    }
  } finally {
    try { await reader.cancel(); } catch { /* already drained */ }
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(merged));
}

/**
 * Variant of fanoutWrite that returns one result *per* server (with which
 * server it came from). Used when the caller needs to act on each response —
 * e.g. ServerSync's block push needs to know if a server flagged "orphan,
 * parent needed" so it can resend the parent first.
 */
export async function fanoutWriteWith<T>(
  servers: string[],
  path: string,
  body: BodyInit | null,
  parse: (r: Response) => Promise<T>,
  headers: HeadersInit = { 'Content-Type': 'application/json' },
): Promise<Array<{ server: string; ok: boolean; value: T | null }>> {
  const out = await Promise.allSettled(
    servers.map(async (base) => {
      try {
        const r = await fetch(new URL(path, base).toString(), {
          method: 'POST',
          headers,
          body,
        });
        if (!r.ok) { markFailure(base); return { server: base, ok: false, value: null as T | null }; }
        markSuccess(base);
        return { server: base, ok: true, value: await parse(r) };
      } catch {
        markFailure(base);
        return { server: base, ok: false, value: null as T | null };
      }
    }),
  );
  return out.map((r) =>
    r.status === 'fulfilled'
      ? r.value
      : { server: '', ok: false, value: null },
  );
}
