import {
  ChangeDetectionStrategy, Component, computed, inject,
} from '@angular/core';
import { MatIconModule } from '@angular/material/icon';

import { OptimisticTracker } from '../state/optimistic-tracker';
import { SwipeRow } from '../ui/swipe-row';

/**
 * Strata COFFEE sediment card — the caffeine domain tile in the Today dashboard.
 *
 * FOCUS (per the build brief): glanceable "{cups} cups · {caffeineMg} mg" with an inline +1 stepper that
 * logs one more cup OPTIMISTICALLY via {@link OptimisticTracker.addCoffee} (hero/roll-ups tick instantly,
 * undo/retry handled by the wrapper). Logged cups list under it as swipe-left-to-delete rows.
 *
 * Self-styled with the page-host Strata tokens (var(--coffee-a/-b), --ink, --lift-*, etc.) — NO global
 * --tech-* tokens. Matte sediment card (.tb-card extrusion language, no blur). Mobile-first: 44px targets,
 * touch-action manipulation, aria labels on icon-only controls, reduced-motion handled by the host
 * killswitch. The card reads through the optimistic wrapper so it stays consistent with the patched day().
 *
 * It is a self-contained `.tb-card` (binds the shared shell class on :host) so the page can drop
 * `<app-tracker-beta-coffee-card>` straight into the card stack with no wrapper.
 *
 * One whole cup labelled "Cup" at ~95 mg caffeine matches the existing tracker's "Mug" quick-add preset
 * (tracker.html quickCoffee(1, 'Mug', 95)) so the beta and classic surfaces never drift on the estimate.
 */
@Component({
  selector: 'app-tracker-beta-coffee-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, SwipeRow],
  host: { class: 'tb-card tb-coffee-card' },
  template: `
    <header class="tb-coffee__head">
      <span class="tb-coffee__icon" aria-hidden="true">
        <mat-icon>local_cafe</mat-icon>
      </span>
      <div class="tb-coffee__headline">
        <h3 class="tb-coffee__title">Coffee</h3>
        <p class="tb-coffee__summary">
          <span class="tb-coffee__num">{{ cups() }}</span>
          <span class="tb-coffee__unit">{{ cups() === 1 ? 'cup' : 'cups' }}</span>
          @if (caffeineMg() > 0) {
            <span class="tb-coffee__dot" aria-hidden="true">·</span>
            <span class="tb-coffee__num">{{ caffeineMg() }}</span>
            <span class="tb-coffee__unit">mg</span>
          }
        </p>
      </div>

      <button type="button" class="tb-coffee__step"
              [disabled]="readOnly()"
              (click)="addCup()"
              [attr.aria-label]="'Add one cup of coffee. ' + ariaState()">
        <mat-icon aria-hidden="true">add</mat-icon>
        <span class="tb-coffee__step-label">1</span>
      </button>
    </header>

    @if (entries().length) {
      <ul class="tb-coffee__rows" aria-label="Logged coffee">
        @for (c of entries(); track c.id) {
          <li>
            <app-swipe-row [disabled]="readOnly()"
                           [label]="rowLabel(c)"
                           (delete)="opt.deleteCoffee(c.id)">
              <div class="tb-coffee__row">
                <span class="tb-coffee__row-name">{{ c.label || (c.cups === 1 ? 'Cup' : c.cups + ' cups') }}</span>
                <span class="tb-coffee__leader" aria-hidden="true"></span>
                <span class="tb-coffee__row-amt">
                  @if ((c.caffeineMg ?? 0) > 0) {
                    {{ c.caffeineMg }} mg
                  } @else {
                    {{ c.cups }}<span class="tb-coffee__row-unit"> cup{{ c.cups === 1 ? '' : 's' }}</span>
                  }
                </span>
              </div>
            </app-swipe-row>
          </li>
        }
      </ul>
    } @else {
      <p class="tb-coffee__empty">No coffee yet today.</p>
    }
  `,
  styles: [`
    :host {
      // Layered onto the shared .tb-card matte extrusion (set on the host element class).
      display: block;
    }

    .tb-coffee__head {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .tb-coffee__icon {
      flex: 0 0 auto;
      display: grid;
      place-items: center;
      width: 40px;
      height: 40px;
      border-radius: var(--r-tile);
      // Bronze->tan coffee accent, applied as a gradient (never flat) per the token contract.
      background: linear-gradient(135deg, var(--coffee-a), var(--coffee-b));
      color: #1a0e00;
      box-shadow: var(--lift-1);

      mat-icon { font-size: 22px; width: 22px; height: 22px; }
    }

    .tb-coffee__headline {
      flex: 1 1 auto;
      min-width: 0;
    }

    .tb-coffee__title {
      margin: 0;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: .04em;
      text-transform: uppercase;
      color: var(--ink-dim);
    }

    .tb-coffee__summary {
      margin: 2px 0 0;
      display: flex;
      align-items: baseline;
      flex-wrap: wrap;
      gap: 4px;
      color: var(--ink);
    }

    .tb-coffee__num {
      font-family: var(--font-display);
      font-size: 22px;
      font-weight: 600;
      letter-spacing: -.025em;
      font-variant-numeric: tabular-nums;
      line-height: 1;
    }

    .tb-coffee__unit {
      font-size: 12px;
      font-weight: 500;
      color: var(--ink-dim);
    }

    .tb-coffee__dot {
      color: var(--ink-faint);
      padding: 0 2px;
    }

    // Inline +1 stepper — Strata press well (sink on tap, spring back).
    .tb-coffee__step {
      flex: 0 0 auto;
      display: inline-flex;
      align-items: center;
      gap: 2px;
      min-width: 56px;
      min-height: 44px;
      padding: 0 14px 0 10px;
      border: 1px solid var(--glass-edge);
      border-radius: var(--r-pill);
      background: var(--bg-base);
      color: var(--ink);
      font-family: var(--font-display);
      font-size: 16px;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
      cursor: pointer;
      touch-action: manipulation;
      -webkit-tap-highlight-color: transparent;
      transition: transform 120ms var(--ease-out), box-shadow 120ms var(--ease-out);

      mat-icon {
        font-size: 18px;
        width: 18px;
        height: 18px;
        color: var(--coffee-b);
      }

      &:active:not(:disabled) {
        transform: scale(.97) translateY(1px);
        box-shadow: var(--press);
      }

      &:disabled {
        opacity: .45;
        cursor: not-allowed;
      }
    }

    .tb-coffee__step-label { line-height: 1; }

    .tb-coffee__rows {
      list-style: none;
      margin: 14px 0 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    // GRAFT(LEDGER): dotted-leader typeset rows — name left, tabular amount right.
    .tb-coffee__row {
      display: flex;
      align-items: baseline;
      gap: 8px;
      min-height: 44px;
      padding: 0 12px;
    }

    .tb-coffee__row-name {
      flex: 0 1 auto;
      font-size: 15px;
      color: var(--ink);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .tb-coffee__leader {
      flex: 1 1 auto;
      align-self: flex-end;
      margin-bottom: 4px;
      border-bottom: 1px dotted var(--hairline);
      min-width: 12px;
    }

    .tb-coffee__row-amt {
      flex: 0 0 auto;
      font-family: var(--font-display);
      font-size: 15px;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
      color: var(--ink-dim);
    }

    .tb-coffee__row-unit {
      font-family: var(--font-ui);
      font-size: 12px;
      font-weight: 500;
      color: var(--ink-faint);
    }

    .tb-coffee__empty {
      margin: 14px 0 0;
      font-size: 13px;
      color: var(--ink-faint);
    }
  `],
})
export class CoffeeCard {
  protected readonly opt = inject(OptimisticTracker);

