import {
  ChangeDetectionStrategy, Component, OnDestroy, computed, inject, signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import type { EChartsOption } from 'echarts';
import { firstValueFrom } from 'rxjs';

import { Api } from '../../core/api';
import {
  AdherenceResponse, DoseSlot, LogDoseInput, Medication, MedicationForm, MedicationInput,
  MedicationLogStatus, MedsResponse, VitalInput, VitalKind, VitalReading, VitalsInsightResponse,
  VitalsResponse, VitalTrend,
} from '../../core/models';
import { ChartComponent } from '../../shared/chart';
import { BetaErrorState } from '../beta-ui';

/** A vital kind's UI descriptor — label, unit, icon, accent, range hint, and whether it carries a 2nd value. */
interface VitalMeta {
  kind: VitalKind;
  label: string;
  short: string;
  unit: string;
  icon: string;
  accent: string;
  dual: boolean;            // BloodPressure carries systolic/diastolic
  placeholder1: string;
  placeholder2?: string;
}

/** The window selector options (days). */
interface WindowOpt { value: number; label: string; }

/**
 * MEDS & VITALS — the DESKTOP `/meds` page. A PRIVATE, OWNER-ONLY, NON-MEDICAL health vertical: nothing here is
 * ever shared to a coach, family member, or contact, and it appears in no activity feed (enforced + tested
 * server-side EXACTLY like Sleep / Cycle). Two sections:
 *
 *  • MEDS — the caller's active medications with TODAY's per-dose checklist (tap a dose to mark it taken /
 *    skipped), an add/edit sheet (name · dose · cadence · reminders), and a deterministic adherence ring + %
 *    over the selected window.
 *  • VITALS — quick-log tiles per vital kind (BP · HR · glucose · temp · SpO₂ · weight), a readings list, and
 *    a per-kind trend mini-chart (the shared ECharts wrapper) with deterministic avg / min / max.
 *
 *  • An OPTIONAL floored ✨ insight card (tracker.ai) summarising AGGREGATE stats only, with a clear
 *    NON-MEDICAL / non-diagnostic disclaimer; it falls back silently to the deterministic plain note otherwise.
 *
 * DATA + PRIVACY (load-bearing): every read/write reuses the owner-scoped, tracker.self-gated
 * `/api/meds` + `/api/vitals` endpoints — adherence and trends are PURE deterministic server math (they always
 * render); the insight is the only AI touchpoint and it ALWAYS 200s (the deterministic floor when AI is off).
 * This page renders only the caller's OWN rows and re-derives nothing client-side. STYLING: the app's own
 * `--tech-*` tokens.
 */
@Component({
  selector: 'app-meds',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MatIconModule, ChartComponent, BetaErrorState],
  styleUrl: './meds.page.scss',
  template: `
    <div class="md">
      <!-- ─────────── HEADER ─────────── -->
      <header class="md-head">
        <div class="md-head__lead">
          <p class="md-head__kicker">
            <mat-icon aria-hidden="true">medication</mat-icon> Meds &amp; Vitals
          </p>
          <h1 class="md-head__title">Your private health log</h1>
          <p class="md-head__sub">
            Medications, doses &amp; vital readings — logged by you, for you. Informational only, not medical
            advice.
          </p>
          <p class="md-private">
            <mat-icon aria-hidden="true">lock</mat-icon>
            Private to you — never shared with family, coaches, or contacts.
          </p>
        </div>
        <div class="md-head__windows" role="tablist" aria-label="Window">
          @for (w of windows; track w.value) {
            <button type="button" class="md-chip" role="tab"
                    [class.is-on]="window() === w.value" [attr.aria-selected]="window() === w.value"
                    [disabled]="loading()" (click)="setWindow(w.value)">{{ w.label }}</button>
          }
        </div>
      </header>

      @if (loading()) {
        <div class="md-skel-grid" aria-hidden="true">
          @for (s of [1,2,3,4]; track s) { <div class="md-skel"></div> }
        </div>
      } @else if (errored()) {
        <app-bs-error
          icon="cloud_off"
          title="Couldn't load your health log"
          body="Something went wrong fetching your data. Give it another go."
          (retry)="reload()" />
      } @else {

        <!-- ─────────── OPTIONAL ✨ INSIGHT (tracker.ai; floors otherwise) ─────────── -->
        @if (insight(); as ins) {
          @if (ins.note) {
          <section class="md-insight" [class.is-ai]="!ins.fellBackToPlain" aria-label="Private insight">
            <p class="md-insight__kicker">
              @if (!ins.fellBackToPlain) {
                <mat-icon aria-hidden="true">auto_awesome</mat-icon> AI read
              } @else {
                <mat-icon aria-hidden="true">summarize</mat-icon> Your summary
              }
            </p>
            <p class="md-insight__text">{{ ins.note }}</p>
            <p class="md-insight__foot">
              <mat-icon aria-hidden="true">health_and_safety</mat-icon>
              Summarises only your own aggregate numbers — non-diagnostic, not medical advice.
            </p>
          </section>
          }
        }

        <!-- ════════════ MEDS SECTION ════════════ -->
        <section class="md-sec" aria-label="Medications">
          <div class="md-sec__head">
            <h2 class="md-sec__title"><mat-icon aria-hidden="true">pill</mat-icon> Medications</h2>
            <button type="button" class="md-add" (click)="openAddMed()">
              <mat-icon aria-hidden="true">add</mat-icon> Add medication
            </button>
          </div>

          <div class="md-meds">
            <!-- adherence ring -->
            <div class="md-ring-card">
              <div class="md-ring" [style.--pct]="adherencePct()">
                <span class="md-ring__num mono-num">{{ adherenceLabel() }}</span>
                <span class="md-ring__cap">adherence</span>
              </div>
              <div class="md-ring__meta">
                <p><span class="mono-num">{{ adherence()?.taken ?? 0 }}</span> of
                   <span class="mono-num">{{ adherence()?.scheduled ?? 0 }}</span> doses taken</p>
                <p class="md-ring__sub">over the last {{ window() }} days</p>
              </div>
            </div>

            <!-- today's checklist -->
            <div class="md-list">
              @if (medList().length === 0) {
                <div class="md-empty">
                  <span class="md-empty__orb"><mat-icon aria-hidden="true">medication</mat-icon></span>
                  <p class="md-empty__body">No active medications. Add one to start a private dose checklist.</p>
                </div>
              } @else {
                @for (m of medList(); track m.id) {
                  <article class="md-med">
                    <div class="md-med__bar">
                      <div class="md-med__id">
                        <span class="md-med__glyph" aria-hidden="true">
                          <mat-icon>{{ formIcon(m.form) }}</mat-icon>
                        </span>
                        <div class="md-med__txt">
                          <h3 class="md-med__name">{{ m.name }}</h3>
                          <p class="md-med__meta">
                            <span>{{ m.dose || '—' }}</span>
                            <span class="md-dot">·</span>
                            <span>{{ scheduleLabel(m) }}</span>
                            @if (m.remindersEnabled) {
                              <span class="md-dot">·</span>
                              <span class="md-med__rem"><mat-icon aria-hidden="true">notifications_active</mat-icon> Reminders</span>
                            }
                          </p>
                        </div>
                      </div>
                      <div class="md-med__actions">
                        <button type="button" class="md-icon-btn" (click)="openEditMed(m)" aria-label="Edit">
                          <mat-icon aria-hidden="true">edit</mat-icon>
                        </button>
                        <button type="button" class="md-icon-btn" (click)="deactivate(m)" aria-label="Deactivate">
                          <mat-icon aria-hidden="true">delete_outline</mat-icon>
                        </button>
                      </div>
                    </div>

                    @if (m.todaySlots?.length) {
                      <div class="md-doses" role="group" aria-label="Today's doses">
                        @for (slot of m.todaySlots; track slot.slot) {
                          <div class="md-dose" [attr.data-status]="statusKey(slot.status)">
                            <span class="md-dose__when">{{ slot.time || ('Dose ' + (slot.slot + 1)) }}</span>
                            <div class="md-dose__btns">
                              <button type="button" class="md-dose__btn is-take"
                                      [class.is-on]="slot.status === 0"
                                      [disabled]="busyDose() === doseKey(m.id, slot.slot)"
                                      (click)="markDose(m, slot, 0)" aria-label="Mark taken">
                                <mat-icon aria-hidden="true">check_circle</mat-icon> Taken
                              </button>
                              <button type="button" class="md-dose__btn is-skip"
                                      [class.is-on]="slot.status === 1"
                                      [disabled]="busyDose() === doseKey(m.id, slot.slot)"
                                      (click)="markDose(m, slot, 1)" aria-label="Mark skipped">
                                <mat-icon aria-hidden="true">cancel</mat-icon> Skip
                              </button>
                            </div>
                          </div>
                        }
                      </div>
                    } @else {
                      <p class="md-med__none">No doses scheduled for today.</p>
                    }
                  </article>
                }
              }
            </div>
          </div>
        </section>

        <!-- ════════════ VITALS SECTION ════════════ -->
        <section class="md-sec" aria-label="Vitals">
          <div class="md-sec__head">
            <h2 class="md-sec__title"><mat-icon aria-hidden="true">monitor_heart</mat-icon> Vitals</h2>
            <div class="md-vital-kinds" role="tablist" aria-label="Vital kind">
              @for (vm of vitalMetas; track vm.kind) {
                <button type="button" class="md-vchip" role="tab"
                        [class.is-on]="vitalKind() === vm.kind"
                        [style.--accent]="vm.accent"
                        [attr.aria-selected]="vitalKind() === vm.kind"
                        (click)="selectVitalKind(vm.kind)">
                  <mat-icon aria-hidden="true">{{ vm.icon }}</mat-icon> {{ vm.short }}
                </button>
              }
            </div>
          </div>

          <div class="md-vitals" [style.--accent]="activeMeta().accent">
            <!-- quick-log tile -->
            <div class="md-qlog">
              <p class="md-qlog__h"><mat-icon aria-hidden="true">{{ activeMeta().icon }}</mat-icon> Log {{ activeMeta().label }}</p>
              <div class="md-qlog__row">
                <label class="md-qlog__field">
                  <span class="md-qlog__lbl">{{ activeMeta().dual ? 'Systolic' : activeMeta().label }}</span>
                  <input class="md-qlog__inp" type="number" inputmode="decimal" [(ngModel)]="qv1" name="qv1"
                         [placeholder]="activeMeta().placeholder1" />
                </label>
                @if (activeMeta().dual) {
                  <span class="md-qlog__sep" aria-hidden="true">/</span>
                  <label class="md-qlog__field">
                    <span class="md-qlog__lbl">Diastolic</span>
                    <input class="md-qlog__inp" type="number" inputmode="decimal" [(ngModel)]="qv2" name="qv2"
                           [placeholder]="activeMeta().placeholder2 || ''" />
                  </label>
                }
                <span class="md-qlog__unit">{{ activeMeta().unit }}</span>
              </div>
              <button type="button" class="md-qlog__btn" [disabled]="logging()" (click)="quickLogVital()">
                @if (logging()) { <span class="md-spin" aria-hidden="true"></span> Logging… }
                @else { <mat-icon aria-hidden="true">add</mat-icon> Log reading }
              </button>
            </div>

            <!-- trend mini-chart + stats -->
            <div class="md-trend">
              @if (trend() && trend()!.count > 0) {
                <div class="md-trend__stats">
                  <div class="md-stat">
                    <span class="md-stat__v mono-num">{{ fmt(trend()!.avg) }}</span>
                    <span class="md-stat__l">avg{{ trend()!.avg2 != null ? ' / ' + fmt(trend()!.avg2!) : '' }}</span>
                  </div>
                  <div class="md-stat">
                    <span class="md-stat__v mono-num">{{ fmt(trend()!.min) }}</span>
                    <span class="md-stat__l">min</span>
                  </div>
                  <div class="md-stat">
                    <span class="md-stat__v mono-num">{{ fmt(trend()!.max) }}</span>
                    <span class="md-stat__l">max</span>
                  </div>
                  <div class="md-stat">
                    <span class="md-stat__v mono-num">{{ trend()!.count }}</span>
                    <span class="md-stat__l">readings</span>
                  </div>
                </div>
                <div class="md-trend__chart">
                  <app-chart [option]="chartOption()" />
                </div>
              } @else {
                <div class="md-empty md-empty--trend">
                  <span class="md-empty__orb"><mat-icon aria-hidden="true">{{ activeMeta().icon }}</mat-icon></span>
                  <p class="md-empty__body">No {{ activeMeta().label.toLowerCase() }} readings yet. Log one above to start a trend.</p>
                </div>
              }
            </div>

            <!-- readings list -->
            <div class="md-readings">
              <h3 class="md-readings__h">Recent readings</h3>
              @if (readingList().length === 0) {
                <p class="md-readings__none">Nothing logged in this window.</p>
              } @else {
                @for (r of readingList(); track r.id) {
                  <div class="md-reading">
                    <span class="md-reading__v mono-num">{{ readingValue(r) }} <i>{{ r.unit }}</i></span>
                    <span class="md-reading__d">{{ friendlyDate(r.localDate) }}</span>
                    <button type="button" class="md-icon-btn" (click)="deleteReading(r)" aria-label="Delete reading">
                      <mat-icon aria-hidden="true">delete_outline</mat-icon>
                    </button>
                  </div>
                }
              }
            </div>
          </div>
        </section>
      }

      <!-- ─────────── ADD / EDIT MEDICATION SHEET ─────────── -->
      @if (medSheetOpen()) {
        <div class="md-scrim" (click)="closeMedSheet()"></div>
        <div class="md-sheet" role="dialog" aria-modal="true" aria-label="Medication">
          <div class="md-sheet__head">
            <h3 class="md-sheet__title">{{ editingId() ? 'Edit' : 'Add' }} medication</h3>
            <button type="button" class="md-icon-btn" (click)="closeMedSheet()" aria-label="Close">
              <mat-icon aria-hidden="true">close</mat-icon>
            </button>
          </div>

          <label class="md-field">
            <span class="md-field__lbl">Name</span>
            <input class="md-field__inp" [(ngModel)]="fName" name="fName" maxlength="120" placeholder="e.g. Atorvastatin" />
          </label>

          <div class="md-field-row">
            <label class="md-field">
              <span class="md-field__lbl">Dose</span>
              <input class="md-field__inp" [(ngModel)]="fDose" name="fDose" maxlength="60" placeholder="e.g. 10 mg" />
            </label>
            <label class="md-field">
              <span class="md-field__lbl">Form</span>
              <select class="md-field__inp" [(ngModel)]="fForm" name="fForm">
                @for (f of formOptions; track f.value) {
                  <option [ngValue]="f.value">{{ f.label }}</option>
                }
              </select>
            </label>
          </div>

          <label class="md-field">
            <span class="md-field__lbl">Doses per day</span>
            <div class="md-stepper">
              <button type="button" (click)="bumpTimes(-1)" aria-label="Fewer">−</button>
              <span class="mono-num">{{ fTimesPerDay() }}</span>
              <button type="button" (click)="bumpTimes(1)" aria-label="More">+</button>
            </div>
          </label>

          <label class="md-toggle" [class.is-on]="fReminders()" (click)="fReminders.set(!fReminders())">
            <mat-icon aria-hidden="true">{{ fReminders() ? 'notifications_active' : 'notifications_off' }}</mat-icon>
            <span class="md-toggle__txt">
              <b>Dose reminders</b>
              <i>A gentle bell + push when a due dose is unlogged.</i>
            </span>
            <span class="md-switch" [class.is-on]="fReminders()" aria-hidden="true"><span></span></span>
          </label>

          <label class="md-field">
            <span class="md-field__lbl">Notes <i>(optional)</i></span>
            <textarea class="md-field__inp md-field__area" rows="2" [(ngModel)]="fNotes" name="fNotes"
                      maxlength="300" placeholder="Anything to remember (private)"></textarea>
          </label>

          @if (sheetError()) { <p class="md-sheet__err">{{ sheetError() }}</p> }

          <button type="button" class="md-sheet__save" [disabled]="saving()" (click)="saveMed()">
            @if (saving()) { <span class="md-spin" aria-hidden="true"></span> Saving… }
            @else { <mat-icon aria-hidden="true">check</mat-icon> {{ editingId() ? 'Save changes' : 'Add medication' }} }
          </button>
          <p class="md-sheet__foot"><mat-icon aria-hidden="true">lock</mat-icon> Stored privately under your account only.</p>
        </div>
      }
    </div>
  `,
})
export class MedsPage implements OnDestroy {
  private api = inject(Api);

