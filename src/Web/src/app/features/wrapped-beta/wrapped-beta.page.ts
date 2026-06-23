import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { firstValueFrom } from 'rxjs';

import { Api } from '../../core/api';
import { WrappedCard, WrappedPeriod, WrappedResponse } from '../../core/models';

/** A period choice for the sticky switcher. */
interface PeriodOption {
  readonly key: WrappedPeriod;
  readonly label: string;
}

/**
 * Hub Wrapped — the caller's "highlight reel" of their OWN Hub over a chosen period (Month / Year / All-time):
 * a vertical story of big, gradient-accented, staggered-reveal stat cards.
 *
 * DATA PARITY + PRIVACY: every number comes straight from {@link Api.wrapped} (`GET /api/wrapped`), which
 * DERIVES each figure server-side by reusing the existing owner-scoped aggregations (so Wrapped agrees with
 * the rest of the app). The response carries the caller's display NAME + userId only — never an email, never a
 * secret. This page only ever renders the caller's own data; it performs NO writes and re-derives nothing
 * client-side. Cards arrive pre-filtered (0-valued cards are dropped server-side) so the reel only tells the
 * parts of the story that actually happened.
 *
 * ISOLATION: all design tokens live on this component's `:host` (wrapped-beta.page.scss) — NO global
 * `--tech-*`, and no live page is imported. Reduced-motion collapses the reveal; layout is mobile-first
 * (44px targets, safe-area insets, no 390px overflow) and centers on desktop.
 */
@Component({
  selector: 'app-wrapped-beta',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './wrapped-beta.page.scss',
  imports: [RouterLink, MatIconModule],
  template: `
    <!-- ─────────────── STICKY PERIOD SWITCHER ─────────────── -->
    <header class="wb-switcher">
      <div class="wb-seg" role="tablist" aria-label="Wrapped period">
        @for (p of periods; track p.key) {
          <button type="button" class="wb-seg__btn"
                  [class.is-active]="period() === p.key"
                  role="tab" [attr.aria-selected]="period() === p.key"
                  [disabled]="loading()"
                  (click)="setPeriod(p.key)">{{ p.label }}</button>
        }
      </div>
    </header>

    <!-- ─────────────── SCROLL REGION ─────────────── -->
    <main class="wb-scroll" aria-live="polite">
      @if (loading()) {
        <div class="wb-cover" aria-hidden="true">
          <p class="wb-cover__kicker">Hub Wrapped</p>
          <h1 class="wb-cover__title">…</h1>
        </div>
        <div class="wb-skeleton" aria-hidden="true"></div>
        <div class="wb-skeleton" aria-hidden="true"></div>
        <div class="wb-skeleton" aria-hidden="true"></div>
      } @else if (errored()) {
        <div class="wb-empty">
          <span class="wb-empty__icon"><mat-icon aria-hidden="true">error_outline</mat-icon></span>
          <h2>Couldn't load Wrapped</h2>
          <p>Something went wrong fetching your highlight reel. Try again.</p>
          <button type="button" class="wb-empty__btn" (click)="reload()">Retry</button>
        </div>
      } @else if (!cards().length) {
        <div class="wb-empty">
          <span class="wb-empty__icon"><mat-icon aria-hidden="true">auto_awesome</mat-icon></span>
          <h2>Nothing to wrap… yet</h2>
          <p>Log a few things first — a workout, a meal, some water — and your highlight reel will fill in.</p>
          <a class="wb-empty__btn" routerLink="/tracker-beta">Open the tracker</a>
        </div>
      } @else {
        <!-- COVER -->
        <div class="wb-cover">
          <p class="wb-cover__kicker">Hub Wrapped</p>
          <h1 class="wb-cover__title">{{ coverTitle() }}</h1>
          <p class="wb-cover__sub">{{ data()?.userName }}, here's your highlight reel.</p>
          <p class="wb-cover__range">{{ rangeLabel() }}</p>
        </div>

        <!-- STORY CARDS -->
        @for (c of cards(); track c.key; let i = $index) {
          <article class="wb-card"
                   [style.--accent]="gradientFor(c.accent)"
                   [style.--delay.ms]="i * 90">
            <span class="wb-card__icon" [style.background]="gradientFor(c.accent)">
              <mat-icon aria-hidden="true">{{ iconFor(c) }}</mat-icon>
            </span>
            <!-- NO inline [style.background] here: the headline is gradient-CLIPPED to text via the
                 stylesheet (background:var(--accent) + background-clip:text). An inline background
                 SHORTHAND resets background-clip to border-box (and wins over the stylesheet), which
                 made the gradient fill the whole box + -webkit-text-fill-color:transparent hid the
                 number. The accent comes from the --accent set on the card above. -->
            <p class="wb-card__headline">{{ c.headline }}</p>
            <p class="wb-card__label">{{ c.label }}</p>
            @if (c.sub) { <p class="wb-card__sub">{{ c.sub }}</p> }
          </article>
        }

        <p class="wb-outro">That's a wrap. Keep showing up. ✨</p>
      }
    </main>
  `,
})
export class WrappedBetaPage {
  private api = inject(Api);

