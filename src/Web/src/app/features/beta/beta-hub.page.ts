import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';

import { AuthService } from '../../core/auth';
import { BETA_EXPERIMENTS, BetaExperiment } from './beta-experiments';

/**
 * Beta hub — a clean, mobile-friendly index of experimental surfaces. Lives in the normal app shell
 * (uses the app's --tech-* design tokens), gated by the `beta.access` page permission. Each card is a
 * pure data entry in {@link experimentDefs}; the visible list is filtered by per-card permission so a
 * card only appears if its own feature flag (e.g. tracker.beta) is also granted to the user.
 */
@Component({
  selector: 'app-beta-hub',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, MatIconModule],
  template: `
    <section class="beta">
      <header class="beta__head">
        <h1 class="beta__title">Beta</h1>
        <p class="beta__note">Experimental — these may change or move.</p>
      </header>

      @if (experiments().length) {
        <div class="beta__grid">
          @for (x of experiments(); track x.route) {
            <a class="beta-card" [routerLink]="x.route">
              <span class="beta-card__icon"><mat-icon aria-hidden="true">{{ x.icon }}</mat-icon></span>
              <span class="beta-card__body">
                <span class="beta-card__title">{{ x.title }}</span>
                <span class="beta-card__blurb">{{ x.blurb }}</span>
              </span>
              <mat-icon class="beta-card__chev" aria-hidden="true">chevron_right</mat-icon>
            </a>
          }
        </div>
      } @else {
        <p class="beta__empty">No beta experiments are available to you yet.</p>
      }
    </section>
  `,
  styles: [`
    .beta { max-width: 880px; margin: 0 auto; padding: var(--tech-space-6) var(--tech-space-4); }
    .beta__head { margin-bottom: var(--tech-space-6); }
    .beta__title { margin: 0; font-family: var(--tech-font-ui); font-size: 26px; font-weight: 700; color: var(--tech-text); letter-spacing: -0.01em; }
    .beta__note { margin: var(--tech-space-1) 0 0; font-size: 13px; color: var(--tech-text-tertiary); }
    .beta__empty { color: var(--tech-text-secondary); font-size: 14px; }

    .beta__grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
      gap: var(--tech-space-4);
    }

    .beta-card {
      display: flex; align-items: center; gap: var(--tech-space-3);
      padding: var(--tech-space-4);
      background: var(--tech-panel);
      border: 1px solid var(--tech-border);
      border-radius: var(--tech-radius);
      box-shadow: var(--tech-shadow-panel);
      text-decoration: none; color: inherit;
      transition: border-color 120ms ease, background 120ms ease, transform 120ms ease;
    }
    .beta-card:hover { background: var(--tech-panel-raised); border-color: var(--tech-border-strong); transform: translateY(-1px); }
    .beta-card:focus-visible { outline: 2px solid var(--tech-accent); outline-offset: 2px; }

    .beta-card__icon {
      flex: 0 0 auto; display: grid; place-items: center;
      width: 40px; height: 40px; border-radius: 10px;
      background: var(--tech-info-tint); color: var(--tech-accent);
    }
    .beta-card__body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .beta-card__title { font-family: var(--tech-font-ui); font-size: 15px; font-weight: 600; color: var(--tech-text); }
    .beta-card__blurb { font-size: 13px; color: var(--tech-text-secondary); line-height: 1.35; }
    .beta-card__chev { margin-left: auto; color: var(--tech-text-tertiary); }
  `],
})
export class BetaHubPage {
  private readonly auth = inject(AuthService);

  /** Experiments visible to the current session (cards without a `perm` always show). */
  readonly experiments = computed<BetaExperiment[]>(() => {
    this.auth.permissions(); // re-run when permissions change
    return BETA_EXPERIMENTS.filter(x => !x.perm || this.auth.hasPermission(x.perm));
  });
}
