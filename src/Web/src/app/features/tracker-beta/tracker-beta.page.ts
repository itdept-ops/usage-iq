import {
  ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject,
  signal, viewChild,
} from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { Router } from '@angular/router';

import { TrackerStore, toLocalDate } from '../../core/tracker-store';
import { Meal } from '../../core/models';

import { OptimisticTracker } from './state/optimistic-tracker';
import { HeroRing, HeroFace } from './hero/hero-ring';
import { QuickRail, QuickTile } from './ui/quick-rail';
import { FuelCard } from './cards/fuel-card';
import { WaterCard } from './cards/water-card';
import { MoveCard } from './cards/move-card';
import { CoffeeCard } from './cards/coffee-card';
import { WeightCard } from './cards/weight-card';
import { LogMenuSheet, LogTarget } from './sheets/log-menu-sheet';
import { FoodSheet } from './sheets/food-sheet';
import { WeightSheet } from './sheets/weight-sheet';
import { CoffeeSheet, ExerciseSheet, SupplementSheet } from './sheets/quick-sheets';
import { currentStreak, dayHasAnyLog } from './util/streak';

/**
 * Tracker Beta — the "Strata" shell. Owns the screen spec end-to-end:
 *   • sticky DAY STRIP (‹ prev / Today / next › + date + avatar)
 *   • floating HERO (the triple-ring hero-ring)
 *   • one-tap QUICK RAIL (optimistic water / coffee / weigh / meal tiles)
 *   • scroll-snap CARD STACK (fuel / water / move / coffee / weight)
 *   • fixed bottom ACTION BAR (dominant "+ LOG" → the log-menu fan-out, + the gentle streak flame)
 *
 * Data flows entirely through the route-provided {@link OptimisticTracker} (which shares the root
 * {@link TrackerStore}'s `day()` signal) and the root store for day-navigation / shared-list. All
 * mutations route through the optimistic wrapper so the hero ring + counts tick sub-second.
 *
 * Motion: day navigation (swipe / Today pill) runs through `store.shiftDate / goToday` wrapped in a
 * feature-detected, reduced-motion-gated View-Transitions slide. Skeletons key off `store.loading`
 * with reserved box dims so first paint is CLS≈0. `store.readOnly()` hides every log affordance for
 * shared-user views.
 *
 * Token / shell isolation: the layout binds the foundation shell classes (`.tb-scroll`, `.tb-day-strip`,
 * `.tb-hero`, `.tb-quick-rail`, `.tb-card`, `.tb-defer`, `.tb-action-bar`, `.tb-skeleton`) and inherits
 * the Strata tokens defined on this page's `:host` in tracker-beta.page.scss. No global `--tech-*`.
 */
