import {
  ChangeDetectionStrategy, Component, computed, effect, inject, model, output, signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { firstValueFrom } from 'rxjs';

import { Api } from '../../../core/api';
import { CopyFoodRequest, Meal } from '../../../core/models';
import { OptimisticTracker } from '../state/optimistic-tracker';
import { BottomSheet } from '../ui/bottom-sheet';

/*
 * sheets/copy-food-sheet.ts — the Tracker Beta ("Strata") COPY-FOOD-TO-ANOTHER-DAY sheet, the mobile twin of
 * the desktop copy-food-dialog (features/tracker/copy-food-dialog.ts). The fuel card emits `copyFood(f)`
 * (a single logged row) or `copyMeal(meal)` (all of a meal's rows); the page seeds this sheet's `entryIds` +
 * `sourceMeal` + `label` and opens it. The user picks a TARGET DATE (default tomorrow, forward-capped) and an
 * optional TARGET MEAL (default = the source meal). On Copy it POSTs the new copyFood endpoint (a COPY — the
 * source day is untouched, the same nutrition is snapshotted onto the picked day), emits the result, and
 * closes; the PAGE toasts + refreshes the viewed day if the copy landed on it.
 *
 * Owner-only server-side (TrackerSelf): foreign/non-existent ids are silently dropped (copiedCount 0); a
 * caller can only copy their OWN entries onto their OWN days. Read-only (shared) views never reach here (the
 * fuel card hides the affordance).
 *
 * Self-styled with the page-host Strata tokens (var(--*) only — no global --tech-*), mobile-first with
 * >=44px targets, aria labels, a visually-hidden aria-live status, reduced-motion-friendly chrome. The
 * accent matches the Food / fuel card (cal).
 *
 * Contract (the page binds these VERBATIM):
 *   selector : app-copy-food-sheet
 *   inputs   : open      (model<boolean>, two-way)
 *              entryIds  (model<number[]>) — the caller's own ids to copy
 *              sourceMeal(model<Meal>)     — seeds the default target meal
 *              label     (model<string>)   — a friendly noun for the count, e.g. "1 item" / "Breakfast — 3 items"
 *   outputs  : copied ({ targetDate; copiedCount }) — emitted after the POST (the sheet then closes itself)
 *
 * Usage:
 *   <app-copy-food-sheet [(open)]="copyFoodOpen" [(entryIds)]="copyIds"
 *                        [(sourceMeal)]="copyMealSlot" [(label)]="copyLabel" (copied)="onFoodCopied($event)" />
 */

/** What the sheet emits after the POST: the target date + how many entries were actually copied. */
export interface CopyFoodDone {
  targetDate: string;
  copiedCount: number;
}

/** One selectable target-day chip. */
interface DayChip {
  iso: string;
  label: string;
}

/** The four meal slots for the optional target-meal picker (matches the food sheet set). */
const MEALS: { value: Meal; label: string }[] = [
  { value: 'breakfast', label: 'Breakfast' },
  { value: 'lunch', label: 'Lunch' },
  { value: 'dinner', label: 'Dinner' },
  { value: 'snack', label: 'Snack' },
];

/** How many forward days (beyond today) to offer as quick "copy onto" chips. */
const FUTURE_DAYS = 6;

/** Strip a possibly-ISO-datetime down to its "YYYY-MM-DD" date part. */
function dateOnly(s: string): string {
  return (s || '').slice(0, 10);
}

/** Local "YYYY-MM-DD" for a Date (no UTC shift — the tracker is local-date keyed). */
function toIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

@Component({
  selector: 'app-copy-food-sheet',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MatIconModule, BottomSheet],
  template: `
    <app-bottom-sheet [(open)]="open" detent="half" label="Copy to another day" [dismissable]="!saving()">
      <div class="cf-head" style="--accent-edge: var(--cal-a);">
        <span class="cf-spark" aria-hidden="true">
          <mat-icon>content_copy</mat-icon>
        </span>
        <div>
          <h2 class="cf-title">Copy to another day</h2>
          <p class="cf-sub">{{ label() }} · the original stays put</p>
        </div>
      </div>

      <div class="cf-body" style="--cta-a: var(--cal-a); --cta-b: var(--cal-b); --accent-edge: var(--cal-a);">
        <!-- 1) Which day to copy onto. -->
        <section class="cf-section" aria-label="Which day">
          <span class="cf-label">Copy onto…</span>
          <div class="cf-days" role="radiogroup" aria-label="Day to copy onto">
            @for (chip of dayChips(); track chip.iso) {
              <button type="button" class="cf-day" [class.on]="targetDate() === chip.iso"
                      role="radio" [attr.aria-checked]="targetDate() === chip.iso"
                      (click)="targetDate.set(chip.iso)">
                @if (targetDate() === chip.iso) {
                  <mat-icon aria-hidden="true">check</mat-icon>
                }
                {{ chip.label }}
              </button>
            }
          </div>

          <label class="cf-pick">
            <span class="cf-pick-label">Or pick a date</span>
            <input class="cf-pick-input" type="date" enterkeyhint="done"
                   [max]="maxDate" aria-label="Pick a date to copy onto"
                   [ngModel]="targetDate()" (ngModelChange)="onPickDate($event)" />
          </label>
        </section>

        <!-- 2) Optional target meal. -->
        <section class="cf-section" aria-label="Meal">
          <span class="cf-label">Meal</span>
          <div class="cf-chips" role="group" aria-label="Target meal">
            @for (m of MEALS; track m.value) {
              <button type="button" class="cf-chip"
                      [class.on]="targetMeal() === m.value"
                      [attr.aria-pressed]="targetMeal() === m.value"
                      (click)="targetMeal.set(m.value)">{{ m.label }}</button>
            }
          </div>
        </section>

        <div class="cf-actions">
          <button type="button" class="cf-cta" (click)="copy()"
                  [disabled]="!canCopy() || tracker.readOnly()">
            @if (saving()) {
              <span class="cf-spin" aria-hidden="true"></span>
            } @else {
              <mat-icon aria-hidden="true">content_copy</mat-icon>
              Copy
            }
          </button>
        </div>

        <span class="cf-sr" role="status" aria-live="polite">{{ announce() }}</span>
      </div>
    </app-bottom-sheet>
  `,
  styles: [`
    :host { display: contents; }

    .cf-head { display: flex; align-items: center; gap: 12px; padding: 4px 2px 14px; }
    .cf-spark {
      flex: 0 0 auto; display: flex; align-items: center; justify-content: center;
      width: 40px; height: 40px; border-radius: var(--r-pill);
      background: linear-gradient(135deg, var(--cal-a), var(--cal-b)); box-shadow: var(--lift-1);
    }
    .cf-spark mat-icon { width: 20px; height: 20px; font-size: 20px; line-height: 20px; color: #fff; }
    .cf-title {
      margin: 0; font-family: var(--font-ui); font-weight: 700; font-size: 19px;
      color: var(--ink); letter-spacing: -.01em;
    }
    .cf-sub { margin: 2px 0 0; font-size: 12px; color: var(--ink-dim); }

    .cf-body { display: flex; flex-direction: column; gap: 18px; padding-bottom: 8px; }

    .cf-section { display: flex; flex-direction: column; gap: 10px; }
    .cf-label {
      font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--ink-dim);
      padding-left: 2px;
    }

    /* Day chips (single-select). */
    .cf-days { display: flex; flex-wrap: wrap; gap: 8px; }
    .cf-day {
      display: inline-flex; align-items: center; gap: 4px; min-height: 44px; padding: 0 14px;
      background: var(--bg-rise); border: 1px solid var(--hairline); border-radius: var(--r-pill);
      font-family: var(--font-ui); font-size: 13px; font-weight: 600; color: var(--ink-dim);
      cursor: pointer; touch-action: manipulation; -webkit-tap-highlight-color: transparent;
      transition: border-color 140ms var(--ease-out), color 140ms var(--ease-out), transform 120ms var(--ease-out);
    }
    .cf-day:active { transform: scale(.97) translateY(1px); }
    .cf-day:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
    .cf-day.on { border-color: var(--accent-edge); color: var(--ink); box-shadow: var(--lift-1); }
    .cf-day mat-icon { width: 16px; height: 16px; font-size: 16px; line-height: 16px; color: var(--accent-edge); }

    /* Native date fallback. */
    .cf-pick { display: flex; flex-direction: column; gap: 6px; }
    .cf-pick-label {
      font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--ink-faint);
      padding-left: 2px;
    }
    .cf-pick-input {
      box-sizing: border-box; min-height: 48px; padding: 0 14px;
      font-family: var(--font-ui); font-size: 16px; color: var(--ink);
      background: var(--bg-sink); border: 1px solid var(--hairline); border-radius: var(--r-tile);
      box-shadow: var(--press); -webkit-appearance: none; appearance: none;
    }
    .cf-pick-input:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; border-color: var(--focus); }

    /* Meal chips. */
    .cf-chips { display: flex; flex-wrap: wrap; gap: 8px; }
    .cf-chip {
      min-height: 44px; padding: 0 14px; display: inline-flex; align-items: center;
      font-family: var(--font-ui); font-size: 13px; font-weight: 600; color: var(--ink-dim);
      background: var(--bg-sink); border: 1px solid var(--hairline); border-radius: var(--r-pill);
      touch-action: manipulation; -webkit-tap-highlight-color: transparent; cursor: pointer;
      transition: transform 120ms var(--ease-out), color 160ms var(--ease-out), border-color 160ms var(--ease-out);
    }
    .cf-chip:active { transform: translateY(1px) scale(.97); box-shadow: var(--press); }
    .cf-chip:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
    .cf-chip.on {
      color: var(--ink);
      background: color-mix(in srgb, var(--cal-a) 18%, var(--bg-sink));
      border-color: color-mix(in srgb, var(--cal-a) 50%, transparent);
    }

    /* Copy CTA. */
    .cf-actions { display: flex; padding-top: 2px; }
    .cf-cta {
      flex: 1 1 auto; min-height: 52px;
      display: flex; align-items: center; justify-content: center; gap: 8px;
      font-family: var(--font-ui); font-size: 16px; font-weight: 700; letter-spacing: -.01em;
      color: #fff; background: linear-gradient(135deg, var(--cta-a, var(--cal-a)), var(--cta-b, var(--cal-b)));
      border: 0; border-radius: var(--r-pill); box-shadow: var(--lift-2);
      touch-action: manipulation; -webkit-tap-highlight-color: transparent; cursor: pointer;
      transition: transform 120ms var(--ease-out), box-shadow 120ms var(--ease-out), opacity 160ms var(--ease-out);
    }
    .cf-cta mat-icon { width: 20px; height: 20px; font-size: 20px; line-height: 20px; }
    .cf-cta:active:not(:disabled) { transform: translateY(1px) scale(.99); box-shadow: var(--press); }
    .cf-cta:disabled { opacity: .45; cursor: default; }
    .cf-cta:focus-visible { outline: 2px solid var(--focus); outline-offset: 3px; }

    .cf-spin {
      width: 18px; height: 18px; border-radius: 50%;
      border: 2px solid rgba(255,255,255,.4); border-top-color: #fff;
      animation: cf-spin 700ms linear infinite;
    }
    @keyframes cf-spin { to { transform: rotate(360deg); } }

    .cf-sr {
      position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; border: 0;
      overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap;
    }

    @media (prefers-reduced-motion: reduce) {
      .cf-day, .cf-chip, .cf-cta { transition: none; }
      .cf-spin { animation: none; }
    }
  `],
})
export class CopyFoodSheet {
  private readonly api = inject(Api);
  protected readonly tracker = inject(OptimisticTracker);

