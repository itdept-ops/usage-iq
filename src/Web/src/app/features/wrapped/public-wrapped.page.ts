import {
  ChangeDetectionStrategy, Component, computed, inject, signal,
} from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';

import { Api } from '../../core/api';
import { PublicWrapped, PublicWrappedCard } from '../../core/models';

/** A rendered public stat (card + icon + accent). */
interface PubStat { readonly key: string; readonly num: string; readonly label: string; readonly sub: string | null; readonly accent: string; readonly icon: string; }

/**
 * PUBLIC Hub Wrapped viewer — the ANONYMOUS, PII-safe page behind a `/w/{token}` link. Clones the
 * {@link PublicShareView} pattern: token from the route → {@link Api.publicWrapped} → loading / error / data
 * states. NO auth, NO writes. The server already FILTERS to the baked PII-safe whitelist (sensitive cards are
 * never present) and serves the FROZEN narrative snapshot (no live AI call), and the owner is a DISPLAY NAME
 * only — so this page just renders what it receives. A 404 (invalid/expired/indistinguishable) surfaces as the
 * generic "link unavailable" state. Styled with the app's own --tech-* tokens + the shared accent palette.
 */
@Component({
  selector: 'app-public-wrapped',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule],
  styleUrl: './wrapped.page.scss',
  template: `
    <div class="wr wr--public">
      @if (loading()) {
        <div class="wr-hero">
          <div class="wr-hero__skel" aria-hidden="true">
            <span class="wr-sk wr-sk--word"></span>
            <span class="wr-sk wr-sk--line"></span>
          </div>
        </div>
      } @else if (errored()) {
        <div class="wr-hero" role="alert">
          <p class="wr-hero__kicker"><mat-icon aria-hidden="true">link_off</mat-icon> Usage IQ</p>
          <h1 class="wr-hero__title">Link unavailable</h1>
          <p class="wr-hero__sub">This shared recap is invalid or has expired.</p>
        </div>
      } @else if (data(); as d) {
        <header class="wr-hero">
          <span class="wr-hero__glow" aria-hidden="true"></span>
          <p class="wr-hero__kicker"><mat-icon aria-hidden="true">auto_awesome</mat-icon> Hub Wrapped</p>
          <h1 class="wr-hero__title">{{ d.label || coverTitle(d.period) }}</h1>
          <p class="wr-hero__sub">{{ d.ownerName }}'s highlight reel.</p>
          <span class="wr-hero__range">
            <mat-icon aria-hidden="true">calendar_today</mat-icon> {{ rangeLabel(d) }}
          </span>
        </header>

        @if (d.narrative) {
          <section class="wr-story">
            <p class="wr-story__text">{{ d.narrative }}</p>
            @if (d.insights?.length) {
              <ul class="wr-story__insights">
                @for (ins of d.insights; track ins) {
                  <li><mat-icon aria-hidden="true">trending_up</mat-icon>{{ ins }}</li>
                }
              </ul>
            }
          </section>
        }

        <section class="wr-grid" aria-label="Highlights">
          @for (s of stats(); track s.key) {
            <article class="wr-stat" [style.--ga]="paFor(s.accent)" [style.--gb]="pbFor(s.accent)">
              <span class="wr-stat__ico"><mat-icon aria-hidden="true">{{ s.icon }}</mat-icon></span>
              <span class="wr-stat__num">{{ s.num }}</span>
              <span class="wr-stat__label">{{ s.label }}</span>
              @if (s.sub) { <span class="wr-stat__sub">{{ s.sub }}</span> }
            </article>
          }
        </section>

        <footer class="wr-foot">
          Read-only shared recap · via Usage IQ · expires {{ fmtDateTime(d.expiresUtc) }}
        </footer>
      }
    </div>
  `,
})
export class PublicWrappedView {
  private api = inject(Api);
  private route = inject(ActivatedRoute);

  readonly data = signal<PublicWrapped | null>(null);
  readonly loading = signal(true);
  readonly errored = signal(false);

  readonly stats = computed<PubStat[]>(() => (this.data()?.cards ?? []).map((c: PublicWrappedCard) => ({
    key: c.key,
    num: c.headline,
    label: c.label,
    sub: c.sub ?? null,
    accent: this.accentKey(c.accent),
    icon: PublicWrappedView.ICONS[c.key] ?? 'auto_awesome',
  })));

  constructor() {
    const token = this.route.snapshot.paramMap.get('token') ?? '';
    this.api.publicWrapped(token).subscribe({
      next: (d) => { this.data.set(d); this.loading.set(false); },
      error: () => { this.errored.set(true); this.loading.set(false); },
    });
  }

  coverTitle(period: string): string {
    switch (period) {
      case 'year': return 'Their Year';
      case 'all': return 'All-Time';
      default: return 'This Month';
    }
  }
  rangeLabel(d: PublicWrapped): string {
    if (d.period === 'all') return `Through ${this.fmt(d.toDate)}`;
    return `${this.fmt(d.fromDate)} – ${this.fmt(d.toDate)}`;
  }

  private static readonly ACCENT_KEYS = new Set([
    'primary', 'exercise', 'food', 'activity', 'hydration', 'coffee',
    'weight', 'sleep', 'hard', 'trophy', 'bills', 'usage',
  ]);
  private accentKey(accent: string | null | undefined): string {
    return accent && PublicWrappedView.ACCENT_KEYS.has(accent) ? accent : 'primary';
  }
  paFor(k: string): string { return `var(--pa-${k})`; }
  pbFor(k: string): string { return `var(--pb-${k})`; }

  private static readonly ICONS: Record<string, string> = {
    'days-tracked': 'event_available',
    'workouts': 'fitness_center',
    'protein': 'egg_alt',
    'calories-out': 'local_fire_department',
    'steps': 'directions_walk',
    'hydration': 'water_drop',
    'coffee': 'local_cafe',
    'hard': 'military_tech',
    'trophies': 'emoji_events',
    'usage': 'insights',
  };

  private fmt(iso: string | null | undefined): string {
    if (!iso) return '';
    const [y, m, d] = iso.split('-').map(Number);
    if (!y || !m || !d) return iso;
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }
  fmtDateTime(iso: string | null | undefined): string {
    if (!iso) return '';
    const dt = new Date(iso);
    return Number.isNaN(dt.getTime()) ? iso : dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
}
