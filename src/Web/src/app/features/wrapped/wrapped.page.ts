import {
  ChangeDetectionStrategy, Component, computed, inject, signal,
} from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { firstValueFrom } from 'rxjs';

import { Api } from '../../core/api';
import { WrappedCard, WrappedNarrative, WrappedPeriod, WrappedResponse } from '../../core/models';

/** A headline stat cell in the desktop recap grid. */
interface RecapStat { readonly key: string; readonly num: string; readonly label: string; readonly sub: string | null; readonly accent: string; readonly icon: string; }

/**
 * Hub Wrapped — the DESKTOP, first-class, premium/celebratory "year in the Hub" recap of the caller's OWN
 * data over a chosen period (Month / Year / All-time). The desktop twin of the mobile {@link WrappedBetaPage}
 * reel: instead of a full-bleed swipeable story it lays the same DERIVED numbers out as a wide, glanceable
 * dashboard — a gradient hero, the AI narrative read, a stat grid, and the full card tail — with the SAME
 * Create-public-link + Share affordances.
 *
 * DATA + PRIVACY: every figure comes from {@link Api.wrapped} (`GET /api/wrapped`), derived server-side from the
 * existing owner-scoped aggregations; the AI narrative from {@link Api.wrappedNarrative} (always 200 — the
 * deterministic floor when AI is off). The page renders only the caller's OWN data, performs no writes, and
 * re-derives nothing client-side. The public share link is created via {@link Api.createWrappedShare}, which bakes
 * the owner/window/whitelist + a frozen narrative server-side (sensitive cards default-excluded — never widened).
 *
 * STYLING: uses the app's own `--tech-*` design tokens (NOT the marketing `_aurora.scss`, which is scoped to
 * marketing) with a celebratory gradient hero — a centered, responsive desktop page.
 */
@Component({
  selector: 'app-wrapped',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule],
  styleUrl: './wrapped.page.scss',
  template: `
    <div class="wr">
      <!-- ─────────── HERO ─────────── -->
      <header class="wr-hero">
        <span class="wr-hero__glow" aria-hidden="true"></span>
        <div class="wr-hero__head">
          <p class="wr-hero__kicker">
            <mat-icon aria-hidden="true">auto_awesome</mat-icon> Hub Wrapped
          </p>
          <div class="wr-hero__periods" role="tablist" aria-label="Wrapped period">
            @for (p of periods; track p.key) {
              <button type="button" class="wr-chip" role="tab"
                      [class.is-on]="period() === p.key" [attr.aria-selected]="period() === p.key"
                      [disabled]="loading()" (click)="setPeriod(p.key)">{{ p.label }}</button>
            }
          </div>
        </div>

        @if (loading()) {
          <div class="wr-hero__skel" aria-hidden="true">
            <span class="wr-sk wr-sk--word"></span>
            <span class="wr-sk wr-sk--line"></span>
          </div>
        } @else if (errored()) {
          <h1 class="wr-hero__title">Couldn't load Wrapped</h1>
          <p class="wr-hero__sub">Something went wrong fetching your recap.</p>
          <button type="button" class="wr-btn wr-btn--solid" (click)="reload()">
            <mat-icon aria-hidden="true">refresh</mat-icon> Try again
          </button>
        } @else if (!cards().length) {
          <h1 class="wr-hero__title">Nothing to wrap… yet</h1>
          <p class="wr-hero__sub">
            Log a few things — a workout, a meal, some water — and your recap writes itself.
          </p>
          <a class="wr-btn wr-btn--solid" href="/tracker">
            <mat-icon aria-hidden="true">arrow_forward</mat-icon> Open the tracker
          </a>
        } @else {
          <h1 class="wr-hero__title">{{ coverTitle() }}</h1>
          <p class="wr-hero__sub">{{ data()?.userName }}, here's your highlight reel.</p>
          <span class="wr-hero__range">
            <mat-icon aria-hidden="true">calendar_today</mat-icon> {{ rangeLabel() }}
          </span>
          <div class="wr-hero__actions">
            <button type="button" class="wr-btn wr-btn--solid"
                    [disabled]="sharing()" (click)="createShareLink()">
              <mat-icon aria-hidden="true">{{ sharing() ? 'hourglass_top' : 'link' }}</mat-icon>
              {{ sharing() ? 'Creating…' : 'Create public link' }}
            </button>
            <button type="button" class="wr-btn wr-btn--ghost" (click)="share()">
              <mat-icon aria-hidden="true">ios_share</mat-icon> Share text
            </button>
          </div>
          @if (linkCopied(); as url) {
            <p class="wr-hero__copied" aria-live="polite">
              <mat-icon aria-hidden="true">check_circle</mat-icon> Public link copied — {{ url }}
            </p>
          }
        }
      </header>

      @if (!loading() && !errored() && cards().length) {
        <!-- ─────────── AI NARRATIVE ─────────── -->
        @if (narrative()?.narrative; as story) {
          <section class="wr-story">
            <p class="wr-story__text">{{ story }}</p>
            @if (narrative()?.insights?.length) {
              <ul class="wr-story__insights">
                @for (ins of narrative()?.insights ?? []; track ins) {
                  <li><mat-icon aria-hidden="true">trending_up</mat-icon>{{ ins }}</li>
                }
              </ul>
            }
          </section>
        }

        <!-- ─────────── STAT GRID ─────────── -->
        <section class="wr-grid" aria-label="Your highlights">
          @for (s of stats(); track s.key) {
            <article class="wr-stat" [style.--ga]="paFor(s.accent)" [style.--gb]="pbFor(s.accent)">
              <span class="wr-stat__ico"><mat-icon aria-hidden="true">{{ s.icon }}</mat-icon></span>
              <span class="wr-stat__num">{{ s.num }}</span>
              <span class="wr-stat__label">{{ s.label }}</span>
              @if (s.sub) { <span class="wr-stat__sub">{{ s.sub }}</span> }
            </article>
          }
        </section>
      }
    </div>
  `,
})
export class WrappedPage {
  private api = inject(Api);

