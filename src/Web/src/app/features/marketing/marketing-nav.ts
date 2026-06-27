import {
  Component,
  OnDestroy,
  effect,
  signal,
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
  }

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
    this.menuOpen.set(false);
  }
}
