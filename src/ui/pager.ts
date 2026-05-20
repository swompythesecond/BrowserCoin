export function renderPager(
  host: HTMLElement,
  page: number,
  pages: number,
  go: (p: number) => void,
): void {
  if (pages <= 1) {
    host.innerHTML = '';
    return;
  }
  host.innerHTML = `
    <button class="ghost small" data-w="prev" ${page === 0 ? 'disabled' : ''}>← Prev</button>
    <span>Page ${page + 1} of ${pages}</span>
    <button class="ghost small" data-w="next" ${page >= pages - 1 ? 'disabled' : ''}>Next →</button>
  `;
  host.querySelector<HTMLButtonElement>('[data-w="prev"]')!.addEventListener('click', () => go(page - 1));
  host.querySelector<HTMLButtonElement>('[data-w="next"]')!.addEventListener('click', () => go(page + 1));
}
