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

  /**
   * Hash routing is used when the History API cannot be: a page opened from
   * the filesystem has origin `null`, and `pushState` to `/settings` throws
   * because it resolves to `file:///C:/settings`, which is a different
   * document. The single-file client is exactly that case, and without this it
   * loads, renders, and then cannot reach a single route.
   *
   * Hosted builds keep clean paths, so nothing about the normal site changes.
   */
  private readonly useHash = location.protocol === 'file:';

  constructor(private host: HTMLElement) {
    window.addEventListener('popstate', () => this.resolve());
    if (this.useHash) window.addEventListener('hashchange', () => this.resolve());
  }

  /** Where we are, in whichever scheme this document supports. */
  private readLocation(): { pathname: string; search: string } {
    if (!this.useHash) {
      return { pathname: location.pathname || this.fallback, search: location.search };
    }
    const raw = location.hash.slice(1);
    if (!raw) return { pathname: this.fallback, search: '' };
    const [pathPart, queryPart] = raw.split('?');
    return { pathname: pathPart || this.fallback, search: queryPart ? `?${queryPart}` : '' };
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
    const here = this.readLocation();
    if (here.pathname === pathPart && here.search === search) {
      this.resolve();
      return;
    }
    if (this.useHash) {
      // Assigning to `location.hash` fires `hashchange`, which resolves; doing
      // it here as well would mount the view twice.
      location.hash = path;
      return;
    }
    history.pushState(null, '', path);
    this.resolve();
  }

  currentRoute(): string {
    return this.currentPath;
  }

  private resolve(): void {
    const { pathname, search } = this.readLocation();
    const params = new URLSearchParams(search);

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
