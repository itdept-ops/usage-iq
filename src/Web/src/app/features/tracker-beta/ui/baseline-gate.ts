import {
  ChangeDetectionStrategy, Component, computed, inject, output, signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

import { Router } from '@angular/router';
import { TrackerStore, toLocalDate } from '../../../core/tracker-store';
import { UnitService } from '../../../core/unit.service';
import { Sex, TrackerProfileDto } from '../../../core/models';

/**
 * Strata BASELINE GATE — the mobile twin of the desktop tracker's BLOCKING baseline onboarding
 * (features/tracker/tracker.ts needsBaseline + OnboardingCard). When the caller's OWN profile is missing
 * any of current weight / height / date of birth / an explicit biological sex, the page replaces the hero
 * with this gate until it's saved: without those the calorie/BMR/TDEE math and the weight trend have no
 * day-one anchor.
 *
 * It collects the FOUR blocking fields (weight/height/DOB/sex) plus a goal, unit-aware for weight+height
 * (the wire stays metric), and commits via the EXISTING store methods: saveProfile (merged onto the current
 * profile so other fields are preserved) + logWeight (seeds today's weigh-in when today has none). Both
 * reload the day, so the page's needsBaseline gate then clears and the dashboard renders. A link hands off
 * to the full /tracker/profile editor for everything else.
 *
 * Self-styled with the page-host Strata tokens (var(--*) only — no global --tech-*), mobile-first + aria.
 *
 * Contract: <app-baseline-gate (done)="onBaselineDone()" /> — `done` fires after a successful save.
 */

const GOALS = ['Lose', 'Maintain', 'Gain'] as const;
const SEXES: { value: Sex; label: string }[] = [
  { value: 'Male', label: 'Male' },
  { value: 'Female', label: 'Female' },
];

@Component({
  selector: 'app-baseline-gate',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  host: { class: 'tb-card tb-baseline' },
  template: `
    <h2 class="bl-title">Let's set your baseline</h2>
    <p class="bl-intro">A few basics unlock your calorie target, recovery, and weight trend. You can refine everything later.</p>

    <div class="bl-form">
      <div class="bl-row">
        <div class="bl-field">
          <label class="bl-label" for="bl-weight">Current weight ({{ weightUnit() }})</label>
          <input id="bl-weight" class="bl-input" type="number" min="1" max="1000" step="0.1"
                 inputmode="decimal" enterkeyhint="next" placeholder="0"
                 [ngModel]="weight()" (ngModelChange)="weight.set($event)" />
        </div>
      </div>

      <div class="bl-row">
        @if (imperial()) {
          <div class="bl-field">
            <label class="bl-label" for="bl-ft">Height</label>
            <div class="bl-ftin">
              <input id="bl-ft" class="bl-input" type="number" min="1" max="8" step="1"
                     inputmode="numeric" placeholder="ft" aria-label="Height feet"
                     [ngModel]="heightFt()" (ngModelChange)="heightFt.set($event)" />
              <input class="bl-input" type="number" min="0" max="11" step="1"
                     inputmode="numeric" placeholder="in" aria-label="Height inches"
                     [ngModel]="heightIn()" (ngModelChange)="heightIn.set($event)" />
            </div>
          </div>
        } @else {
          <div class="bl-field">
            <label class="bl-label" for="bl-cm">Height (cm)</label>
            <input id="bl-cm" class="bl-input" type="number" min="30" max="300" step="1"
                   inputmode="numeric" placeholder="0"
                   [ngModel]="heightCm()" (ngModelChange)="heightCm.set($event)" />
          </div>
        }
        <div class="bl-field">
          <label class="bl-label" for="bl-dob">Date of birth</label>
          <input id="bl-dob" class="bl-input" type="date"
                 [ngModel]="dob()" (ngModelChange)="dob.set($event)" />
        </div>
      </div>

      <div>
        <span class="bl-label" id="bl-sex-lbl">Biological sex</span>
        <div class="bl-chips" role="group" aria-labelledby="bl-sex-lbl">
          @for (s of sexes; track s.value) {
            <button type="button" class="bl-chip" [class.on]="sex() === s.value"
                    [attr.aria-pressed]="sex() === s.value" (click)="sex.set(s.value)">{{ s.label }}</button>
          }
        </div>
      </div>

      <div>
        <span class="bl-label" id="bl-goal-lbl">Goal</span>
        <div class="bl-chips" role="group" aria-labelledby="bl-goal-lbl">
          @for (g of goals; track g) {
            <button type="button" class="bl-chip" [class.on]="goal() === g"
                    [attr.aria-pressed]="goal() === g" (click)="goal.set(g)">{{ g }}</button>
          }
        </div>
      </div>

      <button type="button" class="bl-cta" (click)="save()" [disabled]="busy() || !canSave()">
        @if (busy()) { <span class="bl-spin" aria-hidden="true"></span> } @else { Save baseline }
      </button>
      <button type="button" class="bl-link" (click)="openFullEditor()">Open the full profile &amp; goals editor</button>
      <span class="bl-sr" role="status" aria-live="polite">{{ announce() }}</span>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .bl-title { margin: 0; font-family: var(--font-display); font-size: 22px; font-weight: 700; letter-spacing: -.02em; color: var(--ink); }
    .bl-intro { margin: 6px 0 16px; font-size: 14px; line-height: 1.45; color: var(--ink-dim); }

    .bl-form { display: flex; flex-direction: column; gap: 14px; }
    .bl-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .bl-field { min-width: 0; }
    .bl-ftin { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }

    .bl-label { display: block; margin: 0 0 6px 2px; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--ink-dim); }
    .bl-input {
      width: 100%; box-sizing: border-box; min-height: 48px;
      padding: 0 14px; font-family: var(--font-ui); font-size: 16px; color: var(--ink);
      background: var(--bg-sink); border: 1px solid var(--hairline); border-radius: var(--r-tile);
      box-shadow: var(--press); -webkit-appearance: none; appearance: none;
      transition: border-color 160ms var(--ease-out);
    }
    .bl-input:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; border-color: var(--focus); }

    .bl-chips { display: flex; flex-wrap: wrap; gap: 8px; }
    .bl-chip {
      min-height: 44px; padding: 0 16px;
      font-family: var(--font-ui); font-size: 14px; font-weight: 600; color: var(--ink-dim);
      background: var(--bg-sink); border: 1px solid var(--hairline); border-radius: var(--r-pill);
      touch-action: manipulation; -webkit-tap-highlight-color: transparent; cursor: pointer;
      transition: color 160ms var(--ease-out), border-color 160ms var(--ease-out), background 160ms var(--ease-out);
    }
    .bl-chip.on {
      color: var(--ink);
      background: color-mix(in srgb, var(--tech-accent, var(--cal-a)) 16%, var(--bg-sink));
      border-color: color-mix(in srgb, var(--tech-accent, var(--cal-a)) 50%, transparent);
    }
    .bl-chip:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }

    .bl-cta {
      margin-top: 4px; min-height: 52px; display: flex; align-items: center; justify-content: center; gap: 8px;
      font-family: var(--font-ui); font-size: 16px; font-weight: 700; color: #fff;
      background: linear-gradient(135deg, var(--tech-accent, var(--cal-a)), var(--tech-accent-2, var(--cal-b)));
      border: 0; border-radius: var(--r-pill); box-shadow: var(--lift-2);
      touch-action: manipulation; -webkit-tap-highlight-color: transparent; cursor: pointer;
      transition: transform 120ms var(--ease-out), box-shadow 120ms var(--ease-out), opacity 160ms var(--ease-out);
    }
    .bl-cta:active:not(:disabled) { transform: translateY(1px) scale(.99); box-shadow: var(--press); }
    .bl-cta:disabled { opacity: .45; cursor: default; }
    .bl-cta:focus-visible { outline: 2px solid var(--focus); outline-offset: 3px; }

    .bl-link {
      align-self: center; min-height: 44px; padding: 0 12px;
      font-family: var(--font-ui); font-size: 13px; font-weight: 600; color: var(--ink-dim);
      background: transparent; border: 0; cursor: pointer; text-decoration: underline;
    }
    .bl-link:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }

    .bl-spin { width: 16px; height: 16px; border-radius: 50%; border: 2px solid rgba(255,255,255,.4); border-top-color: #fff; animation: bl-spin 700ms linear infinite; }
    @keyframes bl-spin { to { transform: rotate(360deg); } }
    .bl-sr { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; border: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

    @media (prefers-reduced-motion: reduce) { .bl-chip, .bl-cta { transition: none; } .bl-spin { animation: none; } }
  `],
})
export class BaselineGate {
  private readonly store = inject(TrackerStore);
  private readonly units = inject(UnitService);
  private readonly router = inject(Router);

