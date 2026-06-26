import {
  ChangeDetectionStrategy, Component, computed, inject, output, signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { firstValueFrom } from 'rxjs';

import { Api } from '../../../core/api';
import { AutomationRule, AutomationRuleInput, RuleAction, RuleConditionOp } from '../../../core/models';
import { BetaBottomSheet } from '../../beta-ui';
import { ACTIONS, AutomationTemplate, TRIGGERS, condOpLabel, triggerOpt } from '../automations-beta.model';

/**
 * Relay CreateSheet — "Add automation" in a BetaBottomSheet. The user picks a WHEN (trigger) and a
 * THEN (action), optionally names it, optionally gates it with a numeric condition (only offered for
 * triggers that carry a number), then commits — which creates the rule via the SAME `Api.createAutomation`
 * the live `/automations` page uses. No new endpoint; the server owns all validation + self-scoping.
 *
 * The page owns this sheet's two-way `open`. On a successful create it emits `created` (the new rule) so
 * the page can optimistically prepend + toast. Webhook is intentionally NOT collected here — a fresh rule
 * falls back to the caller's personal Discord webhook (same default as the live form's blank field).
 */
@Component({
  selector: 'app-relay-create-sheet',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MatIconModule, BetaBottomSheet],
  template: `
    <app-bs-sheet [(open)]="open" detent="full" label="Add automation" [dismissable]="!busy()" (closed)="onClosed()">
      <div class="rc">
        <header class="rc-head">
          <span class="rc-spark" aria-hidden="true"><mat-icon>bolt</mat-icon></span>
          <div class="rc-head-txt">
            <h2 class="rc-title">New automation</h2>
            <p class="rc-sub">Pick what happens and how you're nudged. It only ever watches your own activity and only ever pings you.</p>
          </div>
        </header>

        <!-- WHEN -->
        <span class="rc-step">When…</span>
        <div class="rc-grid" role="radiogroup" aria-label="Trigger">
          @for (t of triggers; track t.kind) {
            <button type="button" class="rc-opt" [class.is-on]="triggerKind() === t.kind"
                    role="radio" [attr.aria-checked]="triggerKind() === t.kind"
                    (click)="triggerKind.set(t.kind)">
              <span class="rc-opt-ic" aria-hidden="true"><mat-icon>{{ t.icon }}</mat-icon></span>
              <span class="rc-opt-lbl">{{ t.chip }}</span>
            </button>
          }
        </div>

        <!-- Optional numeric condition (only for triggers that carry a number) -->
        @if (unit()) {
          <span class="rc-step">Only if {{ unit() }} is…</span>
          <div class="rc-cond">
            <div class="rc-ops" role="radiogroup" aria-label="Condition">
              @for (op of ops; track op) {
                <button type="button" class="rc-chip" [class.is-on]="conditionOp() === op"
                        role="radio" [attr.aria-checked]="conditionOp() === op"
                        (click)="conditionOp.set(op)">{{ opLabel(op) }}</button>
              }
            </div>
            @if (conditionOp() !== 0) {
              <input class="rc-input rc-num" type="number" min="0" inputmode="numeric"
                     [ngModel]="conditionValue()" (ngModelChange)="conditionValue.set($event)"
                     [attr.aria-label]="'Value in ' + unit()" placeholder="0" />
            }
          </div>
        }

        <!-- THEN -->
        <span class="rc-step">Then…</span>
        <div class="rc-acts" role="radiogroup" aria-label="Action">
          @for (a of actions; track a.value) {
            <button type="button" class="rc-act" [class.is-on]="action() === a.value"
                    role="radio" [attr.aria-checked]="action() === a.value"
                    (click)="action.set(a.value)">
              <span class="rc-act-ic" aria-hidden="true"><mat-icon>{{ a.icon }}</mat-icon></span>
              <span class="rc-act-lbl">{{ a.label }}</span>
              <span class="rc-act-tick" aria-hidden="true"><mat-icon>check_circle</mat-icon></span>
            </button>
          }
        </div>

        <!-- Optional name -->
        <span class="rc-step">Name <i>(optional)</i></span>
        <input class="rc-input" type="text" maxlength="80"
               [ngModel]="name()" (ngModelChange)="name.set($event)"
               placeholder="e.g. Long run cheer" aria-label="Automation name" />

        @if (error()) {
          <p class="rc-error" role="alert">{{ error() }}</p>
        }

        <button type="button" class="rc-primary" [disabled]="busy()" (click)="commit()">
          @if (busy()) { <span class="rc-spin" aria-hidden="true"></span> Creating… }
          @else { <mat-icon aria-hidden="true">add</mat-icon> Create automation }
        </button>

        <p class="rc-foot">
          <mat-icon aria-hidden="true">lock</mat-icon>
          Private &amp; self-scoped — no @mentions, no other people.
        </p>
      </div>
    </app-bs-sheet>
  `,
  styles: [`
    :host { display: contents; }
    .rc { display: flex; flex-direction: column; gap: 11px; padding-top: 4px; }

    .rc-head { display: flex; gap: 12px; align-items: flex-start; }
    .rc-spark {
      flex: 0 0 auto; display: grid; place-items: center; width: 42px; height: 42px; border-radius: 14px;
      background: linear-gradient(135deg, var(--accent-a), var(--accent-b)); color: #2a0a00;
      box-shadow: 0 6px 18px color-mix(in srgb, var(--accent-a) 40%, transparent);
    }
    .rc-spark mat-icon { font-size: 24px; width: 24px; height: 24px; }
    .rc-head-txt { min-width: 0; }
    .rc-title { margin: 0; font-family: var(--font-display); font-weight: 600; font-size: 22px; color: var(--ink); }
    .rc-sub { margin: 2px 0 0; font-size: 13px; color: var(--ink-dim); line-height: 1.35; }

    .rc-step {
      font-size: 12px; font-weight: 800; letter-spacing: .05em; text-transform: uppercase; color: var(--ink-dim);
      margin-top: 5px;
    }
    .rc-step i { font-style: normal; color: var(--ink-faint); font-weight: 700; }

    /* WHEN grid — two columns of trigger options. */
    .rc-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; }
    .rc-opt {
      display: flex; align-items: center; gap: 9px; text-align: left;
      padding: 12px 12px; border-radius: var(--r-tile);
      border: 1px solid var(--hairline); background: var(--bg-rise); color: var(--ink);
      cursor: pointer; -webkit-tap-highlight-color: transparent; touch-action: manipulation;
      transition: border-color 160ms var(--ease-out), background 160ms var(--ease-out), transform 120ms var(--ease-spring);
    }
    .rc-opt:active { transform: scale(.97); }
    .rc-opt:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
    .rc-opt.is-on {
      border-color: color-mix(in srgb, var(--accent-a) 60%, transparent);
      background: color-mix(in srgb, var(--accent-a) 12%, var(--bg-rise));
    }
    .rc-opt-ic {
      flex: 0 0 auto; display: grid; place-items: center; width: 34px; height: 34px; border-radius: 11px;
      background: color-mix(in srgb, var(--accent-a) 14%, var(--bg-sink)); color: var(--accent-a);
    }
    .rc-opt.is-on .rc-opt-ic { background: linear-gradient(135deg, var(--accent-a), var(--accent-b)); color: #2a0a00; }
    .rc-opt-ic mat-icon { font-size: 19px; width: 19px; height: 19px; }
    .rc-opt-lbl { font-size: 13px; font-weight: 700; color: var(--ink); line-height: 1.2; }

    /* Condition. */
    .rc-cond { display: flex; flex-direction: column; gap: 9px; }
    .rc-ops { display: flex; flex-wrap: wrap; gap: 7px; }
    .rc-chip {
      min-height: 38px; padding: 0 13px; border-radius: var(--r-pill);
      border: 1px solid var(--hairline); background: var(--bg-rise); color: var(--ink-dim);
      font: inherit; font-size: 13px; font-weight: 700; cursor: pointer; -webkit-tap-highlight-color: transparent;
      transition: border-color 140ms var(--ease-out), color 140ms var(--ease-out), background 140ms var(--ease-out);
    }
    .rc-chip:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
    .rc-chip.is-on {
      border-color: color-mix(in srgb, var(--accent-a) 55%, transparent);
      background: color-mix(in srgb, var(--accent-a) 13%, var(--bg-rise)); color: var(--accent-a);
    }

    /* THEN — full-width action rows with a tick. */
    .rc-acts { display: flex; flex-direction: column; gap: 9px; }
    .rc-act {
      display: flex; align-items: center; gap: 11px; width: 100%; text-align: left;
      padding: 12px 13px; border-radius: var(--r-tile);
      border: 1px solid var(--hairline); background: var(--bg-rise); color: var(--ink);
      cursor: pointer; -webkit-tap-highlight-color: transparent; touch-action: manipulation;
      transition: border-color 160ms var(--ease-out), background 160ms var(--ease-out), transform 120ms var(--ease-spring);
    }
    .rc-act:active { transform: scale(.985); }
    .rc-act:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
    .rc-act.is-on {
      border-color: color-mix(in srgb, var(--accent-a) 60%, transparent);
      background: color-mix(in srgb, var(--accent-a) 11%, var(--bg-rise));
    }
    .rc-act-ic {
      flex: 0 0 auto; display: grid; place-items: center; width: 36px; height: 36px; border-radius: 12px;
      background: color-mix(in srgb, var(--accent-a) 14%, var(--bg-sink)); color: var(--accent-a);
    }
    .rc-act.is-on .rc-act-ic { background: linear-gradient(135deg, var(--accent-a), var(--accent-b)); color: #2a0a00; }
    .rc-act-ic mat-icon { font-size: 20px; width: 20px; height: 20px; }
    .rc-act-lbl { flex: 1 1 auto; font-size: 14.5px; font-weight: 700; color: var(--ink); min-width: 0; }
    .rc-act-tick { flex: 0 0 auto; color: var(--accent-a); opacity: 0; transition: opacity 140ms var(--ease-out); }
    .rc-act.is-on .rc-act-tick { opacity: 1; }
    .rc-act-tick mat-icon { font-size: 22px; width: 22px; height: 22px; }

    .rc-input {
      width: 100%; box-sizing: border-box; padding: 12px 14px; min-height: 46px;
      border-radius: var(--r-tile); border: 1px solid var(--hairline); background: var(--bg-sink);
      color: var(--ink); font: inherit; font-size: 15px;
    }
    .rc-input::placeholder { color: var(--ink-faint); }
    .rc-input:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
    .rc-num { max-width: 140px; }

    .rc-error {
      margin: 2px 0 0; padding: 10px 12px; border-radius: var(--r-tile);
      background: color-mix(in srgb, var(--warn) 16%, var(--bg-sink)); color: var(--ink);
      font-size: 13px; font-weight: 600;
    }

    .rc-primary {
      display: inline-flex; align-items: center; justify-content: center; gap: 8px;
      min-height: 52px; margin-top: 6px; padding: 0 20px; border: none; border-radius: var(--r-pill);
      background: linear-gradient(135deg, var(--accent-a), var(--accent-b)); color: #2a0a00;
      font-family: var(--font-ui); font-size: 15px; font-weight: 800; cursor: pointer;
      box-shadow: var(--lift-2); -webkit-tap-highlight-color: transparent; touch-action: manipulation;
      transition: transform 120ms var(--ease-out);
    }
    .rc-primary:active { transform: scale(.98); }
    .rc-primary:disabled { opacity: .55; pointer-events: none; }
    .rc-primary:focus-visible { outline: 2px solid var(--focus); outline-offset: 3px; }
    .rc-primary mat-icon { font-size: 20px; width: 20px; height: 20px; }

    .rc-spin {
      width: 16px; height: 16px; border-radius: 50%;
      border: 2px solid color-mix(in srgb, #2a0a00 35%, transparent); border-top-color: #2a0a00;
      animation: rc-spin 0.7s linear infinite;
    }
    @keyframes rc-spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .rc-spin { animation: none; } }

    .rc-foot {
      display: inline-flex; align-items: center; gap: 6px; justify-content: center;
      margin: 2px 0 0; font-size: 12px; font-weight: 600; color: var(--ink-faint);
    }
    .rc-foot mat-icon { font-size: 15px; width: 15px; height: 15px; }
  `],
})
export class RelayCreateSheet {
  private readonly api = inject(Api);

