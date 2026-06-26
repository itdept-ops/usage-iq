import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';

import { AuthService } from '../../../core/auth';
import { PERM } from '../../../core/models';
import { TrackerStore, toLocalDate } from '../../../core/tracker-store';
import { BetaSvgRing } from '../../beta-ui';
import { AtriumWidgetShell, WidgetPhase } from './widget-shell';
import { ReorderableWidget } from './reorderable';

/**
 * Atrium "Today's rings" widget — calories / protein / water as three REAL concentric SvgRings (kit
 * `BetaSvgRing`, accent gradients rendered as SVG linearGradients, never flat), each with a big Clash
 * Display numeral at its center, plus one optimistic `+water` button.
 *
 * Isolation: injects the ROOT {@link TrackerStore} (shared with the live `/tracker` and `/tracker-beta`
 * pages) and reads its signals READ-ONLY, plus the single legitimate user action `addHydration` (an
 * existing store method — not new behavior, not a live-component edit). It calls `store.load()` once on
 * init exactly as the live pages do (the store does not auto-load); that's a read-only refresh of shared
 * day state.
 *
 * Auto-hide: the parent only renders this card when {@link visible} is true (perm held). Phase: skeleton
 * until `day()` is non-null, `failed` if `store.error()` is set; after load the DTO is always full.
 */
@Component({
  selector: 'atr-rings-widget',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AtriumWidgetShell, BetaSvgRing, MatIconModule],
  template: `
    <atr-widget-shell
      title="Today's rings" route="/tracker"
      accentA="#8b5cff" accentB="#4f7bff"
      [phase]="phase()" emptyText="No tracker data yet — log a meal to fill your rings." emptyIcon="data_usage"
      [reordering]="reordering()"
      (retry)="reload()" (moveUp)="moveUp.emit()" (moveDown)="moveDown.emit()" (hide)="hide.emit()">

      @if (day(); as d) {
        <div body class="rings">
          <div class="ring">
            <app-bs-ring [value]="ringValue(calFrac())" [size]="92" [stroke]="9"
                         from="#7c5cff" to="#4f7bff" [label]="calPct() + '% of calorie goal'">
              <span class="ring__c">
                <span class="ring__num">{{ d.caloriesIn ?? 0 }}</span>
                <span class="ring__unit">{{ d.calorieGoal ? 'of ' + d.calorieGoal : 'no goal' }}</span>
              </span>
            </app-bs-ring>
            <span class="ring__lbl">Calories</span>
          </div>

          <div class="ring">
            <app-bs-ring [value]="ringValue(proFrac())" [size]="92" [stroke]="9"
                         from="#22d3ee" to="#34d399" [label]="proPct() + '% of protein goal'">
              <span class="ring__c">
                <span class="ring__num">{{ d.proteinG ?? 0 }}<small>g</small></span>
                <span class="ring__unit">{{ proteinGoal() ? 'of ' + proteinGoal() + 'g' : 'no goal' }}</span>
              </span>
            </app-bs-ring>
            <span class="ring__lbl">Protein</span>
          </div>

          <div class="ring">
            <app-bs-ring [value]="ringValue(waterFrac())" [size]="92" [stroke]="9"
                         from="#38bdf8" to="#22d3ee" [label]="waterPct() + '% of hydration goal'">
              <span class="ring__c">
                <span class="ring__num">{{ waterCups(d.hydrationMl) }}</span>
                <span class="ring__unit">of {{ waterCups(d.hydrationGoalMl) }} cups</span>
              </span>
            </app-bs-ring>
            <button type="button" class="ring__add" (click)="addWater($event)"
                    [disabled]="busy()" aria-label="Add a cup of water">
              <mat-icon aria-hidden="true">add</mat-icon> water
            </button>
          </div>
        </div>
      }
    </atr-widget-shell>
  `,
  styles: [`
    .rings { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
    .ring { display: flex; flex-direction: column; align-items: center; gap: 8px; min-width: 0; }
    .ring__c { display: flex; flex-direction: column; align-items: center; gap: 1px; line-height: 1; }
    .ring__num {
      font-family: var(--font-display); font-variant-numeric: tabular-nums;
      font-weight: 600; font-size: 22px; letter-spacing: -.03em; color: var(--ink); line-height: 1;
    }
    .ring__num small { font-size: 13px; font-weight: 600; color: var(--ink-dim); }
    .ring__unit { font-family: var(--font-ui); font-size: 10px; color: var(--ink-faint); white-space: nowrap; }
    .ring__lbl { font-size: 11px; font-weight: 600; letter-spacing: .03em; text-transform: uppercase; color: var(--ink-dim); }
    .ring__add {
      display: inline-flex; align-items: center; gap: 3px;
      min-height: 30px; padding: 0 12px; border-radius: var(--r-pill);
      border: 1px solid color-mix(in srgb, #38bdf8 40%, var(--hairline));
      background: color-mix(in srgb, #38bdf8 12%, transparent);
      color: #7ad0ff; font: inherit; font-size: 12px; font-weight: 600; cursor: pointer;
      transition: transform 120ms var(--ease-spring);
    }
    .ring__add:active:not(:disabled) { transform: scale(.92); }
    .ring__add:disabled { opacity: .5; cursor: default; }
    .ring__add mat-icon { font-size: 16px; width: 16px; height: 16px; }
  `],
})
export class RingsWidget extends ReorderableWidget {
  private readonly store = inject(TrackerStore);
  private readonly auth = inject(AuthService);