  // ---- page state ----
  readonly loading = signal(true);
  readonly errored = signal(false);

  readonly window = signal<number>(30);
  readonly windows: readonly WindowOpt[] = [
    { value: 7, label: '7d' }, { value: 30, label: '30d' }, { value: 90, label: '90d' },
  ];

  // ---- meds ----
  readonly meds = signal<Medication[]>([]);
  /** Defensive: the repeater/length reads go through this so a transient null never throws. */
  readonly medList = computed<Medication[]>(() => this.meds() ?? []);
  readonly today = signal<string>(this.todayIso());
  readonly adherence = signal<AdherenceResponse | null>(null);
  readonly busyDose = signal<string | null>(null);

  readonly adherencePct = computed<number>(() => {
    const a = this.adherence();
    return a && a.scheduled > 0 ? Math.round(a.percent) : 0;
  });
  readonly adherenceLabel = computed<string>(() => {
    const a = this.adherence();
    return a && a.scheduled > 0 ? `${Math.round(a.percent)}%` : '—';
  });

  // ---- vitals ----
  readonly vitalKind = signal<VitalKind>(0);
  readonly readings = signal<VitalReading[]>([]);
  readonly readingList = computed<VitalReading[]>(() => this.readings() ?? []);
  readonly trend = signal<VitalTrend | null>(null);
  readonly logging = signal(false);
  readonly qv1 = signal<string>('');
  readonly qv2 = signal<string>('');

