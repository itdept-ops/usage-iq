import {
  ChangeDetectionStrategy, Component, inject, signal,
} from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { MatIconModule } from '@angular/material/icon';

import { Api } from '../../core/api';
import {
  ScheduledAgentDto, ScheduledAgentInput, AgentPreviewResult, AgentTestResult,
} from '../../core/models';
import {
  BetaPullRefresh, BetaBottomSheet, BetaSkeleton, BetaToaster, ToastController,
} from '../beta-ui';

/** Static catalog metadata for one agent kind. */
interface AgentMeta {
  kind: string;
  label: string;
  icon: string;
  blurb: string;
  aiHint: string | null;
}

/** The four agent kinds, in display order. */
const AGENT_CATALOG: readonly AgentMeta[] = [
  {
    kind: 'morningBriefing', label: 'Morning briefing', icon: 'wb_sunny',
    blurb: "Today's events, lists and weather — delivered each morning.", aiHint: 'family.ai',
  },
  {
    kind: 'streakRescue', label: 'Streak rescue', icon: 'local_fire_department',
    blurb: "A late-day nudge if today's tasks aren't done yet.", aiHint: null,
  },
  {
    kind: 'budgetAlert', label: 'Budget alert', icon: 'savings',
    blurb: 'A heads-up when spending approaches your budget.', aiHint: 'finance.ai',
  },
  {
    kind: 'lowStaples', label: 'Low staples', icon: 'shopping_basket',
    blurb: 'A reminder when household staples run low.', aiHint: null,
  },
];

/** The 24 deliver-hour choices, pre-labelled in friendly 12-hour form. */
const HOURS: readonly { value: number; label: string }[] = Array.from({ length: 24 }, (_, h) => {
  const ampm = h < 12 ? 'AM' : 'PM';
  const twelve = h % 12 === 0 ? 12 : h % 12;
  return { value: h, label: `${twelve}:00 ${ampm}` };
});

/** Live, editable view of one agent on mobile. */
interface AgentRow extends AgentMeta {
  dto: ScheduledAgentDto;
  enabled: boolean;
  deliverHour: number;
  quietOn: boolean;
  quietStart: number;
  quietEnd: number;
  saving: boolean;
  preview: AgentPreviewResult | null;
  previewing: boolean;
  testing: boolean;
}

/** Which value an open picker sheet is choosing for which row. */
interface PickerState {
  kind: string;
  field: 'deliver' | 'quietStart' | 'quietEnd';
  title: string;
}

/**
 * Proactive Agents — the mobile-first twin of the live /agents settings page ({@link Agents}), rebuilt on
 * the shared beta-ui "Strata" kit. One signature accent — a warm AMBER → ORANGE — re-skins the whole screen
 * via the per-page accent contract. An immersive header, then a card PER agent kind (morning briefing,
 * streak rescue, budget alert, low staples): a big tap-target enable toggle, a deliver-hour value row that
 * opens a {@link BetaBottomSheet} radio picker, an optional quiet-hours toggle + from/until pickers, and
 * Preview / Send-a-test buttons. Each change persists immediately (PUT) — no save bar needed.
 *
 * DATA PARITY + PRIVACY: every value comes straight from the SAME self-scoped endpoints the live page uses —
 * {@link Api.agents} / {@link Api.updateAgent} / {@link Api.previewAgent} / {@link Api.testAgent}. The server
 * enforces self-scoping + the existing-AI-key gating regardless. No email is ever shown here.
 *
 * ISOLATION: gated by `platform.mobile` + the SAME `agents.use` guard the live page carries; it consumes the
 * kit + the SAME Api/DTOs as the live counterpart. No live page is imported or modified.
 */
