import {
  ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject,
  signal, viewChild,
} from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatSnackBar } from '@angular/material/snack-bar';
import { ActivatedRoute, Router } from '@angular/router';

import { firstValueFrom } from 'rxjs';

import { TrackerStore, toLocalDate } from '../../core/tracker-store';
import { Api } from '../../core/api';
import { AuthService } from '../../core/auth';
import { CopyFoodRequest, FoodEntryDto, Meal, MoveDayResult, PERM, SleepEntryDto } from '../../core/models';
import { UnitService } from '../../core/unit.service';

import { FormsModule } from '@angular/forms';

import { OptimisticTracker } from './state/optimistic-tracker';
import { HeroRing, HeroFace } from './hero/hero-ring';
import { QuickRail, QuickTile } from './ui/quick-rail';
import { BaselineGate } from './ui/baseline-gate';
import { BottomSheet } from './ui/bottom-sheet';
import { FuelCard } from './cards/fuel-card';
import { WaterCard } from './cards/water-card';
import { MoveCard } from './cards/move-card';
import { CoffeeCard } from './cards/coffee-card';
import { SleepCard } from './cards/sleep-card';
import { WeightCard } from './cards/weight-card';
import { AiCard } from './cards/ai-card';
import { LogMenuSheet, LogTarget } from './sheets/log-menu-sheet';
import { FoodSheet } from './sheets/food-sheet';
import { FoodEditSheet } from './sheets/food-edit-sheet';
import { WeightSheet } from './sheets/weight-sheet';
import { WatchSheet } from './sheets/watch-sheet';
import { CoffeeSheet, ExerciseSheet, SleepSheet, SupplementSheet } from './sheets/quick-sheets';
import { LeftoversSheet, LeftoversLogged } from './sheets/leftovers-sheet';
import { CopyFoodSheet, CopyFoodDone } from './sheets/copy-food-sheet';
import { MoveDaySheet } from './sheets/move-day-sheet';
import { SharedSheet } from './sheets/shared-sheet';
import { WhatToEatSheet } from './sheets/what-to-eat-sheet';
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
  // Component-scoped so the page + every child card/sheet shares ONE optimistic store (which wraps the
  // root TrackerStore). Provided HERE rather than on the route so the eager page-registry never references
  // the value and the store stays inside this lazy chunk. The /tracker-beta route file provides it too —
  // both paths land on the same component-tree instance.
  providers: [OptimisticTracker],
  imports: [
    MatIconModule, FormsModule, BottomSheet,
    HeroRing, QuickRail, BaselineGate,
    FuelCard, WaterCard, MoveCard, CoffeeCard, SleepCard, WeightCard, AiCard,
    LogMenuSheet, FoodSheet, FoodEditSheet, WeightSheet, WatchSheet, CoffeeSheet, ExerciseSheet, SleepSheet, SupplementSheet,
    LeftoversSheet, CopyFoodSheet, MoveDaySheet, SharedSheet, WhatToEatSheet,
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
      <div class="tb-strip-actions">
        <!-- Jump to an arbitrary date (parity with the desktop date picker). A visually-hidden native date
             input drives it so we get the OS picker for free; the calendar button is the visible affordance. -->
        <label class="tb-daybtn tb-datepick" [attr.aria-label]="'Pick a date, currently ' + store.date()">
          <mat-icon aria-hidden="true">calendar_today</mat-icon>
          <input class="tb-datepick-input" type="date" [max]="todayIso()"
                 [ngModel]="store.date()" (ngModelChange)="pickDate($event)" />
        </label>
        <button type="button" class="tb-daybtn" aria-label="More tracker actions" (click)="actionsOpen.set(true)">
          <mat-icon aria-hidden="true">more_horiz</mat-icon>
        </button>
        <button type="button" class="tb-avatar"
                [attr.aria-label]="'Viewing ' + ownerName() + ' — switch whose tracker you\\'re viewing'"
                (click)="sharedOpen.set(true)">
          <span class="tb-avatar-initial" aria-hidden="true">{{ initial() }}</span>
        </button>
      </div>
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
      } @else if (needsBaseline()) {
        <!-- BLOCKING baseline gate (own tracker, missing weight/height/DOB/sex) — replaces the dashboard
             until saved, mirroring the desktop needsBaseline onboarding. -->
        <app-baseline-gate (done)="onBaselineDone()" />
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
        <app-fuel-card (addToMeal)="openFood($event)" (editFood)="openEditFood($event)"
                       (copyFood)="openCopyFood($event)" (copyMeal)="openCopyMeal($event)"
                       (repeatFood)="repeatFoodTomorrow($event)" (repeatMeal)="repeatMealTomorrow($event)" />
        <app-tb-water-card />
        <app-move-card (addExercise)="exerciseOpen.set(true)" (editWatch)="watchOpen.set(true)" />
        <app-tracker-beta-coffee-card />
        <app-tracker-beta-sleep-card (log)="openSleep()" (editEntry)="openEditSleep($event)" />
        <div class="tb-defer">
          <app-weight-card #weightCard (weigh)="weightOpen.set(true)" />
        </div>
        <!-- AI COACH (trackerAi + own writable tracker only) -->
        @if (aiEnabled()) {
          <div class="tb-defer">
            <app-tracker-beta-ai-card (whatToEat)="whatToEatOpen.set(true)" />
          </div>
        }
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
    <app-food-edit-sheet [(open)]="foodEditOpen" [(entry)]="editingFood" />
    <app-coffee-sheet [(open)]="coffeeOpen" />
    <app-exercise-sheet [(open)]="exerciseOpen" />
    <app-sleep-sheet [(open)]="sleepOpen" [(entry)]="editingSleep" />
    <app-supplement-sheet [(open)]="supplementOpen" />
    <app-weight-sheet [(open)]="weightOpen" (logged)="onWeighed()" />
    <app-watch-sheet [(open)]="watchOpen" (logged)="onWatchSaved()" />
    <app-leftovers-sheet [(open)]="leftoversOpen" (logged)="onLeftoversLogged($event)" />
    <app-copy-food-sheet [(open)]="copyFoodOpen" [(entryIds)]="copyEntryIds"
                         [(sourceMeal)]="copySourceMeal" [(label)]="copyLabel"
                         (copied)="onFoodCopied($event)" />
    <app-move-day-sheet [(open)]="moveDayOpen" (moved)="onDayMoved($event)" />
    <app-shared-sheet [(open)]="sharedOpen" />
    <app-what-to-eat-sheet [(open)]="whatToEatOpen" />

    <!-- Actions overflow (Profile & Goals, Move day) — the desktop day-level actions on mobile. -->
    <app-bottom-sheet [(open)]="actionsOpen" detent="peek" label="Tracker actions">
      <div class="tb-actions-sheet">
        <button type="button" class="tb-action-row" (click)="goToProfile()">
          <mat-icon aria-hidden="true">tune</mat-icon>
          <span>Profile &amp; goals</span>
          <mat-icon class="tb-action-chev" aria-hidden="true">chevron_right</mat-icon>
        </button>
        @if (!readOnly()) {
          <button type="button" class="tb-action-row" (click)="openMoveDay()">
            <mat-icon aria-hidden="true">event_repeat</mat-icon>
            <span>Move this day…</span>
            <mat-icon class="tb-action-chev" aria-hidden="true">chevron_right</mat-icon>
          </button>
        }
        <button type="button" class="tb-action-row" (click)="openSharedFromActions()">
          <mat-icon aria-hidden="true">group</mat-icon>
          <span>View someone's tracker</span>
          <mat-icon class="tb-action-chev" aria-hidden="true">chevron_right</mat-icon>
        </button>
      </div>
    </app-bottom-sheet>
  `,
  styles: [`
    /* DAY STRIP internals */
    .tb-day-nav { display: flex; align-items: center; gap: 4px; min-width: 0; }
    .tb-strip-actions { display: flex; align-items: center; gap: 2px; flex: 0 0 auto; }

    /* Date-picker button: the visible calendar glyph over a full-cover invisible native date input. */
    .tb-datepick { position: relative; overflow: hidden; }
    .tb-datepick-input {
      position: absolute; inset: 0; width: 100%; height: 100%;
      opacity: 0; border: 0; padding: 0; margin: 0; cursor: pointer;
      -webkit-appearance: none; appearance: none;
    }
    .tb-datepick:focus-within { outline: 2px solid var(--focus); outline-offset: 2px; border-radius: var(--r-pill); }

    /* Actions overflow sheet rows. */
    .tb-actions-sheet { display: flex; flex-direction: column; gap: 6px; padding: 4px 0 8px; }
    .tb-action-row {
      width: 100%; min-height: 52px; padding: 0 12px;
      display: flex; align-items: center; gap: 12px;
      font-family: var(--font-ui); font-size: 15px; font-weight: 600; color: var(--ink);
      background: var(--bg-sink); border: 1px solid var(--hairline); border-radius: var(--r-tile);
      touch-action: manipulation; -webkit-tap-highlight-color: transparent; cursor: pointer;
      transition: background 160ms var(--ease-out);
    }
    .tb-action-row span { flex: 1 1 auto; text-align: left; }
    .tb-action-row mat-icon { width: 22px; height: 22px; font-size: 22px; color: var(--ink-dim); flex: 0 0 auto; }
    .tb-action-chev { color: var(--ink-faint) !important; }
    .tb-action-row:active { background: var(--bg-rise); }
    .tb-action-row:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
    .tb-daybtn {
      width: 44px; height: 44px; display: flex; align-items: center; justify-content: center;
      border: none; background: transparent; color: var(--ink); cursor: pointer;
      border-radius: var(--r-pill); touch-action: manipulation; -webkit-tap-highlight-color: transparent;
    }
    .tb-daybtn:disabled { opacity: .3; pointer-events: none; }
    .tb-daybtn:active { background: var(--bg-sink); }
    .tb-daybtn:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
    .tb-today-pill {
      height: 32px; padding: 0 12px; border-radius: var(--r-pill);
      border: 1px solid var(--glass-edge); background: var(--bg-rise); color: var(--ink);
      font: 600 12px/1 var(--font-ui); letter-spacing: .02em; cursor: pointer;
      touch-action: manipulation; -webkit-tap-highlight-color: transparent;
      transition: box-shadow 120ms var(--ease-out), transform 120ms var(--ease-out);
    }
    .tb-today-pill:active { box-shadow: var(--press); transform: translateY(1px); }
    .tb-today-pill:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
    .tb-date {
      font: 700 15px/1 var(--font-display); letter-spacing: -.01em;
      color: var(--ink); white-space: nowrap;
      overflow: hidden; text-overflow: ellipsis; padding: 0 4px;
    }
    .tb-avatar {
      flex: 0 0 auto; width: 40px; height: 40px; border-radius: var(--r-pill);
      border: 1px solid var(--glass-edge);
      background: linear-gradient(135deg, var(--tech-accent, var(--cal-a)), var(--tech-accent-2, var(--cal-b)));
      color: #fff; display: flex; align-items: center; justify-content: center;
      cursor: pointer; touch-action: manipulation; -webkit-tap-highlight-color: transparent;
    }
    .tb-avatar:active { transform: scale(.95); }
    .tb-avatar:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
    .tb-avatar-initial { font: 700 16px/1 var(--font-display); letter-spacing: -.02em; }

    /* ACTION BAR internals */
    .tb-log-btn {
      flex: 1 1 auto; max-width: 280px; min-height: 56px;
      display: flex; align-items: center; justify-content: center; gap: 8px;
      border: none; border-radius: var(--r-pill);
      background: linear-gradient(135deg, var(--tech-accent, var(--cal-a)), var(--tech-accent-2, var(--cal-b)));
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
  private readonly activatedRoute = inject(ActivatedRoute);
  protected readonly units = inject(UnitService);
  private readonly api = inject(Api);
  private readonly auth = inject(AuthService);
  private readonly snack = inject(MatSnackBar);

  // ── read surface (off the shared day() signal) ──
  protected readonly day = this.opt.day;
  protected readonly loading = this.opt.loading;
  protected readonly readOnly = this.opt.readOnly;

  /**
   * BLOCKING baseline gate (own tracker only): true when weight/height/DOB/sex are unset — mirrors the
   * desktop needsBaseline. Never true in a read-only view (another user's metrics aren't exposed).
   */
  protected readonly needsBaseline = computed(() => {
    const d = this.day();
    if (!d || d.readOnly) return false;
    const p = d.profile;
    if (!p) return false;
    return p.weightKg == null || p.heightCm == null || !p.dateOfBirth || p.sex === 'Unspecified';
  });

  /** AI affordances gate (mirrors desktop aiEnabled): trackerAi held AND own, writable tracker. */
  protected readonly aiEnabled = computed(
    () => this.auth.hasPermission(PERM.trackerAi) && !this.readOnly(),
  );

  // ── hero face (two-way with the hero-ring) ──
  protected readonly heroFace = signal<HeroFace>('rings');

  // ── sheet open states ──
  protected readonly logOpen = signal(false);
  protected readonly foodOpen = signal(false);
  protected readonly foodEditOpen = signal(false);
  /** The logged food entry currently being edited (two-way bound into the edit sheet; null when closed). */
  protected readonly editingFood = signal<FoodEntryDto | null>(null);
  protected readonly coffeeOpen = signal(false);
  protected readonly exerciseOpen = signal(false);
  protected readonly sleepOpen = signal(false);
  /** The logged sleep entry being edited (two-way into the sleep sheet; null = fresh log). */
  protected readonly editingSleep = signal<SleepEntryDto | null>(null);
  protected readonly supplementOpen = signal(false);
  protected readonly weightOpen = signal(false);
  protected readonly watchOpen = signal(false);
  protected readonly leftoversOpen = signal(false);
  // Copy-food sheet state (seeded by the fuel card's copyFood/copyMeal outputs).
  protected readonly copyFoodOpen = signal(false);
  protected readonly copyEntryIds = signal<number[]>([]);
  protected readonly copySourceMeal = signal<Meal>('breakfast');
  protected readonly copyLabel = signal<string>('');
  // Ported desktop capabilities: move-day, shared-user picker, what-to-eat, day-actions overflow.
  protected readonly moveDayOpen = signal(false);
  protected readonly sharedOpen = signal(false);
  protected readonly whatToEatOpen = signal(false);
  protected readonly actionsOpen = signal(false);

  private readonly scrollEl = viewChild<ElementRef<HTMLElement>>('scroll');
  private readonly weightCard = viewChild<WeightCard>('weightCard');

  /** Dates observed to have at least one log — seeds the de-gamified streak flame. */
  private readonly loggedDates = signal<ReadonlySet<string>>(new Set());

  // ── day-strip derived state ──
  protected readonly isToday = computed(() => this.store.date() === toLocalDate(new Date()));

  /** Today as a local yyyy-MM-dd — caps the date picker so you can't jump to a future day. */
  protected readonly todayIso = computed(() => toLocalDate(new Date()));

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
    // Wire stays 250 ml; the label reads the user's small-volume unit ("+8 fl oz" / "+250 ml").
    const waterLabel = `+${this.units.formatVolume(250)}`;
    return [
      { key: 'water', icon: 'water_drop', label: waterLabel, accentA: 'var(--water-a)', accentB: 'var(--water-b)' },
      { key: 'coffee', icon: 'local_cafe', label: 'Coffee', accentA: 'var(--coffee-a)', accentB: 'var(--coffee-b)' },
      { key: 'sleep', icon: 'bedtime', label: 'Sleep', accentA: 'var(--sleep-a)', accentB: 'var(--sleep-b)' },
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
    // Deep-link from Search: ?date=yyyy-MM-dd opens that logged day (parity with the desktop /tracker
    // consumer). setDate() reloads the day, so it REPLACES the default load; an invalid/absent param
    // falls back to the default (today / last-viewed) load so a normal visit behaves exactly as before.
    const dateParam = this.activatedRoute.snapshot.queryParamMap.get('date');
    if (dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
      void this.store.setDate(dateParam);
    } else {
      void this.store.load();
    }
    void this.store.loadShared();

    // Seed the central UnitService from the loaded profile's preference so every unit DISPLAY/INPUT in
    // this surface (weight / volume / distance) honours the user's metric/imperial choice. setLocal only
    // mirrors the signal — it never persists, so this is a pure display seam (storage/wire stay metric).
    effect(() => {
      const system = this.store.profile()?.unitSystem;
      if (system) this.units.setLocal(system);
    });

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
    this.withTransition(() => this.store.shiftDate(days));
  }

  protected today(): void {
    this.withTransition(() => this.store.goToday());
  }

  /** Jump to an arbitrary date picked from the native date input (parity with the desktop date picker). */
  protected pickDate(iso: string): void {
    if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso) || iso === this.store.date()) return;
    this.withTransition(() => this.store.setDate(iso));
  }

  // ── ported day-level actions ──

  /** Open the full Profile & Goals editor (the mobile /tracker/profile twin). Closes the actions sheet. */
  protected goToProfile(): void {
    this.actionsOpen.set(false);
    void this.router.navigate(['/tracker/profile']);
  }

  /** Open the Move-day sheet (own tracker only). Closes the actions sheet first. */
  protected openMoveDay(): void {
    if (this.readOnly()) return;
    this.actionsOpen.set(false);
    this.moveDayOpen.set(true);
  }

  /** Open the shared-user picker from the actions sheet. */
  protected openSharedFromActions(): void {
    this.actionsOpen.set(false);
    this.sharedOpen.set(true);
  }

  /**
   * A day-move settled (the sheet POSTed /tracker/day/move). Toast the per-domain counts and reload if the
   * SOURCE or TARGET day is on screen (the source lost its entries; the target gained them). Mirrors the
   * desktop moveDayMessage.
   */
  protected onDayMoved(res: MoveDayResult): void {
    const m = res.moved;
    const bits: string[] = [];
    if (m.food) bits.push(`${m.food} food${m.food === 1 ? '' : 's'}`);
    if (m.exercise) bits.push(`${m.exercise} workout${m.exercise === 1 ? '' : 's'}`);
    if (m.hydration) bits.push(`${m.hydration} drink${m.hydration === 1 ? '' : 's'}`);
    if (m.weight) bits.push('your weight');
    if (m.activity) bits.push('your activity');
    const to = this.copyDayLabel(res.toDate);
    const msg = bits.length === 0
      ? `Nothing to move to ${to}`
      : `Moved ${bits.join(', ')} to ${to}`;
    this.snack.open(msg, 'OK', { duration: 4000, politeness: 'polite' });
    // The move re-dated entries OFF the viewed day (source) and possibly ONTO it — reload either way.
    void this.store.load();
    void this.weightCard()?.refresh();
  }

  /** Baseline gate completed — the gate already reloaded the day + profile; nothing more to do here. */
  protected onBaselineDone(): void {
    /* needsBaseline() recomputes off the reloaded day and clears; the dashboard renders. */
  }

  /**
   * Run a day change, optionally inside a View-Transitions slide. The mutate is ASYNC (it fetches the
   * new day), so we RETURN its promise into startViewTransition — otherwise the transition captured the
   * stale DOM and could freeze the snapshot on mobile, which looked like "the day won't change". The
   * change is guaranteed to run regardless: reduced-motion / no-VT calls it directly, and a thrown VT
   * still runs it in the catch.
   */
  private withTransition(mutate: () => void | Promise<void>): void {
    const doc = document as Document & {
      startViewTransition?: (cb: () => void | Promise<void>) => unknown;
    };
    if (this.reduceMotion || typeof doc.startViewTransition !== 'function') {
      void Promise.resolve(mutate());
      return;
    }
    try {
      doc.startViewTransition(() => mutate());
    } catch {
      void Promise.resolve(mutate());
    }
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
      case 'sleep':
        // Sleep needs hours/quality — there's no sensible one-tap default, so open the sheet.
        this.openSleep();
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
      case 'water': this.openWater(); break;
      case 'coffee': this.coffeeOpen.set(true); break;
      case 'sleep': this.openSleep(); break;
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
      case 'activity': this.watchOpen.set(true); break;
      case 'leftovers': this.leftoversOpen.set(true); break;
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

  /** Open the sleep sheet for a FRESH log (clears any prior edit seed so it starts blank). */
  protected openSleep(): void {
    if (this.readOnly()) return;
    this.editingSleep.set(null);
    this.sleepOpen.set(true);
  }

  /**
   * Open the sleep sheet seeded to EDIT a tapped logged night (owner-only). The sheet saves by
   * delete-then-add (the backend has no sleep PATCH), mirroring the desktop replaceId edit path.
   */
  protected openEditSleep(s: SleepEntryDto): void {
    if (this.readOnly()) return;
    this.editingSleep.set(s);
    this.sleepOpen.set(true);
  }

  /**
   * Open the edit sheet for a tapped logged food row (owner-only — the card hides the affordance in
   * read-only views). Seeds the sheet's two-way `entry` model with the row, then opens it; the sheet
   * commits servings/macros/meal/delete through OptimisticTracker (instant ring tick + reconcile).
   */
  protected openEditFood(f: FoodEntryDto): void {
    if (this.readOnly()) return;
    this.editingFood.set(f);
    this.foodEditOpen.set(true);
  }

  /**
   * Open the copy-food sheet for a SINGLE tapped row (owner-only — the card hides the affordance in read-only
   * views). Seeds the sheet with the one entry id + the row's meal slot, then opens it; the sheet POSTs the
   * copyFood endpoint (a COPY — the source row is untouched) and reports back via (copied).
   */
  protected openCopyFood(f: FoodEntryDto): void {
    if (this.readOnly()) return;
    this.copyEntryIds.set([f.id]);
    this.copySourceMeal.set(f.meal);
    this.copyLabel.set('1 item');
    this.copyFoodOpen.set(true);
  }

  /**
   * Open the copy-food sheet for a WHOLE meal — copies every food currently logged in that meal onto the
   * picked day. No-op for an empty meal / read-only. Seeds the sheet with all the meal's entry ids + the
   * source meal slot.
   */
  protected openCopyMeal(meal: Meal): void {
    if (this.readOnly()) return;
    const ids = (this.day()?.foods ?? []).filter((f) => f.meal === meal).map((f) => f.id);
    if (ids.length === 0) return;
    this.copyEntryIds.set(ids);
    this.copySourceMeal.set(meal);
    this.copyLabel.set(`${this.mealTitle(meal)} — ${ids.length} item${ids.length === 1 ? '' : 's'}`);
    this.copyFoodOpen.set(true);
  }

  /** Friendly meal title for the copy sheet's sub-line. */
  private mealTitle(meal: Meal): string {
    return { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner', snack: 'Snack' }[meal];
  }

  /**
   * A copy settled (the sheet POSTed copyFood). Surface a confirmation toast, and — if the copy landed on the
   * day currently on screen — reload it so the new rows appear in the fuel card / rings. The source day is
   * never touched server-side (COPY), so only the target day can need a refresh.
   */
  protected onFoodCopied(r: CopyFoodDone): void {
    const n = r.copiedCount;
    if (n === 0) {
      this.snack.open('Nothing was copied', 'Dismiss', { duration: 4000, politeness: 'polite' });
      return;
    }
    const to = this.copyDayLabel(r.targetDate);
    this.snack.open(`Copied ${n} item${n === 1 ? '' : 's'} to ${to}`, 'OK',
      { duration: 3000, politeness: 'polite' });
    if (r.targetDate === this.store.date()) void this.store.load();
  }

  /** A short "today/tomorrow/Jun 25" label for the copy confirmation toast. */
  private copyDayLabel(iso: string): string {
    const d = new Date(iso + 'T00:00:00');
    if (Number.isNaN(d.getTime())) return iso;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diff = Math.round((d.getTime() - today.getTime()) / 86_400_000);
    if (diff === 0) return 'today';
    if (diff === 1) return 'tomorrow';
    if (diff === -1) return 'yesterday';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  // ── repeat tomorrow (one-tap copy onto tomorrow, same meal; no sheet) ──

  /** Tomorrow as a local yyyy-MM-dd (no UTC shift — the tracker is local-date keyed). */
  private tomorrowIso(): string {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 1);
    return toLocalDate(d);
  }

  /**
   * One-tap "Repeat tomorrow" for a SINGLE row — copies it onto tomorrow in the same meal via the existing
   * copyFood endpoint (a COPY: today's row is untouched). No sheet; just a confirmation toast.
   */
  protected repeatFoodTomorrow(f: FoodEntryDto): void {
    if (this.readOnly()) return;
    void this.runRepeatTomorrow([f.id], f.meal);
  }

  /** One-tap "Repeat tomorrow" for a WHOLE meal — copies every row in that meal onto tomorrow's same slot. */
  protected repeatMealTomorrow(meal: Meal): void {
    if (this.readOnly()) return;
    const ids = (this.day()?.foods ?? []).filter((f) => f.meal === meal).map((f) => f.id);
    if (ids.length === 0) return;
    void this.runRepeatTomorrow(ids, meal);
  }

  /** POST the copy onto tomorrow (same meal) + toast. Refreshes only if tomorrow happens to be on screen. */
  private async runRepeatTomorrow(entryIds: number[], sourceMeal: Meal): Promise<void> {
    const targetDate = this.tomorrowIso();
    const body: CopyFoodRequest = { entryIds, targetDate, targetMeal: sourceMeal };
    try {
      const out = await firstValueFrom(this.api.copyFood(body));
      const n = out.copiedCount;
      if (n === 0) {
        this.snack.open('Nothing was copied', 'Dismiss', { duration: 4000, politeness: 'polite' });
        return;
      }
      this.snack.open(`Repeated ${n} item${n === 1 ? '' : 's'} to tomorrow`, 'OK',
        { duration: 3000, politeness: 'polite' });
      if (targetDate === this.store.date()) void this.store.load();
    } catch {
      this.snack.open('Could not repeat — nothing was changed', 'Dismiss',
        { duration: 4000, politeness: 'polite' });
    }
  }

  // ── weight reconcile ──
  /** A weigh-in settled → re-pull the weight card's history so the new point animates into the sparkline. */
  protected onWeighed(): void {
    void this.weightCard()?.refresh();
  }

  /**
   * Watch stats settled. The optimistic wrapper already patched + recomputed the day's `activity` (so the
   * Move ring / burn ticked instantly and reconciled with the server row); nothing further to pull here.
   */
  protected onWatchSaved(): void {
    /* day().activity is already current via OptimisticTracker.upsertActivity — no extra fetch needed. */
  }

  /**
   * Leftovers were logged from the sheet (one from-meal write per selected day). Surface a confirmation
   * snackbar (full success, partial, or total failure — mirroring the live tracker), and if the currently-
   * viewed day was one we logged to, reload it so the new meal shows in the rings/lists. The sheet targets
   * FUTURE days by default, so most logs won't touch the viewed day — in which case the reload is skipped.
   */
  protected onLeftoversLogged(r: LeftoversLogged): void {
    const n = r.loggedDates.length;
    const dayWord = (k: number) => `${k} day${k === 1 ? '' : 's'}`;
    const portion = r.servings === 1 ? '1 serving' : `${r.servings} servings`;
    if (n === 0) {
      this.snack.open(`Couldn’t log ${r.title} as leftovers`, 'Dismiss', { duration: 4000, politeness: 'polite' });
    } else if (r.failed === 0) {
      this.snack.open(`Logged ${r.title} (${portion}) to ${dayWord(n)}`, 'OK', { duration: 3000, politeness: 'polite' });
    } else {
      const total = n + r.failed;
      this.snack.open(
        `Logged ${r.title} to ${n} of ${dayWord(total)} — ${r.failed} failed`,
        'Dismiss', { duration: 5000, politeness: 'polite' },
      );
    }
    // Refresh only if the day on screen was one we just logged to (so the rings/lists pick it up).
    if (r.loggedDates.includes(this.store.date())) void this.store.load();
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