  // ---- insight ----
  readonly insight = signal<VitalsInsightResponse | null>(null);

  // ---- med sheet ----
  readonly medSheetOpen = signal(false);
  readonly editingId = signal<number | null>(null);
  readonly saving = signal(false);
  readonly sheetError = signal<string>('');
  readonly fName = signal('');
  readonly fDose = signal('');
  readonly fForm = signal<MedicationForm>(0);
  readonly fTimesPerDay = signal(1);
  readonly fReminders = signal(false);
  readonly fNotes = signal('');

  readonly formOptions: readonly { value: MedicationForm; label: string }[] = [
    { value: 0, label: 'Pill' }, { value: 1, label: 'Capsule' }, { value: 2, label: 'Tablet' },
    { value: 3, label: 'Liquid' }, { value: 4, label: 'Injection' }, { value: 5, label: 'Inhaler' },
    { value: 6, label: 'Topical' }, { value: 7, label: 'Drops' }, { value: 8, label: 'Other' },
  ];

  readonly vitalMetas: readonly VitalMeta[] = [
    { kind: 0, label: 'Blood pressure', short: 'BP', unit: 'mmHg', icon: 'cardiology', accent: '#ff5c6c', dual: true, placeholder1: '120', placeholder2: '80' },
    { kind: 1, label: 'Heart rate', short: 'HR', unit: 'bpm', icon: 'ecg_heart', accent: '#f2649a', dual: false, placeholder1: '64' },
    { kind: 2, label: 'Glucose', short: 'Glucose', unit: 'mg/dL', icon: 'water_drop', accent: '#3fd8d0', dual: false, placeholder1: '95' },
    { kind: 3, label: 'Temperature', short: 'Temp', unit: '°F', icon: 'thermostat', accent: '#f2b340', dual: false, placeholder1: '98.6' },
    { kind: 4, label: 'Oxygen saturation', short: 'SpO₂', unit: '%', icon: 'spa', accent: '#5ba3ff', dual: false, placeholder1: '98' },
    { kind: 5, label: 'Body weight', short: 'Weight', unit: 'lb', icon: 'monitor_weight', accent: '#8b7cff', dual: false, placeholder1: '165' },
  ];

