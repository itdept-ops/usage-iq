import { Component, computed, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';

import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar } from '@angular/material/snack-bar';

import { Api } from '../../core/api';
import { AuthService } from '../../core/auth';
import { UnitService } from '../../core/unit.service';
import { AddHydrationRequest, PERM, UnitSystem } from '../../core/models';

/** Opens with the active date and the user's unit preference (oz for Imperial, ml for Metric). */
export interface AddHydrationData {
  date: string;
  unitSystem: UnitSystem;
}

/**
 * What the dialog resolves with so the page can refresh + announce:
 *  - `manual`  — one drink to log (the classic amount + label).
 *  - `parsed`  — the AI parsed N drinks; the requests are ready to POST.
 *  - `goal`    — the user accepted an AI-suggested daily hydration target (ml) to persist on the profile.
 * `undefined` (dialog dismissed) means do nothing.
 */
export type AddHydrationResult =
  | { kind: 'manual'; requests: AddHydrationRequest[] }
  | { kind: 'parsed'; requests: AddHydrationRequest[] }
  | { kind: 'goal'; targetMl: number };

/**
 * Quick "add a custom drink" dialog. Enters an amount in the user's chosen units (oz/ml) plus an
 * optional drink label (Water/Coffee/Tea/…); converts to metric ml on save.
 *
 * For users with `tracker.ai`, two ✨ assists are offered (each hidden otherwise, each editable / opt-in,
 * each with a graceful "do it manually" fallback): "Describe what you drank" (parse-hydration → a list of
 * drinks the user reviews then adds) and "Suggest my hydration goal" (hydration-suggest → an offer to set
 * the profile's daily target). Resolves with an {@link AddHydrationResult} for the page to apply.
 */
