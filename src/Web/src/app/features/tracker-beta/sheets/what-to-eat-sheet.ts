import {
  ChangeDetectionStrategy, Component, computed, effect, inject, model, signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';

import { Api } from '../../../core/api';
import { AuthService } from '../../../core/auth';
import {
  AddFoodRequest, EatOption, Meal, PERM, WhatToEatRequest,
} from '../../../core/models';
import { OptimisticTracker } from '../state/optimistic-tracker';
import { BottomSheet } from '../ui/bottom-sheet';

/*
 * sheets/what-to-eat-sheet.ts — the "What should I eat?" bottom-sheet for Tracker Beta ("Strata"), the mobile
 * twin of the desktop WhatToEatDialog (features/tracker/what-to-eat-dialog.ts). Fetches meal/snack OPTIONS
 * that fit the caller's remaining macros today (Api.whatToEat → POST /ai/what-to-eat; server reads the
 * caller's OWN context — no identity sent). Each option can be LOGGED to today's tracker as a single food
 * entry (its title + macros) via OptimisticTracker.addFood (the existing add path), so the hero ring ticks
 * instantly. A free-text craving/constraint refine re-fetches. The endpoint ALWAYS 200s; a non-AI fallback
 * is labelled plainly.
 *
 * Gated exactly like every AI affordance: trackerAi permission + own (writable) tracker. The page only
 * mounts/opens it when aiEnabled; this sheet re-checks so a read-only flip mid-view can't log.
 *
 * Self-styled with the page-host Strata tokens (var(--*) only — no global --tech-*), mobile-first + aria.
 *
 * Contract (the page binds these VERBATIM):
 *   <app-what-to-eat-sheet [(open)]="whatToEatOpen" (logged)="onWhatToEatLogged()" />
 */
@Component({
  selector: 'app-what-to-eat-sheet',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, BottomSheet],
  template: `
    <app-bottom-sheet [(open)]="open" detent="full" label="What should I eat?">
      <div class="we-head">
        <h2 class="we-title">What should I eat?</h2>
        <span class="we-sub">Fits what's left today</span>
      </div>

      <div class="we-refine">
        <input class="we-input" type="text" maxlength="120" autocomplete="off" enterkeyhint="search"
               placeholder="Craving or constraint (optional)"
               [ngModel]="craving()" (ngModelChange)="craving.set($event)"
               (keydown.enter)="fetch()" aria-label="Craving or constraint" />
        <button type="button" class="we-go" (click)="fetch()" [disabled]="busy()">
          @if (busy()) { <span class="we-spin" aria-hidden="true"></span> } @else { Suggest }
        </button>
      </div>

      @if (fallback() && options().length) {
        <p class="we-note">These are built from your planned meals + groceries — not a tailored AI pick.</p>
      }

      @if (busy() && !options().length) {
        <p class="we-empty">Finding options that fit…</p>
      } @else if (!options().length) {
        <p class="we-empty">{{ triedOnce() ? 'No options right now — try a different craving, or log food manually.' : 'Tap Suggest to see options that fit your remaining macros.' }}</p>
      }

      <ul class="we-list">
        @for (o of options(); track o.title) {
          <li class="we-card">
            <div class="we-card-head">
              <h3 class="we-card-title">{{ o.title }}</h3>
              <span class="we-cal">{{ round(o.macros.calories) }} kcal</span>
            </div>
            @if (o.why) { <p class="we-why">{{ o.why }}</p> }
            <p class="we-macros">
              P {{ round(o.macros.proteinG) }} · C {{ round(o.macros.carbsG) }} · F {{ round(o.macros.fatG) }}
            </p>
            <button type="button" class="we-log" (click)="logOption(o)"
                    [disabled]="loggingTitle() === o.title || tracker.readOnly()">
              @if (loggingTitle() === o.title) { Logging… } @else { Log to tracker }
            </button>
          </li>
        }
      </ul>
      <span class="we-sr" role="status" aria-live="polite">{{ announce() }}</span>
    </app-bottom-sheet>
  `,
  styles: [`
    :host { display: contents; }

    .we-head { padding: 4px 2px 12px; }
    .we-title { margin: 0; font-family: var(--font-ui); font-weight: 700; font-size: 19px; color: var(--ink); letter-spacing: -.01em; }
    .we-sub { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--ink-dim); }

    .we-refine { display: flex; gap: 8px; padding-bottom: 12px; }
    .we-input {
      flex: 1 1 auto; min-width: 0; box-sizing: border-box; min-height: 48px;
      padding: 0 14px; font-family: var(--font-ui); font-size: 16px; color: var(--ink);
      background: var(--bg-sink); border: 1px solid var(--hairline); border-radius: var(--r-tile);
      box-shadow: var(--press); -webkit-appearance: none; appearance: none;
      transition: border-color 160ms var(--ease-out);
    }
    .we-input::placeholder { color: var(--ink-faint); }
    .we-input:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; border-color: var(--focus); }
    .we-go {
      flex: 0 0 auto; min-height: 48px; padding: 0 18px;
      font-family: var(--font-ui); font-size: 14px; font-weight: 700; color: #fff;
      background: linear-gradient(135deg, var(--tech-accent, var(--cal-a)), var(--tech-accent-2, var(--cal-b)));
      border: 0; border-radius: var(--r-pill); box-shadow: var(--lift-1);
      display: inline-flex; align-items: center; justify-content: center;
      touch-action: manipulation; -webkit-tap-highlight-color: transparent; cursor: pointer;
    }
    .we-go:disabled { opacity: .5; cursor: default; }
    .we-go:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }

    .we-note { margin: 0 2px 12px; font-size: 12px; color: var(--ink-dim); }
    .we-empty { margin: 8px 2px; font-size: 13px; color: var(--ink-faint); }

    .we-list { list-style: none; margin: 0; padding: 0 0 8px; display: flex; flex-direction: column; gap: 10px; }
    .we-card {
      padding: 14px; border-radius: var(--r-tile);
      background: var(--bg-sink); border: 1px solid var(--hairline); box-shadow: var(--press);
      display: flex; flex-direction: column; gap: 6px;
    }
    .we-card-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
    .we-card-title { margin: 0; font-family: var(--font-ui); font-size: 16px; font-weight: 600; color: var(--ink); }
    .we-cal {
      flex: 0 0 auto; font-family: var(--font-display); font-weight: 600; font-size: 14px;
      font-variant-numeric: tabular-nums; color: var(--ink-dim);
    }
    .we-why { margin: 0; font-size: 13px; line-height: 1.4; color: var(--ink-dim); }
    .we-macros { margin: 0; font-size: 12px; color: var(--ink-faint); font-variant-numeric: tabular-nums; }
    .we-log {
      align-self: flex-start; margin-top: 4px; min-height: 44px; padding: 0 16px;
      font-family: var(--font-ui); font-size: 13px; font-weight: 700; color: var(--ink);
      background: var(--bg-rise); border: 1px solid var(--glass-edge); border-radius: var(--r-pill);
      touch-action: manipulation; -webkit-tap-highlight-color: transparent; cursor: pointer;
      transition: transform 120ms var(--ease-out);
    }
    .we-log:active:not(:disabled) { transform: translateY(1px) scale(.98); }
    .we-log:disabled { opacity: .5; cursor: default; }
    .we-log:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }

    .we-spin {
      width: 16px; height: 16px; border-radius: 50%;
      border: 2px solid rgba(255,255,255,.4); border-top-color: #fff;
      animation: we-spin 700ms linear infinite;
    }
    @keyframes we-spin { to { transform: rotate(360deg); } }

    .we-sr { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; border: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

    @media (prefers-reduced-motion: reduce) { .we-log { transition: none; } .we-spin { animation: none; } }
  `],
})
export class WhatToEatSheet {
  protected readonly tracker = inject(OptimisticTracker);
  private readonly api = inject(Api);
  private readonly auth = inject(AuthService);