  /** Fires after a successful baseline save (both store calls settled + day reloaded). */
  readonly done = output<void>();

  protected readonly goals = GOALS;
  protected readonly sexes = SEXES;

  protected readonly weightUnit = computed(() => this.units.weightUnit());
  protected readonly imperial = computed(() => this.units.weightUnit() === 'lb');

  protected readonly weight = signal<number | null>(null);
  protected readonly heightCm = signal<number | null>(null);
  protected readonly heightFt = signal<number | null>(null);
  protected readonly heightIn = signal<number | null>(null);
  protected readonly dob = signal<string>('');
  protected readonly sex = signal<Sex>('Unspecified');
  protected readonly goal = signal<string>('Maintain');

  protected readonly busy = signal(false);
  protected readonly announce = signal('');

  /** Resolve the entered height to canonical cm (unit-aware), or null when incomplete. */
  private resolveHeightCm(): number | null {
    if (this.imperial()) {
      const ft = this.heightFt();
      const inch = this.heightIn() ?? 0;
      if (ft == null || !(ft > 0)) return null;
      return Math.round(this.units.heightFromFtIn(ft, inch));
    }
    const cm = this.heightCm();
    return cm != null && cm > 0 ? Math.round(cm) : null;
  }

  protected readonly canSave = computed(() => {
    const w = this.weight();
    const hasWeight = w != null && w > 0;
    const hasHeight = this.imperial()
      ? (this.heightFt() ?? 0) > 0
      : (this.heightCm() ?? 0) > 0;
    return hasWeight && hasHeight && !!this.dob() && this.sex() !== 'Unspecified';
  });