@Component({
  selector: 'app-add-hydration-dialog',
  imports: [
    FormsModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
    MatIconModule,
    MatProgressSpinnerModule,
  ],
  template: `
    <h2 mat-dialog-title class="hy-title">Add a drink</h2>
    <mat-dialog-content class="hy-body">
      @if (showAi) {
        <!-- ✨ Describe what you drank: free text → a reviewable list of drinks (parse-hydration). -->
        <div class="hy-ai" role="group" aria-label="Describe what you drank with AI">
          <mat-form-field appearance="outline" class="hy-field">
            <mat-label
              ><mat-icon class="hy-ai-inline" aria-hidden="true">auto_awesome</mat-icon> Describe
              what you drank</mat-label
            >
            <input
              matInput
              type="text"
              maxlength="200"
              placeholder="e.g. 2 coffees and a big water"
              [ngModel]="describeText()"
              (ngModelChange)="describeText.set($event)"
              (keyup.enter)="parseWithAi()"
            />
            <mat-hint>AI lists the drinks below; review then add.</mat-hint>
          </mat-form-field>
          <button
            mat-stroked-button
            type="button"
            class="hy-ai-btn"
            [disabled]="!canParse()"
            (click)="parseWithAi()"
            aria-label="Parse what you drank with AI into drinks to add"
          >
            @if (parseLoading()) {
              <mat-progress-spinner mode="indeterminate" diameter="18" aria-hidden="true" />
              Reading…
            } @else {
              <span class="hy-ai-btn-label"
                ><mat-icon aria-hidden="true">auto_awesome</mat-icon> Parse drinks</span
              >
            }
          </button>
        </div>

        <!-- The parsed drinks — editable amounts before the user commits them. -->
        @if (parsed().length > 0) {
          <div class="hy-parsed" role="group" aria-label="Parsed drinks">
            @for (d of parsed(); track $index) {
              <div class="hy-parsed-row">
                <span class="hy-parsed-label">{{ d.label }}</span>
                <mat-form-field appearance="outline" class="hy-parsed-amt">
                  <input
                    matInput
                    type="number"
                    min="0"
                    step="1"
                    inputmode="decimal"
                    [ngModel]="d.amountDisp"
                    (ngModelChange)="setParsedAmount($index, $event)"
                    [attr.aria-label]="'Amount for ' + d.label"
                  />
                  <span matTextSuffix>{{ volumeUnit }}</span>
                </mat-form-field>
                <button
                  mat-icon-button
                  type="button"
                  (click)="removeParsed($index)"
                  [attr.aria-label]="'Remove ' + d.label"
                >
                  <mat-icon>close</mat-icon>
                </button>
              </div>
            }
            <button
              mat-flat-button
              color="primary"
              type="button"
              class="hy-parsed-add"
              [disabled]="!canAddParsed()"
              (click)="addParsed()"
            >
              <mat-icon aria-hidden="true">add</mat-icon> Add {{ parsedCount() }} drink{{
                parsedCount() === 1 ? '' : 's'
              }}
            </button>
          </div>
        }

        <!-- ✨ Suggest my hydration goal: hydration-suggest → offer to set the profile target. -->
        <div class="hy-ai-goal">
          @if (suggestion(); as s) {
            <div class="hy-suggest-card" role="group" aria-label="AI hydration goal suggestion">
              <p class="hy-suggest-head">
                <mat-icon aria-hidden="true">water_drop</mat-icon>
                Suggested goal:
                <strong>{{ goalDisp(s.targetMl) }} {{ volumeUnit }}/day</strong>
              </p>
              @if (s.rationale) {
                <p class="hy-suggest-why">{{ s.rationale }}</p>
              }
              <button
                mat-stroked-button
                type="button"
                class="hy-suggest-set"
                (click)="acceptGoal(s.targetMl)"
              >
                <mat-icon aria-hidden="true">check</mat-icon> Set as my goal
              </button>
            </div>
          } @else {
            <button
              mat-stroked-button
              type="button"
              class="hy-ai-btn"
              [disabled]="goalLoading()"
              (click)="suggestGoalWithAi()"
              aria-label="Suggest my daily hydration goal with AI from my profile"
            >
              @if (goalLoading()) {
                <mat-progress-spinner mode="indeterminate" diameter="18" aria-hidden="true" />
                Suggesting…
              } @else {
                <span class="hy-ai-btn-label"
                  ><mat-icon aria-hidden="true">auto_awesome</mat-icon> Suggest my hydration
                  goal</span
                >
              }
            </button>
          }
        </div>

        <span class="hy-sr-status" role="status" aria-live="polite">{{ aiAnnounce() }}</span>

        <span class="micro-label hy-or">Or log a single drink</span>
      }

      <mat-form-field appearance="outline" class="hy-field">
        <mat-label>Amount</mat-label>
        <input
          matInput
          type="number"
          min="0"
          step="1"
          inputmode="decimal"
          cdkFocusInitial
          [ngModel]="amountDisp()"
          (ngModelChange)="amountDisp.set($event)"
        />
        <span matTextSuffix>{{ volumeUnit }}</span>
        <mat-hint>Logged for {{ data.date }}.</mat-hint>
      </mat-form-field>

      <mat-form-field appearance="outline" class="hy-field">
        <mat-label>Drink (optional)</mat-label>
        <input
          matInput
          type="text"
          maxlength="64"
          placeholder="Water, Coffee, Tea…"
          [ngModel]="label()"
          (ngModelChange)="label.set($event)"
        />
      </mat-form-field>
    </mat-dialog-content>
    <mat-dialog-actions class="hy-actions" align="end">
      <button mat-stroked-button type="button" (click)="cancel()">Cancel</button>
      <button
        mat-flat-button
        type="button"
        color="primary"
        [disabled]="!canSave()"
        (click)="save()"
      >
        Add
      </button>
    </mat-dialog-actions>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: `
    .hy-title {
      font-family: var(--tech-font-ui);
      font-weight: 700;
      color: var(--tech-text);
    }
    .hy-body {
      min-width: min(360px, 82vw);
      padding-top: 4px !important;
      display: flex;
      flex-direction: column;
      gap: var(--tech-space-2);
    }
    .hy-field {
      width: 100%;
    }
    .hy-actions {
      padding: var(--tech-space-3) var(--tech-space-4);
      gap: 8px;
      button {
        border-radius: var(--tech-r-control);
        font-weight: 600;
        min-height: 44px;
      }
    }

    .hy-ai,
    .hy-ai-goal {
      display: flex;
      flex-direction: column;
      gap: var(--tech-space-2);
    }
    .hy-ai-inline {
      font-size: 16px;
      width: 16px;
      height: 16px;
      vertical-align: -3px;
      color: var(--tech-accent);
    }
    .hy-ai-btn {
      min-height: 44px;
      border-radius: var(--tech-r-control);
      font-weight: 600;
      align-self: flex-start;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      mat-icon {
        color: var(--tech-accent);
        font-size: 18px;
        width: 18px;
        height: 18px;
      }
      mat-progress-spinner {
        display: inline-block;
      }
      .hy-ai-btn-label {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
    }

    .hy-parsed {
      display: flex;
      flex-direction: column;
      gap: var(--tech-space-1);
      padding: var(--tech-space-3);
      border: 1px solid var(--tech-border);
      border-radius: var(--tech-r-control);
      background: var(--tech-bg-sunken);
    }
    .hy-parsed-row {
      display: grid;
      grid-template-columns: 1fr 7.5em auto;
      align-items: center;
      gap: var(--tech-space-2);
      mat-form-field {
        margin-bottom: -1.25em;
      }
    }
    .hy-parsed-label {
      font-size: var(--tech-fs-body);
      color: var(--tech-text);
    }
    .hy-parsed-add {
      align-self: flex-start;
      min-height: 44px;
      border-radius: var(--tech-r-control);
      font-weight: 600;
    }

    .hy-suggest-card {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: var(--tech-space-3);
      border: 1px solid var(--tech-border);
      border-radius: var(--tech-r-control);
      background: var(--tech-bg-sunken);
    }
    .hy-suggest-head {
      display: flex;
      align-items: center;
      gap: 6px;
      margin: 0;
      font-size: var(--tech-fs-body);
      color: var(--tech-text);
      mat-icon {
        color: var(--tech-accent);
        font-size: 18px;
        width: 18px;
        height: 18px;
      }
    }
    .hy-suggest-why {
      margin: 0;
      font-size: var(--tech-fs-label);
      color: var(--tech-text-secondary);
    }
    .hy-suggest-set {
      align-self: flex-start;
      min-height: 44px;
      border-radius: var(--tech-r-control);
      font-weight: 600;
      color: var(--tech-accent);
      mat-icon {
        font-size: 18px;
        width: 18px;
        height: 18px;
      }
    }

    .hy-or {
      margin-top: var(--tech-space-1);
      color: var(--tech-text-secondary);
    }
    .hy-sr-status {
      position: absolute;
      width: 1px;
      height: 1px;
      margin: -1px;
      padding: 0;
      border: 0;
      overflow: hidden;
      clip: rect(0 0 0 0);
      white-space: nowrap;
    }
  `,
})
export class AddHydrationDialog {
  private ref = inject(MatDialogRef<AddHydrationDialog, AddHydrationResult>);
  private api = inject(Api);
  private auth = inject(AuthService);
  private snack = inject(MatSnackBar);
  private units = inject(UnitService);
  readonly data = inject<AddHydrationData>(MAT_DIALOG_DATA);

  constructor() {
    // Seed the central unit pref from the date's profile so display/parse honor the user's choice.
    this.units.setLocal(this.data.unitSystem);
  }

  /** True when the user's display unit is imperial (fl oz). */
  get imperial(): boolean {
    return this.units.imperial();
  }

  /** Volume suffix for the amount fields + goal card ('fl oz' | 'ml'). */
  get volumeUnit(): string {
    return this.units.volumeUnit();
  }

  /** Gate: every AI affordance is hidden unless the user holds tracker.ai. */
  readonly showAi = this.auth.hasPermission(PERM.trackerAi);

  readonly amountDisp = signal<number | null>(null);
  readonly label = signal<string>('');

  /** Metric ml from a display value (fl oz/ml), clamped to the server's 1..5000 ml range, else null. */
  private mlOf(disp: number | null): number | null {
    if (disp == null || disp <= 0) return null;
    const m = Math.round(this.units.volumeToCanonical(disp));
    return m >= 1 && m <= 5000 ? m : null;
  }

  /** A display value (fl oz/ml) from a metric ml amount — used to seed editable parsed rows + the goal card. */
  private dispOf(ml: number): number {
    return Math.round(this.units.volumeToDisplay(ml));
  }

  /** Metric ml from the single-drink amount field (1..5000 ml server-validated range). */
  private readonly ml = computed<number | null>(() => this.mlOf(this.amountDisp()));

  readonly canSave = computed(() => this.ml() != null);

  // ---- ✨ Describe what you drank (parse-hydration) ----
  readonly describeText = signal('');
  readonly parseLoading = signal(false);
  /** Parsed drinks held as EDITABLE display-unit rows (never auto-committed). */
  readonly parsed = signal<{ label: string; amountDisp: number | null }[]>([]);
  readonly aiAnnounce = signal('');

  readonly canParse = computed(() => this.describeText().trim().length > 0 && !this.parseLoading());
  /** How many parsed rows have a valid (1..5000 ml) amount. */
  readonly parsedCount = computed(
    () => this.parsed().filter((r) => this.mlOf(r.amountDisp) != null).length,
  );
  readonly canAddParsed = computed(() => this.parsedCount() > 0);

  /** Parse the free-text drinks into editable rows. A 503/error leaves the manual fields fully usable. */
  async parseWithAi(): Promise<void> {
    const text = this.describeText().trim();
    if (!text || this.parseLoading()) return;
    this.parseLoading.set(true);
    this.aiAnnounce.set('Reading what you drank with AI…');
    try {
      const res = await firstValueFrom(this.api.parseHydration({ text }));
      const rows = res.items.map((i) => ({ label: i.label, amountDisp: this.dispOf(i.ml) }));
      this.parsed.set(rows);
      this.aiAnnounce.set(
        rows.length
          ? `AI found ${rows.length} drink${rows.length === 1 ? '' : 's'}. Review the amounts, then add.`
          : 'AI did not find any drinks. Add one manually below.',
      );
    } catch {
      this.parsed.set([]);
      this.aiAnnounce.set('AI could not read your drinks. Add one manually below.');
      this.snack.open('AI unavailable — add your drink manually', 'OK', { duration: 4000 });
    } finally {
      this.parseLoading.set(false);
    }
  }

  setParsedAmount(index: number, value: number | null): void {
    this.parsed.update((rows) =>
      rows.map((r, i) => (i === index ? { ...r, amountDisp: value } : r)),
    );
  }

  removeParsed(index: number): void {
    this.parsed.update((rows) => rows.filter((_, i) => i !== index));
  }

  /** Commit the (valid) parsed rows as hydration requests for the page to log + refresh. */
  addParsed(): void {
    const requests: AddHydrationRequest[] = [];
    for (const r of this.parsed()) {
      const ml = this.mlOf(r.amountDisp);
      if (ml == null) continue;
      requests.push({ date: this.data.date, amountMl: ml, label: r.label?.trim() || undefined });
    }
    if (requests.length === 0) return;
    this.ref.close({ kind: 'parsed', requests });
  }

  // ---- ✨ Suggest my hydration goal (hydration-suggest) ----
  readonly goalLoading = signal(false);
  /** The suggested target (ml) + rationale, or null until fetched. */
  readonly suggestion = signal<{ targetMl: number; rationale?: string | null } | null>(null);

  /** Suggested goal as a whole DISPLAY value (oz/ml) for the card. */
  goalDisp(ml: number): number {
    return this.dispOf(ml);
  }

  /** Fetch a suggested daily hydration target. A 503/error just shows a snackbar; nothing changes. */
  async suggestGoalWithAi(): Promise<void> {
    if (this.goalLoading()) return;
    this.goalLoading.set(true);
    this.aiAnnounce.set('Suggesting a hydration goal with AI…');
    try {
      const res = await firstValueFrom(this.api.hydrationSuggest());
      this.suggestion.set({ targetMl: res.targetMl, rationale: res.rationale ?? null });
      this.aiAnnounce.set(
        `AI suggests a daily goal of ${this.dispOf(res.targetMl)} ${this.imperial ? 'fluid ounces' : 'millilitres'}.` +
          (res.rationale ? ` ${res.rationale}` : '') +
          ' Set it as your goal, or close to keep your current goal.',
      );
    } catch {
      this.suggestion.set(null);
      this.aiAnnounce.set('AI hydration suggestion unavailable.');
      this.snack.open('AI unavailable — set your goal in Profile', 'OK', { duration: 4000 });
    } finally {
      this.goalLoading.set(false);
    }
  }

  /** Accept the suggested target — resolve so the page persists it on the profile. */
  acceptGoal(targetMl: number): void {
    this.ref.close({ kind: 'goal', targetMl });
  }

  // ---- single-drink (classic) ----
  save(): void {
    const ml = this.ml();
    if (ml == null) return;
    const label = this.label().trim();
    this.ref.close({
      kind: 'manual',
      requests: [{ date: this.data.date, amountMl: ml, label: label || undefined }],
    });
  }

  cancel(): void {
    this.ref.close();
  }
}
