import jsQR from 'jsqr';

const ADDR_RE = /^[0-9a-fA-F]{64}$/;

/**
 * Pull a valid BrowserCoin address out of whatever a QR code decoded to.
 * Accepts both our own share links (`https://host/?to=<addr>`) and a bare
 * 64-hex address. Returns the address lowercased, or null if it isn't one.
 * Same validation rule the send form and `?to=` prefill use.
 */
export function parseScannedAddress(text: string): string | null {
  const raw = text.trim();
  let candidate = raw;
  try {
    const to = new URL(raw).searchParams.get('to');
    if (to) candidate = to.trim();
  } catch {
    // Not a URL — fall through and treat the whole string as the candidate.
  }
  return ADDR_RE.test(candidate) ? candidate.toLowerCase() : null;
}

let modalEl: HTMLElement | null = null;
let escListenerAttached = false;

function ensureModal(): HTMLElement {
  if (modalEl) return modalEl;
  modalEl = document.createElement('div');
  modalEl.className = 'qr-scanner';
  modalEl.innerHTML = `
    <div class="qr-scanner-card" data-w="card">
      <button class="qr-modal-close" data-w="close" aria-label="Close">×</button>
      <div class="qr-scanner-video-wrap">
        <video class="qr-scanner-video" data-w="video" playsinline muted></video>
        <div class="qr-scanner-frame"></div>
      </div>
      <div class="qr-scanner-caption" data-w="caption">Point your camera at a wallet QR code.</div>
    </div>
  `;
  document.body.appendChild(modalEl);
  return modalEl;
}

/**
 * Open a fullscreen camera modal and resolve with a scanned address (lowercased
 * 64-hex), or null if the user cancels, denies camera access, or no camera is
 * available. Decodes frames in-browser with jsQR — no third party involved.
 */
export function openScanner(): Promise<string | null> {
  const m = ensureModal();
  const video = m.querySelector<HTMLVideoElement>('[data-w="video"]')!;
  const captionEl = m.querySelector<HTMLElement>('[data-w="caption"]')!;
  captionEl.textContent = 'Point your camera at a wallet QR code.';
  captionEl.className = 'qr-scanner-caption';

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  return new Promise<string | null>((resolve) => {
    let stream: MediaStream | null = null;
    let rafId = 0;
    let settled = false;

    const cleanup = (): void => {
      cancelAnimationFrame(rafId);
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
      video.srcObject = null;
      m.classList.remove('open');
      m.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKey);
    };

    const finish = (addr: string | null): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(addr);
    };

    const onClick = (e: MouseEvent): void => {
      const t = e.target as HTMLElement;
      if (t === m || t.dataset['w'] === 'close') finish(null);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') finish(null);
    };

    m.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey);
    if (!escListenerAttached) escListenerAttached = true;
    m.classList.add('open');

    const tick = (): void => {
      if (settled) return;
      if (ctx && video.readyState === video.HAVE_ENOUGH_DATA) {
        const w = video.videoWidth;
        const h = video.videoHeight;
        if (w && h) {
          canvas.width = w;
          canvas.height = h;
          ctx.drawImage(video, 0, 0, w, h);
          const img = ctx.getImageData(0, 0, w, h);
          const result = jsQR(img.data, w, h, { inversionAttempts: 'dontInvert' });
          if (result) {
            const addr = parseScannedAddress(result.data);
            if (addr) {
              finish(addr);
              return;
            }
            // A QR that isn't a BrowserCoin address — keep scanning.
          }
        }
      }
      rafId = requestAnimationFrame(tick);
    };

    navigator.mediaDevices
      ?.getUserMedia({ video: { facingMode: 'environment' } })
      .then((s) => {
        if (settled) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = s;
        video.srcObject = s;
        return video.play();
      })
      .then(() => {
        if (!settled && stream) rafId = requestAnimationFrame(tick);
      })
      .catch(() => {
        captionEl.textContent = 'Camera unavailable — paste the address instead.';
        captionEl.className = 'qr-scanner-caption red';
      });
  });
}
