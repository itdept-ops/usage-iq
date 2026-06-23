import {
  ChangeDetectionStrategy, Component, computed, inject, signal,
} from '@angular/core';

import { OptimisticTracker } from '../state/optimistic-tracker';
import { SwipeRow } from '../ui/swipe-row';
import {
  ML_PER_GLASS, formatVolume, glasses, hydrationStep,
} from '../util/units';

/**
 * Strata WATER card — the signature one-tap hydration beat.
 *
 * Renders a horizontal liquid-fill CAPSULE (not a ring) whose fluid level tracks `hydrationMl / goal`,
 * with the live "900 / 2,500 ml" numeral overlaid and inline [+250] [+500] [glass] steppers that call the
 * OPTIMISTIC {@link OptimisticTracker.addHydration} — the capsule rises immediately (sub-second), the tile
 * sinks-and-springs (--press → --lift) and `navigator.vibrate(10)` fires (no-op on iOS). The fill uses an
 * overshoot-settle spring so it "feels like real liquid"; under prefers-reduced-motion the page-host
 * killswitch collapses every transition/animation to instant.
 *
 * Unit-aware via {@link OptimisticTracker.imperial}: the numeral + stepper labels read oz in Imperial while
 * the wire stays metric ml (250 / 500 / one 250 ml glass). Logged drinks list below, each swipe-left to
 * delete (optimistic remove + undo snackbar via the wrapper). Read-only / shared views disable the steppers
 * and swipe.
 *
 * Self-styled with the beta's Strata `var(--*)` tokens (inherited from the page :host) — no global --tech-*.
 * 44px targets, aria-labels on every icon-only control, a text-equivalent aria-label on the capsule.
 *
 * Touches only this component (its template + styles are inline). Injects the route-provided
 * {@link OptimisticTracker} directly.
 */