@Component({
  selector: 'app-tracker-beta',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './tracker-beta.page.scss',
  imports: [
    MatIconModule,
    HeroRing, QuickRail,
    FuelCard, WaterCard, MoveCard, CoffeeCard, WeightCard,
    LogMenuSheet, FoodSheet, WeightSheet, CoffeeSheet, ExerciseSheet, SupplementSheet,
  ],
  template: `
    <!-- ─────────────────── DAY STRIP (fixed top glass) ─────────────────── -->
    <header class="tb-day-strip">
      <div class="tb-day-nav">
        <button type="button" class="tb-daybtn" aria-label="Previous day" (click)="shift(-1)">
          <mat-icon aria-hidden="true">chevron_left</mat-icon>
        </button>
        @if (!isToday()) {
          <button type="button" class="tb-today-pill" (click)="today()">Today</button>
        }
        <span class="tb-date" aria-live="polite">{{ dateHeading() }}</span>
        <button type="button" class="tb-daybtn" aria-label="Next day"
                [disabled]="isToday()" (click)="shift(1)">
          <mat-icon aria-hidden="true">chevron_right</mat-icon>
        </button>
      </div>
      <button type="button" class="tb-avatar"
              [attr.aria-label]="'Viewing ' + ownerName() + ' — open the full tracker for settings, profile, and switching users'"
              (click)="router.navigate(['/tracker'])">
        <span class="tb-avatar-initial" aria-hidden="true">{{ initial() }}</span>
      </button>
    </header>

    <!-- ─────────────────── SCROLL REGION ─────────────────── -->
    <main #scroll class="tb-scroll"
          (pointerdown)="onSwipeDown($event)"
          (pointerup)="onSwipeUp($event)"
          (pointercancel)="onSwipeCancel()">

      @if (loading() && !day()) {
        <!-- Skeletons reserve final layout dims (CLS≈0) -->
        <div class="tb-hero tb-skeleton" aria-hidden="true"></div>
        <div class="tb-rail-skeleton" aria-hidden="true">
          @for (i of [1,2,3,4]; track i) { <div class="tb-qtile-skeleton tb-skeleton"></div> }
        </div>
        @for (i of [1,2,3,4,5]; track i) {
          <div class="tb-card tb-skeleton tb-card-skeleton" aria-hidden="true"></div>
        }
      } @else {
        <!-- HERO -->
        <section class="tb-hero">
          <app-hero-ring [day]="day()" [(face)]="heroFace" />
        </section>

        <!-- QUICK RAIL (hidden in read-only — nothing to one-tap) -->
        @if (!readOnly()) {
          <app-quick-rail [tiles]="railTiles()" (tap)="onQuick($event)" (longPress)="onQuickAdjust($event)" />
        }

        <!-- CARD STACK -->
        <app-fuel-card (addToMeal)="openFood($event)" />
        <app-tb-water-card />
        <app-move-card (addExercise)="exerciseOpen.set(true)" />
        <app-tracker-beta-coffee-card />
        <div class="tb-defer">
          <app-weight-card #weightCard (weigh)="weightOpen.set(true)" />
        </div>
      }
    </main>

    <!-- ─────────────────── ACTION BAR (fixed bottom glass) ─────────────────── -->
    <footer class="tb-action-bar">
      @if (!readOnly()) {
        <button type="button" class="tb-log-btn" aria-label="Log something" (click)="logOpen.set(true)">
          <mat-icon aria-hidden="true">add</mat-icon>
          <span>LOG</span>
        </button>
      } @else {
        <span class="tb-readonly-note">Viewing {{ ownerName() }} · read-only</span>
      }
      @if (streak() > 0) {
        <div class="tb-streak" [attr.aria-label]="streak() + ' day logging streak'">
          <mat-icon aria-hidden="true">local_fire_department</mat-icon>
          <span class="tb-streak-n">{{ streak() }}</span>
        </div>
      }
    </footer>

    <!-- ─────────────────── SHEETS (overlay; closed by default) ─────────────────── -->
    <app-log-menu-sheet [(open)]="logOpen" (choose)="route($event)" />
    <app-food-sheet [(open)]="foodOpen" />
    <app-coffee-sheet [(open)]="coffeeOpen" />
    <app-exercise-sheet [(open)]="exerciseOpen" />
    <app-supplement-sheet [(open)]="supplementOpen" />
    <app-weight-sheet [(open)]="weightOpen" (logged)="onWeighed()" />
  `,
  styles: [`
    /* DAY STRIP internals */
    .tb-day-nav { display: flex; align-items: center; gap: 4px; min-width: 0; }
    .tb-daybtn {
      width: 44px; height: 44px; display: flex; align-items: center; justify-content: center;
      border: none; background: transparent; color: var(--ink); cursor: pointer;
      border-radius: var(--r-pill); touch-action: manipulation; -webkit-tap-highlight-color: transparent;
    }
    .tb-daybtn:disabled { opacity: .3; pointer-events: none; }
    .tb-daybtn:active { background: var(--bg-sink); }
    .tb-today-pill {
      height: 32px; padding: 0 12px; border-radius: var(--r-pill);
      border: 1px solid var(--glass-edge); background: var(--bg-rise); color: var(--ink);
      font: 600 12px/1 var(--font-ui); letter-spacing: .02em; cursor: pointer;
      touch-action: manipulation; -webkit-tap-highlight-color: transparent;
    }
    .tb-today-pill:active { box-shadow: var(--press); transform: translateY(1px); }
    .tb-date {
      font: 600 14px/1 var(--font-ui); color: var(--ink); white-space: nowrap;
      overflow: hidden; text-overflow: ellipsis; padding: 0 4px;
    }
    .tb-avatar {
      flex: 0 0 auto; width: 40px; height: 40px; border-radius: var(--r-pill);
      border: 1px solid var(--glass-edge);
      background: linear-gradient(135deg, var(--cal-a), var(--cal-b));
      color: #fff; display: flex; align-items: center; justify-content: center;
      cursor: pointer; touch-action: manipulation; -webkit-tap-highlight-color: transparent;
    }
    .tb-avatar:active { transform: scale(.95); }
    .tb-avatar-initial { font: 700 16px/1 var(--font-display); letter-spacing: -.02em; }

    /* ACTION BAR internals */
    .tb-log-btn {
      flex: 1 1 auto; max-width: 280px; min-height: 56px;
      display: flex; align-items: center; justify-content: center; gap: 8px;
      border: none; border-radius: var(--r-pill);
      background: linear-gradient(135deg, var(--cal-a), var(--cal-b));
      color: #fff; font: 700 17px/1 var(--font-ui); letter-spacing: .04em;
      box-shadow: var(--lift-2); cursor: pointer;
      touch-action: manipulation; -webkit-tap-highlight-color: transparent;
      transition: transform 120ms var(--ease-out), box-shadow 120ms var(--ease-out);
    }
    .tb-log-btn mat-icon { width: 24px; height: 24px; font-size: 24px; }
    .tb-log-btn:active { transform: scale(.97) translateY(1px); box-shadow: var(--press); }
    .tb-readonly-note {
      flex: 1 1 auto; text-align: center; font: 500 13px/1.3 var(--font-ui); color: var(--ink-dim);
    }
    .tb-streak {
      flex: 0 0 auto; display: flex; align-items: center; gap: 2px;
      color: var(--warn);
    }
    .tb-streak mat-icon { width: 22px; height: 22px; font-size: 22px; }
    .tb-streak-n { font: 700 16px/1 var(--font-display); font-variant-numeric: tabular-nums; }

    /* Skeleton sizing — reserve the real layout dims so first paint is CLS≈0 */
    .tb-card-skeleton { min-height: 96px; }
    .tb-rail-skeleton { display: flex; gap: 10px; padding: 2px; overflow: hidden; }
    .tb-qtile-skeleton { flex: 0 0 auto; width: 64px; height: 64px; border-radius: var(--r-tile); }
  `],
})
export class TrackerBetaPage {
  protected readonly store = inject(TrackerStore);
  protected readonly opt = inject(OptimisticTracker);
  protected readonly router = inject(Router);

