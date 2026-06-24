/**
 * Explorer rendering for script (Lock / Redeem) transactions. Reuses the pure
 * disassembler/explainer in `chain/scriptDisasm.ts` so the block view, tx
 * detail view and (later) the builder all describe scripts the same way.
 */
import { txKind, isLock, isRedeem, TxKind, type Transaction } from '../chain/transaction.js';
import { disassemble, explainScript } from '../chain/scriptDisasm.js';
import { bytesToHex } from '../util/binary.js';
import { formatAmount } from '../node.js';
import { TICKER } from '../brand.js';
import { addressLink, txLink } from './explorerShared.js';

/** Plain label for a tx kind. */
export function kindLabel(tx: Transaction): string {
  switch (txKind(tx)) {
    case TxKind.Lock: return 'Lock';
    case TxKind.Redeem: return 'Redeem';
    default: return 'Transfer';
  }
}

/** Small coloured badge for a tx kind ('' for a plain transfer to avoid noise). */
export function kindBadge(tx: Transaction): string {
  if (isLock(tx)) {
    return `<span class="badge" style="background:#7a5b12;border-color:#7a5b12;color:#fff;" title="Locks coins under a spending script (revealed when redeemed).">Lock</span>`;
  }
  if (isRedeem(tx)) {
    return `<span class="badge" style="background:#1f6f43;border-color:#1f6f43;color:#fff;" title="Spends a locked output by satisfying its script.">Redeem</span>`;
  }
  return '';
}

/**
 * Kind-aware "from → to" cell content for the compact tx tables. A Lock has no
 * recipient (coins go into a script); a Redeem has no signed sender (it's
 * authorised by a witness), so we show the script flow instead.
 */
export function flowCells(tx: Transaction): { from: string; to: string } {
  if (isLock(tx)) {
    return { from: addressLink(bytesToHex(tx.from)), to: `<span class="muted">script ${shortHex(tx.scriptHash)}</span>` };
  }
  if (isRedeem(tx)) {
    return { from: `<span class="muted">lock ${shortHex(tx.lockId)}</span>`, to: addressLink(bytesToHex(tx.to)) };
  }
  return { from: addressLink(bytesToHex(tx.from)), to: addressLink(bytesToHex(tx.to)) };
}

/**
 * Reusable card fragment that explains a redeem script: the one-line plain
 * summary plus the full opcode disassembly. Also used by the script builder.
 */
export function scriptPanel(script: Uint8Array): string {
  const exp = explainScript(script);
  const asm = disassemble(script);
  return `
    <div class="script-panel" style="border:1px solid var(--border);border-radius:8px;padding:12px 14px;background:var(--surface);">
      <div class="row" style="gap:8px;align-items:center;">
        <span class="badge" style="background:#33415c;border-color:#33415c;color:#fff;">${exp.title}</span>
        <span class="text-sm">${exp.summary}</span>
      </div>
      <div class="label-caps" style="margin:12px 0 4px;">script (${script.length} bytes)</div>
      <ol class="mono text-sm" style="margin:0;padding-left:22px;line-height:1.6;">
        ${asm.map((line) => `<li>${escapeAsm(line)}</li>`).join('')}
      </ol>
    </div>`;
}

/** The witness (stack inputs) a redeem supplied to satisfy its script. */
export function witnessPanel(witness: Uint8Array[] | undefined): string {
  const items = witness ?? [];
  if (items.length === 0) return `<span class="muted text-sm">none (script needs no inputs)</span>`;
  return `<ol class="mono text-sm" style="margin:0;padding-left:22px;line-height:1.6;">
    ${items.map((w) => `<li>${w.length === 0 ? '<span class="muted">∅ (empty)</span>' : escapeAsm(`${bytesToHex(w).slice(0, 40)}${w.length > 20 ? '…' : ''} (${w.length}B)`)}</li>`).join('')}
  </ol>`;
}

/**
 * The kind-specific rows for the tx **detail** view. Returns the inner HTML of a
 * `<dl class="kv">` plus any trailing script/witness cards, or null for a plain
 * transfer (caller renders the existing transfer layout).
 */
export function scriptTxDetail(tx: Transaction): string | null {
  if (isLock(tx)) {
    return `
      <dl class="kv">
        <dt>type</dt><dd>${kindBadge(tx)} <span class="muted">locks coins under a script</span></dd>
        <dt>locker</dt><dd>${addressLink(bytesToHex(tx.from), bytesToHex(tx.from))}</dd>
        <dt>amount locked</dt><dd>${formatAmount(tx.amount)} ${TICKER}</dd>
        <dt>fee</dt><dd>${formatAmount(tx.fee)} ${TICKER}</dd>
        <dt>nonce</dt><dd>${tx.nonce}</dd>
        <dt>script hash</dt><dd class="hash">${bytesToHex(tx.scriptHash ?? new Uint8Array())}</dd>
      </dl>
      <p class="muted text-sm mt-md">The spending conditions are committed as a hash and stay hidden until someone redeems this lock — at which point the full script is revealed and checked.</p>`;
  }
  if (isRedeem(tx)) {
    const lockHex = bytesToHex(tx.lockId ?? new Uint8Array());
    return `
      <dl class="kv">
        <dt>type</dt><dd>${kindBadge(tx)} <span class="muted">spends a locked output</span></dd>
        <dt>spends lock</dt><dd>${txLink(lockHex, lockHex)}</dd>
        <dt>recipient</dt><dd>${addressLink(bytesToHex(tx.to), bytesToHex(tx.to))}</dd>
        <dt>amount</dt><dd>${formatAmount(tx.amount)} ${TICKER}</dd>
        <dt>fee</dt><dd>${formatAmount(tx.fee)} ${TICKER}</dd>
      </dl>
      <div class="label-caps" style="margin:16px 0 6px;">revealed script</div>
      ${scriptPanel(tx.redeemScript ?? new Uint8Array())}
      <div class="label-caps" style="margin:16px 0 6px;">witness (inputs that satisfy it)</div>
      ${witnessPanel(tx.witness)}`;
  }
  return null;
}

function shortHex(b: Uint8Array | undefined): string {
  if (!b || b.length === 0) return '—';
  return bytesToHex(b).slice(0, 10) + '…';
}

/** Disassembly strings are derived from our own bytes, but escape defensively. */
function escapeAsm(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
