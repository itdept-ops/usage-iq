import { Component, HostListener, signal } from '@angular/core';
import { IsActiveMatchOptions, RouterLink, RouterLinkActive } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';

// Active-link matching that IGNORES query params (and matrix/fragment) so "Home" (=/login) stays
// underlined even when the auth guard appends ?returnUrl=… on a redirect from the app root (/).
const EXACT_IGNORING_QUERY: IsActiveMatchOptions =
  { paths: 'exact', queryParams: 'ignored', matrixParams: 'ignored', fragment: 'ignored' };
const SUBSET_IGNORING_QUERY: IsActiveMatchOptions =
  { paths: 'subset', queryParams: 'ignored', matrixParams: 'ignored', fragment: 'ignored' };

/** Sticky, glassy public nav shared across the marketing pages. */
@Component({
  selector: 'app-marketing-nav',
  imports: [RouterLink, RouterLinkActive, MatIconModule],
  templateUrl: './marketing-nav.html',
  styleUrl: './marketing-nav.scss',
})
export class MarketingNav {
  readonly scrolled = signal(false);
  readonly menuOpen = signal(false);

  readonly links = [
    { path: '/login', label: 'Home', opts: EXACT_IGNORING_QUERY },
    { path: '/features', label: 'Features', opts: SUBSET_IGNORING_QUERY },
    { path: '/how-it-works', label: 'How it works', opts: SUBSET_IGNORING_QUERY },
    { path: '/about', label: 'About', opts: SUBSET_IGNORING_QUERY },
  ];

  @HostListener('window:scroll')
  onScroll(): void {
    this.scrolled.set(window.scrollY > 8);
  }

  toggle(): void { this.menuOpen.update(v => !v); }
  close(): void { this.menuOpen.set(false); }
}
