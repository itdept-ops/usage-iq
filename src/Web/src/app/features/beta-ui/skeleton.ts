import {
  ChangeDetectionStrategy, Component, input,
} from '@angular/core';

/**
 * BETA-KIT Skeleton — a shimmering placeholder block, generalized from the flagship `.tb-skeleton`
 * into a reusable component. Reserve the final layout's dimensions so first paint is CLS≈0, then
 * swap to real content. The shimmer sweeps left→right (1.4s --ease-out); reduced-motion stops the
 * sweep (the page-host killswitch collapses the animation). Dependency-free + tree-shakeable.
 *
 * CONTRACT (next phase depends on this VERBATIM):
 *   selector:  app-bs-skeleton
 *   inputs:    width (string CSS, default '100%'), height (string CSS, default '16px'),
 *              radius (string CSS, default 'var(--r-tile)'), circle (boolean, default false — force a 1:1 pill)
 *
 * Usage: `<app-bs-skeleton height="120px" radius="var(--r-card)" />`
 *    or: `<app-bs-skeleton width="48px" height="48px" circle />`
 */
@Component({
  selector: 'app-bs-skeleton',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'bs-skeleton',
    'aria-hidden': 'true',
    '[style.width]': 'circle() ? height() : width()',
    '[style.height]': 'height()',
    '[style.borderRadius]': 'circle() ? "50%" : radius()',
  },
  template: '',
  styles: [`
    /* \`bs-skeleton\` is a HOST class (host:{class:'bs-skeleton'}), so it sits on this
       component's own element, which belongs to the PARENT view. Under emulated
       ViewEncapsulation a bare \`.bs-skeleton{…}\` compiles to \`.bs-skeleton[_ngcontent-…]\`
       and NEVER matches the host (the host only carries \`_nghost-…\`). Target it via
       \`:host(.bs-skeleton)\` so the rule actually lands — otherwise the block is invisible. */
    :host(.bs-skeleton) {
      display: block;
      background: linear-gradient(100deg, var(--bg-sink) 30%, var(--bg-rise) 50%, var(--bg-sink) 70%);
      background-size: 200% 100%;
      /* Canonical sweep: the GLOBAL @keyframes tech-shimmer (styles.scss) so every
         skeleton across the app animates in sync. bs-shimmer is kept below as a
         fallback for any context where the global sheet isn't loaded. */
      animation: tech-shimmer 1.4s var(--ease-out) infinite;
    }
    @keyframes bs-shimmer { to { background-position: -200% 0; } }
    @media (prefers-reduced-motion: reduce) { :host(.bs-skeleton) { animation: none; } }
  `],
})
export class BetaSkeleton {
  /** Block width (ignored when `circle`). */
  readonly width = input<string>('100%');
  /** Block height (also the diameter when `circle`). */
  readonly height = input<string>('16px');
  /** Corner radius (ignored when `circle`). */
  readonly radius = input<string>('var(--r-tile)');
  /** Force a circular shape (uses `height` as the diameter). */
  readonly circle = input<boolean>(false);
}
