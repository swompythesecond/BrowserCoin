import QRCode from 'qrcode';
import jsQR from 'jsqr';
import type { Node } from '../node.js';
import { decodeCode } from '../net/signal/manual.js';

/**
 * The "connect with a code" card: two browsers meet by two people swapping a
 * short code, with nothing in between.
 *
 * Your code is ready the moment the card opens, as a QR and as text. Your
 * friend's code can be pasted, or read from a screenshot of their QR
 * (uploaded, dropped, or pasted with Ctrl+V). Whether it is an invite or a
 * reply is worked out from the code itself, so there is one box, not two.
 *
 * Invites travel as a link (`/settings?connect=<code>`): scanning one with a
 * phone camera opens the app with the code already filled in, and the reply
 * is ready without a single tap.
 */

/** Where invite links point when this copy runs from disk. */
const HOSTED_ORIGIN = 'https://browsercoin.org';
export const CONNECT_PARAM = 'connect';

export const MANUAL_CONNECT_HTML = `
  <div class="mc-grid">
    <div class="mc-col">
      <h4 data-mc="mine-title">1. Your code</h4>
      <p class="text-sm muted" data-mc="mine-hint">Let them scan the QR, or send them the link below.</p>
      <div class="mc-qr" data-mc="qr" aria-label="Your code as a QR code"></div>
      <textarea data-mc="mine-text" class="mono mc-text" rows="3" readonly aria-label="Your code as text" placeholder="Making your code…"></textarea>
      <div class="row">
        <button class="small" data-mc="copy" disabled>Copy link</button>
        <button class="ghost small" data-mc="share" hidden>Share</button>
      </div>
      <div class="text-sm muted mt-sm" data-mc="mine-msg">Making your code…</div>
    </div>
    <div class="mc-col" data-mc="theirs">
      <h4>2. Their code</h4>
      <p class="text-sm muted">Paste their code or link, or add a screenshot of their QR.</p>
      <textarea data-mc="their-in" class="mono mc-text" rows="3" placeholder="Paste here" autocomplete="off" spellcheck="false"></textarea>
      <div class="row">
        <label class="btn ghost small mc-file">Upload QR screenshot<input type="file" accept="image/*" data-mc="upload" hidden /></label>
        <button class="small" data-mc="go">Connect</button>
      </div>
      <p class="text-sm muted mt-sm">You can also drop an image here, or paste one with Ctrl+V.</p>
      <div class="text-sm mt-sm" data-mc="their-msg"></div>
    </div>
  </div>
`;

interface Mine {
  mode: 'invite' | 'reply';
  code: string;
  /** For a reply: whose invite it answers. */
  forPeer?: string;
}

/**
 * Wire the card. `startCode` is a code that arrived through an invite link;
 * it is answered as soon as the network is up. Returns the cleanup.
 */
