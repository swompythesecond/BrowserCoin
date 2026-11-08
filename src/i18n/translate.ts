/**
 * DOM-level translation.
 *
 * The views build their markup in English, inline, all over src/ui. Rather than
 * rewrite every one of them around `t('key')` calls, this module watches the
 * document and swaps any text node (and title / placeholder / aria-label) whose
 * English text appears in the active dictionary. English stays the source of
 * truth and the key: an untranslated string simply stays English.
 *
 * Dictionary keys are the English text with whitespace collapsed. A key may
 * contain `{name}` placeholders ("height {n}"); those become patterns that match
 * dynamic strings, and the captured values are substituted into the
 * translation.
 *
 * Anything inside `code`, `pre`, `textarea`, `[translate="no"]` or `.notranslate`
 * is left alone, as is text with no letters in it (numbers, hashes, symbols).
 */
import { LANGUAGES, LANG_KEY, initialLang, type LangCode } from './languages.js';

export type Dict = Record<string, string>;

interface Compiled {
  exact: Map<string, string>;
  patterns: { re: RegExp; names: string[]; out: string }[];
}

const loaders: Record<Exclude<LangCode, 'en'>, () => Promise<{ default: Dict }>> = {
  zh: () => import('./dict/zh.js'),
  es: () => import('./dict/es.js'),
  hi: () => import('./dict/hi.js'),
  fr: () => import('./dict/fr.js'),
};

const ATTRS = ['title', 'placeholder', 'aria-label'] as const;
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'CODE', 'PRE', 'TEXTAREA', 'NOSCRIPT', 'SVG']);
const HAS_LETTER = /\p{L}/u;
const NUM = "([+\\-−]?\\d(?:[\\d.,'\\u00a0\\u202f ]*\\d)?(?: ?[kKMGTP])?%?)";

let lang: LangCode = 'en';
let active: Compiled | null = null;
const compiled = new Map<LangCode, Compiled>();
/** translated text -> English, across every loaded language, for switching back. */
const reverse = new Map<string, string>();
/** Original English of nodes we rewrote, for strings matched by a pattern. */
const textOrig = new WeakMap<Text, { en: string; out: string }>();
const attrOrig = new WeakMap<Element, Map<string, { en: string; out: string }>>();
const listeners = new Set<(l: LangCode) => void>();
let observer: MutationObserver | null = null;

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();

function compile(dict: Dict): Compiled {
  const exact = new Map<string, string>();
  const patterns: Compiled['patterns'] = [];
  for (const [rawKey, out] of Object.entries(dict)) {
    const key = norm(rawKey);
    if (!out) continue;
    reverse.set(norm(out), key);
    if (!/\{\w+\}/.test(key)) { exact.set(key, out); continue; }
    const names: string[] = [];
    const src = key.split(/(\{\w+\})/).map((part) => {
      const m = /^\{(\w+)\}$/.exec(part);
      if (!m) return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      names.push(m[1]!);
      // `{n…}` only matches a number (with locale grouping and an optional
      // k/M/G suffix), so "{n} blocks" cannot swallow "Recent blocks".
      return m[1]!.startsWith('n') ? NUM : '(.+?)';
    }).join('');
    patterns.push({ re: new RegExp(`^${src}$`, 's'), names, out });
  }
  // Longest keys first, so "{n} blocks remaining" beats "{n}".
  patterns.sort((a, b) => b.re.source.length - a.re.source.length);
  return { exact, patterns };
}

/** English text -> active-language text, or null when there is nothing to do. */
function lookup(en: string): string | null {
  if (!active || !en || !HAS_LETTER.test(en)) return null;
  const hit = active.exact.get(en);
  if (hit !== undefined) return hit;
  for (const p of active.patterns) {
    const m = p.re.exec(en);
    if (!m) continue;
    let out = p.out;
    p.names.forEach((name, i) => {
      const val = m[i + 1]!;
      // A captured value can itself be a translatable phrase ("status: {s}").
      out = out.split(`{${name}}`).join(lookup(val) ?? val);
    });
    return out;
  }
  return null;
}