@Component({
  selector: 'app-tb-water-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SwipeRow],
  template: `
    <section class="wc" aria-labelledby="wc-title">
      <header class="wc-head">
        <h3 id="wc-title" class="wc-title">Water</h3>
        @if (goalMl() > 0) {
          <span class="wc-glasses" aria-hidden="true">{{ glassesNow() }} / {{ glassesGoal() }} glasses</span>
        }
      </header>

      <!-- Liquid-fill capsule -->
      <div class="wc-capsule" role="img" [attr.aria-label]="capsuleLabel()">
        <div class="wc-fill" [style.width.%]="fillPct()" [class.wc-over]="overGoal()"></div>
        <div class="wc-readout" aria-hidden="true">
          <span class="wc-now">{{ nowLabel() }}</span>
          <span class="wc-goal">/ {{ goalLabel() }}</span>
        </div>
      </div>

      <!-- Inline steppers -->
      <div class="wc-steppers" role="group" aria-label="Add water">
        <button type="button" class="wc-step"
                [class.wc-pressed]="pressed() === 's250'"
                [disabled]="opt.readOnly()"
                [attr.aria-label]="step250().label + ' of water'"
                (pointerdown)="press('s250')" (pointerup)="release()" (pointercancel)="release()"
                (click)="add(250, 's250')">
          {{ step250().label }}
        </button>
        <button type="button" class="wc-step"
                [class.wc-pressed]="pressed() === 's500'"
                [disabled]="opt.readOnly()"
                [attr.aria-label]="step500().label + ' of water'"
                (pointerdown)="press('s500')" (pointerup)="release()" (pointercancel)="release()"
                (click)="add(500, 's500')">
          {{ step500().label }}
        </button>
        <button type="button" class="wc-step wc-step-glass"
                [class.wc-pressed]="pressed() === 'glass'"
                [disabled]="opt.readOnly()"
                aria-label="Add a glass of water"
                (pointerdown)="press('glass')" (pointerup)="release()" (pointercancel)="release()"
                (click)="add(glassMl, 'glass')">
          <span class="wc-glass-ico" aria-hidden="true">&#x1F964;</span>
          <span>glass</span>
        </button>
      </div>

      <!-- Logged drinks (swipe-left to delete) -->
      @if (entries().length) {
        <ul class="wc-list">
          @for (h of entries(); track h.id) {
            <li>
              <app-swipe-row [disabled]="opt.readOnly()"
                             [label]="'Delete ' + entryLabel(h.amountMl) + ' drink'"
                             (delete)="opt.deleteHydration(h.id)">
                <div class="wc-row">
                  <span class="wc-row-name">{{ h.label || 'Water' }}</span>
                  <span class="wc-row-amt">{{ entryLabel(h.amountMl) }}</span>
                </div>
              </app-swipe-row>
            </li>
          }
        </ul>
      } @else {
        <p class="wc-empty">No drinks logged yet — tap a stepper to start.</p>
      }
    </section>
  `,
  styles: [`
    :host { display: block; }

    .wc { display: flex; flex-direction: column; gap: 14px; }

    .wc-head {
      display: flex; align-items: baseline; justify-content: space-between; gap: 12px;
    }
    .wc-title {
      margin: 0; font-family: var(--font-ui);
      font-size: 15px; font-weight: 600; color: var(--ink);
    }
    .wc-glasses {
      font-size: 11px; font-weight: 500; text-transform: uppercase; letter-spacing: .04em;
      color: var(--ink-dim); font-variant-numeric: tabular-nums;
    }

    /* ── liquid-fill capsule ── */
    .wc-capsule {
      position: relative; width: 100%; height: 56px; overflow: hidden;
      border-radius: var(--r-pill);
      background: var(--bg-sink);
      box-shadow: var(--press);
      border: 1px solid var(--hairline);
      isolation: isolate;
    }
    .wc-fill {
      position: absolute; inset: 0 auto 0 0; height: 100%;
      min-width: 0; max-width: 100%;
      border-radius: var(--r-pill);
      background: linear-gradient(90deg, var(--water-a), var(--water-b));
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, .25);
      /* overshoot-settle: the spring easing gives the liquid a believable surge-then-settle */
      transition: width 700ms var(--ease-spring-up);
      will-change: width;
    }
    .wc-fill.wc-over {
      /* GRAFT(Daylight): over-goal reads warm amber, never red */
      background: linear-gradient(90deg, var(--warn), var(--water-b));
    }
    .wc-readout {
      position: absolute; inset: 0; z-index: 1;
      display: flex; align-items: baseline; justify-content: center; gap: 6px;
      pointer-events: none;
      font-variant-numeric: tabular-nums;
      /* a soft scrim under the text so it stays legible over both empty + filled regions */
      text-shadow: 0 1px 3px rgba(4, 6, 20, .45);
    }
    .wc-now {
      font-family: var(--font-display); font-size: 22px; font-weight: 600;
      letter-spacing: -.02em; color: var(--ink);
    }
    .wc-goal { font-size: 13px; font-weight: 500; color: var(--ink-dim); }

    /* ── steppers ── */
    .wc-steppers { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; }
    .wc-step {
      min-height: 44px; padding: 0 10px;
      display: inline-flex; align-items: center; justify-content: center; gap: 6px;
      font-family: var(--font-ui); font-size: 14px; font-weight: 600;
      color: var(--ink); white-space: nowrap;
      background: var(--bg-rise);
      border: 1px solid var(--glass-edge);
      border-radius: var(--r-tile);
      box-shadow: var(--lift-1);
      cursor: pointer;
      touch-action: manipulation;
      -webkit-tap-highlight-color: transparent;
      transition: transform 120ms var(--ease-out), box-shadow 120ms var(--ease-out),
                  background 120ms var(--ease-out);
    }
    .wc-step:disabled { opacity: .45; cursor: default; box-shadow: none; }
    .wc-step:not(:disabled):active,
    .wc-step.wc-pressed:not(:disabled) {
      /* press = sink into the surface */
      transform: translateY(1px) scale(.97);
      box-shadow: var(--press);
      background: var(--bg-sink);
    }
    .wc-step-glass .wc-glass-ico { font-size: 16px; line-height: 1; }

    /* ── logged drinks ── */
    .wc-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
    .wc-row {
      display: flex; align-items: center; justify-content: space-between; gap: 12px;
      min-height: 44px; padding: 0 14px;
      font-family: var(--font-ui);
    }
    .wc-row-name { font-size: 14px; color: var(--ink); }
    .wc-row-amt {
      font-size: 14px; font-weight: 600; color: var(--ink-dim);
      font-variant-numeric: tabular-nums;
    }
    .wc-empty {
      margin: 2px 0 0; font-family: var(--font-ui); font-size: 13px; color: var(--ink-faint);
    }

    /* reduced-motion: the page-host killswitch already neutralises transitions; belt-and-braces here. */
    @media (prefers-reduced-motion: reduce) {
      .wc-fill, .wc-step { transition: none; }
    }
  `],
})
export class WaterCard {
  protected readonly opt = inject(OptimisticTracker);

