export type RouteHandler = (host: HTMLElement, params: URLSearchParams) => void | (() => void);

interface Route {
  path: string;
  mount: RouteHandler;
}

/**
 * Minimal hash router. Routes are matched against the part of the hash before
 * the optional `?` query, so `#/wallet?page=2` resolves to `/wallet` with
 * `page=2`. The previously mounted view's optional cleanup function is invoked
 * before mounting the next one.
 */
export class Router {
  private routes: Route[] = [];
  private fallback = '/';
  private currentCleanup: (() => void) | null = null;
  private currentPath = '';

  constructor(private host: HTMLElement) {
    window.addEventListener('hashchange', () => this.resolve());
  }

  route(path: string, mount: RouteHandler): this {
    this.routes.push({ path, mount });
    return this;
  }

  setFallback(path: string): this {
    this.fallback = path;
    return this;
  }

  start(): void {
    this.resolve();
  }

  navigate(path: string): void {
    if (location.hash === `#${path}`) {
      this.resolve();
      return;
    }
    location.hash = `#${path}`;
  }

  currentRoute(): string {
    return this.currentPath;
  }

  private resolve(): void {
    const raw = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash;
    const [pathPart, queryPart = ''] = raw.split('?');
    const path = pathPart && pathPart.length > 0 ? pathPart : this.fallback;
    const params = new URLSearchParams(queryPart);

    const match = this.routes.find((r) => r.path === path) ?? this.routes.find((r) => r.path === this.fallback);
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
  }
}

export function wireNav(router: Router, root: HTMLElement = document.body): void {
  root.querySelectorAll<HTMLElement>('[data-nav] .nav-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const target = tab.dataset['route'];
      if (target) router.navigate(target);
    });
  });
}
