import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { firstValueFrom } from 'rxjs';

import { Api } from '../../../core/api';
import { FamilyMealSlot, PlanMealDay, PlanMealSlot, PlanMealToWrite } from '../../../core/models';
import { BetaBottomSheet, BetaSegmentedControl, BetaSkeleton, Segment } from '../../beta-ui';
import { slotMeta } from '../meals-beta.model';

/**
 * Forage PlanSheet — "AI plan my week" in a BetaBottomSheet. Wraps the EXISTING `planMeals` (POST
 * /api/ai/plan-meals — writes nothing) + `planMealsToPlan` (the separate confirmed commit). The user
 * picks how many days + an optional free-text refine ("high protein", "quick"), previews the proposed
 * plan (each slot shows its dish, the per-dish calories, and an on-list/need ingredient hint), deselects
 * any they don't want, then commits — which creates the meals via the SAME create path as the live page.
 *
 * Reuse-only: no new endpoint. `aiUsed:false` is labelled plainly (deterministic fallback). On a
 * successful commit it emits `planned` (count) so the page reloads + toasts; the page owns the sheet's
 * open state (two-way).
 */
@Component({
  selector: 'app-forage-plan-sheet',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MatIconModule, BetaBottomSheet, BetaSegmentedControl, BetaSkeleton],
  template: `
    <app-bs-sheet [(open)]="open" detent="full" label="AI plan my week" (closed)="onClosed()">
      <div class="ps">
        <header class="ps-head">
          <span class="ps-spark" aria-hidden="true"><mat-icon>auto_awesome</mat-icon></span>
          <div class="ps-head-txt">
            <h2 class="ps-title">Plan with AI</h2>
            <p class="ps-sub">Fits your remaining macros and what's on hand. Review before anything is saved.</p>
          </div>
        </header>

        @if (phase() === 'setup') {
          <label class="ps-lbl">How many days?</label>
          <app-bs-segmented [segments]="daySegs" [(value)]="daysKey" label="Days to plan" />

          <label class="ps-lbl" for="ps-refine">Any preference? (optional)</label>
          <input id="ps-refine" class="ps-input" type="text" [(ngModel)]="constraints"
                 placeholder="high protein, quick, vegetarian…" maxlength="120" />

          <button type="button" class="ps-primary" [disabled]="busy()" (click)="generate()">
            @if (busy()) { <span class="ps-spin" aria-hidden="true"></span> Planning… }
            @else { <mat-icon aria-hidden="true">bolt</mat-icon> Generate plan }
          </button>
        }

        @if (phase() === 'loading') {
          <div class="ps-skel">
            @for (s of [0,1,2]; track s) { <app-bs-skeleton height="84px" radius="var(--r-tile)" /> }
          </div>
        }

        @if (phase() === 'review') {
          @if (!aiUsed()) {
            <div class="ps-note" role="status">
              <mat-icon aria-hidden="true">info</mat-icon>
              AI is off right now — here's a simple plan from your recent meals and groceries.
            </div>
          }
          <div class="ps-days">
            @for (d of days(); track d.localDate) {
              <div class="ps-day">
                <div class="ps-day-h">{{ dayLabel(d.localDate) }}</div>
                @for (s of d.slots; track $index) {
                  <button type="button" class="ps-slot" [class.is-off]="isOff(d.localDate, $index)"
                          (click)="toggle(d.localDate, $index)"
                          [attr.aria-pressed]="!isOff(d.localDate, $index)">
                    <span class="ps-check" aria-hidden="true">
                      <mat-icon>{{ isOff(d.localDate, $index) ? 'add_circle_outline' : 'check_circle' }}</mat-icon>
                    </span>
                    <span class="ps-slot-body">
                      <span class="ps-slot-top">
                        <mat-icon class="ps-slot-ic" aria-hidden="true">{{ icon(s.slot) }}</mat-icon>
                        <span class="ps-slot-name">{{ label(s.slot) }}</span>
                        <span class="ps-slot-cal">{{ kcal(s) }} kcal</span>
                      </span>
                      <span class="ps-slot-title">{{ s.title }}</span>
                      @if (needCount(s) > 0) {
                        <span class="ps-slot-need">{{ needCount(s) }} to buy · {{ haveCount(s) }} on hand</span>
                      } @else {
                        <span class="ps-slot-need ps-have">Everything's on hand</span>
                      }
                    </span>
                  </button>
                }
              </div>
            }
          </div>

          <div class="ps-actions">
            <button type="button" class="ps-ghost" [disabled]="busy()" (click)="phase.set('setup')">Redo</button>
            <button type="button" class="ps-primary ps-grow" [disabled]="busy() || selectedCount() === 0"
                    (click)="commit()">
              @if (busy()) { <span class="ps-spin" aria-hidden="true"></span> Adding… }
              @else { <mat-icon aria-hidden="true">playlist_add_check</mat-icon> Add {{ selectedCount() }} to plan }
            </button>
          </div>
        }

        @if (phase() === 'error') {
          <div class="ps-empty">
            <span class="ps-empty-ic" aria-hidden="true"><mat-icon>cloud_off</mat-icon></span>
            <p>Couldn't reach the planner. Please try again.</p>
            <button type="button" class="ps-primary" (click)="phase.set('setup')">Back</button>
          </div>
        }
      </div>
    </app-bs-sheet>
  `,
  styles: [`
    :host { display: contents; }
    .ps { display: flex; flex-direction: column; gap: 12px; padding-top: 4px; }
    .ps-head { display: flex; gap: 12px; align-items: flex-start; }
    .ps-spark {
      flex: 0 0 auto; display: grid; place-items: center; width: 42px; height: 42px; border-radius: 14px;
      background: linear-gradient(135deg, var(--accent-a), var(--accent-b)); color: var(--tech-text-on-accent, #07140d);
    }
    .ps-spark mat-icon { font-size: 22px; width: 22px; height: 22px; }
    .ps-head-txt { min-width: 0; }
    .ps-title { margin: 0; font-family: var(--font-display); font-weight: 600; font-size: 22px; color: var(--ink); }
    .ps-sub { margin: 2px 0 0; font-size: 13px; color: var(--ink-dim); line-height: 1.35; }

    .ps-lbl { font-size: 12px; font-weight: 800; letter-spacing: .04em; text-transform: uppercase; color: var(--ink-dim); margin-top: 4px; }
    .ps-input {
      width: 100%; box-sizing: border-box; padding: 12px 14px; min-height: 46px;
      border-radius: var(--r-tile); border: 1px solid var(--hairline); background: var(--bg-sink);
      color: var(--ink); font: inherit; font-size: 15px;
    }
    .ps-input::placeholder { color: var(--ink-faint); }
    .ps-input:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }

    .ps-primary {
      display: inline-flex; align-items: center; justify-content: center; gap: 8px;
      min-height: 50px; padding: 0 20px; border: none; border-radius: var(--r-pill);
      background: linear-gradient(135deg, var(--accent-a), var(--accent-b)); color: var(--tech-text-on-accent, #07140d);
      font-family: var(--font-ui); font-size: 15px; font-weight: 800; cursor: pointer;
      box-shadow: var(--lift-2); -webkit-tap-highlight-color: transparent; touch-action: manipulation;
      transition: transform 120ms var(--ease-out);
    }
    .ps-primary:active { transform: scale(.97); }
    .ps-primary:disabled { opacity: .55; pointer-events: none; }
    .ps-primary:focus-visible { outline: 2px solid var(--focus); outline-offset: 3px; }
    .ps-primary mat-icon { font-size: 20px; width: 20px; height: 20px; }
    .ps-grow { flex: 1 1 auto; }

    .ps-ghost {
      min-height: 50px; padding: 0 18px; border-radius: var(--r-pill);
      border: 1px solid var(--hairline); background: var(--bg-sink); color: var(--ink-dim);
      font: inherit; font-size: 14px; font-weight: 700; cursor: pointer;
    }
    .ps-ghost:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }

    .ps-spin {
      width: 16px; height: 16px; border-radius: 50%;
      border: 2px solid color-mix(in srgb, var(--tech-text-on-accent, #07140d) 35%, transparent); border-top-color: var(--tech-text-on-accent, #07140d);
      animation: ps-spin 0.7s linear infinite;
    }
    @keyframes ps-spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .ps-spin { animation: none; } }

    .ps-skel { display: flex; flex-direction: column; gap: 10px; }
    .ps-note {
      display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-radius: var(--r-tile);
      background: color-mix(in srgb, var(--warn) 14%, var(--bg-sink)); color: var(--ink);
      font-size: 13px; font-weight: 600;
    }
    .ps-note mat-icon { color: var(--warn); font-size: 20px; width: 20px; height: 20px; }

    .ps-days { display: flex; flex-direction: column; gap: 14px; }
    .ps-day { display: flex; flex-direction: column; gap: 8px; }
    .ps-day-h {
      font-family: var(--font-ui); font-size: 13px; font-weight: 800; color: var(--ink);
      letter-spacing: .02em;
    }
    .ps-slot {
      display: flex; align-items: stretch; gap: 10px; width: 100%; text-align: left;
      padding: 11px 12px; border-radius: var(--r-tile);
      border: 1px solid var(--hairline); background: var(--bg-rise); color: var(--ink);
      box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 6%, transparent);
      cursor: pointer; -webkit-tap-highlight-color: transparent;
      transition: border-color 160ms var(--ease-out), background 160ms var(--ease-out), opacity 160ms var(--ease-out);
    }
    .ps-slot:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
    .ps-slot.is-off { opacity: .5; }
    .ps-slot:not(.is-off) { border-color: color-mix(in srgb, var(--accent-a) 40%, transparent); }
    .ps-check { flex: 0 0 auto; display: grid; place-items: center; color: var(--accent-a); }
    .ps-slot.is-off .ps-check { color: var(--ink-faint); }
    .ps-check mat-icon { font-size: 24px; width: 24px; height: 24px; }
    .ps-slot-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .ps-slot-top { display: inline-flex; align-items: center; gap: 6px; }
    .ps-slot-ic { font-size: 16px; width: 16px; height: 16px; color: var(--accent-a); }
    .ps-slot-name {
      font-size: 11px; font-weight: 800; letter-spacing: .05em; text-transform: uppercase; color: var(--ink-dim);
    }
    .ps-slot-cal {
      margin-left: auto; font-family: var(--font-display); font-variant-numeric: tabular-nums;
      font-size: 13px; font-weight: 600; color: var(--ink-dim);
    }
    .ps-slot-title { font-size: 15px; font-weight: 700; color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ps-slot-need { font-size: 12px; font-weight: 600; color: var(--ink-faint); }
    .ps-slot-need.ps-have { color: var(--signal); }

    .ps-actions { display: flex; gap: 10px; align-items: center; padding-top: 4px; }
    .ps-empty {
      display: flex; flex-direction: column; align-items: center; text-align: center; gap: 12px;
      padding: 32px 18px; border-radius: var(--r-tile); background: var(--bg-rise); border: 1px dashed var(--hairline);
    }
    .ps-empty-ic {
      display: grid; place-items: center; width: 52px; height: 52px; border-radius: 50%;
      background: color-mix(in srgb, var(--accent-a) 10%, var(--bg-sink));
      box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 10%, transparent);
      color: var(--accent-a);
    }
    .ps-empty-ic mat-icon { font-size: 26px; width: 26px; height: 26px; }
    .ps-empty p { margin: 0; color: var(--ink-dim); font-size: 14px; font-weight: 600; max-width: 26ch; }
  `],
})
export class ForagePlanSheet {
  private readonly api = inject(Api);

