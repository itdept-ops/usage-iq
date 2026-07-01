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
  MedicationLogStatus, MedsResponse, RepeatDosesRequest, VitalInput, VitalKind, VitalReading,
  VitalsInsightResponse, VitalsResponse, VitalTrend,
} from '../../core/models';
import { ChartComponent } from '../../shared/chart';
import {
  BetaPullRefresh, BetaBottomSheet, BetaSkeleton, BetaFab, BetaToaster, ToastController,
  BetaSvgRing, BetaSegmentedControl, BetaEmptyState, BetaErrorState, type Segment,
} from '../beta-ui';

interface VitalMeta {
  kind: VitalKind;
  label: string;
  short: string;
  unit: string;
  icon: string;
  accent: string;
  dual: boolean;
  placeholder1: string;
  placeholder2?: string;
}

/**
 * Meds & Vitals — the MOBILE twin of the live `/meds` desktop page, rebuilt on the shared beta-ui "Strata"
 * kit (`@use '../beta-ui/beta-kit'`). One signature accent (a clinical TEAL → INDIGO ramp) re-skins the whole
 * screen via the per-page accent contract. PRIVATE, OWNER-ONLY, NON-MEDICAL:
 *
 *  • an adherence RING + today's per-dose checklist (tap Taken / Skip), with an add/edit medication
 *    {@link BetaBottomSheet} (name · dose · cadence · reminders);
 *  • a vital-kind picker, a quick-log tile, a per-kind trend mini-chart (the shared ECharts wrapper) +
 *    deterministic avg/min/max, and a readings list;
 *  • an OPTIONAL floored ✨ insight card (tracker.ai) over AGGREGATE stats with a NON-MEDICAL disclaimer.
 *
 * DATA PARITY + PRIVACY: every read/write reuses the SAME owner-scoped, tracker.self-gated `/api/meds` +
 * `/api/vitals` endpoints the desktop page uses (adherence + trends are deterministic; the insight ALWAYS
 * 200s). Nothing here is shared to a coach / family / contact, and it appears in no activity feed.
 *
 * ISOLATION: gated by `platform.mobile` + the SAME `tracker.self`; imports only the kit + shared Api/models.
 * No live page is imported or modified.
 */