  protected async save(): Promise<void> {
    if (this.busy() || !this.canSave()) return;
    const w = this.weight();
    const heightCm = this.resolveHeightCm();
    if (w == null || heightCm == null) return;
    const weightKg = Math.round(this.units.weightToCanonical(w) * 10) / 10;

    // Merge onto the current profile so unrelated fields (goals, sharing, etc.) are preserved.
    const current = this.store.profile();
    const body: TrackerProfileDto = {
      ...(current ?? {
        goal: 'Maintain', shareWithContacts: false, sex: 'Unspecified',
        activityLevel: 'Sedentary', unitSystem: this.imperial() ? 'Imperial' : 'Metric',
      }),
      goal: this.goal(),
      weightKg,
      heightCm,
      dateOfBirth: this.dob(),
      sex: this.sex(),
    };

    this.busy.set(true);
    this.announce.set('Saving your baseline…');
    try {
      await this.store.saveProfile(body);
      // Seed today's weigh-in only if today doesn't already have one (avoid clobbering an existing entry).
      const today = toLocalDate(new Date());
      const history = await this.store.weightHistory(7).catch(() => []);
      if (!history.some(h => h.date === today)) {
        await this.store.logWeight({ date: today, weightKg });
      }
      await this.store.load();
      this.announce.set('Baseline saved.');
      this.done.emit();
    } catch {
      this.announce.set('Could not save your baseline. Try again.');
    } finally {
      this.busy.set(false);
    }
  }

  protected openFullEditor(): void {
    void this.router.navigate(['/tracker/profile']);
  }
}
