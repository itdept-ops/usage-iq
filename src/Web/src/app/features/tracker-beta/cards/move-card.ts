import {
  ChangeDetectionStrategy, Component, computed, effect, inject, output, signal,
} from '@angular/core';

import { OptimisticTracker } from '../state/optimistic-tracker';
import { SwipeRow } from '../ui/swipe-row';
import { formatDistance, group } from '../util/units';

/**
 * Strata MOVE card (sediment, --lift-2, matte — NOT one of the 3 blurred surfaces).
 *
 * A glanceable steps ring (move gradient rose→amber) reading day().activity.steps against
 * day().stepGoal, with the resolved active-burn (day().caloriesOut) + distance as secondary
 * read-outs, followed by the day's exercise rows. Every exercise row swipes left to delete
 * (optimistic + undo via {@link OptimisticTracker}). "+ add exercise" emits `addExercise` so the
 * PAGE opens the exercise quick-sheet (this card owns no sheet).
 *
 * Data (all already resolved by the wrapper's recompute / the server):
 *   - day().activity?.steps / .distanceMeters / .activeCalories  (watch row, may be null)
 *   - day().stepGoal                                             (resolved goal, may be undefined)
 *   - day().caloriesOut                                          (resolved burn: exercise + watch per calorieMode)
 *   - day().exercises[]                                          (logged exercise rows)
 *
 * Self-styled with the inherited var(--*) Strata tokens (no global --tech-*). Mobile-first:
 * 44px targets, aria text equivalents, reduced-motion handled by the page-host killswitch (the
 * ring's count-up + arc transition collapse to instant).
 *
 * Contract:
 *   selector: app-move-card
 *   inputs:   none (reads everything off the injected OptimisticTracker / shared day() signal)
 *   outputs:  addExercise (void) — the page opens the exercise quick-sheet
 */