@Component({
  selector: 'app-meds-mobile',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [ToastController],
  imports: [
    FormsModule, MatIconModule, ChartComponent,
    BetaPullRefresh, BetaBottomSheet, BetaSkeleton, BetaFab, BetaToaster, BetaSvgRing, BetaSegmentedControl,
    BetaEmptyState, BetaErrorState,
  ],
  template: `
    <app-bs-pull-refresh class="mv-ptr" [busy]="refreshing()" (refresh)="reload()">
      <div class="mv-scroll" aria-live="polite">

        <!-- ─── HERO ─── -->
        <header class="mv-hero">
          <p class="mv-hero__kicker"><mat-icon aria-hidden="true">medication</mat-icon> Meds &amp; Vitals</p>
          <h1 class="mv-hero__title">Your private health log</h1>
          <p class="mv-hero__sub"><mat-icon aria-hidden="true">lock</mat-icon> Only you ever see this — not medical advice.</p>
        </header>

        @if (loading()) {
          <app-bs-skeleton height="92px" radius="var(--r-tile)" />
          <app-bs-skeleton height="150px" radius="var(--r-tile)" />
          <app-bs-skeleton height="220px" radius="var(--r-tile)" />
        } @else if (errored()) {
          <app-bs-error
            icon="cloud_off"
            title="Couldn't load your log"
            body="Something went wrong. Give it another go."
            (retry)="reload()" />
        } @else {

          <!-- ─── OPTIONAL ✨ INSIGHT ─── -->
          @if (insight(); as ins) {
            @if (ins.note) {
            <section class="mv-insight" [class.is-ai]="!ins.fellBackToPlain" aria-label="Private insight">
              <p class="mv-insight__kicker">
                @if (!ins.fellBackToPlain) { <mat-icon aria-hidden="true">auto_awesome</mat-icon> AI read }
                @else { <mat-icon aria-hidden="true">summarize</mat-icon> Your summary }
              </p>
              <p class="mv-insight__text">{{ ins.note }}</p>
              <p class="mv-insight__foot"><mat-icon aria-hidden="true">health_and_safety</mat-icon>
                Your aggregate numbers only — non-diagnostic.</p>
            </section>
            }
          }

          <!-- ─── ADHERENCE RING ─── -->
          <section class="mv-adh" aria-label="Adherence">
            <app-bs-ring [value]="adherenceFraction()" [size]="92" [stroke]="9"
                         [label]="adherenceLabel() + ' adherence'">
              <div class="mv-adh__ctr">
                <span class="mv-adh__num">{{ adherenceLabel() }}</span>
              </div>
            </app-bs-ring>
            <div class="mv-adh__meta">
              <b><span class="mono-num">{{ adherence()?.taken ?? 0 }}</span> / <span class="mono-num">{{ adherence()?.scheduled ?? 0 }}</span> doses</b>
              <i>over the last {{ window() }} days</i>
            </div>
          </section>

          <!-- ─── WINDOW ─── -->
          <app-bs-segmented class="mv-seg" [segments]="windowSegments" [value]="windowKey()"
                            label="Window" (change)="onWindow($event)" />

          <!-- ─── MEDS: today's checklist ─── -->
          <div class="mv-sec-row">
            <h2 class="mv-sec-h"><mat-icon aria-hidden="true">pill</mat-icon> Medications</h2>
            @if (medList().length > 0) {
              <button type="button" class="mv-repeat" [disabled]="repeating()"
                      (click)="repeatYesterday()" aria-label="Repeat yesterday's doses onto today">
                <mat-icon aria-hidden="true">event_repeat</mat-icon>
                {{ repeating() ? 'Pulling…' : 'Repeat yesterday' }}
              </button>
            }
          </div>
          @if (medList().length === 0) {
            <app-bs-empty compact
              icon="medication"
              title="No active meds"
              body="Tap + to add one and start a private dose checklist." />
          } @else {
            @for (m of medList(); track m.id) {
              <article class="mv-med">
                <div class="mv-med__bar">
                  <span class="mv-med__glyph" aria-hidden="true"><mat-icon>{{ formIcon(m.form) }}</mat-icon></span>
                  <div class="mv-med__txt">
                    <h3>{{ m.name }}</h3>
                    <p>{{ m.dose || '—' }} · {{ scheduleLabel(m) }}
                      @if (m.remindersEnabled) { · <mat-icon class="mv-bell" aria-hidden="true">notifications_active</mat-icon> }
                    </p>
                  </div>
                  <button type="button" class="mv-icon-btn" (click)="openEditMed(m)" aria-label="Edit medication">
                    <mat-icon aria-hidden="true">edit</mat-icon>
                  </button>
                  <button type="button" class="mv-icon-btn" (click)="deactivate(m)"
                          [attr.aria-label]="'Deactivate ' + m.name">
                    <mat-icon aria-hidden="true">delete_outline</mat-icon>
                  </button>
                </div>
                @if (m.todaySlots?.length) {
                  <div class="mv-doses">
                    @for (slot of m.todaySlots; track slot.slot) {
                      <div class="mv-dose" [attr.data-status]="statusKey(slot.status)">
                        <span class="mv-dose__when">{{ slot.time || ('Dose ' + (slot.slot + 1)) }}</span>
                        <div class="mv-dose__btns">
                          <button type="button" class="mv-dose__b is-take" [class.is-on]="slot.status === 0"
                                  [disabled]="busyDose() === doseKey(m.id, slot.slot)"
                                  (click)="markDose(m, slot, 0)" aria-label="Mark taken">
                            <mat-icon aria-hidden="true">check</mat-icon>
                          </button>
                          <button type="button" class="mv-dose__b is-skip" [class.is-on]="slot.status === 1"
                                  [disabled]="busyDose() === doseKey(m.id, slot.slot)"
                                  (click)="markDose(m, slot, 1)" aria-label="Mark skipped">
                            <mat-icon aria-hidden="true">close</mat-icon>
                          </button>
                        </div>
                      </div>
                    }
                  </div>
                } @else {
                  <p class="mv-med__none">No doses scheduled today.</p>
                }
              </article>
            }
          }

          <!-- ─── VITALS ─── -->
          <h2 class="mv-sec-h"><mat-icon aria-hidden="true">monitor_heart</mat-icon> Vitals</h2>
          <div class="mv-kinds" role="tablist" aria-label="Vital kind">
            @for (vm of vitalMetas; track vm.kind) {
              <button type="button" class="mv-kind" role="tab" [style.--accent]="vm.accent"
                      [class.is-on]="vitalKind() === vm.kind" [attr.aria-selected]="vitalKind() === vm.kind"
                      (click)="selectVitalKind(vm.kind)">
                <mat-icon aria-hidden="true">{{ vm.icon }}</mat-icon><span>{{ vm.short }}</span>
              </button>
            }
          </div>

          <section class="mv-vitals" [style.--accent]="activeMeta().accent">
            <!-- quick log -->
            <div class="mv-qlog">
              <div class="mv-qlog__row">
                <label class="mv-qlog__field">
                  <span class="mv-qlog__lbl">{{ activeMeta().dual ? 'Sys' : activeMeta().label }}</span>
                  <input class="mv-qlog__inp" type="number" inputmode="decimal" [(ngModel)]="qv1" name="qv1"
                         [placeholder]="activeMeta().placeholder1" />
                </label>
                @if (activeMeta().dual) {
                  <span class="mv-qlog__sep" aria-hidden="true">/</span>
                  <label class="mv-qlog__field">
                    <span class="mv-qlog__lbl">Dia</span>
                    <input class="mv-qlog__inp" type="number" inputmode="decimal" [(ngModel)]="qv2" name="qv2"
                           [placeholder]="activeMeta().placeholder2 || ''" />
                  </label>
                }
                <span class="mv-qlog__unit">{{ activeMeta().unit }}</span>
              </div>
              <button type="button" class="mv-qlog__btn" [disabled]="logging()" (click)="quickLogVital()">
                @if (logging()) { Logging… } @else { <mat-icon aria-hidden="true">add</mat-icon> Log {{ activeMeta().short }} }
              </button>
            </div>

            <!-- trend -->
            @if (trend() && trend()!.count > 0) {
              <div class="mv-stats">
                <div class="mv-stat"><b class="mono-num">{{ fmt(trend()!.avg) }}</b><i>avg</i></div>
                <div class="mv-stat"><b class="mono-num">{{ fmt(trend()!.min) }}</b><i>min</i></div>
                <div class="mv-stat"><b class="mono-num">{{ fmt(trend()!.max) }}</b><i>max</i></div>
                <div class="mv-stat"><b class="mono-num">{{ trend()!.count }}</b><i>readings</i></div>
              </div>
              <div class="mv-chart"><app-chart [option]="chartOption()" /></div>
            } @else {
              <app-bs-empty compact
                [icon]="activeMeta().icon"
                title="No readings yet"
                [body]="'No ' + activeMeta().label.toLowerCase() + ' readings yet. Log one above.'" />
            }

            <!-- readings -->
            @if (readingList().length) {
              <div class="mv-readings">
                @for (r of readingList(); track r.id) {
                  <div class="mv-reading">
                    <span class="mv-reading__orb" aria-hidden="true"><mat-icon>{{ activeMeta().icon }}</mat-icon></span>
                    <span class="mv-reading__v mono-num">{{ readingValue(r) }} <i>{{ r.unit }}</i></span>
                    <span class="mv-reading__d">{{ friendlyDate(r.localDate) }}</span>
                    <button type="button" class="mv-icon-btn" (click)="deleteReading(r)" aria-label="Delete reading">
                      <mat-icon aria-hidden="true">delete_outline</mat-icon>
                    </button>
                  </div>
                }
              </div>
            }
          </section>
        }
      </div>
    </app-bs-pull-refresh>

    @if (!loading() && !errored()) {
      <app-bs-fab icon="add" label="Add medication" [extended]="true" [fixed]="true" (action)="openAddMed()" />
    }

    <!-- ─── ADD/EDIT MEDICATION SHEET ─── -->
    <app-bs-sheet [(open)]="medSheetOpen" detent="full" [dismissable]="!saving()" label="Medication">
      <div class="ms">
        <div class="ms__head">
          <h3 class="ms__title">{{ editingId() ? 'Edit' : 'Add' }} medication</h3>
          <button type="button" class="ms__close" (click)="medSheetOpen.set(false)" aria-label="Close" [disabled]="saving()">
            <mat-icon aria-hidden="true">close</mat-icon>
          </button>
        </div>

        <label class="ms__field">
          <span class="ms__lbl">Name</span>
          <input class="ms__inp" [(ngModel)]="fName" name="fName" maxlength="120" placeholder="e.g. Atorvastatin" />
        </label>
        <div class="ms__row">
          <label class="ms__field">
            <span class="ms__lbl">Dose</span>
            <input class="ms__inp" [(ngModel)]="fDose" name="fDose" maxlength="60" placeholder="e.g. 10 mg" />
          </label>
          <label class="ms__field">
            <span class="ms__lbl">Form</span>
            <select class="ms__inp" [(ngModel)]="fForm" name="fForm">
              @for (f of formOptions; track f.value) { <option [ngValue]="f.value">{{ f.label }}</option> }
            </select>
          </label>
        </div>
        <label class="ms__field">
          <span class="ms__lbl">Doses per day</span>
          <div class="ms__stepper">
            <button type="button" (click)="bumpTimes(-1)" aria-label="Fewer">−</button>
            <span class="mono-num">{{ fTimesPerDay() }}</span>
            <button type="button" (click)="bumpTimes(1)" aria-label="More">+</button>
          </div>
        </label>
        <button type="button" class="ms__toggle" [class.is-on]="fReminders()" (click)="fReminders.set(!fReminders())">
          <mat-icon aria-hidden="true">{{ fReminders() ? 'notifications_active' : 'notifications_off' }}</mat-icon>
          <span class="ms__toggle-txt"><b>Dose reminders</b><i>A bell + push for an unlogged due dose.</i></span>
          <span class="mv-switch" [class.is-on]="fReminders()" aria-hidden="true"><span></span></span>
        </button>
        <label class="ms__field">
          <span class="ms__lbl">Notes <i>(optional)</i></span>
          <textarea class="ms__inp ms__area" rows="2" [(ngModel)]="fNotes" name="fNotes" maxlength="300"
                    placeholder="Anything to remember (private)"></textarea>
        </label>
        @if (sheetError()) { <p class="ms__err">{{ sheetError() }}</p> }
        <button type="button" class="ms__save" [disabled]="saving()" (click)="saveMed()">
          @if (saving()) { Saving… } @else { <mat-icon aria-hidden="true">check</mat-icon> {{ editingId() ? 'Save changes' : 'Add medication' }} }
        </button>
        @if (editingId()) {
          <button type="button" class="ms__danger" (click)="deactivate()">
            <mat-icon aria-hidden="true">delete_outline</mat-icon> Deactivate
          </button>
        }
        <p class="ms__foot"><mat-icon aria-hidden="true">lock</mat-icon> Stored privately under your account only.</p>
      </div>
    </app-bs-sheet>

    <app-bs-toaster />
  `,
  styleUrl: './meds-mobile.page.scss',
})
export class MedsMobilePage implements OnDestroy {
  private api = inject(Api);
  private toast = inject(ToastController);

