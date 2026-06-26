import {
  ChangeDetectionStrategy, Component, DestroyRef, ElementRef, NgZone, computed,
  effect, inject, signal, viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { firstValueFrom } from 'rxjs';

import { Api } from '../../core/api';
import { WrappedCard, WrappedPeriod, WrappedResponse } from '../../core/models';
import {
  BetaPullRefresh, BetaSegmentedControl, BetaSkeleton, BetaToaster, ToastController,
  type Segment,
} from '../beta-ui';

/** A spark dot drifting behind a slide (precomputed so it stays stable across renders). */
interface Spark {
  readonly x: string; readonly y: string; readonly s: string; readonly d: string; readonly dur: string;
}

/**
 * One slide of the reel. The COVER is a synthetic intro slide; every other slide wraps a
 * {@link WrappedCard}. `numTarget`/`numText` carry the parsed numeric part of the headline so the
 * active slide can count up to it, while `numPrefix`/`numSuffix`/`unit` hold the non-numeric trim.
 */
interface Slide {
  readonly kind: 'cover' | 'card';
  readonly key: string;
  readonly accent: string;          // accent key (maps to --grad-* / --pa-*/--pb-*)
  readonly icon: string;
  readonly card?: WrappedCard;
  // numeral parts (card slides only)
  readonly numPrefix: string;       // e.g. "$" or "+"
  readonly numText: string;         // the raw numeric token as displayed (e.g. "12,480")
  readonly numTarget: number;       // numeric value to count up to (0 when non-numeric)
  readonly numDecimals: number;     // how many fraction digits the display token carries
  readonly numGroup: boolean;       // whether to group thousands while counting
  readonly numSuffix: string;       // e.g. "k", "%", "h"
  readonly unit: string;            // a trailing word unit (the card label is the big caption)
  readonly sparks: readonly Spark[];
}

/** A cell in the shareable recap grid (top headline stats). */
interface RecapCell { readonly num: string; readonly label: string; readonly accent: string; }

/**
 * Hub Wrapped — the SHOWPIECE "Wrapped" highlight reel: a full-bleed, immersive, swipeable STORY of the
 * caller's OWN Hub over a chosen period (Month / Year / All-time). Rebuilt on the shared beta-ui "Strata"
 * kit (`@use '../beta-ui/beta-kit'`) with a signature PURPLE → MAGENTA accent that re-skins the whole
 * screen via the per-page accent contract. A horizontal scroll-snap REEL of large gradient hero slides
 * with HUGE Clash Display numerals (animated count-ups on the active slide), per-slide accent blooms +
 * spark confetti + spring reveals, a progress-dot tray, and a SHAREABLE summary card (Web Share API +
 * clipboard fallback) — a premium year-in-review. Pull-to-refresh + an elevated empty/loading/error state.
 *
 * DATA PARITY + PRIVACY: every number comes straight from {@link Api.wrapped} (`GET /api/wrapped`), which
 * DERIVES each figure server-side by reusing the existing owner-scoped aggregations (so Wrapped agrees with
 * the rest of the app). The response carries the caller's display NAME + userId only — never an email, never
 * a secret. This page only ever renders the caller's own data; it performs NO writes and re-derives nothing
 * client-side. Cards arrive pre-filtered (0-valued cards dropped server-side) so the reel only tells the
 * parts of the story that actually happened.
 *
 * ISOLATION: gated by `beta.access`; consumes the kit + the SAME read-only Api as the live counterpart. No
 * live page is imported or modified; the flagship tracker-beta + the kit are consumed, never changed.
 * Reduced-motion collapses the reveals/count-ups via the kit a11y killswitch; layout is mobile-first
 * (44px targets, safe-area insets, no 390px overflow) and centers on desktop.
 */
@Component({
  selector: 'app-wrapped-beta',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './wrapped-beta.page.scss',
  providers: [ToastController],
  imports: [
    RouterLink, MatIconModule,
    BetaPullRefresh, BetaSegmentedControl, BetaSkeleton, BetaToaster,
  ],
  template: `
    <!-- ─────────────── STICKY GLASS TOP: period switcher + share ─────────────── -->
    <header class="wb-top">
      <app-bs-segmented class="wb-top__seg"
        [segments]="periodSegments" [value]="period()" label="Wrapped period"
        [disabled]="loading()" (change)="setPeriod($event)" />
      @if (!loading() && !errored() && slides().length) {
        <span class="wb-top__count" aria-hidden="true">{{ active() + 1 }} / {{ slides().length }}</span>
      }
      <button type="button" class="wb-top__share" aria-label="Share your Wrapped"
              [disabled]="loading() || errored() || !cards().length" (click)="share()">
        <mat-icon aria-hidden="true">ios_share</mat-icon>
      </button>
    </header>

    <!-- A single sr-only polite node: announces only on slide CHANGE (not the per-rAF count-up). -->
    <span class="wb-sr" aria-live="polite">{{ slideAnnounce() }}</span>

    <!-- ─────────────── PULL-TO-REFRESH OWNS THE SCROLL ─────────────── -->
    <app-bs-pull-refresh class="wb-ptr" [busy]="refreshing()" (refresh)="reload()">
      <div class="wb-scroll">

        @if (loading()) {
          <div class="wb-load" aria-hidden="true">
            <p class="wb-load__word">Wrapped</p>
            <div class="wb-load__bars">
              <app-bs-skeleton height="120px" radius="var(--r-card)" />
              <app-bs-skeleton height="56px" radius="var(--r-pill)" width="62%" />
              <app-bs-skeleton height="56px" radius="var(--r-pill)" width="48%" />
            </div>
          </div>

        } @else if (errored()) {
          <div class="wb-state">
            <span class="wb-state__orb"><mat-icon aria-hidden="true">error_outline</mat-icon></span>
            <h2 class="wb-state__title">Couldn't load Wrapped</h2>
            <p class="wb-state__body">Something went wrong fetching your highlight reel. Give it another go.</p>
            <button type="button" class="wb-state__cta" (click)="reload()">
              <mat-icon aria-hidden="true">refresh</mat-icon> Try again
            </button>
          </div>

        } @else if (!cards().length) {
          <div class="wb-state">
            <span class="wb-state__orb"><mat-icon aria-hidden="true">auto_awesome</mat-icon></span>
            <h2 class="wb-state__title">Nothing to wrap… yet</h2>
            <p class="wb-state__body">
              Log a few things first — a workout, a meal, some water — and your highlight reel
              writes itself. Come back to a story worth sharing.
            </p>
            <a class="wb-state__cta" routerLink="/tracker-beta">
              <mat-icon aria-hidden="true">arrow_forward</mat-icon> Open the tracker
            </a>
          </div>

        } @else {
          <!-- ─── THE REEL: a horizontal snap-scroll of full-bleed story slides ─── -->
          <div #reel class="wb-reel" role="group" aria-roledescription="carousel"
               aria-label="Your Wrapped highlight reel" (scroll)="onReelScroll()">
            @for (s of slides(); track s.key; let i = $index) {
              <section class="wb-slide" [class.wb-cover]="s.kind === 'cover'"
                       [class.is-active]="active() === i"
                       [attr.aria-roledescription]="'slide'"
                       [attr.aria-label]="(i + 1) + ' of ' + slides().length"
                       [style.--sa]="paFor(s.accent)" [style.--sb]="pbFor(s.accent)"
                       [style.--pa]="paFor(s.accent)" [style.--pb]="pbFor(s.accent)">
                <span class="wb-slide__bloom" aria-hidden="true"></span>
                <span class="wb-slide__vignette" aria-hidden="true"></span>
                <span class="wb-slide__sparks" aria-hidden="true">
                  @for (sp of s.sparks; track $index) {
                    <span class="wb-spark"
                          [style.--x]="sp.x" [style.--y]="sp.y" [style.--s]="sp.s"
                          [style.--d]="sp.d" [style.--dur]="sp.dur"></span>
                  }
                </span>

                @if (s.kind === 'cover') {
                  <p class="wb-cover__kicker wb-reveal" [style.--ri]="0">Hub Wrapped</p>
                  <h1 class="wb-cover__word wb-reveal" [style.--ri]="1">{{ coverTitle() }}</h1>
                  <p class="wb-cover__name wb-reveal" [style.--ri]="2">
                    {{ data()?.userName }}, here's your highlight reel.
                  </p>
                  <span class="wb-cover__range wb-reveal" [style.--ri]="3">
                    <mat-icon aria-hidden="true" style="font-size:16px;width:16px;height:16px">calendar_today</mat-icon>
                    {{ rangeLabel() }}
                  </span>
                  <span class="wb-cover__hint wb-reveal" [style.--ri]="4" aria-hidden="true">
                    Swipe to begin <mat-icon>arrow_forward</mat-icon>
                  </span>
                } @else {
                  <span class="wb-slide__chip wb-reveal" [style.--ri]="0">
                    <span class="wb-slide__chip-ico"><mat-icon aria-hidden="true">{{ s.icon }}</mat-icon></span>
                    {{ s.card?.label }}
                  </span>
                  <p class="wb-slide__num wb-reveal" [style.--ri]="1"
                     [attr.aria-label]="s.card?.headline">
                    <span aria-hidden="true">{{ active() === i ? displayNum(i) : s.numText }}</span>@if (s.unit) {<span class="wb-slide__unit">{{ s.unit }}</span>}
                  </p>
                  <h2 class="wb-slide__label wb-reveal" [style.--ri]="2">{{ s.card?.label }}</h2>
                  @if (s.card?.sub) {
                    <p class="wb-slide__sub wb-reveal" [style.--ri]="3">{{ s.card?.sub }}</p>
                  }
                  @if (i === slides().length - 1) {
                    <div class="wb-slide__outro wb-reveal" [style.--ri]="4">
                      <button type="button" class="wb-replay" (click)="replay()">
                        <mat-icon aria-hidden="true">replay</mat-icon> Start over
                      </button>
                      <button type="button" class="wb-replay wb-replay--ghost" (click)="copyShare()">
                        <mat-icon aria-hidden="true">content_copy</mat-icon> Copy recap
                      </button>
                    </div>
                  }
                }
              </section>
            }
          </div>

          <!-- progress-dot tray + keyboard Prev/Next arrows -->
          <div class="wb-tray">
            <button type="button" class="wb-nav" aria-label="Previous slide"
                    [disabled]="active() === 0" (click)="prev()">
              <mat-icon aria-hidden="true">chevron_left</mat-icon>
            </button>
            <div class="wb-dots" role="tablist" aria-label="Reel progress">
              @for (s of slides(); track s.key; let i = $index) {
                <button type="button" class="wb-dot" [class.is-on]="active() === i"
                        role="tab" [attr.aria-selected]="active() === i"
                        [attr.aria-label]="'Go to slide ' + (i + 1)"
                        (click)="goTo(i)"></button>
              }
            </div>
            <button type="button" class="wb-nav" aria-label="Next slide"
                    [disabled]="active() >= slides().length - 1" (click)="next()">
              <mat-icon aria-hidden="true">chevron_right</mat-icon>
            </button>
          </div>

          <!-- ─── SHAREABLE SUMMARY CARD ─── -->
          <article class="wb-recap" aria-label="Your Wrapped summary">
            <div class="wb-recap__band">
              <p class="wb-recap__kicker">Hub Wrapped · {{ rangeLabel() }}</p>
              <h2 class="wb-recap__title">{{ coverTitle() }}</h2>
              <p class="wb-recap__name">{{ data()?.userName }}</p>
            </div>
            @if (recapCells().length) {
              <div class="wb-recap__grid">
                @for (c of recapCells(); track c.label) {
                  <div class="wb-recap__cell">
                    <span class="wb-recap__cell-num" [style.--cn]="paFor(c.accent)">{{ c.num }}</span>
                    <span class="wb-recap__cell-label">{{ c.label }}</span>
                  </div>
                }
              </div>
            }
            <div class="wb-recap__foot">
              <div class="wb-recap__brand">
                <span class="wb-recap__brand-name">Usage IQ</span>
                <span class="wb-recap__brand-sub">{{ cards().length }} highlights this {{ periodNoun() }}</span>
              </div>
              <button type="button" class="wb-recap__share" (click)="share()">
                <mat-icon aria-hidden="true">ios_share</mat-icon> Share
              </button>
            </div>
          </article>

          <!-- the remaining-cards tail (everything, glanceable) -->
          @if (cards().length) {
            <div class="wb-tail">
              <p class="wb-tail__head">In this wrap</p>
              @for (c of cards(); track c.key) {
                <div class="wb-tail__row">
                  <span class="wb-tail__ico" [style.--tg]="gradientFor(c.accent)">
                    <mat-icon aria-hidden="true">{{ iconFor(c) }}</mat-icon>
                  </span>
                  <span class="wb-tail__txt">
                    <span class="wb-tail__label">{{ c.label }}</span>
                    @if (c.sub) { <span class="wb-tail__sub">{{ c.sub }}</span> }
                  </span>
                  <span class="wb-tail__val" [style.color]="solidFor(c.accent)">{{ c.headline }}</span>
                </div>
              }
            </div>
          }
        }
      </div>
    </app-bs-pull-refresh>

    <app-bs-toaster />
  `,
})
export class WrappedBetaPage {
  private api = inject(Api);
  private toast = inject(ToastController);
  private zone = inject(NgZone);
  private destroyRef = inject(DestroyRef);

  private readonly reelEl = viewChild<ElementRef<HTMLDivElement>>('reel');

  readonly periodSegments: Segment[] = [
    { key: 'month', label: 'Month' },
    { key: 'year', label: 'Year' },
    { key: 'all', label: 'All-time' },
  ];

  readonly period = signal<WrappedPeriod>('month');
  readonly data = signal<WrappedResponse | null>(null);
  readonly loading = signal(true);
  readonly errored = signal(false);
  readonly refreshing = signal(false);

  /** Index of the slide currently snapped into view (drives the dots + count-up). */
  readonly active = signal(0);

  /**
   * A single polite sr-only line that announces ONLY on slide change ("Slide N of M") — so a screen
   * reader isn't spammed by the per-rAF count-up that re-runs every animation frame on the active slide.
   */
  readonly slideAnnounce = computed(() => {
    const total = this.slides().length;
    return total ? `Slide ${this.active() + 1} of ${total}` : '';
  });

  readonly cards = computed<WrappedCard[]>(() => this.data()?.cards ?? []);

  /** The big gradient cover word for the active period. */
  readonly coverTitle = computed(() => {
    switch (this.period()) {
      case 'year': return 'Your Year';
      case 'all': return 'All-Time';
      default: return 'This Month';
    }
  });

  /** Lowercase noun for the brand line ("month" / "year" / "wrap"). */
  readonly periodNoun = computed(() => {
    switch (this.period()) {
      case 'year': return 'year';
      case 'all': return 'wrap';
      default: return 'month';
    }
  });

  /** Friendly human range under the cover (e.g. "Jun 1 – Jun 23, 2026"). */
  readonly rangeLabel = computed(() => {
    const d = this.data();
    if (!d) return '';
    if (d.period === 'all') return `Through ${this.fmt(d.toDate)}`;
    return `${this.fmt(d.fromDate)} – ${this.fmt(d.toDate)}`;
  });

  /** The reel slides: a synthetic cover + one per card. */
  readonly slides = computed<Slide[]>(() => {
    const cs = this.cards();
    if (!cs.length) return [];
    const cover: Slide = {
      kind: 'cover', key: '__cover', accent: 'primary', icon: 'auto_awesome',
      numPrefix: '', numText: '', numTarget: 0, numDecimals: 0, numGroup: false, numSuffix: '', unit: '',
      sparks: WrappedBetaPage.SPARKS,
    };
    const cardSlides = cs.map<Slide>((c, idx) => {
      const accent = this.accentKey(c.accent);
      const parsed = WrappedBetaPage.parseHeadline(c.headline);
      return {
        kind: 'card', key: c.key, accent, icon: this.iconFor(c), card: c,
        numPrefix: parsed.prefix, numText: parsed.text, numTarget: parsed.target,
        numDecimals: parsed.decimals, numGroup: parsed.group, numSuffix: parsed.suffix, unit: parsed.unit,
        sparks: WrappedBetaPage.SPARKS_BY_INDEX[idx % WrappedBetaPage.SPARKS_BY_INDEX.length],
      };
    });
    return [cover, ...cardSlides];
  });

  /** Top headline stats for the shareable recap grid (the first 4 card slides). */
  readonly recapCells = computed<RecapCell[]>(() =>
    this.cards().slice(0, 4).map(c => ({
      num: c.headline,
      label: c.label,
      accent: this.accentKey(c.accent),
    })),
  );

  // ---- count-up state (per active slide) ----
  /** The currently-displayed (animating) number for each slide index. */
  private readonly counted = signal<Record<number, string>>({});
  private rafId = 0;

  constructor() {
    this.reload();

    // Whenever the active slide changes (and after data loads), animate its numeral up from 0.
    effect(() => {
      const i = this.active();
      const slide = this.slides()[i];
      // Touch slides() above so this re-runs when the reel rebuilds.
      if (!slide || slide.kind !== 'card') return;
      this.runCountUp(i, slide);
    });

    this.destroyRef.onDestroy(() => cancelAnimationFrame(this.rafId));
  }

  setPeriod(key: string): void {
    const p = key as WrappedPeriod;
    if (p === this.period()) return;
    this.period.set(p);
    this.active.set(0);
    this.scrollReelTo(0, 'auto');
    this.reload();
  }

  async reload(): Promise<void> {
    const wasLoaded = !!this.data();
    if (wasLoaded) this.refreshing.set(true); else this.loading.set(true);
    this.errored.set(false);
    try {
      const res = await firstValueFrom(this.api.wrapped(this.period()));
      this.data.set(res);
      this.active.set(0);
      // After the new reel paints, ensure we're scrolled to the cover.
      queueMicrotask(() => this.scrollReelTo(0, 'auto'));
    } catch {
      this.errored.set(true);
    } finally {
      this.loading.set(false);
      this.refreshing.set(false);
    }
  }

  // ─────────────── REEL NAVIGATION ───────────────

  /** Update the active index from the reel's scroll position (page-width snapping). */
  onReelScroll(): void {
    const el = this.reelEl()?.nativeElement;
    if (!el) return;
    const w = el.clientWidth || 1;
    const i = Math.round(el.scrollLeft / w);
    if (i !== this.active()) this.active.set(Math.max(0, Math.min(i, this.slides().length - 1)));
  }

  /** Tap a dot → snap that slide into view. */
  goTo(i: number): void {
    this.active.set(i);
    this.scrollReelTo(i, 'smooth');
  }

  /** Keyboard Prev arrow → step back one slide (clamped). */
  prev(): void {
    if (this.active() > 0) this.goTo(this.active() - 1);
  }

  /** Keyboard Next arrow → step forward one slide (clamped). */
  next(): void {
    if (this.active() < this.slides().length - 1) this.goTo(this.active() + 1);
  }

  private scrollReelTo(i: number, behavior: ScrollBehavior): void {
    const el = this.reelEl()?.nativeElement;
    if (!el) return;
    el.scrollTo({ left: i * el.clientWidth, behavior });
  }

  // ─────────────── COUNT-UP ───────────────

  /** The live count-up string for a slide index (falls back to the final text). */
  displayNum(i: number): string {
    return this.counted()[i] ?? this.slides()[i]?.numText ?? '';
  }

  /**
   * Animate the slide's numeral from 0 → target with a spring-ease, writing into `counted`. Reduced-motion
   * (or a non-numeric headline) snaps straight to the final value. Cancels any in-flight rAF first.
   */
  private runCountUp(i: number, slide: Slide): void {
    const prefix = slide.numPrefix;
    const finalText = `${prefix}${slide.numText}`;
    cancelAnimationFrame(this.rafId);

    const reduce = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce || slide.numTarget <= 0 || !slide.numText) {
      this.counted.update(m => ({ ...m, [i]: finalText }));
      return;
    }

    const fmt = (v: number): string => {
      const n = slide.numDecimals > 0
        ? v.toLocaleString(undefined, { minimumFractionDigits: slide.numDecimals, maximumFractionDigits: slide.numDecimals })
        : (slide.numGroup ? Math.round(v).toLocaleString() : String(Math.round(v)));
      return `${prefix}${n}${slide.numSuffix}`;
    };

    // rAF outside Angular; commit the string back inside the zone each frame (cheap signal write, CD coalesces).
    this.zone.runOutsideAngular(() => {
      const DUR = 1100;
      const start = performance.now();
      const tick = (now: number) => {
        const t = Math.min(1, (now - start) / DUR);
        // easeOutBack-ish settle without overshooting past the target on the final frame.
        const eased = t >= 1 ? 1 : 1 - Math.pow(1 - t, 3);
        const v = slide.numTarget * eased;
        this.zone.run(() => this.counted.update(m => ({ ...m, [i]: t >= 1 ? finalText : fmt(v) })));
        if (t < 1) this.rafId = requestAnimationFrame(tick);
      };
      this.rafId = requestAnimationFrame(tick);
    });
  }

  // ─────────────── REPLAY ───────────────

  /** "Start over" on the final slide — jump back to the cover and restart the reel from the top. */
  replay(): void {
    this.goTo(0);
  }

  // ─────────────── SHARE ───────────────

  /**
   * Build a short one-line highlights summary from the WrappedResponse fields the page already has and
   * copy it to the clipboard (navigator.clipboard) with a success toast. A net-new affordance distinct
   * from {@link share} (which prefers the native Web Share sheet): this ALWAYS copies the short summary.
   */
  async copyShare(): Promise<void> {
    const d = this.data();
    if (!d || !this.cards().length) return;

    const parts: string[] = [];
    if (d.workouts > 0) parts.push(`${d.workouts.toLocaleString()} workout${d.workouts === 1 ? '' : 's'}`);
    if (d.hydrationBestStreak > 0) parts.push(`${d.hydrationBestStreak.toLocaleString()} day streak`);
    if (d.usageCostUsd > 0) parts.push(`$${d.usageCostUsd.toFixed(2)} on AI`);
    if (d.stepsTotal > 0) parts.push(`${d.stepsTotal.toLocaleString()} steps`);
    if (d.coffeeCups > 0) parts.push(`${d.coffeeCups.toLocaleString()} coffees`);

    // Fall back to the top card headlines if none of the structured fields fired.
    const summary = parts.length
      ? parts.slice(0, 4).join(', ')
      : this.cards().slice(0, 3).map(c => `${c.headline} ${c.label}`.toLowerCase()).join(', ');
    const text = `My Usage IQ Wrapped: ${summary} — ${this.rangeLabel()}`;

    const nav: (Navigator & { clipboard?: Clipboard }) | undefined =
      typeof navigator !== 'undefined' ? navigator : undefined;
    try {
      await nav?.clipboard?.writeText(text);
      this.toast.show('Highlights copied — paste them anywhere', { tone: 'success', durationMs: 2400 });
    } catch {
      this.toast.show('Couldn’t copy on this device', { tone: 'warn' });
    }
  }

  /** Build a plain-text recap and share it (Web Share API → clipboard fallback → toast). */
  async share(): Promise<void> {
    const d = this.data();
    if (!d || !this.cards().length) return;
    const lines = [
      `My Hub Wrapped — ${this.coverTitle()} (${this.rangeLabel()})`,
      ...this.cards().slice(0, 6).map(c => `• ${c.headline} — ${c.label}`),
      `via Usage IQ`,
    ];
    const text = lines.join('\n');
    const title = `Hub Wrapped — ${this.coverTitle()}`;

    // Capture into a loosely-typed local so the `'share' in nav` guard below doesn't narrow the
    // outer `navigator` to `never` for the clipboard fallback path.
    const nav: (Navigator & { share?: (d: ShareData) => Promise<void> }) | undefined =
      typeof navigator !== 'undefined' ? navigator : undefined;

    if (nav?.share) {
      try {
        await nav.share({ title, text });
        return;
      } catch {
        // user cancelled the native sheet, or it failed — nothing more to do.
        return;
      }
    }

    try {
      await nav?.clipboard.writeText(text);
      this.toast.show('Wrapped copied — paste it anywhere', { tone: 'success', durationMs: 2200 });
    } catch {
      this.toast.show('Couldn’t share on this device', { tone: 'warn' });
    }
  }

  // ─────────────── ACCENT + ICON MAPPING ───────────────

  private static readonly ACCENT_KEYS = new Set([
    'primary', 'exercise', 'food', 'activity', 'hydration', 'coffee',
    'weight', 'sleep', 'hard', 'trophy', 'bills', 'usage',
  ]);

  /** Normalize a server accent hint to a known key (falls back to 'primary'). */
  private accentKey(accent: string | null | undefined): string {
    return accent && WrappedBetaPage.ACCENT_KEYS.has(accent) ? accent : 'primary';
  }

  /** Map a server accent hint to one of the :host per-accent gradients. */
  gradientFor(accent: string | null | undefined): string {
    return `var(--grad-${this.accentKey(accent)})`;
  }

  /** Map a server accent hint to its SOLID vivid headline colour (the tail value colour). */
  solidFor(accent: string | null | undefined): string {
    return `var(--pa-${this.accentKey(accent)})`;
  }

  /** Per-accent gradient START stop (the slide numeral / recap cell). */
  paFor(accentKey: string): string { return `var(--pa-${accentKey})`; }
  /** Per-accent gradient END stop. */
  pbFor(accentKey: string): string { return `var(--pb-${accentKey})`; }

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

  // ─────────────── HEADLINE PARSING (for the count-up) ───────────────

  /**
   * Split a display headline into a numeric core + its trim so we can count up to it. Handles a leading
   * symbol ($, +, −/-), grouped thousands, decimals, a k/m magnitude suffix, a % or unit suffix, and a
   * trailing word unit (e.g. "12,480 steps"). Non-numeric headlines fall back to target 0 (no count-up).
   */
  private static parseHeadline(headline: string): {
    prefix: string; text: string; target: number; decimals: number; group: boolean; suffix: string; unit: string;
  } {
    const raw = (headline ?? '').trim();
    // prefix: a leading currency / sign symbol.
    const pre = raw.match(/^[$€£+\-−]/)?.[0] ?? '';
    const rest = pre ? raw.slice(pre.length).trim() : raw;
    // the first number token (grouped, optional decimals).
    const m = rest.match(/^([0-9][0-9,]*)(\.[0-9]+)?/);
    if (!m) {
      return { prefix: '', text: raw, target: 0, decimals: 0, group: false, suffix: '', unit: '' };
    }
    const intPart = m[1];
    const fracPart = m[2] ?? '';
    const numText = intPart + fracPart;                    // as displayed (keeps grouping)
    const target = Number(intPart.replace(/,/g, '') + fracPart);
    const after = rest.slice(m[0].length);                 // everything after the number token
    // a tight magnitude/percent suffix glued to the number (k, m, %, x).
    const tight = after.match(/^(k|m|%|x)/i)?.[0] ?? '';
    const unit = after.slice(tight.length).trim();          // a spaced trailing word unit
    const normPre = pre === '-' ? '−' : pre;                // prettify a hyphen-minus
    return {
      prefix: normPre,
      text: numText + tight,
      target: Number.isFinite(target) ? target : 0,
      decimals: fracPart ? fracPart.length - 1 : 0,
      group: intPart.includes(','),
      suffix: tight,
      unit,
    };
  }

  // ─────────────── DECORATIVE SPARKS (precomputed, stable) ───────────────

  private static mkSparks(seed: number): readonly Spark[] {
    // deterministic pseudo-random so SSR/CSR + re-renders stay identical (no layout thrash).
    const r = (n: number) => {
      const x = Math.sin(seed * 99.13 + n * 12.9898) * 43758.5453;
      return x - Math.floor(x);
    };
    return Array.from({ length: 6 }, (_, n) => ({
      x: `${Math.round(8 + r(n) * 84)}%`,
      y: `${Math.round(10 + r(n + 50) * 78)}%`,
      s: `${Math.round(6 + r(n + 100) * 10)}px`,
      d: `${(r(n + 150) * 2).toFixed(2)}s`,
      dur: `${(4 + r(n + 200) * 4).toFixed(2)}s`,
    }));
  }
  private static readonly SPARKS = WrappedBetaPage.mkSparks(1);
  private static readonly SPARKS_BY_INDEX: readonly (readonly Spark[])[] =
    Array.from({ length: 8 }, (_, i) => WrappedBetaPage.mkSparks(i + 2));

  // ─────────────── DATE FORMAT ───────────────

  /** yyyy-MM-dd → "Jun 23, 2026" (locale-friendly, tz-safe by parsing the parts). */
  private fmt(iso: string): string {
    const [y, m, d] = iso.split('-').map(Number);
    if (!y || !m || !d) return iso;
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }
}