  /** Two-way open state — the page sets this true when the user picks "Copy to…". */
  readonly open = model<boolean>(false);
  /** The caller's own food-entry id(s) to copy (seeded by the page from the tapped row / meal). */
  readonly entryIds = model<number[]>([]);
  /** The source meal slot — seeds the default target meal. */
  readonly sourceMeal = model<Meal>('breakfast');
  /** A friendly noun for the count, shown in the sub-line ("1 item" / "Breakfast — 3 items"). */
  readonly label = model<string>('');
  /** Emitted after the POST with the target date + how many landed (the sheet then closes). */
  readonly copied = output<CopyFoodDone>();

  protected readonly MEALS = MEALS;
  protected readonly maxDate = this.computeMaxDate();

  /** The forward day chips (Tomorrow … +N), rebuilt from local today on each open. */
  protected readonly dayChips = signal<DayChip[]>([]);
  /** The chosen target date (yyyy-MM-dd) — defaults to tomorrow. */
  protected readonly targetDate = signal<string>('');
  /** The chosen target meal — defaults to the source meal on open. */
  protected readonly targetMeal = signal<Meal>('breakfast');

  /** True while the POST is in flight (latches Copy against a double-tap; blocks dismiss). */
  protected readonly saving = signal(false);
  /** Visually-hidden aria-live status. */
  protected readonly announce = signal('');

