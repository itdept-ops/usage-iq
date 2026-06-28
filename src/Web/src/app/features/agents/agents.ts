import { Component, computed, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { catchError, of } from 'rxjs';

import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';

import { Api } from '../../core/api';
import {
  ScheduledAgentDto,
  ScheduledAgentInput,
  AgentPreviewResult,
  AgentTestResult,
} from '../../core/models';

/** Static catalog metadata for one agent kind: the wire kind + how it presents in the UI. */
interface AgentMeta {
  /** Wire string value (the `{kind}` route param). */
  kind: string;
  label: string;
  icon: string;
  blurb: string;
  /** Which existing AI key (if any) powers the optional narrative — shown as a hint, not a gate here. */
  aiHint: string | null;
}

/** The four agent kinds, in display order. The AI hint mirrors the backend's existing-key gating. */
const AGENT_CATALOG: readonly AgentMeta[] = [
  {
    kind: 'morningBriefing',
    label: 'Morning briefing',
    icon: 'wb_sunny',
    blurb: "A daily rundown of today's events, lists and weather, delivered to your bell each morning.",
    aiHint: 'family.ai',
  },
  {
    kind: 'streakRescue',
    label: 'Streak rescue',
    icon: 'local_fire_department',
    blurb: "A late-day nudge if your 75-Hard tasks or water goal aren't done yet — so a streak never slips.",
    aiHint: null,
  },
  {
    kind: 'budgetAlert',
    label: 'Budget alert',
    icon: 'savings',
    blurb: 'A heads-up when bills or spending approach your budget, so nothing sneaks up on you.',
    aiHint: 'finance.ai',
  },
  {
    kind: 'lowStaples',
    label: 'Low staples',
    icon: 'shopping_basket',
    blurb: 'A reminder when household staples on your shopping lists run low — honoring your dietary needs.',
    aiHint: null,
  },
];

/** The 24 deliver-hour choices, pre-labelled in friendly 12-hour form. */
const HOURS: readonly { value: number; label: string }[] = Array.from({ length: 24 }, (_, h) => {
  const ampm = h < 12 ? 'AM' : 'PM';
  const twelve = h % 12 === 0 ? 12 : h % 12;
  return { value: h, label: `${twelve}:00 ${ampm}` };
});

/** Live, editable view of one agent: its saved DTO merged with the in-flight draft + per-row UI state. */
interface AgentRow extends AgentMeta {
  dto: ScheduledAgentDto;
  // draft (seeded from the dto; saved on toggle/picker change)
  enabled: boolean;
  deliverHour: number;
  /** Whether quiet-hours are set at all (both bounds present). Off ⇒ both bounds sent as null. */
  quietOn: boolean;
  quietStart: number;
  quietEnd: number;
  // per-row transient UI
  saving: boolean;
  preview: AgentPreviewResult | null;
  previewing: boolean;
  testing: boolean;
  testMsg: string | null;
  error: string | null;
}

/**
 * Proactive Agents (/agents) — manage the caller's OWN scheduled assistants. Four per-user agents run
 * server-side on a daily cadence and nudge via the in-app bell + opt-in web-push: a morning briefing, a
 * late-day streak rescue, a budget alert, and a low-staples reminder. Each row carries an enable toggle, a
 * deliver-hour, optional quiet-hours, a Preview (renders the deterministic floor NOW, never delivers) and a
 * Test (delivers one real one-off, untouching the idempotency stamps).
 *
 * PRIVACY + SCOPE: everything is self-scoped server-side (gated `agents.use`) — a prefs row only ever belongs
 * to the caller, and an agent only ever nudges the caller. AI narratives (briefing/budget) stay gated on the
 * EXISTING AI keys (family.ai / finance.ai); without them, the deterministic baseline is always returned.
 */
@Component({
  selector: 'app-agents',
  imports: [
    MatButtonModule,
    MatIconModule,
    MatProgressSpinnerModule,
    MatSlideToggleModule,
  ],
  templateUrl: './agents.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './agents.scss',
})
export class Agents {
  private api = inject(Api);

  readonly hours = HOURS;

  readonly rows = signal<AgentRow[]>([]);
  readonly loading = signal(true);
  readonly error = signal(false);

  constructor() {
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.error.set(false);
    this.api
      .agents()
      .pipe(
        catchError(() => {
          this.error.set(true);
          return of(null);
        }),
      )
      .subscribe((dtos) => {
        if (dtos) this.rows.set(this.merge(dtos));
        this.loading.set(false);
      });
  }

  /** Merge the server DTOs (one per kind) with the static catalog into editable rows, in catalog order. */
  private merge(dtos: ScheduledAgentDto[]): AgentRow[] {
    const byKind = new Map(dtos.map((d) => [d.kind, d]));
    return AGENT_CATALOG.map((meta) => {
      const dto =
        byKind.get(meta.kind) ??
        ({
          kind: meta.kind,
          enabled: false,
          deliverHourLocal: 7,
          quietStartLocalHour: null,
          quietEndLocalHour: null,
          timeZone: 'America/New_York',
        } satisfies ScheduledAgentDto);
      return this.seed(meta, dto);
    });
  }

  /** Build a row's editable draft from a (meta, dto) pair. */
  private seed(meta: AgentMeta, dto: ScheduledAgentDto): AgentRow {
    const quietOn = dto.quietStartLocalHour != null && dto.quietEndLocalHour != null;
    return {
      ...meta,
      dto,
      enabled: dto.enabled,
      deliverHour: dto.deliverHourLocal,
      quietOn,
      quietStart: dto.quietStartLocalHour ?? 22,
      quietEnd: dto.quietEndLocalHour ?? 7,
      saving: false,
      preview: null,
      previewing: false,
      testing: false,
      testMsg: null,
      error: null,
    };
  }

  // ---- per-row mutation (replace the row in the signal array immutably) ----

  private patch(kind: string, fn: (r: AgentRow) => AgentRow): void {
    this.rows.update((rs) => rs.map((r) => (r.kind === kind ? fn(r) : r)));
  }

  // ---- field handlers ----

  setEnabled(r: AgentRow, on: boolean): void {
    this.patch(r.kind, (x) => ({ ...x, enabled: on }));
    this.persist(r.kind);
  }

  setDeliverHour(r: AgentRow, value: string): void {
    this.patch(r.kind, (x) => ({ ...x, deliverHour: +value }));
    this.persist(r.kind);
  }

  setQuietOn(r: AgentRow, on: boolean): void {
    this.patch(r.kind, (x) => ({ ...x, quietOn: on }));
    this.persist(r.kind);
  }

  setQuietStart(r: AgentRow, value: string): void {
    this.patch(r.kind, (x) => ({ ...x, quietStart: +value }));
    this.persist(r.kind);
  }

  setQuietEnd(r: AgentRow, value: string): void {
    this.patch(r.kind, (x) => ({ ...x, quietEnd: +value }));
    this.persist(r.kind);
  }

  /** Persist the current draft for one kind (PUT). Quiet hours go as both-or-neither. */
  private persist(kind: string): void {
    const r = this.rows().find((x) => x.kind === kind);
    if (!r || r.saving) return;
    const body: ScheduledAgentInput = {
      enabled: r.enabled,
      deliverHourLocal: r.deliverHour,
      quietStartLocalHour: r.quietOn ? r.quietStart : null,
      quietEndLocalHour: r.quietOn ? r.quietEnd : null,
      timeZone: r.dto.timeZone ?? null,
    };
    this.patch(kind, (x) => ({ ...x, saving: true, error: null }));
    this.api
      .updateAgent(kind, body)
      .pipe(
        catchError((e) => {
          this.patch(kind, (x) => ({ ...x, error: this.messageOf(e, 'Could not save this agent.') }));
          return of(null);
        }),
      )
      .subscribe((dto) => {
        // Re-seed from the authoritative DTO so the UI reflects exactly what the server stored.
        this.patch(kind, (x) => (dto ? { ...this.seed(x, dto), preview: x.preview, testMsg: x.testMsg } : { ...x, saving: false }));
      });
  }

  // ---- Preview (deterministic floor NOW; never delivers) ----

  preview(r: AgentRow): void {
    if (r.previewing) return;
    this.patch(r.kind, (x) => ({ ...x, previewing: true, error: null, testMsg: null }));
    this.api
      .previewAgent(r.kind)
      .pipe(
        catchError((e) => {
          this.patch(r.kind, (x) => ({ ...x, error: this.messageOf(e, 'Could not render a preview.') }));
          return of(null);
        }),
      )
      .subscribe((res) => {
        this.patch(r.kind, (x) => ({ ...x, previewing: false, preview: res ?? x.preview }));
      });
  }

  // ---- Test (delivers one real one-off; does NOT touch idempotency stamps) ----

  test(r: AgentRow): void {
    if (r.testing) return;
    this.patch(r.kind, (x) => ({ ...x, testing: true, error: null, testMsg: null }));
    this.api
      .testAgent(r.kind)
      .pipe(
        catchError((e) => {
          this.patch(r.kind, (x) => ({ ...x, error: this.messageOf(e, 'Could not send a test.') }));
          return of(null);
        }),
      )
      .subscribe((res: AgentTestResult | null) => {
        this.patch(r.kind, (x) => ({
          ...x,
          testing: false,
          testMsg: res
            ? res.delivered
              ? 'Sent — check your bell.'
              : (res.message ?? 'Nothing to send right now.')
            : x.testMsg,
        }));
      });
  }

  // ---- display helpers ----

  hourLabel(h: number): string {
    return HOURS.find((x) => x.value === h)?.label ?? `${h}:00`;
  }

  readonly isEmpty = computed(() => !this.loading() && !this.error() && this.rows().length === 0);

  trackRow = (_: number, r: AgentRow) => r.kind;

  /** Pull the server's friendly `message` from an HttpErrorResponse, falling back to a default. */
  private messageOf(e: unknown, fallback: string): string {
    const msg = (e as { error?: { message?: string } })?.error?.message;
    return typeof msg === 'string' && msg ? msg : fallback;
  }
}
