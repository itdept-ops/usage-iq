import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';

import { AuthService } from '../../../core/auth';
import { ChallengeStore } from '../../../core/challenge-store';
import { PERM } from '../../../core/models';
import { BetaSvgRing } from '../../beta-ui';
import { AtriumWidgetShell, WidgetPhase } from './widget-shell';
import { ReorderableWidget } from './reorderable';

/**
 * Atrium "75 Hard" widget — a hero progress ring (day N of total, as a real `BetaSvgRing` with the streak
 * flame + day-count at its center), today's points, and a compact day-progress pip row. Injects the ROOT
 * {@link ChallengeStore} (shared with the live `/challenge` page), reads it READ-ONLY, and calls
 * `store.load()` once on init (the store does not auto-load).
 *
 * Auto-hide: {@link visible} is false when the perm is missing OR a load has completed with no active
 * challenge (`loaded() && challenge() === null`) — the brief's "hidden if no challenge".
 */
@Component({
  selector: 'atr-hard-widget',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AtriumWidgetShell, BetaSvgRing],
  template: `
    <atr-widget-shell
      title="75 Hard" route="/challenge"
      accentA="#f0a35a" accentB="#fb7185"
      [phase]="phase()" emptyText="No active challenge — start one to track your streak." emptyIcon="local_fire_department"
      [reordering]="reordering()"
      (retry)="reload()" (moveUp)="moveUp.emit()" (moveDown)="moveDown.emit()" (hide)="hide.emit()">

      @if (challenge(); as c) {
        <div body class="hard">
          <app-bs-ring class="hard__ring" [value]="ringValue()" [size]="78" [stroke]="9"
                       from="#f0a35a" to="#fb7185"
                       [label]="'Day ' + c.currentDay + ' of ' + c.totalDays">
            <span class="hard__c">
              <span class="hard__day">{{ c.currentDay }}</span>
              <span class="hard__of">of {{ c.totalDays }}</span>
            </span>
          </app-bs-ring>

          <div class="hard__side">
            @if (c.currentDay <= 0) {
              <div class="hard__notstarted">Not started</div>
            } @else {
              <div class="hard__streak">
                <span class="hard__flame" aria-hidden="true">🔥</span>
                <span class="hard__streak-n">{{ c.currentStreak }}</span>
                <span class="hard__streak-l">day streak</span>
              </div>
            }
            <div class="hard__pts">{{ c.todayPoints }} pts today</div>
            <div class="hard__pips" role="img" [attr.aria-label]="c.currentDay + ' of ' + c.totalDays + ' days'">
              @for (p of pips(); track p.i) {
                <span class="hard__pip" [class.hard__pip--on]="p.done" [class.hard__pip--today]="p.today"></span>
              }
            </div>
          </div>
        </div>
      }
    </atr-widget-shell>
  `,
  styles: [`
    .hard { display: flex; align-items: center; gap: 16px; }
    .hard__ring { flex: 0 0 auto; }
    .hard__c { display: flex; flex-direction: column; align-items: center; line-height: 1; }
    .hard__day {
      font-family: var(--font-display); font-variant-numeric: tabular-nums;
      font-weight: 600; font-size: 28px; letter-spacing: -.03em; color: var(--ink); line-height: 1;
    }
    .hard__of { font-family: var(--font-ui); font-size: 11px; font-weight: 600; color: var(--ink-faint); white-space: nowrap; }

    .hard__notstarted {
      align-self: flex-start;
      padding: 3px 10px; border-radius: var(--r-pill);
      background: color-mix(in srgb, var(--ink) 8%, transparent);
      color: var(--ink-dim); font-size: 12px; font-weight: 700;
    }

    .hard__side { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
    .hard__streak { display: flex; align-items: baseline; gap: 6px; }
    .hard__flame { font-size: 18px; line-height: 1; filter: drop-shadow(0 0 6px color-mix(in srgb, #fb7185 55%, transparent)); }
    .hard__streak-n {
      font-family: var(--font-display); font-variant-numeric: tabular-nums;
      font-weight: 600; font-size: 24px; letter-spacing: -.03em; color: var(--ink); line-height: 1;
    }
    .hard__streak-l { font-size: 11px; font-weight: 600; letter-spacing: .03em; text-transform: uppercase; color: var(--ink-dim); }
    .hard__pts {
      align-self: flex-start;
      padding: 3px 10px; border-radius: var(--r-pill);
      background: color-mix(in srgb, #f0a35a 14%, transparent);
      color: #f6bd84; font-size: 12px; font-weight: 700;
    }
    .hard__pips { display: flex; flex-wrap: wrap; gap: 4px; }
    .hard__pip { width: 7px; height: 7px; border-radius: 2.5px; background: color-mix(in srgb, var(--ink) 10%, transparent); }
    .hard__pip--on { background: linear-gradient(135deg, #f0a35a, #fb7185); }
    .hard__pip--today { box-shadow: 0 0 0 2px color-mix(in srgb, #fb7185 55%, transparent); }
  `],
})
export class HardWidget extends ReorderableWidget {
  private readonly store = inject(ChallengeStore);
  private readonly auth = inject(AuthService);

  readonly challenge = this.store.challenge;

  /** Auto-hide gate: needs the perm AND (still loading OR an active challenge). Hidden once loaded-empty. */
  readonly visible = computed(() => {
    this.auth.permissions();
    if (!this.auth.hasPermission(PERM.trackerSelf)) return false;
    // Keep the card while loading or on error (so the skeleton/retry shows); only hide when we KNOW
    // there's no challenge.
    return !(this.store.loaded() && this.store.challenge() === null && !this.store.error());
  });

  readonly phase = computed<WidgetPhase>(() => {
    if (this.store.challenge()) return 'ready';
    if (this.store.error()) return 'failed';
    if (!this.store.loaded()) return 'loading';
    return 'empty'; // loaded, no challenge — but the page hides us via visible() anyway
  });

  /** Day completion fraction for the hero ring. */
  readonly dayFrac = computed(() => {
    const c = this.store.challenge();
    if (!c || c.totalDays <= 0) return 0;
    return Math.max(0, Math.min(1, c.currentDay / c.totalDays));
  });

  /**
   * Floor the hero-ring fraction to a faint minimum so the accent cap still hints at day 0 (an
   * all-grey ring reads as broken). The aria label keeps the true day count.
   */
  readonly ringValue = computed(() => {
    const f = this.dayFrac();
    return f > 0 ? f : 0.035;
  });

  /** One pip per day; filled up to (and including) the current day, with the current day marked. */
  readonly pips = computed(() => {
    const c = this.store.challenge();
    if (!c) return [];
    const total = Math.max(0, c.totalDays);
    return Array.from({ length: total }, (_, i) => {
      const dayNum = i + 1;
      return { i, done: dayNum < c.currentDay, today: dayNum === c.currentDay };
    });
  });

  constructor() {
    super();
    void this.reload();
  }

  reload(): Promise<void> {
    return this.store.load();
  }
}