  /** Default caffeine for one quick cup — matches the classic tracker's "Mug" preset (~95 mg). */
  private static readonly MG_PER_CUP = 95;

  protected readonly readOnly = this.opt.readOnly;

  /** Total cups logged today (roll-up kept consistent by the optimistic wrapper's recompute). */
  protected readonly cups = computed(() => this.opt.day()?.coffeeCups ?? 0);
  /** Total caffeine (mg) logged today across all coffee entries. */
  protected readonly caffeineMg = computed(() => this.opt.day()?.caffeineMg ?? 0);
  /** Resolved daily coffee cap, in cups (server default 3 when unset). */
  protected readonly goalCups = computed(() => this.opt.day()?.coffeeGoalCups ?? 0);
  /** The day's coffee entries, oldest-first. */
  protected readonly entries = computed(() => this.opt.day()?.coffee ?? []);

  /** aria description of the current standing (e.g. "2 of 3 cups, 190 mg caffeine"). */
  protected readonly ariaState = computed(() => {
    const cups = this.cups();
    const goal = this.goalCups();
    const mg = this.caffeineMg();
    const cupsPart = goal > 0 ? `${cups} of ${goal} cups` : `${cups} cup${cups === 1 ? '' : 's'}`;
    return mg > 0 ? `${cupsPart}, ${mg} mg caffeine.` : `${cupsPart}.`;
  });

  /** Optimistically log one more cup (~95 mg) for the active day. */
  protected addCup(): void {
    if (this.readOnly()) return;
    void this.opt.addCoffee({
      date: this.opt.date(),
      cups: 1,
      label: 'Cup',
      caffeineMg: CoffeeCard.MG_PER_CUP,
    });
  }

  /** aria label for a swipe row (what would be deleted). */
  protected rowLabel(c: { label?: string; cups: number; caffeineMg?: number }): string {
    const name = c.label || (c.cups === 1 ? 'Cup' : `${c.cups} cups`);
    const mg = (c.caffeineMg ?? 0) > 0 ? `, ${c.caffeineMg} mg` : '';
    return `Delete ${name}${mg}`;
  }
}