  /** Two-way open state, owned by the page. */
  readonly open = signal(false);
  /** The viewed week's Monday ("YYYY-MM-DD") — anchors the plan. */
  readonly weekStart = input.required<string>();
  /**
   * On-hand ingredients (from a Snap & Route pantry hand-off) that bias the AI plan toward what the caller
   * already has. Null/empty leaves planner behaviour unchanged. Mirrors the live planner's openPlanMyWeek.
   */
  readonly ingredientsOnHand = input<string[]>([]);
  /** Emitted with the number of meals added on a successful commit. */
  readonly planned = output<number>();

  protected readonly daySegs: Segment[] = [
    { key: '1', label: 'Today' }, { key: '3', label: '3 days' }, { key: '7', label: 'Week' },
  ];
  protected readonly daysKey = signal<string>('3');
  protected readonly constraints = signal<string>('');

  protected readonly phase = signal<'setup' | 'loading' | 'review' | 'error'>('setup');
  protected readonly busy = signal(false);
  protected readonly aiUsed = signal(true);
  protected readonly days = signal<PlanMealDay[]>([]);
  /** Per-slot "deselected" keys ("localDate#index") the user opted out of. */
  private readonly off = signal<Set<string>>(new Set());

  /** Reset to the setup step whenever the sheet is (re)opened from closed. */
  reset(): void {
    this.phase.set('setup');
    this.busy.set(false);
    this.days.set([]);
    this.off.set(new Set());
  }