@Component({
  selector: 'app-move-card',
  standalone: true,
  imports: [SwipeRow],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="mv" aria-labelledby="mv-h">
      <header class="mv-head">
        <h2 id="mv-h" class="mv-title">Move</h2>
        <span class="mv-burn" [attr.aria-label]="caloriesOut() + ' calories burned'">
          {{ group(caloriesOut()) }}<span class="mv-burn-u"> kcal</span>
        </span>
      </header>

      <div class="mv-top">
        <!-- Steps ring (move gradient, rose→amber). Decorative; the figures carry an aria-label. -->
        <div class="mv-ring" role="img" [attr.aria-label]="ringAria()">
          <svg viewBox="0 0 120 120" width="120" height="120" aria-hidden="true">
            <defs>
              <linearGradient id="mv-grad" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stop-color="var(--move-a)" />
                <stop offset="1" stop-color="var(--move-b)" />
              </linearGradient>
            </defs>
            <circle class="mv-track" cx="60" cy="60" [attr.r]="R" />
            <circle class="mv-arc" cx="60" cy="60" [attr.r]="R"
                    [attr.stroke-dasharray]="CIRC"
                    [attr.stroke-dashoffset]="dashOffset()"
                    transform="rotate(-90 60 60)" />
          </svg>
          <div class="mv-ring-center">
            <span class="mv-steps">{{ group(displaySteps()) }}</span>
            <span class="mv-steps-l">steps</span>
          </div>
        </div>

        <dl class="mv-stats">
          @if (stepGoal()) {
            <div class="mv-stat">
              <dt>goal</dt>
              <dd>{{ group(stepGoal()!) }}</dd>
            </div>
          }
          @if (distance(); as dist) {
            <div class="mv-stat">
              <dt>distance</dt>
              <dd>{{ dist }}</dd>
            </div>
          }
          @if (activeCalories() != null) {
            <div class="mv-stat">
              <dt>active</dt>
              <dd>{{ group(activeCalories()!) }} kcal</dd>
            </div>
          }
        </dl>
      </div>

      <!-- Exercise rows — each a swipe-to-delete ledger line. -->
      @if (exercises().length) {
        <ul class="mv-list">
          @for (ex of exercises(); track ex.id) {
            <li>
              <app-swipe-row [disabled]="readOnly()"
                             [label]="'Delete ' + ex.name"
                             (delete)="onDelete(ex.id)">
                <div class="mv-row">
                  <span class="mv-row-name">{{ ex.name }}</span>
                  <span class="mv-leader" aria-hidden="true"></span>
                  <span class="mv-row-meta">
                    @if (ex.durationMin) { <span class="mv-row-dur">{{ ex.durationMin }} min</span> }
                    <span class="mv-row-kcal">{{ group(ex.caloriesBurned) }} kcal</span>
                  </span>
                </div>
              </app-swipe-row>
            </li>
          }
        </ul>
      } @else {
        <p class="mv-empty">No exercise logged yet.</p>
      }

      @if (!readOnly()) {
        <button type="button" class="mv-add" (click)="addExercise.emit()">
          <span class="mv-add-plus" aria-hidden="true">+</span> add exercise
        </button>
      }
    </section>
  `,
  styles: [`
    :host { display: block; }

    .mv-head {
      display: flex; align-items: baseline; justify-content: space-between; gap: 12px;
      margin-bottom: 14px;
    }
    .mv-title {
      margin: 0; font-family: var(--font-ui); font-size: 13px; font-weight: 600;
      letter-spacing: .04em; text-transform: uppercase; color: var(--ink-dim);
    }
    .mv-burn {
      font-family: var(--font-display); font-size: 20px; font-weight: 600;
      letter-spacing: -.02em; color: var(--ink); font-variant-numeric: tabular-nums;
    }
    .mv-burn-u {
      font-family: var(--font-ui); font-size: 11px; font-weight: 500;
      letter-spacing: .04em; text-transform: uppercase; color: var(--ink-dim);
    }

    .mv-top {
      display: flex; align-items: center; gap: 18px; margin-bottom: 14px;
    }

    .mv-ring {
      position: relative; flex: 0 0 auto; width: 120px; height: 120px;
    }
    .mv-track {
      fill: none; stroke: var(--hairline); stroke-width: 10;
    }
    .mv-arc {
      fill: none; stroke: url(#mv-grad); stroke-width: 10; stroke-linecap: round;
      transition: stroke-dashoffset 700ms var(--ease-spring);
    }
    .mv-ring-center {
      position: absolute; inset: 0; display: flex; flex-direction: column;
      align-items: center; justify-content: center; gap: 1px; pointer-events: none;
    }
    .mv-steps {
      font-family: var(--font-display); font-size: 22px; font-weight: 600;
      letter-spacing: -.02em; color: var(--ink); font-variant-numeric: tabular-nums;
    }
    .mv-steps-l {
      font-size: 10px; font-weight: 500; letter-spacing: .04em; text-transform: uppercase;
      color: var(--ink-dim);
    }

    .mv-stats {
      flex: 1 1 auto; margin: 0; display: flex; flex-direction: column; gap: 8px;
    }
    .mv-stat {
      display: flex; align-items: baseline; justify-content: space-between; gap: 8px;
    }
    .mv-stat dt {
      font-size: 11px; font-weight: 500; letter-spacing: .04em; text-transform: uppercase;
      color: var(--ink-dim);
    }
    .mv-stat dd {
      margin: 0; font-size: 14px; font-weight: 600; color: var(--ink);
      font-variant-numeric: tabular-nums;
    }

    .mv-list {
      list-style: none; margin: 0 0 4px; padding: 0;
      display: flex; flex-direction: column; gap: 6px;
    }
    .mv-row {
      display: flex; align-items: baseline; gap: 8px;
      min-height: 44px; padding: 8px 12px;
    }
    .mv-row-name {
      flex: 0 1 auto; font-size: 15px; font-weight: 500; color: var(--ink);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    /* GRAFT(LEDGER): 1px dotted leader between the humanist name and the tabular figures. */
    .mv-leader {
      flex: 1 1 auto; align-self: flex-end; margin-bottom: 4px;
      border-bottom: 1px dotted var(--hairline); min-width: 12px;
    }
    .mv-row-meta {
      flex: 0 0 auto; display: flex; align-items: baseline; gap: 8px;
      font-variant-numeric: tabular-nums;
    }
    .mv-row-dur { font-size: 12px; color: var(--ink-faint); }
    .mv-row-kcal { font-size: 14px; font-weight: 600; color: var(--ink); }

    .mv-empty {
      margin: 0 0 6px; padding: 8px 2px; font-size: 13px; color: var(--ink-faint);
    }

    .mv-add {
      display: inline-flex; align-items: center; gap: 6px;
      min-height: 44px; padding: 10px 14px;
      border: 1px solid var(--glass-edge); border-radius: var(--r-pill);
      background: transparent; color: var(--ink-dim);
      font-family: var(--font-ui); font-size: 13px; font-weight: 600; letter-spacing: .01em;
      cursor: pointer; touch-action: manipulation; -webkit-tap-highlight-color: transparent;
      transition: transform 120ms var(--ease-out), box-shadow 120ms var(--ease-out),
                  color 120ms var(--ease-out);
    }
    .mv-add:active { transform: scale(.97) translateY(1px); box-shadow: var(--press); }
    .mv-add-plus {
      font-size: 18px; font-weight: 600; line-height: 1;
      color: var(--move-a);
    }
  `],
})
export class MoveCard {
  private opt = inject(OptimisticTracker);

  /** The page opens the exercise quick-sheet in response. */
  readonly addExercise = output<void>();

  // ---- ring geometry (matches the 120x120 viewBox + 10px stroke) ----
  protected readonly R = 52;
  protected readonly CIRC = 2 * Math.PI * 52;

  // ---- read state (off the shared day() signal) ----
  protected readonly readOnly = this.opt.readOnly;
  protected readonly group = group;

  private readonly day = this.opt.day;

  protected readonly exercises = computed(() => this.day()?.exercises ?? []);
  /** Resolved burn (exercise + watch active per calorieMode) — already summed by the wrapper. */
  protected readonly caloriesOut = computed(() => this.day()?.caloriesOut ?? 0);
  protected readonly steps = computed(() => this.day()?.activity?.steps ?? 0);
  protected readonly stepGoal = computed(() => this.day()?.stepGoal);
  protected readonly activeCalories = computed<number | null>(
    () => this.day()?.activity?.activeCalories ?? null,
  );
  protected readonly distance = computed(() =>
    formatDistance(this.day()?.activity?.distanceMeters, this.opt.imperial()),
  );

  /** Fraction of the step goal met (0..1), clamped; 0 when no goal so the arc reads empty. */
  private readonly progress = computed(() => {
    const goal = this.stepGoal();
    if (!goal || goal <= 0) return 0;
    return Math.min(1, this.steps() / goal);
  });

  // ---- count-up ticker for the steps numeral (collapses to instant under reduced-motion) ----
  protected readonly displaySteps = signal(0);
  private rafId: ReturnType<typeof requestAnimationFrame> | null = null;
  private readonly prefersReduced =
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  /** Arc dash offset; 0 progress = fully offset (empty), full progress = 0 offset. */
  protected readonly dashOffset = computed(() => this.CIRC * (1 - this.progress()));

  constructor() {
    // Animate the steps numeral toward the live value whenever it changes.
    effect(() => {
      const target = this.steps();
      if (this.prefersReduced) { this.displaySteps.set(target); return; }
      this.tickTo(target);
    });
  }

  private tickTo(target: number): void {
    if (this.rafId != null) cancelAnimationFrame(this.rafId);
    const from = this.displaySteps();
    if (from === target) return;
    const start = performance.now();
    const dur = 600;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / dur);
      // ease-out cubic
      const eased = 1 - Math.pow(1 - t, 3);
      this.displaySteps.set(Math.round(from + (target - from) * eased));
      if (t < 1) this.rafId = requestAnimationFrame(step);
      else this.rafId = null;
    };
    this.rafId = requestAnimationFrame(step);
  }

  /** Text equivalent for the steps ring (the SVG itself is aria-hidden). */
  protected readonly ringAria = computed(() => {
    const s = this.steps();
    const goal = this.stepGoal();
    const base = `${group(s)} steps`;
    return goal ? `${base} of ${group(goal)} goal` : base;
  });

  protected onDelete(id: number): void {
    void this.opt.deleteExercise(id);
  }
}