  constructor() {
    // Each time the sheet OPENS: rebuild the forward chips + seed the defaults (tomorrow + the source meal).
    effect(() => {
      if (this.open()) {
        this.dayChips.set(this.buildDayChips());
        this.targetDate.set(this.defaultDate());
        this.targetMeal.set(this.sourceMeal());
        this.announce.set('');
      }
    });
  }

  /** Copy is enabled with a valid target date + at least one entry to copy + not already saving. */
  protected readonly canCopy = computed(
    () => !this.saving() && !!this.targetDate() && this.entryIds().length > 0,
  );

  /** Clamp a hand-picked date to the forward cap (never past it); empty input is ignored. */
  protected onPickDate(v: string): void {
    const iso = dateOnly(v);
    if (!iso) return;
    this.targetDate.set(iso > this.maxDate ? this.maxDate : iso);
  }

  /**
   * POST the copy (a COPY — the source day is untouched; the same nutrition is snapshotted onto the target).
   * Emits the result then closes; the PAGE toasts + refreshes the viewed day if the copy landed on it.
   * Latched against a double-tap. Foreign/non-existent ids are dropped server-side (copiedCount may be 0).
   */
  protected async copy(): Promise<void> {
    if (!this.canCopy() || this.tracker.readOnly()) return;
    const targetDate = this.targetDate();
    const body: CopyFoodRequest = {
      entryIds: this.entryIds(),
      targetDate,
      targetMeal: this.targetMeal(),
    };

    this.saving.set(true);
    this.announce.set('Copying…');
    try {
      const out = await firstValueFrom(this.api.copyFood(body));
      this.announce.set(
        out.copiedCount > 0 ? `Copied ${out.copiedCount} item(s).` : 'Nothing was copied.',
      );
      this.copied.emit({ targetDate, copiedCount: out.copiedCount });
      this.open.set(false);
    } catch {
      this.announce.set('Couldn’t copy — nothing was changed.');
      this.copied.emit({ targetDate, copiedCount: 0 });
      this.open.set(false);
    } finally {
      this.saving.set(false);
    }
  }

  // ── helpers ──────────────────────────────────────────────────────────────────

  /** Build the forward "copy onto" chips: Tomorrow, then the next several dated days from local today. */
  private buildDayChips(): DayChip[] {
    const base = new Date();
    base.setHours(0, 0, 0, 0);
    const chips: DayChip[] = [];
    for (let i = 1; i <= 1 + FUTURE_DAYS; i++) {
      const d = new Date(base);
      d.setDate(d.getDate() + i);
      chips.push({ iso: toIso(d), label: this.dayLabel(toIso(d)) });
    }
    return chips;
  }

  /** Tomorrow (relative to local today) is the default copy target. */
  private defaultDate(): string {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 1);
    return toIso(d);
  }

  /** A reasonable forward cap (today + 1 year) for the native date input. */
  private computeMaxDate(): string {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setFullYear(d.getFullYear() + 1);
    return toIso(d);
  }

  /** A friendly label for an ISO date: Tomorrow, else "Wed Jun 25". */
  private dayLabel(iso: string): string {
    const d = new Date(`${iso}T00:00:00`);
    if (isNaN(d.getTime())) return iso;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diff = Math.round((d.getTime() - today.getTime()) / 86_400_000);
    if (diff === 1) return 'Tomorrow';
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  }
}