export function mountManualConnect(card: HTMLElement, node: Node, startCode?: string): () => void {
  const q = <T extends HTMLElement = HTMLElement>(name: string): T =>
    card.querySelector<T>(`[data-mc="${name}"]`)!;
  const qrBox = q('qr');
  const mineTitle = q('mine-title');
  const mineHint = q('mine-hint');
  const mineText = q<HTMLTextAreaElement>('mine-text');
  const mineMsg = q('mine-msg');
  const copyBtn = q<HTMLButtonElement>('copy');
  const shareBtn = q<HTMLButtonElement>('share');
  const theirIn = q<HTMLTextAreaElement>('their-in');
  const theirMsg = q('their-msg');
  const theirCol = q('theirs');

  let mine: Mine | null = null;
  let busy = false;
  let making = false;
  let disposed = false;

  const linkBase = location.protocol === 'file:' ? HOSTED_ORIGIN : location.origin;
  const shareable = (m: Mine): string =>
    m.mode === 'invite' ? `${linkBase}/settings?${CONNECT_PARAM}=${m.code}` : m.code;

  const say = (el: HTMLElement, text: string, cls: 'green' | 'red' | 'muted'): void => {
    el.textContent = text;
    el.className = `text-sm mt-sm ${cls}`;
  };
  const net = () => node.network;

  async function showMine(m: Mine): Promise<void> {
    mine = m;
    const invite = m.mode === 'invite';
    mineTitle.textContent = invite ? '1. Your code' : '1. Send this back';
    mineHint.textContent = invite
      ? 'Let them scan the QR, or send them the link below.'
      : 'They scan the QR or paste the text into their page. You connect the moment they do.';
    copyBtn.textContent = invite ? 'Copy link' : 'Copy reply';
    copyBtn.disabled = false;
    shareBtn.hidden = typeof navigator.share !== 'function';
    mineText.value = shareable(m);
    try {
      qrBox.innerHTML = await QRCode.toString(shareable(m), {
        type: 'svg',
        margin: 1,
        errorCorrectionLevel: 'M',
        color: { dark: '#0d0f17', light: '#ffffff' },
      });
    } catch {
      qrBox.innerHTML = '';
    }
  }

  async function makeInvite(): Promise<void> {
    const n = net();
    if (making || disposed || !n?.manualReady()) return;
    making = true;
    copyBtn.disabled = true;
    say(mineMsg, 'Making your code…', 'muted');
    try {
      const code = n.currentManualInvite() ?? await n.createManualInvite();
      if (disposed) return;
      await showMine({ mode: 'invite', code });
      say(mineMsg, 'Ready. Waiting for the other person.', 'muted');
    } catch (e) {
      say(mineMsg, errorText(e), 'red');
    } finally {
      making = false;
    }
  }

  /** Accept a bare code, one with stray whitespace, or one of our invite links. */
  function extractCode(raw: string): string {
    const t = raw.trim();
    try {
      const c = new URL(t).searchParams.get(CONNECT_PARAM);
      if (c) return c.replace(/\s+/g, '');
    } catch { /* not a link */ }
    return t.replace(/\s+/g, '');
  }

  async function useTheirCode(raw: string): Promise<void> {
    const n = net();
    const code = extractCode(raw);
    if (!code || busy) return;
    if (!n?.manualReady()) return say(theirMsg, 'The network is still starting. Try again in a moment.', 'muted');
    const decoded = decodeCode(code);
    if (decoded === null) return say(theirMsg, "That doesn't look like a code. Copy the whole thing and try again.", 'red');
    if (decoded === 'incomplete') return say(theirMsg, 'That code looks cut off. Copy the whole thing and try again.', 'red');
    if (decoded === 'version') return say(theirMsg, 'That code comes from a newer version of browserCoin. Reload and try again.', 'red');
    if (decoded.peerId === n.getStatus().myId) return say(theirMsg, "That's your own code. The other person needs it, not you.", 'red');
    if (n.isConnectedTo(decoded.peerId)) return say(theirMsg, "You're already connected to them.", 'green');

    busy = true;
    try {
      if (/^a=setup:actpass$/m.test(decoded.sdp)) {
        // Their invite: answer it. The link opens once they use our reply.
        say(theirMsg, 'Making your reply…', 'muted');
        const reply = await n.acceptManualInvite(code);
        if (disposed) return;
        await showMine({ mode: 'reply', code: reply, forPeer: decoded.peerId });
        say(mineMsg, 'Waiting for them to use your reply.', 'muted');
        say(theirMsg, 'Got it. Now send your reply back to them.', 'green');
      } else {
        // Their reply to our invite: this finishes the handshake.
        if (mine?.mode !== 'invite' || !n.currentManualInvite()) {
          say(theirMsg, 'That is a reply code. Put it into the page that made the original code.', 'red');
          return;
        }
        say(theirMsg, 'Connecting…', 'muted');
        await n.completeManualInvite(code);
        say(theirMsg, 'Connected. You are on the network through them.', 'green');
        void makeInvite();
      }
      theirIn.value = '';
    } catch (e) {
      say(theirMsg, errorText(e), 'red');
      if (mine?.mode === 'invite' && !n.currentManualInvite()) void makeInvite();
    } finally {
      busy = false;
    }
  }

  async function useImage(file: Blob): Promise<void> {
    say(theirMsg, 'Reading the QR code…', 'muted');
    const text = await readQr(file).catch(() => null);
    if (!text) {
      say(theirMsg, "Couldn't find a QR code in that image. Try a sharper or closer screenshot.", 'red');
      return;
    }
    theirIn.value = text;
    void useTheirCode(text);
  }

  // ── Wiring ──────────────────────────────────────────────────────────────

  copyBtn.addEventListener('click', () => {
    if (!mine) return;
    void navigator.clipboard.writeText(shareable(mine)).then(() => {
      const old = copyBtn.textContent;
      copyBtn.textContent = 'Copied!';
      setTimeout(() => (copyBtn.textContent = old), 1200);
    }, () => { copyBtn.textContent = 'Copy failed'; });
  });
  shareBtn.addEventListener('click', () => {
    if (mine) void navigator.share({ text: shareable(mine) }).catch(() => { /* sheet closed */ });
  });
  // One tap selects the whole code, so copying by hand never grabs half of it.
  mineText.addEventListener('focus', () => mineText.select());
  mineText.addEventListener('click', () => mineText.select());

  q('go').addEventListener('click', () => void useTheirCode(theirIn.value));
  // A complete, valid code needs no button press.
  theirIn.addEventListener('input', () => {
    const d = decodeCode(extractCode(theirIn.value));
    if (d && typeof d === 'object') void useTheirCode(theirIn.value);
  });

  q<HTMLInputElement>('upload').addEventListener('change', (ev) => {
    const input = ev.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (file) void useImage(file);
  });
  theirCol.addEventListener('dragover', (ev) => { ev.preventDefault(); theirCol.classList.add('mc-drop'); });
  theirCol.addEventListener('dragleave', () => theirCol.classList.remove('mc-drop'));
  theirCol.addEventListener('drop', (ev) => {
    ev.preventDefault();
    theirCol.classList.remove('mc-drop');
    const file = [...(ev.dataTransfer?.files ?? [])].find((f) => f.type.startsWith('image/'));
    if (file) void useImage(file);
  });
  // A pasted screenshot anywhere on the page counts; pasted text goes where the caret is.
  const onPaste = (ev: ClipboardEvent): void => {
    const file = [...(ev.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'));
    if (!file) return;
    ev.preventDefault();
    void useImage(file);
  };
  document.addEventListener('paste', onPaste);

  // Polled rather than subscribed: the network may not exist yet when the card
  // mounts (the node boots on first visit). Each tick keeps a live code on
  // show, since invites expire, and notices when a reply we sent turned into
  // a link, since the joiner has no "connect" moment of its own.
  let started = false;
  const tick = (): void => {
    const n = net();
    if (!n?.manualReady()) return;
    if (!started) {
      started = true;
      if (startCode) {
        theirIn.value = startCode;
        card.scrollIntoView({ behavior: 'smooth', block: 'start' });
        void useTheirCode(startCode).then(() => { if (!mine) void makeInvite(); });
      } else {
        void makeInvite();
      }
      return;
    }
    if (mine?.mode === 'reply' && mine.forPeer && n.isConnectedTo(mine.forPeer)) {
      say(theirMsg, 'Connected. You are on the network through them.', 'green');
      mine = null;
      void makeInvite();
    } else if (mine?.mode === 'invite' && !busy && !n.currentManualInvite()) {
      void makeInvite();
    }
  };
  tick();
  const timer = setInterval(tick, 1000);

  return () => {
    disposed = true;
    clearInterval(timer);
    document.removeEventListener('paste', onPaste);
  };
}

/** Decode a QR from an image, trying a few sizes since screenshots vary wildly. */
async function readQr(file: Blob): Promise<string | null> {
  const bmp = await createImageBitmap(file);
  const tried = new Set<number>();
  for (const max of [1600, 3200, 800]) {
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    if (tried.has(w)) continue;
    tried.add(w);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bmp, 0, 0, w, h);
    const hit = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'attemptBoth' });
    if (hit?.data) return hit.data;
  }
  return null;
}

function errorText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)) || 'Something went wrong.';
}
