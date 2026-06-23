import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';

/** The four lifecycle phases every Hearth glance card renders. */
export type HearthPhase = 'loading' | 'ready' | 'empty' | 'failed';

/**
 * The shared chrome for a Hearth glance card: a tap-through header (accent dot + title + a deep-link
 * chevron to the matching LIVE family page via `route`) and the standard skeleton / empty / failed
 * scaffolding so every card is visually consistent and one card's failure NEVER escapes its own card.
 *
 * Pure presentational + isolated: it inherits the page's own `--hearth-*` / Hearth-ember `:host` tokens
 * (NO global `--tech-*`, no live imports). The accent hue is passed as a CSS-variable NAME so each domain
 * keeps its color. The READY body is projected into `[body]`.
 *
 * This is a self-contained copy of the Atrium widget-shell idea (NOT imported) so the beta family page
 * owns its full token set independently of `/beta/home`.
 */
@Component({
  selector: 'fb-hearth-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, MatIconModule],
  template: `
    <section class="c">
      <header class="c__head">
        <span class="c__dot" [style.background]="'var(' + accentVar() + ')'" aria-hidden="true"></span>
        <span class="c__title">{{ title() }}</span>
        <ng-content select="[head-trailing]"></ng-content>
        @if (route(); as r) {
          <a class="c__open" [routerLink]="r" [attr.aria-label]="'Open ' + title()">
            <mat-icon aria-hidden="true">chevron_right</mat-icon>
          </a>
        }
      </header>

      @switch (phase()) {
        @case ('loading') {
          <div class="c__skel" aria-hidden="true">
            <span class="c__skel-line"></span>
            <span class="c__skel-line c__skel-line--short"></span>
          </div>
        }
        @case ('failed') {
          <div class="c__state">
            <p class="c__state-msg">Couldn’t load.</p>
            <button type="button" class="c__retry" (click)="retry.emit()">
              <mat-icon aria-hidden="true">refresh</mat-icon> Retry
            </button>
          </div>
        }
        @case ('empty') {
          <div class="c__state"><p class="c__state-msg">{{ emptyText() }}</p></div>
        }
        @default {
          <ng-content select="[body]"></ng-content>
        }
      }
    </section>
  `,
  styles: [`
    .c {
      display: block;
      border-radius: var(--r-card, 24px);
      background: var(--bg-rise);
      border: 1px solid var(--glass-edge);
      box-shadow: var(--lift-1);
      padding: 16px;
      scroll-snap-align: start;
      content-visibility: auto;
      contain-intrinsic-size: auto 120px;
    }
    .c__head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
    .c__dot { flex: 0 0 auto; width: 9px; height: 9px; border-radius: 999px; }
    .c__title { font-weight: 700; font-size: 14px; letter-spacing: .01em; color: var(--ink); }
    .c__open {
      margin-left: auto; display: grid; place-items: center;
      width: 36px; height: 36px; border-radius: 999px;
      color: var(--ink-dim); text-decoration: none;
      transition: background 120ms ease, color 120ms ease;
    }
    .c__open:hover { background: rgba(255,255,255,.06); color: var(--ink); }
    .c__open:focus-visible { outline: 2px solid var(--hearth-a); outline-offset: 2px; }

    .c__skel { display: flex; flex-direction: column; gap: 10px; padding: 4px 0 8px; }
    .c__skel-line {
      height: 16px; border-radius: 8px;
      background: linear-gradient(100deg, rgba(255,255,255,.04) 30%, rgba(255,255,255,.10) 50%, rgba(255,255,255,.04) 70%);
      background-size: 200% 100%; animation: fb-shimmer 1.4s ease infinite;
    }
    .c__skel-line--short { width: 55%; }
    @keyframes fb-shimmer { to { background-position: -200% 0; } }

    .c__state { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 6px 0; }
    .c__state-msg { margin: 0; color: var(--ink-dim); font-size: 13px; }
    .c__retry {
      display: inline-flex; align-items: center; gap: 6px;
      min-height: 40px; padding: 0 14px; border-radius: 999px;
      border: 1px solid var(--glass-edge); background: transparent; color: var(--ink);
      font: inherit; font-size: 13px; cursor: pointer;
    }
    .c__retry mat-icon { font-size: 18px; width: 18px; height: 18px; }

    @media (prefers-reduced-motion: reduce) {
      .c__skel-line { animation: none; }
    }
  `],
})
export class HearthCard {
  /** Card title shown in the header. */
  readonly title = input.required<string>();
  /** Deep-link to the matching LIVE family page; null hides the chevron. */
  readonly route = input<string | null>(null);
  /** The CSS custom-property NAME for this domain's accent (e.g. `--event`). */
  readonly accentVar = input<string>('--ink');
  /** Current lifecycle phase. */
  readonly phase = input.required<HearthPhase>();
  /** Friendly nudge shown in the empty state. */
  readonly emptyText = input<string>('Nothing here yet.');

  readonly retry = output<void>();
}
