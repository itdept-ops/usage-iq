import {
  Component, computed, inject, input, signal, ChangeDetectionStrategy,
} from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar } from '@angular/material/snack-bar';

import { Api } from '../../core/api';
import { AuthService } from '../../core/auth';
import { PERM } from '../../core/models';

/**
 * Desktop RECOVERY ring + breakdown card — the sleep twin of {@link CoffeeRing}/{@link HydrationRing},
 * but a SCORE ring (0..100) rather than a progress-to-goal ring. It renders the deterministic recovery
 * score the backend fuses from last night's sleep, the day's caffeine, training load, and calorie
 * adherence, with the four component sub-scores and a short label ("Primed"/"Steady"/…).
 *
 * The ring colour follows the band (good → success, mid → neutral, low → warning/error) so the glance
 * read matches the label. Pure SVG (no chart lib), theme-driven via --tech tokens, with a role="img"
 * aria-label text equivalent.
 *
 * It ALSO carries the optional AI insight line (cloned from the weight-insight affordance): a small
 * on-demand "read my recovery" button that calls GET /api/ai/sleep-insight, shown ONLY when the caller
 * holds tracker.ai. The endpoint always 200s with a deterministic floor, so a failure just hides the
 * line — the deterministic score above is the source of truth and never depends on AI.
 *
 * OWNER-ONLY: recovery derives from sleep, which the backend returns null for any viewer. The parent
 * only renders this card on the OWN, writable tracker, so there's no read-only path here.
 */