  readonly activeMeta = computed<VitalMeta>(() =>
    this.vitalMetas.find((m) => m.kind === this.vitalKind()) ?? this.vitalMetas[0]);

  /** An ILLUSTRATIVE oldest→newest line of the active kind's readings (own data only). */
  readonly chartOption = computed<EChartsOption>(() => {
    const meta = this.activeMeta();
    const rows = [...this.readingList()].reverse(); // API is newest-first; chart oldest→newest
    const dates = rows.map((r) => this.shortDate(r.localDate));
    const v1 = rows.map((r) => r.value1);
    const series: EChartsOption['series'] = [{
      name: meta.dual ? 'Systolic' : meta.label, type: 'line', smooth: true, showSymbol: rows.length <= 30,
      data: v1, lineStyle: { width: 2.5 }, areaStyle: { opacity: 0.1 },
    }];
    if (meta.dual) {
      (series as unknown[]).push({
        name: 'Diastolic', type: 'line', smooth: true, showSymbol: rows.length <= 30,
        data: rows.map((r) => r.value2 ?? null), lineStyle: { width: 2 },
      });
    }
    return {
      grid: { left: 44, right: 16, top: 24, bottom: 28 },
      legend: meta.dual ? { top: 0, right: 0 } : undefined,
      xAxis: { type: 'category', data: dates, boundaryGap: false },
      yAxis: { type: 'value', scale: true },
      series,
    };
  });