  /** One 250 ml "glass" — the wire amount the glass stepper sends. */
  protected readonly glassMl = ML_PER_GLASS;

  /** Which stepper is currently held (drives the press-sink visual while held). */
  protected readonly pressed = signal<'s250' | 's500' | 'glass' | null>(null);

  // ── derived state off the optimistic day() signal ──
  protected readonly imperial = this.opt.imperial;

  private readonly day = this.opt.day;

  protected readonly currentMl = computed(() => this.day()?.hydrationMl ?? 0);
  protected readonly goalMl = computed(() => this.day()?.hydrationGoalMl ?? 0);
  protected readonly entries = computed(() => this.day()?.hydration ?? []);

  /** Capsule fill as a 0..100 percentage of the goal (clamped; 0 when no goal). */
  protected readonly fillPct = computed(() => {
    const goal = this.goalMl();
    if (goal <= 0) return 0;
    return Math.min(100, (this.currentMl() / goal) * 100);
  });
  protected readonly overGoal = computed(() => this.goalMl() > 0 && this.currentMl() > this.goalMl());

  /** Unit-aware stepper labels (the wire ml is fixed; the label reads oz in Imperial). */
  protected readonly step250 = computed(() => hydrationStep(250, this.imperial()));
  protected readonly step500 = computed(() => hydrationStep(500, this.imperial()));

  /** Numeral halves of the capsule readout, unit-aware. */
  protected readonly nowLabel = computed(() => formatVolume(this.currentMl(), this.imperial()) ?? '0');
  protected readonly goalLabel = computed(() => formatVolume(this.goalMl(), this.imperial()) ?? '—');

  protected readonly glassesNow = computed(() => glasses(this.currentMl()));
  protected readonly glassesGoal = computed(() => glasses(this.goalMl()));

  /** Full text-equivalent for the capsule (it is an img role, so it needs a label). */
  protected readonly capsuleLabel = computed(() => {
    const now = this.nowLabel();
    const goal = this.goalMl() > 0 ? ` of ${this.goalLabel()} goal` : '';
    const over = this.overGoal() ? ', goal reached' : '';
    return `${now} water logged${goal}${over}`;
  });

  /** Per-entry amount label (unit-aware). */
  protected entryLabel(ml: number): string {
    return formatVolume(ml, this.imperial()) ?? `${ml} ml`;
  }

  /** Begin the held-press visual (paired with the click that actually logs). */
  protected press(which: 's250' | 's500' | 'glass'): void {
    if (this.opt.readOnly()) return;
    this.pressed.set(which);
  }

  protected release(): void {
    this.pressed.set(null);
  }

  /**
   * Optimistically log `amountMl` of water: the wrapper patches day() first so the capsule rises instantly,
   * then fires the API and reconciles. A short haptic confirms the tap on supporting hardware.
   */
  protected add(amountMl: number, which: 's250' | 's500' | 'glass'): void {
    if (this.opt.readOnly()) return;
    this.release();
    try { navigator.vibrate?.(10); } catch { /* unsupported — no-op */ }
    void this.opt.addHydration({ date: this.opt.date(), amountMl });
  }
}