@Component({
  selector: 'app-recovery-ring',
  standalone: true,
  imports: [MatIconModule, MatButtonModule, MatProgressSpinnerModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="rec">
      <div class="rec__ringwrap">
        <svg viewBox="0 0 120 120" class="ring" role="img" [attr.aria-label]="ariaLabel()">
          <circle class="ring__track" cx="60" cy="60" [attr.r]="radius" fill="none" stroke-width="11" />
          <circle
            class="ring__bar"
            [class]="'ring__bar--' + band()"
            cx="60"
            cy="60"
            [attr.r]="radius"
            fill="none"
            stroke-width="11"
            stroke-linecap="round"
            transform="rotate(-90 60 60)"
            [attr.stroke-dasharray]="circumference"
            [attr.stroke-dashoffset]="dashOffset()"
          />
          <text x="60" y="56" class="ring__value" text-anchor="middle">{{ score() }}</text>
          <text x="60" y="74" class="ring__label" text-anchor="middle">{{ label() }}</text>
        </svg>
      </div>

      <div class="rec__breakdown">
        <ul class="rec__subs" aria-label="Recovery breakdown">
          <li class="rec__sub">
            <span class="rec__sub-name">Sleep</span>
            <span class="rec__sub-bar" aria-hidden="true">
              <span class="rec__sub-fill" [style.width.%]="sleep()"></span>
            </span>
            <span class="rec__sub-num mono-num">{{ sleep() }}</span>
          </li>
          <li class="rec__sub">
            <span class="rec__sub-name">Fuel</span>
            <span class="rec__sub-bar" aria-hidden="true">
              <span class="rec__sub-fill" [style.width.%]="fuel()"></span>
            </span>
            <span class="rec__sub-num mono-num">{{ fuel() }}</span>
          </li>
          <li class="rec__sub">
            <span class="rec__sub-name">Caffeine</span>
            <span class="rec__sub-bar" aria-hidden="true">
              <span class="rec__sub-fill" [style.width.%]="caffeine()"></span>
            </span>
            <span class="rec__sub-num mono-num">{{ caffeine() }}</span>
          </li>
          <li class="rec__sub">
            <span class="rec__sub-name">Training</span>
            <span class="rec__sub-bar" aria-hidden="true">
              <span class="rec__sub-fill" [style.width.%]="training()"></span>
            </span>
            <span class="rec__sub-num mono-num">{{ training() }}</span>
          </li>
        </ul>

        @if (showAi) {
          <div class="rec__ai">
            @if (insight(); as ins) {
              <p class="rec__ai-text">
                <mat-icon aria-hidden="true">auto_awesome</mat-icon>
                <span>{{ ins.insight }}</span>
              </p>
              @if (ins.tips) {
                <p class="rec__ai-tips">{{ ins.tips }}</p>
              }
            } @else {
              <button
                mat-stroked-button
                type="button"
                class="rec__ai-btn"
                [disabled]="insightLoading()"
                (click)="loadInsight()"
              >
                @if (insightLoading()) {
                  <mat-spinner diameter="16" />
                } @else {
                  <mat-icon>auto_awesome</mat-icon>
                }
                Read my recovery
              </button>
            }
            <span class="cdk-visually-hidden" role="status" aria-live="polite">{{ aiAnnounce() }}</span>
          </div>
        }
      </div>
    </div>
  `,
  styles: [`
    :host { display: block; width: 100%; }

    .rec {
      display: flex;
      gap: 20px;
      align-items: center;
      flex-wrap: wrap;
    }

    .rec__ringwrap {
      flex: 0 0 auto;
      width: 100%;
      max-width: 156px;
    }

    .ring { display: block; width: 100%; height: auto; }
    .ring__track { stroke: var(--tech-border); }
    .ring__bar {
      transition: stroke-dashoffset 600ms cubic-bezier(0.22, 1, 0.36, 1), stroke var(--tech-t-control) ease;
      stroke: var(--tech-accent);
    }
    .ring__bar--good { stroke: var(--tech-success); }
    .ring__bar--mid { stroke: var(--tech-accent); }
    .ring__bar--low { stroke: var(--tech-warn); }
    .ring__bar--bad { stroke: var(--tech-error); }

    .ring__value {
      font-family: var(--tech-font-mono);
      font-size: 26px;
      font-weight: 700;
      fill: var(--tech-text);
    }
    .ring__label {
      font-family: var(--tech-font-ui);
      font-size: 9px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      fill: var(--tech-text-tertiary);
    }

    .rec__breakdown { flex: 1 1 220px; min-width: 200px; }

    .rec__subs {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .rec__sub {
      display: grid;
      grid-template-columns: 64px 1fr 32px;
      align-items: center;
      gap: 10px;
    }

    .rec__sub-name {
      font-family: var(--tech-font-ui);
      font-size: 11px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--tech-text-tertiary);
    }

    .rec__sub-bar {
      height: 6px;
      border-radius: 999px;
      background: var(--tech-border);
      overflow: hidden;
    }

    .rec__sub-fill {
      display: block;
      height: 100%;
      border-radius: 999px;
      background: var(--tech-accent);
      transition: width 600ms cubic-bezier(0.22, 1, 0.36, 1);
    }

    .rec__sub-num {
      text-align: right;
      font-size: 13px;
      color: var(--tech-text);
    }

    .rec__ai {
      margin-top: 14px;
      padding-top: 12px;
      border-top: 1px solid var(--tech-border);
    }

    .rec__ai-text {
      display: flex;
      gap: 8px;
      align-items: flex-start;
      margin: 0;
      font-size: 13px;
      line-height: 1.5;
      color: var(--tech-text);

      mat-icon {
        flex: 0 0 auto;
        font-size: 18px;
        width: 18px;
        height: 18px;
        color: var(--tech-accent);
      }
    }

    .rec__ai-tips {
      margin: 6px 0 0 26px;
      font-size: 12px;
      line-height: 1.5;
      color: var(--tech-text-secondary);
    }

    .rec__ai-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }

    @media (prefers-reduced-motion: reduce) {
      .ring__bar, .rec__sub-fill { transition: none; }
    }
  `],
})
export class RecoveryRing {
  private readonly api = inject(Api);
  private readonly auth = inject(AuthService);
  private readonly snack = inject(MatSnackBar);

  /** The composite recovery score (0..100). */
  readonly score = input.required<number>();
  /** Sub-score (0..100) for sleep duration + quality. */
  readonly sleep = input.required<number>();
  /** Sub-score (0..100) for calorie/fuel adherence. */
  readonly fuel = input.required<number>();
  /** Sub-score (0..100) for the day's caffeine load. */
  readonly caffeine = input.required<number>();
  /** Sub-score (0..100) for training load. */
  readonly training = input.required<number>();
  /** Short deterministic label ("Primed"/"Steady"/"Run down"/"Depleted"). */
  readonly label = input.required<string>();

  readonly radius = 52;
  readonly circumference = 2 * Math.PI * this.radius;

  /** Arc fill: the score as a fraction of 100. */
  readonly dashOffset = computed(() => {
    const pct = Math.max(0, Math.min(100, this.score())) / 100;
    return this.circumference * (1 - pct);
  });

  /** Colour band that mirrors the label thresholds (≥80 Primed, ≥65 Steady, ≥45 Run down, else Depleted). */
  readonly band = computed<'good' | 'mid' | 'low' | 'bad'>(() => {
    const s = this.score();
    if (s >= 80) return 'good';
    if (s >= 65) return 'mid';
    if (s >= 45) return 'low';
    return 'bad';
  });

  readonly ariaLabel = computed(
    () =>
      `Recovery score ${this.score()} out of 100, ${this.label()}. ` +
      `Sleep ${this.sleep()}, fuel ${this.fuel()}, caffeine ${this.caffeine()}, training ${this.training()}.`,
  );

  // ---- AI sleep insight (GET /api/ai/sleep-insight; reads the caller's own recovery snapshot) ----

  /** Gate: the AI recovery-insight affordance is hidden unless the user holds tracker.ai. */
  readonly showAi = this.auth.hasPermission(PERM.trackerAi);

  /** The fetched insight (recovery read + tips), or null until loaded. */
  readonly insight = signal<{ insight: string; tips: string } | null>(null);
  /** True while sleep-insight is in flight. */
  readonly insightLoading = signal(false);
  /** Polite sr-only announcement of the insight (or its unavailability). */
  readonly aiAnnounce = signal('');

  /**
   * Fetch the AI read of the caller's recovery (sleep + caffeine + training + score) and show it as a
   * small line. The endpoint always 200s with a deterministic floor; on a network blip we just leave the
   * line hidden — the deterministic score above never depends on AI.
   */
  async loadInsight(): Promise<void> {
    if (this.insightLoading()) return;
    this.insightLoading.set(true);
    this.aiAnnounce.set('Reading your recovery with AI…');
    try {
      const res = await firstValueFrom(this.api.sleepInsight());
      this.insight.set({ insight: res.insight, tips: res.tips });
      this.aiAnnounce.set(`Recovery: ${res.insight} ${res.tips}`);
    } catch {
      this.insight.set(null);
      this.aiAnnounce.set('AI recovery insight unavailable.');
      this.snack.open('AI insight unavailable — try again later', 'OK', { duration: 4000 });
    } finally {
      this.insightLoading.set(false);
    }
  }
}