@Component({
  selector: 'app-agents-mobile',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [ToastController],
  imports: [
    MatIconModule,
    BetaPullRefresh, BetaBottomSheet, BetaSkeleton, BetaToaster,
  ],
  template: `
    <app-bs-pull-refresh class="ag-ptr" [busy]="refreshing()" [disabled]="loading()" (refresh)="reload()">
      <div class="ag-scroll" aria-live="polite">

        <!-- ─── IMMERSIVE HEADER ─── -->
        <header class="ag-hero">
          <div class="ag-hero__bloom" aria-hidden="true"></div>
          <p class="ag-hero__kicker"><mat-icon aria-hidden="true">smart_toy</mat-icon> Proactive</p>
          <h1 class="ag-hero__title">Agents</h1>
          <p class="ag-hero__sub">Per-you assistants that run on a schedule and nudge your bell — a morning
            briefing, streak rescue, budget alert and low-staples reminder. They only ever watch your own data.</p>
        </header>

        @if (loading()) {
          <div class="ag-list" aria-hidden="true">
            @for (n of skeletonCells; track n) {
              <app-bs-skeleton height="132px" radius="var(--r-tile)" />
            }
          </div>

        } @else if (errored()) {
          <div class="ag-state">
            <span class="ag-state__orb"><mat-icon aria-hidden="true">cloud_off</mat-icon></span>
            <h2 class="ag-state__title">Couldn't load agents</h2>
            <p class="ag-state__body">Something went wrong fetching your agents. Give it another go.</p>
            <button type="button" class="ag-state__cta" (click)="reload()">
              <mat-icon aria-hidden="true">refresh</mat-icon> Try again
            </button>
          </div>

        } @else {
          @for (r of rows(); track r.kind) {
            <section class="ag-card" [class.is-off]="!r.enabled">
              <!-- title + enable toggle -->
              <button type="button" class="ag-row ag-row--toggle" [attr.aria-pressed]="r.enabled"
                      [disabled]="r.saving" (click)="toggleEnabled(r)">
                <span class="ag-row__ic" aria-hidden="true"><mat-icon>{{ r.icon }}</mat-icon></span>
                <span class="ag-row__body">
                  <span class="ag-row__label">{{ r.label }}</span>
                  <span class="ag-row__hint">{{ r.blurb }}</span>
                </span>
                <span class="ag-switch" [class.is-on]="r.enabled" aria-hidden="true">
                  <span class="ag-switch__knob"></span>
                </span>
              </button>

              @if (r.enabled) {
                <!-- deliver-hour -->
                <button type="button" class="ag-row ag-row--value" [disabled]="r.saving"
                        (click)="openPicker(r, 'deliver')">
                  <span class="ag-row__ic" aria-hidden="true"><mat-icon>schedule</mat-icon></span>
                  <span class="ag-row__body">
                    <span class="ag-row__label">Deliver at</span>
                    <span class="ag-row__hint">When this agent nudges you, in your timezone.</span>
                  </span>
                  <span class="ag-row__value">{{ hourLabel(r.deliverHour) }}</span>
                  <mat-icon class="ag-row__go" aria-hidden="true">chevron_right</mat-icon>
                </button>

                <!-- quiet-hours toggle -->
                <button type="button" class="ag-row ag-row--toggle" [attr.aria-pressed]="r.quietOn"
                        [disabled]="r.saving" (click)="toggleQuiet(r)">
                  <span class="ag-row__ic" aria-hidden="true"><mat-icon>bedtime</mat-icon></span>
                  <span class="ag-row__body">
                    <span class="ag-row__label">Quiet hours</span>
                    <span class="ag-row__hint">Hold nudges during a window (e.g. overnight).</span>
                  </span>
                  <span class="ag-switch" [class.is-on]="r.quietOn" aria-hidden="true">
                    <span class="ag-switch__knob"></span>
                  </span>
                </button>

                @if (r.quietOn) {
                  <button type="button" class="ag-row ag-row--value" [disabled]="r.saving"
                          (click)="openPicker(r, 'quietStart')">
                    <span class="ag-row__ic" aria-hidden="true"><mat-icon>nightlight</mat-icon></span>
                    <span class="ag-row__body"><span class="ag-row__label">Quiet from</span></span>
                    <span class="ag-row__value">{{ hourLabel(r.quietStart) }}</span>
                    <mat-icon class="ag-row__go" aria-hidden="true">chevron_right</mat-icon>
                  </button>
                  <button type="button" class="ag-row ag-row--value" [disabled]="r.saving"
                          (click)="openPicker(r, 'quietEnd')">
                    <span class="ag-row__ic" aria-hidden="true"><mat-icon>wb_twilight</mat-icon></span>
                    <span class="ag-row__body"><span class="ag-row__label">Quiet until</span></span>
                    <span class="ag-row__value">{{ hourLabel(r.quietEnd) }}</span>
                    <mat-icon class="ag-row__go" aria-hidden="true">chevron_right</mat-icon>
                  </button>
                }
              }

              @if (r.aiHint) {
                <p class="ag-card__ai"><mat-icon aria-hidden="true">auto_awesome</mat-icon>
                  AI summary uses your <code>{{ r.aiHint }}</code> access; a plain version is sent otherwise.</p>
              }

              <!-- preview + test -->
              <div class="ag-card__actions">
                <button type="button" class="ag-btn" [disabled]="r.previewing" (click)="preview(r)">
                  <mat-icon aria-hidden="true">visibility</mat-icon>
                  @if (r.previewing) { Rendering… } @else { Preview }
                </button>
                <button type="button" class="ag-btn ag-btn--accent" [disabled]="r.testing" (click)="test(r)">
                  <mat-icon aria-hidden="true">send</mat-icon>
                  @if (r.testing) { Sending… } @else { Test }
                </button>
              </div>

              @if (r.preview) {
                <div class="ag-preview">
                  <p class="ag-preview__head">
                    <mat-icon aria-hidden="true">visibility</mat-icon> Preview
                    @if (r.preview.fellBackToPlain) { <span class="ag-tag">Plain</span> }
                  </p>
                  <p class="ag-preview__text">{{ r.preview.text }}</p>
                </div>
              }
            </section>
          }
        }
      </div>
    </app-bs-pull-refresh>

    <!-- ─── PICKER BOTTOM SHEET ─── -->
    <app-bs-sheet [(open)]="pickerOpen" detent="half" [label]="picker()?.title ?? ''">
      <div class="ag-picker">
        <h3 class="ag-picker__title">{{ picker()?.title }}</h3>
        <ul class="ag-picker__list" role="radiogroup" [attr.aria-label]="picker()?.title">
          @for (h of hours; track h.value) {
            <li>
              <button type="button" class="ag-opt" role="radio" [attr.aria-checked]="h.value === pickerCurrent()"
                      [class.is-sel]="h.value === pickerCurrent()" (click)="choose(h.value)">
                <span class="ag-opt__label">{{ h.label }}</span>
                @if (h.value === pickerCurrent()) { <mat-icon class="ag-opt__check" aria-hidden="true">check</mat-icon> }
              </button>
            </li>
          }
        </ul>
      </div>
    </app-bs-sheet>

    <app-bs-toaster />
  `,
  styleUrl: './agents-mobile.page.scss',
})
export class AgentsMobilePage {
  private api = inject(Api);
  private toast = inject(ToastController);