  constructor() {
    void this.reload();
  }

  ngOnDestroy(): void {}

  // ============================================================== loading

  async reload(): Promise<void> {
    this.loading.set(true);
    this.errored.set(false);
    try {
      const [medsRes, adh, vitals] = await Promise.all([
        firstValueFrom(this.api.meds()),
        firstValueFrom(this.api.medsAdherence(this.window())),
        firstValueFrom(this.api.vitals(this.vitalKind(), this.window())),
      ]);
      this.applyMeds(medsRes);
      this.adherence.set(adh);
      this.applyVitals(vitals);
    } catch {
      this.errored.set(true);
    } finally {
      this.loading.set(false);
    }
    if (!this.errored()) void this.loadInsight();
  }

  private applyMeds(res: MedsResponse): void {
    this.meds.set(res.medications);
    this.today.set(res.today);
  }

  private applyVitals(res: VitalsResponse): void {
    this.readings.set(res.readings);
    this.trend.set(res.trend);
  }

  private async loadInsight(): Promise<void> {
    try {
      this.insight.set(await firstValueFrom(this.api.vitalsInsight(this.window())));
    } catch {
      this.insight.set(null);
    }
  }

  setWindow(value: number): void {
    if (this.window() === value) return;
    this.window.set(value);
    void this.reload();
  }

