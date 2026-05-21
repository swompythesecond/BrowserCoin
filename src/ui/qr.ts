import QRCode from 'qrcode';

/** Where the QR-share link points. Same origin as wherever the page is served. */
export function shareUrl(address: string): string {
  return `${window.location.origin}/?to=${address}`;
}

/**
 * Render a QR for the given address into `el`. Caches the last-rendered
 * address on the element itself so we don't redraw on every paint() call.
 */
export function renderAddressQr(el: HTMLElement, address: string): void {
  if (el.dataset['qrFor'] === address) return;
  el.dataset['qrFor'] = address;
  QRCode.toString(shareUrl(address), {
    type: 'svg',
    margin: 1,
    errorCorrectionLevel: 'M',
    color: { dark: '#0d0f17', light: '#ffffff' },
  }).then((svg) => {
    el.innerHTML = svg;
  }).catch(() => {
    el.innerHTML = '';
  });
}
