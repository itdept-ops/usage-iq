import { Component, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { catchError, of } from 'rxjs';

import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';

import { Api } from '../../core/api';
import { AutomationRule, AutomationRuleInput, RuleAction, RuleConditionOp } from '../../core/models';

/** A trigger option: the kind + a human label + whether it carries a numeric payload (enables a condition). */
interface TriggerOpt {
  kind: string;
  label: string;
  /** The unit word for the numeric payload (e.g. "minutes", "day"); null => no numeric condition. */
  unit: string | null;
}

/**
 * Automations (/automations) — manage the caller's OWN rules. A rule reacts to ONE of the caller's own
 * activity events (a workout logged, a 75-Hard day completed, the challenge started, the water goal hit),
 * optionally gated by a numeric condition on the event's value, and runs ONE safe action against the
 * caller's OWN channels: an in-app notification to themselves and/or their own Discord webhook.
 *
 * PRIVACY: everything is self-scoped server-side — a rule only ever triggers on the owner's own events and
 * only ever notifies the owner. There is no cross-user target, no arbitrary URL, no @everyone/@here.
 */
@Component({
  selector: 'app-automations',
  imports: [
    ReactiveFormsModule, MatButtonModule, MatIconModule, MatProgressSpinnerModule, MatSlideToggleModule,
  ],
  templateUrl: './automations.html',
  styleUrl: './automations.scss',
})
export class Automations {
  private api = inject(Api);
  private fb = inject(FormBuilder);

  readonly triggers: readonly TriggerOpt[] = [
    { kind: 'workout.logged', label: 'When I log a workout', unit: 'minutes' },
    { kind: 'challenge.dayComplete', label: 'When I complete a 75-Hard day', unit: 'day number' },
    { kind: 'challenge.started', label: 'When I start the 75-Hard challenge', unit: null },
    { kind: 'hydration.goalHit', label: 'When I hit my water goal', unit: null },
  ];

  readonly rules = signal<AutomationRule[]>([]);
  readonly loading = signal(true);
  readonly error = signal(false);
  readonly saving = signal(false);
  readonly saveError = signal<string | null>(null);
  /** The id being edited (null => the form is in "create" mode). */
  readonly editingId = signal<number | null>(null);
  /** Whether the create/edit form is open. */
  readonly formOpen = signal(false);

  readonly form = this.fb.nonNullable.group({
    name: [''],
    triggerKind: ['workout.logged', Validators.required],
    conditionOp: [0 as RuleConditionOp],
    conditionValue: [null as number | null],
    action: [0 as RuleAction],
    messageTemplate: [''],
    enabled: [true],
  });

  /** The selected trigger's metadata (drives whether a numeric condition is offered). */
  readonly selectedTrigger = computed(() =>
    this.triggers.find(t => t.kind === this.form.controls.triggerKind.value) ?? this.triggers[0]);

  constructor() {
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.error.set(false);
    this.api.automations()
      .pipe(catchError(() => { this.error.set(true); return of(null); }))
      .subscribe(rs => {
        if (rs) this.rules.set(rs);
        this.loading.set(false);
      });
  }

  readonly isEmpty = computed(() => !this.loading() && !this.error() && this.rules().length === 0);

  /** Open the form to create a fresh rule. */
  newRule(): void {
    this.editingId.set(null);
    this.saveError.set(null);
    this.form.reset({
      name: '', triggerKind: 'workout.logged', conditionOp: 0, conditionValue: null,
      action: 0, messageTemplate: '', enabled: true,
    });
    this.formOpen.set(true);
  }

  /** Open the form pre-filled to edit an existing rule. */
  edit(r: AutomationRule): void {
    this.editingId.set(r.id);
    this.saveError.set(null);
    this.form.reset({
      name: r.name,
      triggerKind: r.triggerKind,
      conditionOp: r.conditionOp,
      conditionValue: r.conditionValue,
      action: r.action,
      messageTemplate: r.messageTemplate ?? '',
      enabled: r.enabled,
    });
    this.formOpen.set(true);
  }

  cancel(): void {
    this.formOpen.set(false);
    this.saveError.set(null);
  }

  /** Persist the form (create or update), then refresh the list. */
  save(): void {
    if (this.form.invalid || this.saving()) return;
    const v = this.form.getRawValue();
    const trig = this.triggers.find(t => t.kind === v.triggerKind);
    // A condition only makes sense for kinds with a numeric payload; force "always" otherwise.
    const op: RuleConditionOp = trig?.unit ? v.conditionOp : 0;
    const body: AutomationRuleInput = {
      name: v.name?.trim() || null,
      triggerKind: v.triggerKind,
      conditionOp: op,
      conditionValue: op === 0 ? null : (v.conditionValue ?? null),
      action: v.action,
      messageTemplate: v.messageTemplate?.trim() || null,
      enabled: v.enabled,
    };

    this.saving.set(true);
    this.saveError.set(null);
    const id = this.editingId();
    const req$ = id == null ? this.api.createAutomation(body) : this.api.updateAutomation(id, body);
    req$
      .pipe(catchError(() => { this.saveError.set('Could not save this automation. Check the fields and try again.'); return of(null); }))
      .subscribe(saved => {
        this.saving.set(false);
        if (saved) {
          this.formOpen.set(false);
          this.load();
        }
      });
  }

  /** Toggle a rule's enabled flag in place (a one-field update reusing the same upsert body). */
  toggleEnabled(r: AutomationRule): void {
    const body: AutomationRuleInput = {
      name: r.name, triggerKind: r.triggerKind, conditionOp: r.conditionOp,
      conditionValue: r.conditionValue, action: r.action, messageTemplate: r.messageTemplate,
      enabled: !r.enabled,
    };
    this.api.updateAutomation(r.id, body)
      .pipe(catchError(() => of(null)))
      .subscribe(saved => { if (saved) this.load(); });
  }

  remove(r: AutomationRule): void {
    this.api.deleteAutomation(r.id)
      .pipe(catchError(() => of(null)))
      .subscribe(() => this.load());
  }

  // ---- Display helpers ----

  triggerLabel(kind: string): string {
    return this.triggers.find(t => t.kind === kind)?.label ?? kind;
  }

  /** A short, human description of a rule's condition (or "Always"). */
  conditionLabel(r: AutomationRule): string {
    const trig = this.triggers.find(t => t.kind === r.triggerKind);
    if (r.conditionOp === 0 || r.conditionValue == null || !trig?.unit) return 'Always';
    const op = r.conditionOp === 1 ? '≥' : r.conditionOp === 2 ? '≤' : '=';
    return `${op} ${r.conditionValue} ${trig.unit}`;
  }

  actionLabel(a: RuleAction): string {
    switch (a) {
      case 1: return 'Discord';
      case 2: return 'Notify + Discord';
      default: return 'In-app notification';
    }
  }

  trackRule = (_: number, r: AutomationRule) => r.id;
}
