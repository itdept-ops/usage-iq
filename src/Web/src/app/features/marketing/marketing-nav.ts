import { Component, HostListener, signal } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';

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
    { path: '/login', label: 'Home', exact: true },
    { path: '/features', label: 'Features', exact: false },
    { path: '/how-it-works', label: 'How it works', exact: false },
  ];

  @HostListener('window:scroll')
  onScroll(): void {
    this.scrolled.set(window.scrollY > 8);
  }

  toggle(): void { this.menuOpen.update(v => !v); }
  close(): void { this.menuOpen.set(false); }
}
