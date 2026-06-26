import { ChangeDetectionStrategy, Component, inject, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { firstValueFrom } from 'rxjs';

import { Api } from '../../../core/api';
import { EatOption } from '../../../core/models';
import { BetaBottomSheet, BetaSkeleton } from '../../beta-ui';

/**
 * Forage EatSheet — the "What can I eat?" quick action in a BetaBottomSheet. Wraps the EXISTING
 * `whatToEat` (POST /api/ai/what-to-eat — writes nothing) to surface 3-5 options that fit the caller's
 * remaining macros today. Each option shows its kcal + P/C/F, a one-line "why it fits", and a have/need
 * ingredient hint. An optional craving box refines the ask. `aiUsed:false` is labelled plainly.
 *
 * Pure read — nothing is written; the page owns the open state. Reuse-only (no new endpoint).
 */
@Component({
  selector: 'app-forage-eat-sheet',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MatIconModule, BetaBottomSheet, BetaSkeleton],
  template: `
    <app-bs-sheet [(open)]="open" detent="full" label="What can I eat" (closed)="onClosed()">
      <div class="es">
        <header class="es-head">
          <span class="es-spark" aria-hidden="true"><mat-icon>restaurant</mat-icon></span>
          <div class="es-head-txt">
            <h2 class="es-title">What can I eat?</h2>
            <p class="es-sub">Ideas that fit what's left in your day, using what you have.</p>
          </div>
        </header>

        <div class="es-ask">
          <input class="es-input" type="text" [(ngModel)]="craving"
                 placeholder="craving anything? (optional)" maxlength="120"
                 (keydown.enter)="ask()" aria-label="Craving" />
          <button type="button" class="es-go" [disabled]="busy()" (click)="ask()" aria-label="Get ideas">
            @if (busy()) { <span class="es-spin" aria-hidden="true"></span> }
            @else { <mat-icon aria-hidden="true">auto_awesome</mat-icon> }
          </button>
        </div>

        @if (phase() === 'idle') {
          <div class="es-hint">
            <mat-icon aria-hidden="true">tips_and_updates</mat-icon>
            <p>Tap the spark for tailored ideas — or type a craving first.</p>
          </div>
        }

        @if (phase() === 'loading') {
          <div class="es-skel">
            @for (s of [0,1,2]; track s) { <app-bs-skeleton height="92px" radius="var(--r-tile)" /> }
          </div>
        }

        @if (phase() === 'done') {
          @if (!aiUsed()) {
            <div class="es-note" role="status">
              <mat-icon aria-hidden="true">info</mat-icon>
              AI is off right now — these come from your planned meals and groceries.
            </div>
          }
          @if (options().length) {
            <div class="es-list">
              @for (o of options(); track $index) {
                <div class="es-opt" [style.--i]="$index">
                  <div class="es-opt-h">
                    <span class="es-opt-title">{{ o.title }}</span>
                    <span class="es-opt-cal">{{ kcal(o) }} <i>kcal</i></span>
                  </div>
                  @if (o.why) { <p class="es-why">{{ o.why }}</p> }
                  <div class="es-macros" aria-hidden="true">
                    <span class="es-chip es-chip--p">P {{ o.macros.proteinG }}g</span>
                    <span class="es-chip">C {{ o.macros.carbsG }}g</span>
                    <span class="es-chip">F {{ o.macros.fatG }}g</span>
                  </div>
                  @if (o.ingredients.length) {
                    <div class="es-ings">
                      @if (need(o) > 0) {
                        <span class="es-ing-need">{{ need(o) }} to buy</span>
                      }
                      <span class="es-ing-have">{{ have(o) }} on hand</span>
                    </div>
                  }
                </div>
              }
            </div>
          } @else {
            <div class="es-hint">
              <mat-icon aria-hidden="true">sentiment_satisfied</mat-icon>
              <p>No ideas right now — try a different craving.</p>
            </div>
          }
        }

        @if (phase() === 'error') {
          <div class="es-hint">
            <mat-icon aria-hidden="true">cloud_off</mat-icon>
            <p>Couldn't fetch ideas. Please try again.</p>
          </div>
        }
      </div>
    </app-bs-sheet>
  `,
  styles: [`
    :host { display: contents; }
    .es { display: flex; flex-direction: column; gap: 12px; padding-top: 4px; }
    .es-head { display: flex; gap: 12px; align-items: flex-start; }
    .es-spark {
      flex: 0 0 auto; display: grid; place-items: center; width: 42px; height: 42px; border-radius: 14px;
      background: linear-gradient(135deg, var(--accent-a), var(--accent-b)); color: #07140d;
    }
    .es-spark mat-icon { font-size: 22px; width: 22px; height: 22px; }
    .es-head-txt { min-width: 0; }
    .es-title { margin: 0; font-family: var(--font-display); font-weight: 600; font-size: 22px; color: var(--ink); }
    .es-sub { margin: 2px 0 0; font-size: 13px; color: var(--ink-dim); line-height: 1.35; }

    .es-ask { display: flex; gap: 8px; align-items: stretch; }
    .es-input {
      flex: 1 1 auto; min-width: 0; box-sizing: border-box; padding: 12px 14px; min-height: 48px;
      border-radius: var(--r-pill); border: 1px solid var(--hairline); background: var(--bg-sink);
      color: var(--ink); font: inherit; font-size: 15px;
    }
    .es-input::placeholder { color: var(--ink-faint); }
    .es-input:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
    .es-go {
      flex: 0 0 auto; display: grid; place-items: center; width: 48px; height: 48px;
      border: none; border-radius: 50%; background: linear-gradient(135deg, var(--accent-a), var(--accent-b));
      color: #07140d; cursor: pointer; box-shadow: var(--lift-2); -webkit-tap-highlight-color: transparent;
      transition: transform 120ms var(--ease-out);
    }
    .es-go:active { transform: scale(.93); }
    .es-go:disabled { opacity: .55; pointer-events: none; }
    .es-go:focus-visible { outline: 2px solid var(--focus); outline-offset: 3px; }
    .es-go mat-icon { font-size: 22px; width: 22px; height: 22px; }
    .es-spin {
      width: 18px; height: 18px; border-radius: 50%;
      border: 2px solid color-mix(in srgb, #07140d 35%, transparent); border-top-color: #07140d;
      animation: es-spin .7s linear infinite;
    }
    @keyframes es-spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .es-spin { animation: none; } }

    .es-skel { display: flex; flex-direction: column; gap: 10px; }
    .es-note {
      display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-radius: var(--r-tile);
      background: color-mix(in srgb, var(--warn) 14%, var(--bg-sink)); color: var(--ink);
      font-size: 13px; font-weight: 600;
    }
    .es-note mat-icon { color: var(--warn); font-size: 20px; width: 20px; height: 20px; }

    .es-hint {
      display: flex; flex-direction: column; align-items: center; text-align: center; gap: 8px;
      padding: 26px 16px; color: var(--ink-dim);
    }
    .es-hint mat-icon { font-size: 32px; width: 32px; height: 32px; color: var(--ink-faint); }
    .es-hint p { margin: 0; font-size: 14px; }

    .es-list { display: flex; flex-direction: column; gap: 10px; }
    .es-opt {
      padding: 13px 14px; border-radius: var(--r-tile);
      background: var(--bg-rise); border: 1px solid var(--hairline); box-shadow: var(--lift-1);
      animation: es-in 420ms var(--ease-spring-up) both; animation-delay: calc(var(--i, 0) * 50ms);
    }
    @keyframes es-in { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
    .es-opt-h { display: flex; align-items: baseline; gap: 10px; }
    .es-opt-title { flex: 1 1 auto; min-width: 0; font-size: 16px; font-weight: 700; color: var(--ink); }
    .es-opt-cal {
      flex: 0 0 auto; font-family: var(--font-display); font-variant-numeric: tabular-nums;
      font-size: 20px; font-weight: 600; color: var(--ink);
    }
    .es-opt-cal i { font-family: var(--font-ui); font-style: normal; font-size: 11px; font-weight: 700; color: var(--ink-dim); }
    .es-why { margin: 4px 0 8px; font-size: 13px; color: var(--ink-dim); line-height: 1.4; }
    .es-macros { display: flex; gap: 6px; }
    .es-chip {
      padding: 2px 9px; border-radius: var(--r-pill); background: var(--bg-sink); border: 1px solid var(--hairline);
      font-size: 11px; font-weight: 700; color: var(--ink-dim); font-variant-numeric: tabular-nums;
    }
    .es-chip--p { color: var(--ink); border-color: color-mix(in srgb, var(--accent-a) 30%, transparent); }
    .es-ings { display: flex; gap: 8px; margin-top: 8px; font-size: 12px; font-weight: 700; }
    .es-ing-need { color: var(--warn); }
    .es-ing-have { color: var(--signal); }
  `],
})
export class ForageEatSheet {
  private readonly api = inject(Api);