  readonly loading = signal(true);
  readonly errored = signal(false);
  readonly refreshing = signal(false);

  readonly window = signal<number>(30);
  readonly windowSegments: Segment[] = [
    { key: '7', label: '7d' }, { key: '30', label: '30d' }, { key: '90', label: '90d' },
  ];
  readonly windowKey = computed(() => String(this.window()));

  readonly meds = signal<Medication[]>([]);
  readonly medList = computed<Medication[]>(() => this.meds() ?? []);
  readonly today = signal<string>(this.todayIso());
  readonly adherence = signal<AdherenceResponse | null>(null);
  readonly busyDose = signal<string | null>(null);
  /** "Repeat yesterday" in-flight latch (blocks a double-tap; the toaster carries the result). */
  readonly repeating = signal(false);

  readonly adherenceFraction = computed<number>(() => {
    const a = this.adherence();
    return a && a.scheduled > 0 ? Math.min(1, a.percent / 100) : 0;
  });
  readonly adherenceLabel = computed<string>(() => {
    const a = this.adherence();
    return a && a.scheduled > 0 ? `${Math.round(a.percent)}%` : '—';
  });

  readonly vitalKind = signal<VitalKind>(0);
  readonly readings = signal<VitalReading[]>([]);
  readonly readingList = computed<VitalReading[]>(() => this.readings() ?? []);
  readonly trend = signal<VitalTrend | null>(null);
  readonly logging = signal(false);
  readonly qv1 = signal<string>('');
  readonly qv2 = signal<string>('');

