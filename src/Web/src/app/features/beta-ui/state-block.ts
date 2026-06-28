import {
  booleanAttribute, ChangeDetectionStrategy, Component, input, output,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';

/**
 * BETA-KIT EmptyState + ErrorState — the unified loading→error→empty triad's two STATIC panels,
 * generalized from the per-surface ad-hoc blocks (`im-state` / `iq-state` / `family__empty` /
 * `jr-empty` / `state state--error` …) into two reusable kit primitives. Both render a centered
 * accent-tinted orb (a Material glyph) + a title + an optional body, on a raised `--bg-rise` card.
 *
 * EMPTY is a neutral region (a calm "nothing here yet" panel). ERROR is an assertive `role="alert"`
 * with `aria-live="polite"` and a default "Try again" retry CTA. Each panel offers ONE optional CTA,
 * either a real <button> that emits `action`, or — when `ctaLink` is set — an `<a routerLink>` (used
 * by empty states that route somewhere, e.g. "Open the tracker"). Extra page-specific nuance can be
 * dropped in via content projection (anything inside the element renders below the body).
 *
 * Both read --accent-a/--accent-b (orb + CTA gradient), --ink/--ink-dim (text), --bg-rise/--hairline
 * (the card), and the radii/elevation tokens — so dropping a page accent reskins them. The orb is
 * static (no animation), so there is nothing for reduced-motion to suppress. Dependency-free +
 * tree-shakeable; no imports from the flagship tracker-beta.
 *
 * DUAL-TOKEN: every color/radius reads the kit token FIRST and falls back to the app-wide `--tech-*`
 * token, so the SAME primitive renders correctly on a kit-host page (mobile twins, family) AND on a
 * plain `--tech-*` desktop vertical (insights / meds / journal / habits / agents / feed / search)
 * with no host setup. On a kit page the kit tokens win; on a tech page the --tech-* fallbacks win.
 *
 * CONTRACT (next phase depends on this VERBATIM):
 *   EMPTY  selector: app-bs-empty
 *     inputs:  icon (string Material ligature, default 'inbox'),
 *              title (string, required),
 *              body (string, default ''),
 *              ctaLabel (string, default '' — presence renders a CTA),
 *              ctaIcon (string Material ligature, default 'arrow_forward'),
 *              ctaLink (string | null, default null — when set the CTA is an <a routerLink> instead of a <button>),
 *              compact (boolean via booleanAttribute, default false — accepts bare `compact`; tighter padding for inline/list-row empties)
 *     outputs: action (void) — fired when the <button> CTA is tapped (not when ctaLink is set)
 *
 *   ERROR  selector: app-bs-error
 *     inputs:  icon (string Material ligature, default 'error_outline'),
 *              title (string, required),
 *              body (string, default ''),
 *              ctaLabel (string, default 'Try again'),
 *              ctaIcon (string Material ligature, default 'refresh'),
 *              compact (boolean via booleanAttribute, default false — accepts bare `compact`)
 *     outputs: retry (void) — fired when the retry CTA is tapped
 *
 * Usage:
 *   <app-bs-empty icon="query_stats" title="Keep logging" body="Insights appear once…"
 *                 ctaLabel="Open the tracker" ctaIcon="arrow_forward" ctaLink="/tracker-beta" />
 *   <app-bs-error title="Couldn't load insights" body="Something went wrong." (retry)="reload()" />
 */

const STATE_STYLES = `
  /* Resolve each token once with a --tech-* fallback so the panel works on kit + tech pages alike. */
  :host {
    display: block;
    --bs-accent-a: var(--accent-a, var(--tech-accent, #7c8cff));
    --bs-accent-b: var(--accent-b, var(--tech-accent, #7c8cff));
    --bs-ink: var(--ink, var(--tech-text, #e6edf6));
    --bs-ink-dim: var(--ink-dim, var(--tech-text-secondary, #9ba9bd));
    --bs-on-accent: var(--ink-on-accent, #fff);
    --bs-surface: var(--bg-rise, var(--tech-panel, #11161f));
    --bs-edge: var(--hairline, var(--tech-border, #26303f));
    --bs-r-card: var(--r-card, var(--tech-radius, 16px));
    --bs-r-pill: var(--r-pill, var(--tech-radius, 12px));
    --bs-shadow: var(--lift-2, 0 6px 24px rgba(0,0,0,.18));
    --bs-shadow-1: var(--lift-1, 0 2px 10px rgba(0,0,0,.12));
    --bs-focus: var(--focus, var(--tech-accent, #7c8cff));
    --bs-ease: var(--ease-out, cubic-bezier(.2,.6,.2,1));
  }
  .bs-state {
    display: flex; flex-direction: column; align-items: center;
    text-align: center; gap: .7rem;
    padding: clamp(36px, 12vw, 64px) 1.25rem;
    border-radius: var(--bs-r-card);
    background: var(--bs-surface);
    border: 1px solid var(--bs-edge);
    box-shadow: var(--bs-shadow);
  }
  .bs-state.compact { padding: clamp(20px, 7vw, 32px) 1rem; gap: .5rem; box-shadow: var(--bs-shadow-1); }
  .bs-state__orb {
    display: grid; place-items: center;
    width: 60px; height: 60px; border-radius: 50%;
    color: var(--bs-accent-b);
    background: color-mix(in srgb, var(--bs-accent-a) 18%, transparent);
  }
  .bs-state__orb mat-icon { font-size: 30px; width: 30px; height: 30px; }
  .bs-state.compact .bs-state__orb { width: 46px; height: 46px; }
  .bs-state.compact .bs-state__orb mat-icon { font-size: 24px; width: 24px; height: 24px; }
  .bs-state__title { margin: 0; font-family: var(--font-ui, inherit); font-size: 1.15rem; font-weight: 700; color: var(--bs-ink); }
  .bs-state.compact .bs-state__title { font-size: 1rem; }
  .bs-state__body { margin: 0; max-width: 40ch; font-size: .88rem; line-height: 1.5; color: var(--bs-ink-dim); }
  .bs-state__cta {
    display: inline-flex; align-items: center; gap: .4rem;
    margin-top: .3rem; min-height: 44px; padding: 0 1.1rem;
    border-radius: var(--bs-r-pill);
    font: inherit; font-weight: 600; text-decoration: none;
    border: 0; cursor: pointer;
    color: var(--bs-on-accent);
    background: linear-gradient(135deg, var(--bs-accent-a), var(--bs-accent-b));
    touch-action: manipulation; -webkit-tap-highlight-color: transparent;
    transition: opacity 120ms var(--bs-ease);
  }
  .bs-state__cta:active { opacity: .8; }
  .bs-state__cta:focus-visible { outline: 2px solid var(--bs-focus); outline-offset: 3px; }
  .bs-state__cta mat-icon { font-size: 19px; width: 19px; height: 19px; }
`;

/** Empty-state panel — a neutral "nothing here yet" region with an optional routing/action CTA. */
@Component({
  selector: 'app-bs-empty',
  standalone: true,
  imports: [MatIconModule, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="bs-state" [class.compact]="compact()" role="region" [attr.aria-label]="title()">
      <span class="bs-state__orb" aria-hidden="true"><mat-icon>{{ icon() }}</mat-icon></span>
      <h2 class="bs-state__title">{{ title() }}</h2>
      @if (body()) { <p class="bs-state__body">{{ body() }}</p> }
      <ng-content />
      @if (ctaLabel()) {
        @if (ctaLink()) {
          <a class="bs-state__cta" [routerLink]="ctaLink()">
            <mat-icon aria-hidden="true">{{ ctaIcon() }}</mat-icon> {{ ctaLabel() }}
          </a>
        } @else {
          <button type="button" class="bs-state__cta" (click)="action.emit()">
            <mat-icon aria-hidden="true">{{ ctaIcon() }}</mat-icon> {{ ctaLabel() }}
          </button>
        }
      }
    </div>
  `,
  styles: [STATE_STYLES],
})
export class BetaEmptyState {
  /** Material ligature for the orb glyph. */
  readonly icon = input<string>('inbox');
  /** The headline ("No habits yet", "Keep logging"…). */
  readonly title = input.required<string>();
  /** Optional supporting line. */
  readonly body = input<string>('');
  /** CTA label; when blank no CTA renders. */
  readonly ctaLabel = input<string>('');
  /** CTA leading icon. */
  readonly ctaIcon = input<string>('arrow_forward');
  /** When set, the CTA is an `<a routerLink>` to this path instead of an action button. */
  readonly ctaLink = input<string | null>(null);
  /** Tighter padding for inline / list-row empties (accepts the bare `compact` attribute). */
  readonly compact = input<boolean, unknown>(false, { transform: booleanAttribute });
  /** Fired when the <button> CTA is tapped (ignored when `ctaLink` is set). */
  readonly action = output<void>();
}

/** Error-state panel — an assertive alert with a default "Try again" retry CTA. */
@Component({
  selector: 'app-bs-error',
  standalone: true,
  imports: [MatIconModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="bs-state" [class.compact]="compact()" role="alert" aria-live="polite">
      <span class="bs-state__orb" aria-hidden="true"><mat-icon>{{ icon() }}</mat-icon></span>
      <h2 class="bs-state__title">{{ title() }}</h2>
      @if (body()) { <p class="bs-state__body">{{ body() }}</p> }
      <ng-content />
      @if (ctaLabel()) {
        <button type="button" class="bs-state__cta" (click)="retry.emit()">
          <mat-icon aria-hidden="true">{{ ctaIcon() }}</mat-icon> {{ ctaLabel() }}
        </button>
      }
    </div>
  `,
  styles: [STATE_STYLES],
})
export class BetaErrorState {
  /** Material ligature for the orb glyph. */
  readonly icon = input<string>('error_outline');
  /** The headline ("Couldn't load insights"…). */
  readonly title = input.required<string>();
  /** Optional supporting line. */
  readonly body = input<string>('');
  /** Retry CTA label; clear it to '' to hide the button. */
  readonly ctaLabel = input<string>('Try again');
  /** Retry CTA leading icon. */
  readonly ctaIcon = input<string>('refresh');
  /** Tighter padding for inline error rows (accepts the bare `compact` attribute). */
  readonly compact = input<boolean, unknown>(false, { transform: booleanAttribute });
  /** Fired when the retry CTA is tapped. */
  readonly retry = output<void>();
}