  // ============================================================== meds: doses

  async markDose(med: Medication, slot: DoseSlot, status: MedicationLogStatus): Promise<void> {
    const key = this.doseKey(med.id, slot.slot);
    if (this.busyDose() === key) return;
    // Tapping the active status again clears it back to unlogged-ish by re-sending the opposite is noisy;
    // instead just (re)send the chosen status (idempotent upsert server-side).
    this.busyDose.set(key);
    const body: LogDoseInput = { date: this.today(), slot: slot.slot, status };
    try {
      const log = await firstValueFrom(this.api.logDose(med.id, body));
      // optimistic-ish: patch the slot in place
      this.meds.update((list) => list.map((m) => m.id !== med.id ? m : {
        ...m,
        todaySlots: m.todaySlots.map((s) => s.slot !== slot.slot ? s
          : { ...s, status: log.status, logId: log.id }),
      }));
      // refresh adherence (deterministic) in the background
      void this.refreshAdherence();
    } catch {
      // silent; the next reload will reconcile
    } finally {
      this.busyDose.set(null);
    }
  }

  private async refreshAdherence(): Promise<void> {
    try {
      this.adherence.set(await firstValueFrom(this.api.medsAdherence(this.window())));
    } catch { /* keep prior */ }
  }

  // ============================================================== meds: sheet

  openAddMed(): void {
    this.editingId.set(null);
    this.sheetError.set('');
    this.fName.set('');
    this.fDose.set('');
    this.fForm.set(0);
    this.fTimesPerDay.set(1);
    this.fReminders.set(false);
    this.fNotes.set('');
    this.medSheetOpen.set(true);
  }

  openEditMed(m: Medication): void {
    this.editingId.set(m.id);
    this.sheetError.set('');
    this.fName.set(m.name);
    this.fDose.set(m.dose);
    this.fForm.set(m.form ?? 0);
    this.fTimesPerDay.set(Math.max(1, m.schedule.timesPerDay));
    this.fReminders.set(m.remindersEnabled);
    this.fNotes.set(m.notes ?? '');
    this.medSheetOpen.set(true);
  }

  closeMedSheet(): void {
    if (this.saving()) return;
    this.medSheetOpen.set(false);
  }

  bumpTimes(delta: number): void {
    this.fTimesPerDay.update((n) => Math.min(12, Math.max(1, n + delta)));
  }