  readonly insight = signal<VitalsInsightResponse | null>(null);

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

  readonly chartOption = computed<EChartsOption>(() => {
    const meta = this.activeMeta();
    const rows = [...this.readingList()].reverse();
    const dates = rows.map((r) => this.shortDate(r.localDate));
    const series: EChartsOption['series'] = [{
      name: meta.dual ? 'Systolic' : meta.label, type: 'line', smooth: true,
      showSymbol: rows.length <= 20, data: rows.map((r) => r.value1),
      lineStyle: { width: 2.5 }, areaStyle: { opacity: 0.12 },
    }];
    if (meta.dual) {
      (series as unknown[]).push({
        name: 'Diastolic', type: 'line', smooth: true, showSymbol: rows.length <= 20,
        data: rows.map((r) => r.value2 ?? null), lineStyle: { width: 2 },
      });
    }
    return {
      grid: { left: 38, right: 12, top: 22, bottom: 24 },
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

  // ---- loading ----
  async reload(): Promise<void> {
    const wasLoaded = !this.loading();
    if (wasLoaded) this.refreshing.set(true); else this.loading.set(true);
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
      if (wasLoaded) {
        this.refreshing.set(false);
        if (!this.errored()) this.toast.show('Refreshed', { tone: 'success', durationMs: 1500 });
      }
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
    try { this.insight.set(await firstValueFrom(this.api.vitalsInsight(this.window()))); }
    catch { this.insight.set(null); }
  }

  onWindow(key: string): void {
    const v = Number(key);
    if (this.window() === v) return;
    this.window.set(v);
    void this.reload();
  }

  // ---- doses ----
  async markDose(med: Medication, slot: DoseSlot, status: MedicationLogStatus): Promise<void> {
    const key = this.doseKey(med.id, slot.slot);
    if (this.busyDose() === key) return;
    this.busyDose.set(key);
    const body: LogDoseInput = { date: this.today(), slot: slot.slot, status };
    try {
      const log = await firstValueFrom(this.api.logDose(med.id, body));
      this.meds.update((list) => list.map((m) => m.id !== med.id ? m : {
        ...m,
        todaySlots: m.todaySlots.map((s) => s.slot !== slot.slot ? s : { ...s, status: log.status, logId: log.id }),
      }));
      void this.refreshAdherence();
    } catch {
      this.toast.show("Couldn't log that — try again.", { tone: 'warn' });
    } finally {
      this.busyDose.set(null);
    }
  }

  private async refreshAdherence(): Promise<void> {
    try { this.adherence.set(await firstValueFrom(this.api.medsAdherence(this.window()))); }
    catch { /* keep */ }
  }

  /**
   * "Repeat yesterday": copy the caller's OWN dose logs from yesterday onto today so the daily checklist
   * arrives pre-filled. COPY not move + idempotent server-side (a (med, slot) already on today is skipped).
   * Re-pulls the day's checklist + adherence and toasts the outcome.
   */
  async repeatYesterday(): Promise<void> {
    if (this.repeating()) return;
    this.repeating.set(true);
    const body: RepeatDosesRequest = { fromDate: this.yesterdayIso(), toDate: this.today() };
    try {
      const out = await firstValueFrom(this.api.repeatDoses(body));
      const [medsRes, adh] = await Promise.all([
        firstValueFrom(this.api.meds()),
        firstValueFrom(this.api.medsAdherence(this.window())),
      ]);
      this.applyMeds(medsRes);
      this.adherence.set(adh);
      this.toast.show(
        out.copiedCount > 0 ? "Pulled in yesterday's doses" : 'Nothing to pull in',
        { tone: 'success', durationMs: 1800 },
      );
    } catch {
      this.toast.show("Couldn't repeat yesterday — try again.", { tone: 'warn' });
    } finally {
      this.repeating.set(false);
    }
  }

  // ---- med sheet ----
  openAddMed(): void {
    this.editingId.set(null);
    this.sheetError.set('');
    this.fName.set(''); this.fDose.set(''); this.fForm.set(0);
    this.fTimesPerDay.set(1); this.fReminders.set(false); this.fNotes.set('');
    this.medSheetOpen.set(true);
  }
  openEditMed(m: Medication): void {
    this.editingId.set(m.id);
    this.sheetError.set('');
    this.fName.set(m.name); this.fDose.set(m.dose); this.fForm.set(m.form ?? 0);
    this.fTimesPerDay.set(Math.max(1, m.schedule.timesPerDay));
    this.fReminders.set(m.remindersEnabled); this.fNotes.set(m.notes ?? '');
    this.medSheetOpen.set(true);
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
      name, dose: this.fDose().trim(),
      schedule: { timesPerDay: this.fTimesPerDay(), timesOfDay: [], daysOfWeek: [] },
      form: this.fForm(), notes: this.fNotes().trim() || null, remindersEnabled: this.fReminders(),
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
      this.toast.show('Saved', { tone: 'success', durationMs: 1600 });
    } catch (e) {
      this.sheetError.set(this.messageOf(e, "Couldn't save that — try again."));
    } finally {
      this.saving.set(false);
    }
  }

  /**
   * Deactivate a medication — one tap from either the med card (pass the row) or the edit sheet (no arg →
   * falls back to the editing id). Matches the desktop per-card deactivate action; confirms by name, drops
   * the row locally, refreshes adherence, and toasts.
   */
  async deactivate(med?: Medication): Promise<void> {
    const id = med?.id ?? this.editingId();
    if (id == null) return;
    const name = med?.name ?? this.meds().find((x) => x.id === id)?.name ?? 'this medication';
    if (typeof confirm === 'function' &&
        !confirm(`Deactivate ${name}? It stops appearing in your daily checklist.`)) return;
    try {
      await firstValueFrom(this.api.deleteMed(id));
      this.meds.update((list) => list.filter((x) => x.id !== id));
      if (this.editingId() === id) this.medSheetOpen.set(false);
      void this.refreshAdherence();
      this.toast.show('Deactivated', { tone: 'success', durationMs: 1600 });
    } catch {
      this.toast.show("Couldn't deactivate — try again.", { tone: 'warn' });
    }
  }

  // ---- vitals ----
  selectVitalKind(kind: VitalKind): void {
    if (this.vitalKind() === kind) return;
    this.vitalKind.set(kind);
    this.qv1.set(''); this.qv2.set('');
    void this.refreshVitals();
  }
  private async refreshVitals(): Promise<void> {
    try { this.applyVitals(await firstValueFrom(this.api.vitals(this.vitalKind(), this.window()))); }
    catch { /* keep */ }
  }

  async quickLogVital(): Promise<void> {
    if (this.logging()) return;
    const meta = this.activeMeta();
    const v1 = Number(this.qv1());
    if (!this.qv1().trim() || Number.isNaN(v1)) return;
    const v2raw = this.qv2().trim();
    const input: VitalInput = {
      kind: meta.kind, value1: v1,
      value2: meta.dual && v2raw ? Number(v2raw) : null,
      unit: meta.unit, localDate: this.today(),
    };
    this.logging.set(true);
    try {
      await firstValueFrom(this.api.addVital(input));
      this.qv1.set(''); this.qv2.set('');
      await this.refreshVitals();
      void this.loadInsight();
      this.toast.show('Reading logged', { tone: 'success', durationMs: 1500 });
    } catch {
      this.toast.show("Couldn't log that — try again.", { tone: 'warn' });
    } finally {
      this.logging.set(false);
    }
  }

  async deleteReading(r: VitalReading): Promise<void> {
    try {
      await firstValueFrom(this.api.deleteVital(r.id));
      await this.refreshVitals();
      void this.loadInsight();
    } catch {
      this.toast.show("Couldn't delete that — try again.", { tone: 'warn' });
    }
  }

  // ---- view helpers ----
  doseKey(medId: number, slot: number): string { return `${medId}:${slot}`; }
  statusKey(s: MedicationLogStatus | null): string {
    return s === 0 ? 'taken' : s === 1 ? 'skipped' : s === 2 ? 'missed' : 'open';
  }
  formIcon(form: MedicationForm | null): string {
    switch (form) {
      case 3: return 'water_drop';
      case 4: return 'vaccines';
      case 5: return 'air';
      case 6: return 'healing';
      case 7: return 'opacity';
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
  /** Yesterday relative to the SERVER's display-tz "today" (this.today()), so the repeat target matches the
   *  day the meds GET renders — not the browser clock (which can disagree across the UTC/display-tz boundary). */
  private yesterdayIso(): string {
    const d = this.parseIso(this.today()) ?? new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - 1);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  private messageOf(e: unknown, fallback: string): string {
    const msg = (e as { error?: { message?: string } })?.error?.message;
    return typeof msg === 'string' && msg ? msg : fallback;
  }
}
