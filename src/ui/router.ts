export type RouteHandler = (host: HTMLElement, params: URLSearchParams) => void | (() => void);

interface Route {
  path: string;
  mount: RouteHandler;
}

/**
 * Minimal History-API SPA router. Routes are matched against `location.pathname`
 * with `location.search` parsed into params, so `/wallet?page=2` resolves to
 * `/wallet` with `page=2`. The previously mounted view's optional cleanup
 * function is invoked before mounting the next one.
 *
 * Static hosting note: refreshing on any non-root path requires the host to
 * serve `index.html` for unknown URLs (SPA fallback). See `public/_redirects`
 * for the Cloudflare Pages config; other hosts need the equivalent.
 */
export class Router {
  private routes: Route[] = [];
  private fallback = '/';
  private currentCleanup: (() => void) | null = null;
  private currentPath = '';
  private navListeners = new Set<(path: string) => void>();

  constructor(private host: HTMLElement) {
    window.addEventListener('popstate', () => this.resolve());
  }

  route(path: string, mount: RouteHandler): this {
    this.routes.push({ path, mount });
    return this;
  }

  /**
   * Notified after every resolved navigation with the matched route path.
   * Chrome that lives outside the view root (the sync overlay, the nav strip)
   * subscribes here so it can react to route class — e.g. the overlay only
   * covers routes that actually run a node.
   */
  onNavigate(cb: (path: string) => void): () => void {
    this.navListeners.add(cb);
    return () => this.navListeners.delete(cb);
  }

  setFallback(path: string): this {
    this.fallback = path;
    return this;
  }

  start(): void {
    this.resolve();
  }

  navigate(path: string): void {
    // path may include a `?query` — split before comparing against the current
    // pathname so we don't double-stack identical entries in the back-button
    // history.
    const [pathPart, queryPart] = path.split('?');
    const search = queryPart ? `?${queryPart}` : '';
    if (location.pathname === pathPart && location.search === search) {
      this.resolve();
      return;
    }
    history.pushState(null, '', path);
    this.resolve();
  }

  currentRoute(): string {
    return this.currentPath;
  }

  private resolve(): void {
    const pathname = location.pathname || this.fallback;
    const params = new URLSearchParams(location.search);

    const match = this.routes.find((r) => r.path === pathname) ?? this.routes.find((r) => r.path === this.fallback);
    if (!match) return;

    this.currentCleanup?.();
    this.currentCleanup = null;
    this.host.replaceChildren();
    this.currentPath = match.path;
    const cleanup = match.mount(this.host, params);
    if (typeof cleanup === 'function') this.currentCleanup = cleanup;

    document.querySelectorAll<HTMLElement>('[data-nav] .nav-tab').forEach((tab) => {
      tab.classList.toggle('active', tab.dataset['route'] === this.currentPath);
    });

    window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });

    for (const cb of this.navListeners) cb(this.currentPath);
  }
}

export interface NavOptions {
  root?: HTMLElement;
  /**
   * Where the brand (logo + name) navigates. Resolved per click, because the
   * answer changes: a reader belongs on the landing page, someone already
   * running a node belongs on their dashboard.
   */
  homePath?: () => string;
}

/**
 * Wire nav-tab buttons AND intercept clicks on any internal `<a href="/...">`
 * so anchor clicks become SPA navigations instead of full page loads. We only
 * intercept plain left-clicks with no modifier keys — middle-click, cmd-click,
 * etc. still open in a new tab as the user expects.
 */
export function wireNav(router: Router, opts: NavOptions = {}): void {
  const root = opts.root ?? document.body;
  root.querySelectorAll<HTMLElement>('[data-nav] .nav-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const target = tab.dataset['route'];
      if (target) router.navigate(target);
    });
  });

  // Clicking the brand (logo + name) returns to the home page.
  root.querySelector<HTMLElement>('.brand')?.addEventListener('click', () => {
    router.navigate(opts.homePath?.() ?? '/');
  });

  document.addEventListener('click', (e) => {
    if (e.defaultPrevented) return;
    if (e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const anchor = (e.target as Element | null)?.closest('a');
    if (!anchor) return;
    const href = anchor.getAttribute('href');
    if (!href || !href.startsWith('/')) return;
    if (anchor.target && anchor.target !== '' && anchor.target !== '_self') return;
    e.preventDefault();
    router.navigate(href);
  });
}