  async saveMed(): Promise<void> {
    if (this.saving()) return;
    const name = this.fName().trim();
    if (!name) { this.sheetError.set('A medication name is required.'); return; }
    this.sheetError.set('');
    this.saving.set(true);
    const input: MedicationInput = {
      name,
      dose: this.fDose().trim(),
      schedule: { timesPerDay: this.fTimesPerDay(), timesOfDay: [], daysOfWeek: [] },
      form: this.fForm(),
      notes: this.fNotes().trim() || null,
      remindersEnabled: this.fReminders(),
    };
    try {
      const id = this.editingId();
      if (id != null) await firstValueFrom(this.api.updateMed(id, input));
      else await firstValueFrom(this.api.addMed(input));
      this.medSheetOpen.set(false);
      const [medsRes, adh] = await Promise.all([
        firstValueFrom(this.api.meds()),
        firstValueFrom(this.api.medsAdherence(this.window())),
      ]);
      this.applyMeds(medsRes);
      this.adherence.set(adh);
    } catch (e) {
      this.sheetError.set(this.messageOf(e, "Couldn't save that — try again."));
    } finally {
      this.saving.set(false);
    }
  }

  async deactivate(m: Medication): Promise<void> {
    if (typeof confirm === 'function' &&
        !confirm(`Deactivate ${m.name}? It stops appearing in your daily checklist.`)) return;
    try {
      await firstValueFrom(this.api.deleteMed(m.id));
      this.meds.update((list) => list.filter((x) => x.id !== m.id));
      void this.refreshAdherence();
    } catch { /* keep */ }
  }

  // ============================================================== vitals

  selectVitalKind(kind: VitalKind): void {
    if (this.vitalKind() === kind) return;
    this.vitalKind.set(kind);
    this.qv1.set('');
    this.qv2.set('');
    void this.refreshVitals();
  }

  private async refreshVitals(): Promise<void> {
    try {
      this.applyVitals(await firstValueFrom(this.api.vitals(this.vitalKind(), this.window())));
    } catch { /* keep */ }
  }

  async quickLogVital(): Promise<void> {
    if (this.logging()) return;
    const meta = this.activeMeta();
    const v1 = Number(this.qv1());
    if (!this.qv1().trim() || Number.isNaN(v1)) { return; }
    const v2raw = this.qv2().trim();
    const input: VitalInput = {
      kind: meta.kind,
      value1: v1,
      value2: meta.dual && v2raw ? Number(v2raw) : null,
      unit: meta.unit,
      localDate: this.todayIso(),
    };
    this.logging.set(true);
    try {
      await firstValueFrom(this.api.addVital(input));
      this.qv1.set('');
      this.qv2.set('');
      await this.refreshVitals();
      void this.loadInsight();
    } catch { /* silent */ } finally {
      this.logging.set(false);
    }
  }

  async deleteReading(r: VitalReading): Promise<void> {
    try {
      await firstValueFrom(this.api.deleteVital(r.id));
      await this.refreshVitals();
      void this.loadInsight();
    } catch { /* keep */ }
  }

  // ============================================================== view helpers

  doseKey(medId: number, slot: number): string { return `${medId}:${slot}`; }
  statusKey(s: MedicationLogStatus | null): string {
    return s === 0 ? 'taken' : s === 1 ? 'skipped' : s === 2 ? 'missed' : 'open';
  }

  formIcon(form: MedicationForm | null): string {
    switch (form) {
      case 3: return 'water_drop';      // Liquid
      case 4: return 'vaccines';        // Injection
      case 5: return 'air';             // Inhaler
      case 6: return 'healing';         // Topical
      case 7: return 'opacity';         // Drops
      default: return 'medication';
    }
  }

  scheduleLabel(m: Medication): string {
    const n = m.schedule.timesPerDay;
    if (m.schedule.timesOfDay.length) return m.schedule.timesOfDay.join(' · ');
    return n === 1 ? 'Once daily' : `${n}× daily`;
  }

  readingValue(r: VitalReading): string {
    return r.value2 != null ? `${this.fmt(r.value1)}/${this.fmt(r.value2)}` : this.fmt(r.value1);
  }

  fmt(n: number): string {
    return Number.isInteger(n) ? String(n) : (Math.round(n * 10) / 10).toString();
  }

  friendlyDate(iso: string): string {
    const d = this.parseIso(iso);
    return d ? d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) : iso;
  }

  shortDate(iso: string): string {
    const d = this.parseIso(iso);
    return d ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : iso;
  }

  private parseIso(iso: string): Date | null {
    if (!iso) return null;
    const d = new Date(`${iso}T00:00:00`);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  private todayIso(): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  private messageOf(e: unknown, fallback: string): string {
    const msg = (e as { error?: { message?: string } })?.error?.message;
    return typeof msg === 'string' && msg ? msg : fallback;
  }
}
