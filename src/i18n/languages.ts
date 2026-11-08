/**
 * The languages the UI ships in. Each one is labelled in its OWN script
 * ("中文", not "Chinese"), which is how someone who reads no English still
 * finds theirs in the picker. Flags are deliberately not used: a language is
 * not a country, and flag emoji render as bare letters on Windows.
 */
export interface Language {
  code: LangCode;
  /** The language's name in that language. */
  native: string;
  /** BCP-47 tag for <html lang>, which also picks the right CJK font. */
  htmlLang: string;
}

export type LangCode = 'en' | 'zh' | 'es' | 'hi' | 'fr';

export const LANGUAGES: readonly Language[] = [
  { code: 'en', native: 'English',  htmlLang: 'en' },
  { code: 'zh', native: '中文',      htmlLang: 'zh-CN' },
  { code: 'es', native: 'Español',  htmlLang: 'es' },
  { code: 'hi', native: 'हिन्दी',     htmlLang: 'hi' },
  { code: 'fr', native: 'Français', htmlLang: 'fr' },
];

export const LANG_KEY = 'browsercoin:lang';

export function isLangCode(v: unknown): v is LangCode {
  return LANGUAGES.some((l) => l.code === v);
}

/**
 * The saved choice if there is one, otherwise the first browser language we
 * support, otherwise English. Auto-detecting matters: a visitor who cannot read
 * English cannot read the picker's surroundings either.
 */
export function initialLang(): LangCode {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (isLangCode(saved)) return saved;
  } catch { /* storage blocked: fall through to detection */ }
  const prefs = navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const tag of prefs) {
    const base = (tag || '').toLowerCase().split('-')[0];
    if (isLangCode(base)) return base;
  }
  return 'en';
}
