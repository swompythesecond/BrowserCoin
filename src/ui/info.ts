interface InfoConfig {
  title: string;
  body: string; // plain text; newlines become paragraph breaks
}

/**
 * Click-popover with a friendly explanation. Returns an anchor span that wraps
 * the trigger so the popover can position itself relative to it. Only one
 * popover is open at a time — opening another closes the first.
 */
export function infoButton(cfg: InfoConfig): HTMLElement {
  const anchor = document.createElement('span');
  anchor.className = 'info-anchor';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'info-btn';
  btn.setAttribute('aria-label', `About: ${cfg.title}`);
  btn.textContent = 'i';

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (anchor.querySelector('.info-popover')) {
      closeAll();
      return;
    }
    closeAll();
    anchor.appendChild(buildPopover(cfg));
  });

  anchor.appendChild(btn);
  return anchor;
}

function buildPopover(cfg: InfoConfig): HTMLElement {
  const pop = document.createElement('div');
  pop.className = 'info-popover';
  const h = document.createElement('h4');
  h.textContent = cfg.title;
  pop.appendChild(h);
  for (const para of cfg.body.split(/\n\s*\n/)) {
    const p = document.createElement('p');
    p.textContent = para.trim();
    pop.appendChild(p);
  }
  return pop;
}

function closeAll(): void {
  document.querySelectorAll('.info-popover').forEach((el) => el.remove());
}

document.addEventListener('click', (e) => {
  const target = e.target as HTMLElement | null;
  if (target?.closest('.info-popover') || target?.closest('.info-btn')) return;
  closeAll();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeAll();
});

/** Convenience: build a `<header>` with title, info button, optional link. */
export function cardHeader(opts: {
  title: string;
  info?: InfoConfig;
  link?: { label: string; onClick: () => void };
}): HTMLElement {
  const h = document.createElement('div');
  h.className = 'card-header';

  const titleEl = document.createElement('h3');
  titleEl.className = 'card-title';
  titleEl.textContent = opts.title;
  h.appendChild(titleEl);

  if (opts.info) h.appendChild(infoButton(opts.info));

  const spacer = document.createElement('span');
  spacer.className = 'card-spacer';
  h.appendChild(spacer);

  if (opts.link) {
    const btn = document.createElement('button');
    btn.className = 'card-link';
    btn.textContent = opts.link.label;
    btn.addEventListener('click', opts.link.onClick);
    h.appendChild(btn);
  }
  return h;
}