  readonly hours = HOURS;
  readonly skeletonCells = Array.from({ length: 4 }, (_, i) => i);

  readonly rows = signal<AgentRow[]>([]);
  readonly loading = signal(true);
  readonly errored = signal(false);
  readonly refreshing = signal(false);

  readonly pickerOpen = signal(false);
  readonly picker = signal<PickerState | null>(null);

  constructor() {
    void this.reload();
  }

  // ─────────────── LOAD ───────────────

  async reload(): Promise<void> {
    const wasLoaded = !this.loading();
    if (wasLoaded) this.refreshing.set(true); else this.loading.set(true);
    this.errored.set(false);
    try {
      const dtos = await firstValueFrom(this.api.agents());
      this.rows.set(this.merge(dtos));
    } catch {
      this.errored.set(true);
    } finally {
      this.loading.set(false);
      if (wasLoaded) {
        this.refreshing.set(false);
        if (!this.errored()) this.toast.show('Agents refreshed', { tone: 'success', durationMs: 1600 });
      }
    }
  }

  private merge(dtos: ScheduledAgentDto[]): AgentRow[] {
    const byKind = new Map(dtos.map((d) => [d.kind, d]));
    return AGENT_CATALOG.map((meta) => {
      const dto =
        byKind.get(meta.kind) ??
        ({
          kind: meta.kind, enabled: false, deliverHourLocal: 7,
          quietStartLocalHour: null, quietEndLocalHour: null, timeZone: 'America/New_York',
        } satisfies ScheduledAgentDto);
      return this.seed(meta, dto);
    });
  }

  private seed(meta: AgentMeta, dto: ScheduledAgentDto): AgentRow {
    const quietOn = dto.quietStartLocalHour != null && dto.quietEndLocalHour != null;
    return {
      ...meta, dto,
      enabled: dto.enabled,
      deliverHour: dto.deliverHourLocal,
      quietOn,
      quietStart: dto.quietStartLocalHour ?? 22,
      quietEnd: dto.quietEndLocalHour ?? 7,
      saving: false,
      preview: null,
      previewing: false,
      testing: false,
    };
  }

