/**
 * The language picker in the top bar: a globe icon (recognisable without
 * reading anything) over a native <select> whose options are each language's
 * own name in its own script. A native select also gets the phone's built-in
 * picker for free.
 */
import { LANGUAGES, isLangCode } from './languages.js';
import { currentLang, onLangChange, setLang } from './translate.js';

const GLOBE = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9.5"/><path d="M2.5 12h19M12 2.5c2.6 2.6 4 6 4 9.5s-1.4 6.9-4 9.5c-2.6-2.6-4-6-4-9.5s1.4-6.9 4-9.5Z"/></svg>`;

export function mountLangPicker(host: HTMLElement): void {
  const wrap = document.createElement('label');
  wrap.className = 'lang-picker';
  wrap.setAttribute('translate', 'no');
  wrap.title = 'Language / 语言 / Idioma / भाषा / Langue';
  wrap.innerHTML = `${GLOBE}<select aria-label="Language / 语言 / Idioma / भाषा / Langue">${
    LANGUAGES.map((l) => `<option value="${l.code}" lang="${l.htmlLang}">${l.native}</option>`).join('')
  }</select>`;
  const select = wrap.querySelector('select')!;
  select.value = currentLang();
  select.addEventListener('change', () => {
    if (isLangCode(select.value)) void setLang(select.value, true);
  });
  onLangChange((l) => { select.value = l; });
  host.appendChild(wrap);
}