  readonly day = this.store.day;

  /** True when the user can see this widget AND data isn't structurally null — drives parent auto-hide. */
  readonly visible = computed(() => {
    this.auth.permissions();
    return this.auth.hasPermission(PERM.trackerSelf);
  });

  readonly phase = computed<WidgetPhase>(() => {
    if (this.store.day()) return 'ready';
    if (this.store.error()) return 'failed';
    return 'loading';
  });

  readonly busy = computed(() => this.store.loading());

  readonly proteinGoal = computed(() => this.store.day()?.profile?.proteinGoalG ?? null);

  readonly calPct = computed(() => this.pct(this.store.day()?.caloriesIn, this.store.day()?.calorieGoal));
  readonly proPct = computed(() => this.pct(this.store.day()?.proteinG, this.proteinGoal() ?? undefined));
  readonly waterPct = computed(() => this.pct(this.store.day()?.hydrationMl, this.store.day()?.hydrationGoalMl));

  /** 0..1 fractions for the SvgRings (the % computeds power the aria labels). */
  readonly calFrac = computed(() => this.calPct() / 100);
  readonly proFrac = computed(() => this.proPct() / 100);
  readonly waterFrac = computed(() => this.waterPct() / 100);

  constructor() {
    super();
    // Read-only refresh of the shared day (same call the live pages make on init).
    void this.reload();
  }

  reload(): Promise<void> {
    return this.store.load();
  }

  /** ~250 ml per cup, rounded. */
  waterCups(ml: number | undefined): number {
    return Math.round((ml ?? 0) / 250);
  }

  /**
   * Floor the ring fraction to a faint minimum so the accent gradient's rounded cap still hints at
   * 0 (an all-grey donut reads as broken). The aria %/numerals stay truthful — this only nudges the
   * drawn arc.
   */
  ringValue(frac: number): number {
    return frac > 0 ? frac : 0.035;
  }

  /** Optimistic +water: the existing store action POSTs then refreshes the shared `day()` signal. */
  async addWater(ev: Event): Promise<void> {
    ev.preventDefault();
    ev.stopPropagation();
    if (this.busy()) return;
    try {
      await this.store.addHydration({ date: toLocalDate(new Date()), amountMl: 250, label: 'Water' });
    } catch {
      // store.error() surfaces in the phase; nothing to do here
    }
  }

  private pct(value: number | undefined, goal: number | undefined): number {
    if (!goal || goal <= 0) return 0;
    return Math.max(0, Math.min(100, Math.round(((value ?? 0) / goal) * 100)));
  }
}
