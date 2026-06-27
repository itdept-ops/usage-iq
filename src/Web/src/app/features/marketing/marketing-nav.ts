import {
  Component,
  ElementRef,
  OnDestroy,
  effect,
  signal,
  viewChild,
  ChangeDetectionStrategy,
} from '@angular/core';
import { IsActiveMatchOptions, RouterLink, RouterLinkActive } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';

// Active-link matching that IGNORES query params (and matrix/fragment) so "Home" (=/login) stays
// underlined even when the auth guard appends ?returnUrl=… on a redirect from the app root (/).
const EXACT_IGNORING_QUERY: IsActiveMatchOptions = {
  paths: 'exact',
  queryParams: 'ignored',
  matrixParams: 'ignored',
  fragment: 'ignored',
};
const SUBSET_IGNORING_QUERY: IsActiveMatchOptions = {
  paths: 'subset',
  queryParams: 'ignored',
  matrixParams: 'ignored',
  fragment: 'ignored',
};

/** Sticky, glassy public nav shared across the marketing pages. */
@Component({
  selector: 'app-marketing-nav',
  imports: [RouterLink, RouterLinkActive, MatIconModule],
  templateUrl: './marketing-nav.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './marketing-nav.scss',
})
export class MarketingNav implements OnDestroy {
  readonly scrolled = signal(false);
  readonly menuOpen = signal(false);

  /** The drawer <nav> — focus is moved in / trapped within it while open. */
  private readonly drawer = viewChild<ElementRef<HTMLElement>>('drawer');
  /** The burger button — focus returns here when the drawer closes. */
  private readonly burger = viewChild<ElementRef<HTMLButtonElement>>('burger');

  // The marketing pages scroll their content INSIDE <body> (the app shell makes
  // <body> a height:100% / overflow:auto scroller, so the viewport/window never
  // scrolls). A `window:scroll` HostListener therefore never fires and the nav
  // would stay transparent over scrolling content. We listen on `document` in
  // the CAPTURE phase (catches scroll bubbling from body OR window) and read the
  // position from whichever scroller is actually moving.
  private readonly onScroll = (): void => {
    const y =
      window.scrollY ||
      document.scrollingElement?.scrollTop ||
      document.documentElement.scrollTop ||
      document.body.scrollTop ||
      0;
    this.scrolled.set(y > 8);
  };

  constructor() {
    // Capture phase + passive: see the body's scroll even though it doesn't
    // reach window. Passive keeps it off the scroll-jank critical path.
    document.addEventListener('scroll', this.onScroll, { capture: true, passive: true });
    this.onScroll(); // seed initial state (e.g. restored scroll position)

    // Lock page scroll while the mobile drawer is open so the long marketing
    // pages don't scroll behind the overlay. Set inline since this component's
    // styles are emulated-scoped and can't target the global <body>.
    effect(() => {
      document.body.style.overflow = this.menuOpen() ? 'hidden' : '';
    });

    // FOCUS MANAGEMENT (mirrors beta-ui/bottom-sheet): on open, remember the
    // opener and move focus to the first link inside the drawer so Tab is
    // trapped there (see onKeydown). On close, restore focus to the burger.
    effect(() => {
      if (this.menuOpen()) {
        const active = (typeof document !== 'undefined' ? document.activeElement : null) as HTMLElement | null;
        if (active && active !== this.burger()?.nativeElement) this.opener = active;
        queueMicrotask(() => this.focusables()[0]?.focus?.());
      }
    });
  }

  /** The element focused when the drawer opened — focus returns here on close
   *  (falls back to the burger so focus never lands on a detached node). */
  private opener: HTMLElement | null = null;

  ngOnDestroy(): void {
    document.removeEventListener('scroll', this.onScroll, { capture: true });
    document.body.style.overflow = '';
  }

  readonly links = [
    { path: '/login', label: 'Home', opts: EXACT_IGNORING_QUERY },
    { path: '/features', label: 'Features', opts: SUBSET_IGNORING_QUERY },
    { path: '/how-it-works', label: 'How it works', opts: SUBSET_IGNORING_QUERY },
    { path: '/technology', label: 'Technology', opts: SUBSET_IGNORING_QUERY },
    { path: '/ai', label: 'AI', opts: SUBSET_IGNORING_QUERY },
    { path: '/about', label: 'About', opts: SUBSET_IGNORING_QUERY },
  ];

  toggle(): void {
    this.menuOpen.update((v) => !v);
  }
  close(): void {
    if (!this.menuOpen()) return;
    this.menuOpen.set(false);
    // Focus-trap exit: restore focus to the opener (or the burger) after the
    // drawer leaves the DOM, so keyboard users aren't dumped at <body>.
    const target = this.opener ?? this.burger()?.nativeElement ?? null;
    this.opener = null;
    if (target?.isConnected) queueMicrotask(() => target.focus?.());
  }

  /** Escape closes the drawer; Tab / Shift+Tab wrap focus within it. */
  onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.close();
      return;
    }
    if (e.key === 'Tab') this.trapTab(e);
  }

  /** Focusable elements inside the drawer, in DOM order (visible ones only). */
  private focusables(): HTMLElement[] {
    const root = this.drawer()?.nativeElement;
    if (!root) return [];
    const sel = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]),'
      + ' select:not([disabled]), [tabindex]:not([tabindex="-1"])';
    return Array.from(root.querySelectorAll<HTMLElement>(sel))
      .filter((el) => el.offsetParent !== null || el === document.activeElement);
  }

  /** Wrap Tab / Shift+Tab focus within the drawer so it can't escape behind the scrim. */
  private trapTab(e: KeyboardEvent): void {
    const els = this.focusables();
    if (els.length === 0) return;
    const first = els[0];
    const last = els[els.length - 1];
    const active = document.activeElement as HTMLElement | null;
    const root = this.drawer()?.nativeElement;
    if (e.shiftKey) {
      if (active === first || !root?.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else if (active === last || !root?.contains(active)) {
      e.preventDefault();
      first.focus();
    }
  }
}