function skipped(el: Element | null): boolean {
  for (let e = el; e; e = e.parentElement) {
    if (SKIP_TAGS.has(e.tagName.toUpperCase())) return true;
    if (e.getAttribute('translate') === 'no' || e.classList.contains('notranslate')) return true;
  }
  return false;
}

/** Recover the English behind whatever a node currently says. */
function englishOf(current: string, rec: { en: string; out: string } | undefined): string {
  const n = norm(current);
  if (rec && n === norm(rec.out)) return rec.en;
  return reverse.get(n) ?? n;
}

function translateText(node: Text): void {
  const data = node.data;
  if (!HAS_LETTER.test(data)) return;
  const en = englishOf(data, textOrig.get(node));
  const out = lookup(en) ?? en;
  if (norm(data) === norm(out)) return;
  const lead = /^\s*/.exec(data)![0];
  const trail = /\s*$/.exec(data)![0];
  textOrig.set(node, { en, out });
  node.data = lead + out + trail;
}

function translateAttrs(el: Element): void {
  for (const a of ATTRS) {
    const cur = el.getAttribute(a);
    if (!cur || !HAS_LETTER.test(cur)) continue;
    let recs = attrOrig.get(el);
    const en = englishOf(cur, recs?.get(a));
    const out = lookup(en) ?? en;
    if (norm(cur) === norm(out)) continue;
    if (!recs) { recs = new Map(); attrOrig.set(el, recs); }
    recs.set(a, { en, out });
    el.setAttribute(a, out);
  }
}

function translateTree(root: Node): void {
  if (root.nodeType === Node.TEXT_NODE) {
    if (!skipped(root.parentElement)) translateText(root as Text);
    return;
  }
  if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
  if (root.nodeType === Node.ELEMENT_NODE && skipped(root as Element)) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (n.nodeType === Node.ELEMENT_NODE) {
        const el = n as Element;
        if (SKIP_TAGS.has(el.tagName.toUpperCase())) return NodeFilter.FILTER_REJECT;
        if (el.getAttribute('translate') === 'no' || el.classList.contains('notranslate')) return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  if (root.nodeType === Node.ELEMENT_NODE) translateAttrs(root as Element);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) translateText(n as Text);
    else translateAttrs(n as Element);
  }
}

function startObserver(): void {
  if (observer) return;
  observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'childList') r.addedNodes.forEach((n) => translateTree(n));
      else if (r.type === 'characterData') translateTree(r.target);
      else if (r.type === 'attributes' && r.target.nodeType === Node.ELEMENT_NODE && !skipped(r.target as Element)) {
        translateAttrs(r.target as Element);
      }
    }
  });
  observer.observe(document.body, {
    childList: true, subtree: true, characterData: true,
    attributes: true, attributeFilter: [...ATTRS],
  });
}

export function currentLang(): LangCode {
  return lang;
}

export function onLangChange(cb: (l: LangCode) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * Switch language. `remember` is true only for an explicit pick in the menu:
 * an auto-detected language is never saved, so it keeps following the
 * browser's language until the person chooses one themselves.
 */
export async function setLang(next: LangCode, remember = false): Promise<void> {
  if (next !== 'en' && !compiled.has(next)) {
    try {
      compiled.set(next, compile((await loaders[next]()).default));
    } catch (e) {
      console.warn('[i18n] could not load', next, e);
      return;
    }
  }
  lang = next;
  active = next === 'en' ? null : compiled.get(next)!;
  if (remember) {
    try { localStorage.setItem(LANG_KEY, next); } catch { /* not persisted, still applied */ }
  }
  document.documentElement.lang = LANGUAGES.find((l) => l.code === next)!.htmlLang;
  // One pass over everything rewrites the page in place, in either direction:
  // English recovery goes through `reverse` and the per-node records.
  translateTree(document.body);
  startObserver();
  for (const cb of listeners) cb(next);
}

/** Boot: pick the saved or detected language and start translating. */
export function initI18n(): Promise<void> {
  return setLang(initialLang());
}

/**
 * Translate a string from code, for the rare text that never lands in the DOM
 * (confirm() dialogs, document.title).
 */
export function tr(en: string): string {
  return lookup(norm(en)) ?? en;
}