  readonly open = model<boolean>(false);
  /** Emitted after an option is logged (the page can toast / it already ticks via the optimistic wrapper). */
  readonly logged = model<boolean>(false);

  protected readonly craving = signal('');
  protected readonly options = signal<EatOption[]>([]);
  protected readonly fallback = signal(false);
  protected readonly busy = signal(false);
  protected readonly triedOnce = signal(false);
  protected readonly loggingTitle = signal<string | null>(null);
  protected readonly announce = signal('');

  private readonly aiEnabled = computed(() => this.auth.hasPermission(PERM.trackerAi) && !this.tracker.readOnly());

  private wasOpen = false;

  constructor() {
    // Reset + auto-fetch on the open transition (matches the desktop dialog auto-fetch).
    effect(() => {
      const isOpen = this.open();
      if (isOpen && !this.wasOpen) {
        this.craving.set('');
        this.options.set([]);
        this.fallback.set(false);
        this.triedOnce.set(false);
        this.announce.set('');
        void this.fetch();
      }
      this.wasOpen = isOpen;
    });
  }

  protected round(n: number): number { return Math.max(0, Math.round(n)); }

  /** A time-of-day default meal slot (mirrors desktop defaultMeal). */
  private defaultMeal(): Meal {
    const h = new Date().getHours();
    if (h < 11) return 'breakfast';
    if (h < 15) return 'lunch';
    if (h < 21) return 'dinner';
    return 'snack';
  }

  protected async fetch(): Promise<void> {
    if (!this.aiEnabled() || this.busy()) return;
    this.busy.set(true);
    this.announce.set('Finding options that fit…');
    const craving = this.craving().trim();
    const body: WhatToEatRequest = {
      meal: this.defaultMeal(),
      craving: craving || undefined,
    };
    try {
      const res = await firstValueFrom(this.api.whatToEat(body));
      this.options.set(res.options ?? []);
      this.fallback.set(!res.aiUsed);
      this.announce.set(res.options?.length ? `${res.options.length} options.` : 'No options right now.');
    } catch {
      this.options.set([]);
      this.announce.set('Suggestions are unavailable right now.');
    } finally {
      this.triedOnce.set(true);
      this.busy.set(false);
    }
  }

  /** Log an option to today's tracker as ONE food entry (title + macros) via the existing add path. */
  protected async logOption(o: EatOption): Promise<void> {
    if (this.tracker.readOnly() || this.loggingTitle()) return;
    this.loggingTitle.set(o.title);
    const body: AddFoodRequest = {
      date: this.tracker.date(),
      meal: this.defaultMeal(),
      description: o.title,
      quantity: 1,
      calories: this.round(o.macros.calories),
      proteinG: this.round(o.macros.proteinG),
      carbG: this.round(o.macros.carbsG),
      fatG: this.round(o.macros.fatG),
      source: 'custom',
    };
    try {
      await this.tracker.addFood(body);
      this.announce.set(`Logged ${o.title}.`);
      this.logged.set(true);
      this.open.set(false);
    } finally {
      this.loggingTitle.set(null);
    }
  }
}