  private patch(kind: string, fn: (r: AgentRow) => AgentRow): void {
    this.rows.update((rs) => rs.map((r) => (r.kind === kind ? fn(r) : r)));
  }

  hourLabel(h: number): string {
    return HOURS.find((x) => x.value === h)?.label ?? `${h}:00`;
  }

  // ─────────────── EDIT + PERSIST ───────────────

  toggleEnabled(r: AgentRow): void {
    this.patch(r.kind, (x) => ({ ...x, enabled: !x.enabled }));
    void this.persist(r.kind);
  }

  toggleQuiet(r: AgentRow): void {
    this.patch(r.kind, (x) => ({ ...x, quietOn: !x.quietOn }));
    void this.persist(r.kind);
  }

  private async persist(kind: string): Promise<void> {
    const r = this.rows().find((x) => x.kind === kind);
    if (!r) return;
    const body: ScheduledAgentInput = {
      enabled: r.enabled,
      deliverHourLocal: r.deliverHour,
      quietStartLocalHour: r.quietOn ? r.quietStart : null,
      quietEndLocalHour: r.quietOn ? r.quietEnd : null,
      timeZone: r.dto.timeZone ?? null,
    };
    this.patch(kind, (x) => ({ ...x, saving: true }));
    try {
      const dto = await firstValueFrom(this.api.updateAgent(kind, body));
      this.patch(kind, (x) => ({ ...this.seed(x, dto), preview: x.preview }));
    } catch (e) {
      this.toast.show(this.messageOf(e, "Couldn't save — try again"), { tone: 'warn' });
      this.patch(kind, (x) => ({ ...x, saving: false }));
    }
  }

  // ─────────────── PICKER ───────────────

  openPicker(r: AgentRow, field: PickerState['field']): void {
    const title = field === 'deliver' ? 'Deliver at' : field === 'quietStart' ? 'Quiet from' : 'Quiet until';
    this.picker.set({ kind: r.kind, field, title });
    this.pickerOpen.set(true);
  }

  /** The hour currently selected for the open picker (drives the radio check state). */
  pickerCurrent(): number | null {
    const p = this.picker();
    if (!p) return null;
    const r = this.rows().find((x) => x.kind === p.kind);
    if (!r) return null;
    return p.field === 'deliver' ? r.deliverHour : p.field === 'quietStart' ? r.quietStart : r.quietEnd;
  }

  choose(value: number): void {
    const p = this.picker();
    if (!p) return;
    this.patch(p.kind, (x) => {
      if (p.field === 'deliver') return { ...x, deliverHour: value };
      if (p.field === 'quietStart') return { ...x, quietStart: value };
      return { ...x, quietEnd: value };
    });
    this.pickerOpen.set(false);
    void this.persist(p.kind);
  }

  // ─────────────── PREVIEW + TEST ───────────────

  async preview(r: AgentRow): Promise<void> {
    if (r.previewing) return;
    this.patch(r.kind, (x) => ({ ...x, previewing: true }));
    try {
      const res = await firstValueFrom(this.api.previewAgent(r.kind));
      this.patch(r.kind, (x) => ({ ...x, preview: res }));
    } catch (e) {
      this.toast.show(this.messageOf(e, "Couldn't render a preview"), { tone: 'warn' });
    } finally {
      this.patch(r.kind, (x) => ({ ...x, previewing: false }));
    }
  }

  async test(r: AgentRow): Promise<void> {
    if (r.testing) return;
    this.patch(r.kind, (x) => ({ ...x, testing: true }));
    try {
      const res: AgentTestResult = await firstValueFrom(this.api.testAgent(r.kind));
      this.toast.show(
        res.delivered ? 'Sent — check your bell' : (res.message ?? 'Nothing to send right now'),
        { tone: res.delivered ? 'success' : 'warn', durationMs: 2200 },
      );
    } catch (e) {
      this.toast.show(this.messageOf(e, "Couldn't send a test"), { tone: 'warn' });
    } finally {
      this.patch(r.kind, (x) => ({ ...x, testing: false }));
    }
  }

  private messageOf(e: unknown, fallback: string): string {
    const msg = (e as { error?: { message?: string } })?.error?.message;
    return typeof msg === 'string' && msg ? msg : fallback;
  }
}
