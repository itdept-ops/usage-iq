import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';

/** Shared public footer for the marketing pages. */
@Component({
  selector: 'app-marketing-footer',
  imports: [RouterLink],
  templateUrl: './marketing-footer.html',
  styleUrl: './marketing-footer.scss',
})
export class MarketingFooter {
  readonly year = 2026;
  readonly cols = [
    {
      title: 'Product',
      links: [
        { label: 'Home', path: '/login' },
        { label: 'Features', path: '/features' },
        { label: 'How it works', path: '/how-it-works' },
        { label: 'Technology', path: '/technology' },
        { label: 'AI', path: '/ai' },
        { label: 'About', path: '/about' },
      ],
    },
    {
      title: 'Account',
      links: [
        { label: 'Sign in', path: '/signin' },
        { label: 'Dashboard', path: '/' },
      ],
    },
  ];
}