  /** Two-way open state, owned by the page. */
  readonly open = signal(false);
  /** Emitted with the freshly created rule on a successful commit. */
  readonly created = output<AutomationRule>();

  protected readonly triggers = TRIGGERS;
  protected readonly actions = ACTIONS;
  protected readonly ops: readonly RuleConditionOp[] = [0, 1, 2, 3];

  protected readonly triggerKind = signal<string>('workout.logged');
  protected readonly conditionOp = signal<RuleConditionOp>(0);
  protected readonly conditionValue = signal<number | null>(null);
  protected readonly action = signal<RuleAction>(0);
  protected readonly name = signal<string>('');

  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  /** The selected trigger's numeric-payload unit (null => no condition row). */
  protected readonly unit = computed(() => triggerOpt(this.triggerKind()).unit);

  protected opLabel(op: RuleConditionOp): string { return condOpLabel(op); }

  /** Reset to defaults whenever the sheet is (re)opened. */
  reset(): void {
    this.triggerKind.set('workout.logged');
    this.conditionOp.set(0);
    this.conditionValue.set(null);
    this.action.set(0);
    this.name.set('');
    this.busy.set(false);
    this.error.set(null);
  }

  /**
   * Pre-fill the sheet from a starter template (a partial {@link AutomationRuleInput}) so the user lands on a
   * sensible draft they can tweak + commit. Resets first, then applies the template's fields. The user still
   * presses "Create" — nothing is written here, and the same `Api.createAutomation` path runs on commit.
   */
  prefill(t: AutomationTemplate): void {
    this.reset();
    this.triggerKind.set(t.triggerKind);
    this.conditionOp.set(t.conditionOp ?? 0);
    this.conditionValue.set(t.conditionValue ?? null);
    this.action.set(t.action);
    this.name.set(t.name ?? '');
  }

  protected onClosed(): void { /* page clears its own open flag via two-way; nothing else to do */ }

  protected async commit(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set(null);

    const trig = triggerOpt(this.triggerKind());
    // A condition only makes sense for kinds with a numeric payload; force "always" otherwise.
    const op: RuleConditionOp = trig.unit ? this.conditionOp() : 0;
    const body: AutomationRuleInput = {
      name: this.name().trim() || null,
      triggerKind: this.triggerKind(),
      conditionOp: op,
      conditionValue: op === 0 ? null : (this.conditionValue() ?? null),
      action: this.action(),
      messageTemplate: null,
      // webhookUrl omitted => null = leave unset; a fresh rule uses the caller's personal Discord webhook.
      enabled: true,
    };

    try {
      const saved = await firstValueFrom(this.api.createAutomation(body));
      this.open.set(false);
      this.created.emit(saved);
    } catch {
      this.error.set('Could not create this automation. Please try again.');
    } finally {
      this.busy.set(false);
    }
  }
}