  // ── read surface (off the shared day() signal) ──
  protected readonly day = this.opt.day;
  protected readonly loading = this.opt.loading;
  protected readonly readOnly = this.opt.readOnly;
  protected readonly imperial = this.opt.imperial;

  // ── hero face (two-way with the hero-ring) ──
  protected readonly heroFace = signal<HeroFace>('rings');

  // ── sheet open states ──
  protected readonly logOpen = signal(false);
  protected readonly foodOpen = signal(false);
  protected readonly coffeeOpen = signal(false);
  protected readonly exerciseOpen = signal(false);
  protected readonly supplementOpen = signal(false);
  protected readonly weightOpen = signal(false);

  private readonly scrollEl = viewChild<ElementRef<HTMLElement>>('scroll');
  private readonly weightCard = viewChild<WeightCard>('weightCard');

  /** Dates observed to have at least one log — seeds the de-gamified streak flame. */
  private readonly loggedDates = signal<ReadonlySet<string>>(new Set());

  // ── day-strip derived state ──
  protected readonly isToday = computed(() => this.store.date() === toLocalDate(new Date()));

  protected readonly dateHeading = computed(() => {
    const iso = this.store.date();
    const d = new Date(iso + 'T00:00:00');
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  });

  protected readonly ownerName = computed(() => this.day()?.userName ?? 'You');
  protected readonly initial = computed(() => (this.ownerName().trim()[0] ?? '?').toUpperCase());

  /** The current days-with-logs streak (encouragement only — no XP/levels). */
  protected readonly streak = computed(() => currentStreak(this.loggedDates()));

  /** Quick-rail tiles, highest-frequency first (water leftmost in the thumb arc). */
  protected readonly railTiles = computed<QuickTile[]>(() => {
    const oz = this.imperial();
    return [
      { key: 'water', icon: 'water_drop', label: oz ? '+8 oz' : '+250 ml', accentA: 'var(--water-a)', accentB: 'var(--water-b)' },
      { key: 'coffee', icon: 'local_cafe', label: 'Coffee', accentA: 'var(--coffee-a)', accentB: 'var(--coffee-b)' },
      { key: 'weigh', icon: 'monitor_weight', label: 'Weigh', accentA: 'var(--pro-a)', accentB: 'var(--pro-b)' },
      { key: 'meal', icon: 'restaurant', label: 'Meal +', accentA: 'var(--cal-a)', accentB: 'var(--cal-b)' },
    ];
  });

  // ── day swipe (horizontal content swipe → shiftDate, View-Transitions slide) ──
  private swipeX = 0;
  private swipeY = 0;
  private swipePointer = -1;

  private readonly reduceMotion =
    typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  constructor() {
    // First paint + shared-user list (matches the existing /tracker route's init).
    void this.store.load();
    void this.store.loadShared();

    // Accumulate the streak set as days load (today is a grace day inside currentStreak()).
    effect(() => {
      const d = this.day();
      if (!d) return;
      const has = dayHasAnyLog({
        foods: d.foods, exercises: d.exercises, hydration: d.hydration,
        coffee: d.coffee, supplements: d.supplements,
      });
      const key = d.date;
      this.loggedDates.update(prev => {
        const had = prev.has(key);
        if (has === had) return prev; // no change → keep identity (avoids needless recompute)
        const next = new Set(prev);
        if (has) next.add(key); else next.delete(key);
        return next;
      });
    });
  }