  readonly periods: { key: WrappedPeriod; label: string }[] = [
    { key: 'month', label: 'Month' },
    { key: 'year', label: 'Year' },
    { key: 'all', label: 'All-time' },
  ];

  readonly period = signal<WrappedPeriod>('month');
  readonly data = signal<WrappedResponse | null>(null);
  readonly narrative = signal<WrappedNarrative | null>(null);
  readonly loading = signal(true);
  readonly errored = signal(false);
  readonly sharing = signal(false);
  /** The most-recently-created public link (echoed under the hero), or null. */
  readonly linkCopied = signal<string | null>(null);

  readonly cards = computed<WrappedCard[]>(() => this.data()?.cards ?? []);

  readonly coverTitle = computed(() => {
    switch (this.period()) {
      case 'year': return 'Your Year';
      case 'all': return 'All-Time';
      default: return 'This Month';
    }
  });

  readonly rangeLabel = computed(() => {
    const d = this.data();
    if (!d) return '';
    if (d.period === 'all') return `Through ${this.fmt(d.toDate)}`;
    return `${this.fmt(d.fromDate)} – ${this.fmt(d.toDate)}`;
  });

  readonly stats = computed<RecapStat[]>(() => this.cards().map(c => ({
    key: c.key,
    num: c.headline,
    label: c.label,
    sub: c.sub ?? null,
    accent: this.accentKey(c.accent),
    icon: WrappedPage.ICONS[c.key] ?? 'auto_awesome',
  })));

  constructor() {
    this.reload();
  }

  setPeriod(p: WrappedPeriod): void {
    if (p === this.period()) return;
    this.period.set(p);
    this.linkCopied.set(null);
    this.reload();
  }

  async reload(): Promise<void> {
    this.loading.set(true);
    this.errored.set(false);
    this.narrative.set(null);
    const period = this.period();
    try {
      const res = await firstValueFrom(this.api.wrapped(period));
      this.data.set(res);
      if (res.cards.length) void this.loadNarrative(period);
    } catch {
      this.errored.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  /** Best-effort narrative load (the endpoint always 200s; a transport hiccup just leaves it off). */
  private async loadNarrative(period: WrappedPeriod): Promise<void> {
    try {
      const n = await firstValueFrom(this.api.wrappedNarrative(period));
      if (period === this.period()) this.narrative.set(n);
    } catch { /* progressive enhancement */ }
  }

  /** Create a PUBLIC, PII-safe share link for the caller's OWN recap and copy the absolute URL. */
  async createShareLink(): Promise<void> {
    if (!this.cards().length || this.sharing()) return;
    this.sharing.set(true);
    this.linkCopied.set(null);
    try {
      const created = await firstValueFrom(this.api.createWrappedShare({ period: this.period() }));
      const origin = typeof location !== 'undefined' ? location.origin : '';
      const url = `${origin}${created.path}`;
      try {
        await navigator?.clipboard?.writeText(url);
      } catch { /* clipboard blocked — still echo the URL below so it's copyable by hand */ }
      this.linkCopied.set(url);
    } catch {
      this.linkCopied.set(null);
    } finally {
      this.sharing.set(false);
    }
  }

  /** Plain-text recap → Web Share API → clipboard fallback. */
  async share(): Promise<void> {
    const d = this.data();
    if (!d || !this.cards().length) return;
    const lines = [
      `My Hub Wrapped — ${this.coverTitle()} (${this.rangeLabel()})`,
      ...this.cards().slice(0, 6).map(c => `• ${c.headline} — ${c.label}`),
      'via Usage IQ',
    ];
    const text = lines.join('\n');
    const nav: (Navigator & { share?: (d: ShareData) => Promise<void> }) | undefined =
      typeof navigator !== 'undefined' ? navigator : undefined;
    if (nav?.share) {
      try { await nav.share({ title: `Hub Wrapped — ${this.coverTitle()}`, text }); return; } catch { return; }
    }
    try { await nav?.clipboard?.writeText(text); } catch { /* nothing more to do */ }
  }

  // ─────────────── ACCENT + ICON MAPPING (mirrors the mobile reel) ───────────────

  private static readonly ACCENT_KEYS = new Set([
    'primary', 'exercise', 'food', 'activity', 'hydration', 'coffee',
    'weight', 'sleep', 'hard', 'trophy', 'bills', 'usage',
  ]);
  private accentKey(accent: string | null | undefined): string {
    return accent && WrappedPage.ACCENT_KEYS.has(accent) ? accent : 'primary';
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
    'weight-delta': 'monitor_weight',
    'sleep': 'bedtime',
    'hard': 'military_tech',
    'trophies': 'emoji_events',
    'bills': 'receipt_long',
    'usage': 'insights',
  };

  /** yyyy-MM-dd → "Jun 23, 2026" (tz-safe by parsing the parts). */
  private fmt(iso: string | null | undefined): string {
    if (!iso) return '';
    const [y, m, d] = iso.split('-').map(Number);
    if (!y || !m || !d) return iso;
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }
}