  protected onClosed(): void { /* page clears its own open flag via two-way; nothing else to do */ }

  protected async generate(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.phase.set('loading');
    const days = Number(this.daysKey()) || 3;
    const refine = this.constraints().trim();
    try {
      const onHand = this.ingredientsOnHand();
      const res = await firstValueFrom(this.api.planMeals({
        days,
        weekStart: this.weekStart(),
        constraints: refine || null,
        ingredientsOnHand: onHand.length ? onHand : null,
      }));
      this.aiUsed.set(res.aiUsed);
      this.days.set(res.days ?? []);
      this.off.set(new Set());
      this.phase.set((res.days?.length ?? 0) > 0 ? 'review' : 'error');
    } catch {
      this.phase.set('error');
    } finally {
      this.busy.set(false);
    }
  }

  private key(date: string, i: number): string { return `${date}#${i}`; }
  protected isOff(date: string, i: number): boolean { return this.off().has(this.key(date, i)); }
  protected toggle(date: string, i: number): void {
    const next = new Set(this.off());
    const k = this.key(date, i);
    if (next.has(k)) next.delete(k); else next.add(k);
    this.off.set(next);
  }

  protected readonly selectedCount = computed(() => {
    const off = this.off();
    let n = 0;
    for (const d of this.days()) for (let i = 0; i < d.slots.length; i++) if (!off.has(this.key(d.localDate, i))) n++;
    return n;
  });