  // ── day navigation ──
  protected shift(days: number): void {
    if (days > 0 && this.isToday()) return;
    this.withTransition(() => void this.store.shiftDate(days));
  }

  protected today(): void {
    this.withTransition(() => void this.store.goToday());
  }

  /** Run a day change inside a feature-detected, reduced-motion-gated View-Transitions slide. */
  private withTransition(mutate: () => void): void {
    const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
    if (this.reduceMotion || typeof doc.startViewTransition !== 'function') {
      mutate();
      return;
    }
    doc.startViewTransition(() => mutate());
  }

  // ── quick rail ──
  protected onQuick(key: string): void {
    if (this.readOnly()) return;
    const date = this.opt.date();
    switch (key) {
      case 'water': {
        // Metric on the wire regardless of display units (250 ml ≈ the 8 oz label).
        void this.opt.addHydration({ date, amountMl: 250, label: 'Water' });
        break;
      }
      case 'coffee':
        // The "usual" cup — matches the classic tracker's quick-coffee preset (95 mg).
        void this.opt.addCoffee({ date, cups: 1, caffeineMg: 95, label: 'Cup' });
        break;
      case 'weigh':
        this.weightOpen.set(true);
        break;
      case 'meal':
        this.openFood('breakfast');
        break;
    }
  }

  /** Long-press a rail tile → open the matching adjust sheet (unit-aware amounts etc.). */
  protected onQuickAdjust(key: string): void {
    if (this.readOnly()) return;
    switch (key) {
      case 'water': this.foodOpen.set(false); this.openWater(); break;
      case 'coffee': this.coffeeOpen.set(true); break;
      case 'weigh': this.weightOpen.set(true); break;
      case 'meal': this.openFood('breakfast'); break;
    }
  }

  /** Water has no dedicated sheet (capsule steppers cover adjust) — fall back to the log menu's water path. */
  private openWater(): void {
    // The water card's inline steppers ARE the adjust affordance; long-press simply scrolls to it.
    const el = this.scrollEl()?.nativeElement.querySelector('app-tb-water-card');
    el?.scrollIntoView({ behavior: this.reduceMotion ? 'auto' : 'smooth', block: 'center' });
  }

  // ── log-menu routing ──
  protected route(target: LogTarget): void {
    switch (target) {
      case 'food': case 'scan': case 'snap': case 'brain':
        // The food sheet owns the fast lanes (scan/snap/brain) internally.
        this.openFood('breakfast');
        break;
      case 'water': this.openWater(); break;
      case 'coffee': this.coffeeOpen.set(true); break;
      case 'exercise': this.exerciseOpen.set(true); break;
      case 'weight': this.weightOpen.set(true); break;
      case 'supplement': this.supplementOpen.set(true); break;
    }
  }

  /**
   * Open the food sheet. The shipped FoodSheet exposes only `open` (no meal-target input), so the meal
   * argument is accepted for the call-site contract (fuel-card emits a Meal) but the sheet defaults to its
   * own meal selector — opening it is the correct action either way.
   */
  protected openFood(_meal: Meal): void {
    this.foodOpen.set(true);
  }

  // ── weight reconcile ──
  /** A weigh-in settled → re-pull the weight card's history so the new point animates into the sparkline. */
  protected onWeighed(): void {
    void this.weightCard()?.refresh();
  }

  // ── horizontal day-swipe gesture (content area) ──
  protected onSwipeDown(e: PointerEvent): void {
    if (e.pointerType === 'mouse') return; // pointer-drag day-nav is touch-first
    this.swipePointer = e.pointerId;
    this.swipeX = e.clientX;
    this.swipeY = e.clientY;
  }

  protected onSwipeUp(e: PointerEvent): void {
    if (e.pointerId !== this.swipePointer) return;
    this.swipePointer = -1;
    const dx = e.clientX - this.swipeX;
    const dy = e.clientY - this.swipeY;
    // Predominantly-horizontal flick past threshold → step the day.
    if (Math.abs(dx) > 64 && Math.abs(dx) > Math.abs(dy) * 1.6) {
      // Swipe right → previous day; swipe left → next day (blocked when already today).
      this.shift(dx > 0 ? -1 : 1);
    }
  }

  protected onSwipeCancel(): void {
    this.swipePointer = -1;
  }
}