  /** Two-way open state, owned by the page. */
  readonly open = signal(false);

  protected readonly craving = signal<string>('');
  protected readonly phase = signal<'idle' | 'loading' | 'done' | 'error'>('idle');
  protected readonly busy = signal(false);
  protected readonly aiUsed = signal(true);
  protected readonly options = signal<EatOption[]>([]);

  /** Reset to idle whenever the sheet is (re)opened from closed. */
  reset(): void {
    this.phase.set('idle');
    this.busy.set(false);
    this.options.set([]);
  }

  protected onClosed(): void { /* page clears its own open flag via two-way */ }

  protected async ask(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.phase.set('loading');
    const craving = this.craving().trim();
    try {
      const res = await firstValueFrom(this.api.whatToEat({ craving: craving || null, meal: 'dinner' }));
      this.aiUsed.set(res.aiUsed);
      this.options.set(res.options ?? []);
      this.phase.set('done');
    } catch {
      this.phase.set('error');
    } finally {
      this.busy.set(false);
    }
  }

  protected kcal(o: EatOption): number { return Math.round(o.macros.calories); }
  protected need(o: EatOption): number { return o.ingredients.filter(i => !i.onList).length; }
  protected have(o: EatOption): number { return o.ingredients.filter(i => i.onList).length; }
}
