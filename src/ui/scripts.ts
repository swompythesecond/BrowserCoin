import type { Node } from '../node.js';
import { TICKER } from '../brand.js';
import { sha256 } from '../crypto/hash.js';
import { hashlockSigScript } from '../chain/scriptBuild.js';
import { bytesToHex, hexToBytes } from '../util/binary.js';
import { cardHeader } from './info.js';
import { scriptPanel } from './explorerScript.js';
import { OPCODE_REFERENCE } from '../chain/opcodeRef.js';

/**
 * The Scripts tab: a guided builder for hash-locked coins — create a lock that
 * only releases to whoever knows a secret, then redeem it by revealing that
 * secret. It's the friendly front-end to the Lock/Redeem consensus rules; every
 * action goes through the same `node` submission path as a normal send.
 */
export function mountScripts(host: HTMLElement, node: Node): () => void {
  const view = document.createElement('div');
  view.className = 'view';
  view.innerHTML = `
    <div class="view-header">
      <h2 class="view-title">Scripts</h2>
      <span class="view-sub">Lock coins behind a condition instead of a single key — then unlock them by satisfying it.</span>
    </div>

    <section class="card" data-mount="intro">
      <div data-slot="header"></div>
      <p class="text-sm muted" style="margin:0;">
        A <b>hash-locked payment</b> releases coins to one specific recipient — but only once they
        reveal a shared secret. It commits to both the secret's hash <em>and</em> the recipient's key,
        so the recipient must sign to claim. That signature binds the destination, so even though
        redeeming reveals the secret publicly, no one else can grab the coins. This is the building
        block behind atomic swaps.
      </p>
    </section>

    <div class="grid grid-12 mt-md">
      <section class="card col-6" data-mount="create">
        <div data-slot="header"></div>
        <label>Amount to lock (${TICKER})</label>
        <input data-w="c-amount" placeholder="1.0" />
        <label class="mt-sm">Recipient address (who may claim)</label>
        <input data-w="c-to" spellcheck="false" />
        <label class="mt-sm">Secret phrase</label>
        <div class="row">
          <input data-w="c-secret" placeholder="something only the right person knows" />
          <button class="ghost" data-w="c-rand">Random</button>
        </div>
        <label class="mt-sm">Fee (${TICKER})</label>
        <input data-w="c-fee" value="0.00001" />

        <div class="label-caps" style="margin:14px 0 6px;">script preview</div>
        <div data-w="c-preview"><span class="muted text-sm">Enter a secret to see the generated script.</span></div>

        <div class="row mt-md">
          <button data-w="c-go">Lock coins</button>
          <span data-w="c-msg" class="text-sm muted"></span>
        </div>
        <div data-w="c-result" class="text-sm mt-sm" hidden></div>
      </section>

      <section class="card col-6" data-mount="redeem">
        <div data-slot="header"></div>
        <label>Lock ID (the lock's transaction hash)</label>
        <input data-w="r-lock" placeholder="64 hex characters" spellcheck="false" />
        <label class="mt-sm">Secret phrase</label>
        <input data-w="r-secret" placeholder="the phrase the lock was created with" />
        <label class="mt-sm">Send to (address)</label>
        <input data-w="r-to" spellcheck="false" />
        <label class="mt-sm">Fee (${TICKER})</label>
        <input data-w="r-fee" value="0.00001" />

        <div class="row mt-md">
          <button data-w="r-go">Redeem</button>
          <span data-w="r-msg" class="text-sm muted"></span>
        </div>
      </section>
    </div>

    <section class="card mt-md" data-mount="raw">
      <div data-slot="header"></div>
      <div class="grid grid-12">
        <div class="col-6">
          <div class="label-caps" style="margin-bottom:8px;">Lock with a raw script</div>
          <div class="row" style="align-items:flex-end;">
            <div style="flex:1;min-width:0;"><label>Amount (${TICKER})</label><input data-w="raw-amount" placeholder="1.0" /></div>
            <div style="flex:1;min-width:0;"><label>Fee (${TICKER})</label><input data-w="raw-fee" value="0.00001" /></div>
          </div>
          <label class="mt-sm">Redeem script (hex)</label>
          <textarea data-w="raw-script" rows="3" spellcheck="false" placeholder="e.g. a820&lt;32-byte hash&gt;87"></textarea>
          <div data-w="raw-preview" class="mt-sm"></div>
          <div class="row mt-sm"><button data-w="raw-lock-go">Lock with raw script</button><span data-w="raw-lock-msg" class="text-sm muted"></span></div>
          <div data-w="raw-lock-result" class="text-sm mt-sm" hidden></div>
        </div>
        <div class="col-6">
          <div class="label-caps" style="margin-bottom:8px;">Redeem with a raw script</div>
          <label>Lock ID</label><input data-w="raw-lockid" spellcheck="false" placeholder="64 hex characters" />
          <label class="mt-sm">Redeem script (hex)</label><textarea data-w="raw-rscript" rows="2" spellcheck="false"></textarea>
          <label class="mt-sm">Witness — one hex push per line</label><textarea data-w="raw-witness" rows="3" spellcheck="false" placeholder="one push per line (hex); leave empty if the script needs no inputs"></textarea>
          <label class="mt-sm">Send to (address)</label><input data-w="raw-to" spellcheck="false" />
          <label class="mt-sm">Fee (${TICKER})</label><input data-w="raw-rfee" value="0.00001" />
          <div class="row mt-sm"><button data-w="raw-redeem-go">Redeem with raw script</button><span data-w="raw-redeem-msg" class="text-sm muted"></span></div>
        </div>
      </div>
    </section>

    <section class="card mt-md" data-mount="ref">
      <div data-slot="header"></div>
      <div data-w="ref-body"></div>
    </section>
  `;
  host.appendChild(view);

  const slot = (key: string, header: HTMLElement): void => {
    view.querySelector<HTMLElement>(`[data-mount="${key}"] [data-slot="header"]`)!.replaceWith(header);
  };
  slot('intro', cardHeader({
    title: 'Hash-locked payments',
    info: {
      title: 'What is a script?',
      body: `Normally a coin is guarded by one key. A script guards it with a small program. A hash-locked payment requires two things to claim: the recipient's signature AND a shared secret. The signature is what makes it safe — it binds the spend to the recipient, so revealing the secret on-chain doesn't let anyone else grab the coins. (A "bare" hash lock with no signature is front-runnable; it lives only in the Advanced section, marked demonstration-only.)`,
    },
  }));
  slot('create', cardHeader({
    title: 'Create a hash-locked payment',
    info: {
      title: 'Locking coins',
      body: `Pick an amount, the recipient's address, and a secret phrase. The lock commits to the secret's hash and the recipient's key. Only that recipient can claim, and only once they know the secret. Keep the secret safe — there's no recovery, but note a wrong recipient can never claim it either.`,
    },
  }));
  slot('redeem', cardHeader({
    title: 'Redeem a hash-locked payment',
    info: {
      title: 'Unlocking coins',
      body: `Paste the lock's ID, the secret phrase, and where to send the coins. Your node rebuilds the script from the secret + your own key, signs the spend (which binds the destination), and broadcasts it. Only the wallet the lock was addressed to can succeed.`,
    },
  }));
  slot('raw', cardHeader({
    title: 'Advanced — raw scripts',
    info: {
      title: 'Hand-written scripts',
      body: `For power users: paste a redeem script as raw hex to lock coins under any condition, then redeem by revealing the same script plus a witness (the stack inputs that satisfy it, one push per line). See the opcode reference below to write your own.`,
    },
  }));
  slot('ref', cardHeader({
    title: 'Opcode reference',
    info: {
      title: 'The script vocabulary',
      body: `Every opcode the interpreter understands, grouped by purpose. A script is just a list of these run on a small stack machine; it succeeds if it finishes with a true value on top.`,
    },
  }));

  const $ = <T extends HTMLElement = HTMLElement>(w: string): T => view.querySelector<T>(`[data-w="${w}"]`)!;

  // ----- Create -----
  const cAmount = $<HTMLInputElement>('c-amount');
  const cTo = $<HTMLInputElement>('c-to');
  const cSecret = $<HTMLInputElement>('c-secret');
  const cFee = $<HTMLInputElement>('c-fee');
  const cPreview = $('c-preview');
  const cMsg = $('c-msg');
  const cResult = $('c-result');
  cTo.value = node.wallet.address; // default: a lock you can redeem yourself (handy for testing)

  /** The secret preimage derived from a phrase (SHA-256 of the UTF-8 text). */
  function preimageOf(phrase: string): Uint8Array {
    return sha256(new TextEncoder().encode(phrase));
  }
  /** The hash-locked-payment script binding the secret to a recipient's key. */
  function scriptFor(phrase: string, recipient: Uint8Array): Uint8Array {
    return hashlockSigScript(sha256(preimageOf(phrase)), recipient);
  }

  function renderPreview(): void {
    const phrase = cSecret.value;
    const to = cTo.value.trim().toLowerCase();
    if (!phrase || !/^[0-9a-f]{64}$/.test(to)) {
      cPreview.innerHTML = `<span class="muted text-sm">Enter a recipient address and a secret to see the generated script.</span>`;
      return;
    }
    cPreview.innerHTML = scriptPanel(scriptFor(phrase, hexToBytes(to)));
  }

  cSecret.addEventListener('input', renderPreview);
  cTo.addEventListener('input', renderPreview);
  $('c-rand').addEventListener('click', () => {
    const r = new Uint8Array(12);
    crypto.getRandomValues(r);
    cSecret.value = bytesToHex(r);
    renderPreview();
  });

  $('c-go').addEventListener('click', () => {
    cMsg.textContent = '';
    cResult.hidden = true;
    const phrase = cSecret.value.trim();
    const to = cTo.value.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(to)) { cMsg.textContent = 'Enter a valid 64-hex recipient address.'; cMsg.className = 'text-sm red'; return; }
    if (!phrase) { cMsg.textContent = 'Enter a secret phrase.'; cMsg.className = 'text-sm red'; return; }
    const res = node.lock(cAmount.value.trim(), cFee.value.trim(), scriptFor(phrase, hexToBytes(to)));
    if (typeof res === 'string') { cMsg.textContent = res; cMsg.className = 'text-sm red'; return; }
    cMsg.textContent = 'Locked! Mining will confirm it shortly.';
    cMsg.className = 'text-sm green';
    cResult.hidden = false;
    cResult.innerHTML = `Lock ID (share with the recipient): <span class="hash">${res.lockId}</span><br>
      <span class="muted">Only the recipient's wallet can claim it, using the secret — the signed spend can't be front-run.</span>`;
    // Pre-fill the redeem form so the round-trip is one click away (works here because
    // the recipient defaults to your own address).
    rLock.value = res.lockId;
    rSecret.value = phrase;
  });

  // ----- Redeem -----
  const rLock = $<HTMLInputElement>('r-lock');
  const rSecret = $<HTMLInputElement>('r-secret');
  const rTo = $<HTMLInputElement>('r-to');
  const rFee = $<HTMLInputElement>('r-fee');
  const rMsg = $('r-msg');
  rTo.value = node.wallet.address; // default: redeem to yourself

  $('r-go').addEventListener('click', () => {
    rMsg.className = 'text-sm muted';
    const lockId = rLock.value.trim().toLowerCase();
    const phrase = rSecret.value.trim();
    const to = rTo.value.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(lockId)) { rMsg.textContent = 'Lock ID must be 64 hex characters.'; rMsg.className = 'text-sm red'; return; }
    if (!phrase) { rMsg.textContent = 'Enter the secret phrase.'; rMsg.className = 'text-sm red'; return; }
    if (!/^[0-9a-f]{64}$/.test(to)) { rMsg.textContent = 'Recipient must be a 64-hex address.'; rMsg.className = 'text-sm red'; return; }
    // Your node reconstructs the script from the secret + your own key and signs
    // the spend, so the redeem is bound to you and can't be front-run.
    const err = node.redeemHashlock(lockId, preimageOf(phrase), hexToBytes(to), rFee.value.trim());
    if (err) { rMsg.textContent = err; rMsg.className = 'text-sm red'; return; }
    rMsg.textContent = 'Redeem submitted! It will pay out once mined.';
    rMsg.className = 'text-sm green';
  });

  // ----- Advanced: raw scripts -----
  /** Parse a hex string (whitespace allowed) into bytes, or null if malformed. */
  function parseHex(s: string): Uint8Array | null {
    const clean = s.trim().toLowerCase().replace(/\s+/g, '');
    if (clean.length % 2 !== 0 || !/^[0-9a-f]*$/.test(clean)) return null;
    return hexToBytes(clean);
  }

  const rawScript = $<HTMLTextAreaElement>('raw-script');
  const rawPreview = $('raw-preview');
  const rawLockMsg = $('raw-lock-msg');
  const rawLockResult = $('raw-lock-result');

  function renderRawPreview(): void {
    const bytes = parseHex(rawScript.value);
    if (rawScript.value.trim() === '') { rawPreview.innerHTML = ''; return; }
    rawPreview.innerHTML = bytes ? scriptPanel(bytes) : `<span class="text-sm red">Not valid hex.</span>`;
  }
  rawScript.addEventListener('input', renderRawPreview);

  $('raw-lock-go').addEventListener('click', () => {
    rawLockResult.hidden = true;
    rawLockMsg.className = 'text-sm muted';
    const bytes = parseHex(rawScript.value);
    if (!bytes || bytes.length === 0) { rawLockMsg.textContent = 'Enter a redeem script as hex.'; rawLockMsg.className = 'text-sm red'; return; }
    const res = node.lock($<HTMLInputElement>('raw-amount').value.trim(), $<HTMLInputElement>('raw-fee').value.trim(), bytes);
    if (typeof res === 'string') { rawLockMsg.textContent = res; rawLockMsg.className = 'text-sm red'; return; }
    rawLockMsg.textContent = 'Locked!';
    rawLockMsg.className = 'text-sm green';
    rawLockResult.hidden = false;
    rawLockResult.innerHTML = `Lock ID: <span class="hash">${res.lockId}</span>`;
  });

  const rawRedeemMsg = $('raw-redeem-msg');
  $<HTMLInputElement>('raw-to').value = node.wallet.address;
  $('raw-redeem-go').addEventListener('click', () => {
    rawRedeemMsg.className = 'text-sm muted';
    const lockId = $<HTMLInputElement>('raw-lockid').value.trim().toLowerCase();
    const to = $<HTMLInputElement>('raw-to').value.trim().toLowerCase();
    const script = parseHex($<HTMLTextAreaElement>('raw-rscript').value);
    if (!/^[0-9a-f]{64}$/.test(lockId)) { rawRedeemMsg.textContent = 'Lock ID must be 64 hex characters.'; rawRedeemMsg.className = 'text-sm red'; return; }
    if (!script || script.length === 0) { rawRedeemMsg.textContent = 'Enter the redeem script as hex.'; rawRedeemMsg.className = 'text-sm red'; return; }
    if (!/^[0-9a-f]{64}$/.test(to)) { rawRedeemMsg.textContent = 'Recipient must be a 64-hex address.'; rawRedeemMsg.className = 'text-sm red'; return; }
    const witness: Uint8Array[] = [];
    for (const line of $<HTMLTextAreaElement>('raw-witness').value.split('\n')) {
      if (line.trim() === '') continue;
      const item = parseHex(line);
      if (!item) { rawRedeemMsg.textContent = `Witness line is not valid hex: "${line.trim()}"`; rawRedeemMsg.className = 'text-sm red'; return; }
      witness.push(item);
    }
    const err = node.redeem(lockId, hexToBytes(to), $<HTMLInputElement>('raw-rfee').value.trim(), script, witness);
    if (err) { rawRedeemMsg.textContent = err; rawRedeemMsg.className = 'text-sm red'; return; }
    rawRedeemMsg.textContent = 'Redeem submitted!';
    rawRedeemMsg.className = 'text-sm green';
  });

  // ----- Opcode reference -----
  $('ref-body').innerHTML = OPCODE_REFERENCE.map((g) => `
    <div style="margin-top:14px;">
      <div class="label-caps">${g.title}</div>
      ${g.note ? `<p class="text-sm muted" style="margin:4px 0 6px;">${g.note}</p>` : ''}
      <div class="table-scroll"><table class="table">
        <tbody>${g.ops.map((o) => `<tr>
          <td class="mono" style="white-space:nowrap;">${o.name}</td>
          <td class="mono muted" style="white-space:nowrap;">${o.hex}</td>
          <td class="text-sm">${o.desc}</td>
        </tr>`).join('')}</tbody>
      </table></div>
    </div>`).join('');

  return () => { /* no timers/subscriptions to clean up */ };
}