  protected icon(slot: FamilyMealSlot): string { return slotMeta(slot).icon; }
  protected label(slot: FamilyMealSlot): string { return slotMeta(slot).label; }
  protected kcal(s: PlanMealSlot): number { return Math.round(s.macros.calories); }
  protected needCount(s: PlanMealSlot): number { return s.ingredients.filter(i => !i.onList).length; }
  protected haveCount(s: PlanMealSlot): number { return s.ingredients.filter(i => i.onList).length; }

  protected dayLabel(iso: string): string {
    const d = new Date(`${iso}T00:00:00`);
    return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  }

  protected async commit(): Promise<void> {
    if (this.busy() || this.selectedCount() === 0) return;
    this.busy.set(true);
    const off = this.off();
    const meals: PlanMealToWrite[] = [];
    for (const d of this.days()) {
      d.slots.forEach((s, i) => {
        if (off.has(this.key(d.localDate, i))) return;
        meals.push({
          localDate: d.localDate,
          slot: s.slot,
          title: s.title,
          ingredients: s.ingredients.map(ing => (ing.quantity ? `${ing.quantity} ${ing.name}` : ing.name).trim()).join('\n'),
          calories: Math.round(s.macros.calories),
          proteinG: s.macros.proteinG,
          carbG: s.macros.carbsG,
          fatG: s.macros.fatG,
          macroSource: 'ai',
        });
      });
    }
    try {
      const res = await firstValueFrom(this.api.planMealsToPlan(meals));
      this.open.set(false);
      this.planned.emit(res.added);
    } catch {
      this.phase.set('error');
    } finally {
      this.busy.set(false);
    }
  }
}