  readonly periods: readonly PeriodOption[] = [
    { key: 'month', label: 'Month' },
    { key: 'year', label: 'Year' },
    { key: 'all', label: 'All-time' },
  ];

  readonly period = signal<WrappedPeriod>('month');
  readonly data = signal<WrappedResponse | null>(null);
  readonly loading = signal(true);
  readonly errored = signal(false);

  readonly cards = computed<WrappedCard[]>(() => this.data()?.cards ?? []);

  /** The big gradient cover word for the active period. */
  readonly coverTitle = computed(() => {
    switch (this.period()) {
      case 'year': return 'Your Year';
      case 'all': return 'All-Time';
      default: return 'This Month';
    }
  });

  /** Friendly human range under the cover (e.g. "Jun 1 – Jun 23, 2026"). */
  readonly rangeLabel = computed(() => {
    const d = this.data();
    if (!d) return '';
    if (d.period === 'all') return `Through ${this.fmt(d.toDate)}`;
    return `${this.fmt(d.fromDate)} – ${this.fmt(d.toDate)}`;
  });

  constructor() {
    this.reload();
  }

  setPeriod(p: WrappedPeriod): void {
    if (p === this.period()) return;
    this.period.set(p);
    this.reload();
  }

  async reload(): Promise<void> {
    this.loading.set(true);
    this.errored.set(false);
    try {
      this.data.set(await firstValueFrom(this.api.wrapped(this.period())));
    } catch {
      this.errored.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  /** Map a server accent hint to one of the :host per-accent gradients (falls back to the primary spark). */
  gradientFor(accent: string | null | undefined): string {
    const known = new Set([
      'primary', 'exercise', 'food', 'activity', 'hydration', 'coffee',
      'weight', 'sleep', 'hard', 'trophy', 'bills', 'usage',
    ]);
    const key = accent && known.has(accent) ? accent : 'primary';
    return `var(--grad-${key})`;
  }

  /** A Material icon per card key (purely cosmetic; the headline number is the story). */
  iconFor(c: WrappedCard): string {
    return WrappedBetaPage.ICONS[c.key] ?? 'auto_awesome';
  }

  private static readonly ICONS: Record<string, string> = {
    'days-tracked': 'event_available',
    'workouts': 'fitness_center',
    'protein': 'egg_alt',
    'calories-out': 'local_fire_department',
    'steps': 'directions_walk',
    'hydration': 'water_drop',
    'coffee': 'local_cafe',
    'weight-delta': 'monitor_weight',
    'sleep': 'bedtime',
    'hard': 'military_tech',
    'trophies': 'emoji_events',
    'bills': 'receipt_long',
    'usage': 'insights',
  };

  /** yyyy-MM-dd → "Jun 23, 2026" (locale-friendly, tz-safe by parsing the parts). */
  private fmt(iso: string): string {
    const [y, m, d] = iso.split('-').map(Number);
    if (!y || !m || !d) return iso;
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }
}
