import { Component, OnDestroy, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';

import { Api } from '../../core/api';
import { AuthService } from '../../core/auth';
import {
  CalendarEvent, CalendarEventInput, CalendarRecurrence, CalendarStatus, CycleOverlayMember, FamilyMemberEvents,
  FindTimeAiInterpreted, FindTimeConsideredMember, FindTimeSlot, HouseholdMember, PERM, ScheduleAiEvent,
  ScheduleImageFile,
} from '../../core/models';
import { downscaleToJpeg, readFileAsBase64 } from '../tracker/ai-image';
import { FamilyConfirmDialog, ConfirmData } from './confirm-dialog';
import { EventEditorDialog, EventEditorData, EventEditorResult } from './event-editor-dialog';
import { FindTimeData, FindTimeDialog, FindTimeResultSlot } from './find-time-dialog';

/* The Google OAuth code client (loaded via the GIS script in index.html). */
declare const google: any;

/** An event positioned within a single day of the week grid. */
interface DayEvent {
  ev: CalendarEvent;
  /** "h:mm a" local start (timed) or "All day". */
  timeLabel: string;
  /** True for a READ-ONLY family-overlay event (another member's), false for the caller's own editable event. */
  overlay: boolean;
  /** The owning member's display name (overlay only) — for the tooltip + a11y label; never an email. */
  memberName?: string;
  /** The overlay member's stable color (overlay only); the caller's own events use the default accent. */
  color?: string;
}

/** One sharing household member surfaced in the overlay legend (identity = userId + name; never an email). */
interface OverlayMember {
  userId: number;
  name: string;
  color: string;
}

/**
 * The PREDICTED cycle phase covering a single day, for the soft background layer. Identity is the member
 * NAME(s) only (never an email); `kind` is "period" or "fertile" (period wins when a day has both). Always
 * predicted + read-only — it tags a day cell so the template can paint a faint rose/teal wash + a "predicted"
 * tooltip/aria. Absent (undefined) on days no opted-in member predicts a phase.
 */
interface CyclePhaseDay {
  /** "period" (faint rose) beats "fertile" (faint teal) when a day is covered by both. */
  kind: 'period' | 'fertile';
  /** Distinct opted-in member display names covering this day (for the tooltip/aria); never an email. */
  names: string[];
}

/** One AI-proposed event the family member can confirm/edit before it's created on their calendar. */
interface ProposedEvent {
  ai: ScheduleAiEvent;
  /** A friendly "Tue, Jun 23 · 4:00 – 5:00 PM" (or "All day") when-label in the viewer's local zone. */
  whenLabel: string;
  /** A short repeat label ("Every week") or '' for a one-off — drives the recurrence chip. */
  repeatLabel: string;
  /** True while THIS card's "Add to calendar" is creating the event. */
  saving: boolean;
}

/** One column of the week view: its date + the events that fall on it (all-day first, then by start). */
interface DayColumn {
  date: Date;
  iso: string;            // "YYYY-MM-DD" local
  weekdayLabel: string;   // "Sun"
  dayNum: number;         // 1..31
  isToday: boolean;
  events: DayEvent[];
  /** The predicted cycle phase covering this day (soft background layer), or undefined when none. */
  cyclePhase?: CyclePhaseDay;
}

/** One cell of the month grid (6×7): a day with its events, truncated with a "+N more" overflow. */
interface MonthCell {
  date: Date;
  iso: string;            // "YYYY-MM-DD" local
  dayNum: number;         // 1..31
  isToday: boolean;
  /** True for days inside the visible month; false for leading/trailing days from adjacent months. */
  inMonth: boolean;
  /** The first few events shown in the cell (all-day first, then by start). */
  events: DayEvent[];
  /** How many further events are hidden ("+N more"). 0 when nothing overflows. */
  moreCount: number;
  /** The predicted cycle phase covering this day (soft background layer), or undefined when none. */
  cyclePhase?: CyclePhaseDay;
}

type ViewMode = 'week' | 'agenda' | 'month';

/**
 * Family Hub F6 — the family calendar. Until the caller connects their Google Calendar we show a warm
 * "Connect" panel (or a gentle "not set up on the server yet" note when the server has no OAuth secret).
 * Connecting uses Google Identity Services' OAuth CODE client (offline access, minimal calendar.events
 * scope); the one-time code is POSTed to the server, which stores an encrypted refresh token — the secret
 * and token never touch the client.
 *
 * Once connected: a week grid + an agenda list of the caller's OWN events for the visible range, with
 * prev/next/today navigation and a today marker. Create an event (title, date, time or all-day, location,
 * notes); click one to edit or delete. Mobile-friendly; reuses the family design tokens. No other-person
 * identity is ever rendered.
 */
@Component({
  selector: 'app-family-calendar',
  imports: [
    FormsModule, RouterLink, MatIconModule, MatButtonModule, MatButtonToggleModule, MatTooltipModule,
    MatProgressSpinnerModule, MatFormFieldModule, MatInputModule, MatSnackBarModule,
  ],
  templateUrl: './calendar.html',
  styleUrls: ['./family.scss', './calendar.scss'],
})
export class FamilyCalendar implements OnDestroy {
  private api = inject(Api);
  private auth = inject(AuthService);
  private dialog = inject(MatDialog);
  private snack = inject(MatSnackBar);

  /** AI gating: schedule-from-text is generative and needs family.ai (else the server 403s); the image/PDF
   *  "upload a schedule" additionally needs ai.vision. Hide what the caller can't use so we never surface a
   *  control that errors. (The family-member preset grants both; a partial grant gets the right subset.) */
  readonly canScheduleAi = computed(() => { this.auth.permissions(); return this.auth.hasPermission(PERM.familyAi); });
  readonly canUploadSchedule = computed(() => {
    this.auth.permissions();
    return this.auth.hasPermission(PERM.familyAi) && this.auth.hasPermission(PERM.aiVision);
  });

  /** Auto-poll cadence while connected + the tab is visible. */
  private static readonly POLL_MS = 60_000;

  /** null while the initial status check is in flight. */
  readonly status = signal<CalendarStatus | null>(null);
  readonly loadingStatus = signal(true);
  readonly statusError = signal(false);
  readonly connecting = signal(false);

  readonly events = signal<CalendarEvent[]>([]);
  readonly loadingEvents = signal(false);
  readonly eventsError = signal(false);

  /** Household members for the Find-a-time picker (avatar + name only; never an email). */
  readonly members = signal<HouseholdMember[]>([]);

  readonly view = signal<ViewMode>('week');

  /** The Sunday (local midnight) that anchors the visible week (week + agenda views). */
  readonly weekStart = signal<Date>(this.sundayOf(new Date()));

  /** The first-of-month (local midnight) that anchors the visible month grid (month view). */
  readonly monthStart = signal<Date>(this.firstOfMonth(new Date()));

  // ---- Family overlay (other members' shared events, color-coded + read-only) ----
  /** Raw per-member shared events for the visible range (only opted-in + connected members appear). */
  readonly familyEvents = signal<FamilyMemberEvents[]>([]);
  /** Whether the overlay is shown (the legend toggle). Persisted in-session only. */
  readonly showOverlay = signal(true);
  /** True while the caller's "Share my calendar" opt-in PATCH is in flight (disables the toggle). */
  readonly sharingBusy = signal(false);

  /** A small, stable palette for per-member overlay colors (assigned by sorted-userId order). */
  private static readonly OVERLAY_PALETTE = [
    '#f59e0b', '#a855f7', '#ec4899', '#10b981', '#3b82f6', '#ef4444', '#14b8a6', '#f97316',
  ];

  /** userId → overlay color, stable across renders (derived from the sharing members, sorted by userId). */
  readonly overlayMembers = computed<OverlayMember[]>(() => {
    const sorted = [...this.familyEvents()].sort((a, b) => a.userId - b.userId);
    return sorted.map((m, i) => ({
      userId: m.userId,
      name: m.name,
      color: FamilyCalendar.OVERLAY_PALETTE[i % FamilyCalendar.OVERLAY_PALETTE.length],
    }));
  });

  // ---- Cycle overlay (opted-in members' PREDICTED period/fertile phases, soft read-only background) ----
  /** Raw per-member predicted phase spans for the visible range (only opted-in members appear). */
  readonly cyclePhases = signal<CycleOverlayMember[]>([]);
  /** Whether the predicted-phase background layer is shown (its own toggle). In-session only. */
  readonly showCyclePhases = signal(true);

  /** True when at least one opted-in member shares a PAINTABLE predicted phase (period/fertile) — gates the
   *  cycle toggle/legend so it never appears when nothing would actually paint. */
  readonly hasCyclePhases = computed<boolean>(() =>
    this.cyclePhases().some(m => (m.phases ?? []).some(p => p.kind === 'period' || p.kind === 'fertile')));

  /** The caller's calendar-share opt-in (mirrors status.shareHousehold); drives the share toggle state. */
  readonly shareHousehold = computed<boolean>(() => this.status()?.shareHousehold === true);

  /** Epoch ms of the last successful events fetch (null = never). Drives the "updated Xm ago" hint. */
  readonly lastUpdated = signal<number | null>(null);
  /** A ticking clock (epoch ms) so the relative "updated" label re-renders without a new fetch. */
  private readonly nowTick = signal<number>(Date.now());

  // ---- Schedule with AI ----
  /** The free-text scheduling box ("soccer every Tuesday at 4pm"). */
  readonly aiText = signal('');
  readonly aiBusy = signal(false);
  /** A friendly status line for the AI box (aria-live), e.g. an error or "couldn't find an event". */
  readonly aiStatus = signal('');
  /** The AI-proposed events awaiting the user's confirmation. */
  readonly proposals = signal<ProposedEvent[]>([]);
  /** True while "Add all" is bulk-creating proposals (disables every per-card button + the AI boxes). */
  readonly addingAll = signal(false);

  // ---- 📄 Upload a schedule (extract events from an image / PDF) ----
  /** True while a chosen image/PDF schedule is being prepared + sent for extraction. */
  readonly uploadBusy = signal(false);
  /** True while a file is being dragged over the drop zone (drives the highlight). */
  readonly uploadDragOver = signal(false);

  /** Accepted upload mimes (mirrors the endpoint's scoped allowlist: images + PDF). */
  private static readonly UPLOAD_ACCEPT = 'image/jpeg,image/png,image/webp,application/pdf';
  /** Max files per upload (mirrors the endpoint cap). */
  private static readonly UPLOAD_MAX_FILES = 5;
  /** Per-PDF decoded cap (~10 MB; mirrors the endpoint's MaxSchedulePdfBytes). */
  private static readonly UPLOAD_MAX_PDF_BYTES = 10 * 1024 * 1024;

  // ---- ✨ Best time for X (AI free-text → find-time form → candidate slots) ----
  /** The free-text "best time" box ("a 45-min slot for the dentist next week, mornings"). */
  readonly bestText = signal('');
  readonly bestBusy = signal(false);
  /** A friendly status line for the best-time box (aria-live), e.g. an error or "no openings". */
  readonly bestStatus = signal('');
  /** What the AI understood (duration + window + hours) — shown above the slots. null until a search runs. */
  readonly bestInterpreted = signal<FindTimeAiInterpreted | null>(null);
  /** The candidate slots the deterministic engine found for the parsed request. */
  readonly bestSlots = signal<FindTimeSlot[]>([]);
  /** Members considered but not connected — surfaced as a gentle note (their availability is unknown). */
  readonly bestNotConnected = signal<FindTimeConsideredMember[]>([]);
  /** True after a search returns and NOBODY considered was connected (warm "no one's connected yet"). */
  readonly bestNoneConnected = signal(false);

  /** A friendly "here's what I understood" line from the interpreted find-time form. */
  readonly bestUnderstood = computed<string>(() => {
    const i = this.bestInterpreted();
    if (!i) return '';
    const dur = this.durationLabel(i.durationMinutes);
    const window = this.windowLabel(i.fromUtc, i.toUtc);
    const hours = `${this.hourLabel(i.dayStartHourLocal)}–${this.hourLabel(i.dayEndHourLocal)}`;
    return `Looking for a ${dur} slot ${window}, between ${hours}.`;
  });

  readonly connected = computed(() => this.status()?.connected === true);
  readonly configured = computed(() => this.status()?.configured !== false);

  /** A tiny "updated just now / Xm ago" hint for the refresh control. '' until the first load. */
  readonly updatedLabel = computed<string>(() => {
    const at = this.lastUpdated();
    if (at === null) return '';
    const secs = Math.max(0, Math.round((this.nowTick() - at) / 1000));
    if (secs < 45) return 'updated just now';
    const mins = Math.round(secs / 60);
    if (mins < 60) return `updated ${mins}m ago`;
    const hrs = Math.round(mins / 60);
    return `updated ${hrs}h ago`;
  });

  /**
   * A "YYYY-MM-DD" → DayEvent[] map of the caller's OWN events plus (when the overlay is on) every sharing
   * member's read-only events, color-coded per member. Recomputed whenever the events, the family overlay,
   * the toggle, or the member→color mapping change.
   */
  private readonly eventsByDay = computed<Map<string, DayEvent[]>>(() => {
    const byDay = new Map<string, DayEvent[]>();
    const push = (iso: string, de: DayEvent) => {
      const arr = byDay.get(iso) ?? [];
      arr.push(de);
      byDay.set(iso, arr);
    };
    // The caller's own (editable) events.
    for (const ev of this.events()) {
      for (const iso of this.spannedDays(ev)) {
        push(iso, { ev, timeLabel: this.timeLabel(ev), overlay: false });
      }
    }
    // Other members' shared (read-only) events, color-coded — only when the overlay is shown.
    if (this.showOverlay()) {
      const colorOf = new Map(this.overlayMembers().map(m => [m.userId, m.color]));
      for (const member of this.familyEvents()) {
        const color = colorOf.get(member.userId);
        for (const item of member.events) {
          const ev = this.overlayToEvent(item, member.userId);
          for (const iso of this.spannedDays(ev)) {
            push(iso, { ev, timeLabel: this.timeLabel(ev), overlay: true, memberName: member.name, color });
          }
        }
      }
    }
    return byDay;
  });

  /**
   * A "YYYY-MM-DD" → CyclePhaseDay map of the PREDICTED period/fertile phases covering each day, merged across
   * every opted-in member (only when the cycle layer is shown). Period beats fertile when a day is covered by
   * both; the member names covering the day are collected for the tooltip/aria. Empty when nobody shares.
   */
  private readonly cyclePhaseByDay = computed<Map<string, CyclePhaseDay>>(() => {
    const byDay = new Map<string, CyclePhaseDay>();
    if (!this.showCyclePhases()) return byDay;
    // Accumulate member names PER KIND per day, so a day covered by both a period (member A) and a fertile
    // window (member B) surfaces only the WINNING kind's members — never misattributing B's fertile window
    // as a predicted period in the label/aria (cycle data is sensitive; accuracy matters).
    const acc = new Map<string, { period: string[]; fertile: string[] }>();
    for (const member of this.cyclePhases()) {
      for (const span of member.phases ?? []) {
        const kind = span.kind === 'period' ? 'period' : span.kind === 'fertile' ? 'fertile' : null;
        if (!kind) continue;
        for (const iso of this.spannedPhaseDays(span.start, span.end)) {
          let day = acc.get(iso);
          if (!day) { day = { period: [], fertile: [] }; acc.set(iso, day); }
          if (!day[kind].includes(member.name)) day[kind].push(member.name);
        }
      }
    }
    // Period beats fertile; surface only the winning kind's member names for that day.
    for (const [iso, day] of acc) {
      if (day.period.length) byDay.set(iso, { kind: 'period', names: day.period });
      else if (day.fertile.length) byDay.set(iso, { kind: 'fertile', names: day.fertile });
    }
    return byDay;
  });

  /** The seven day-columns of the visible week (Sun→Sat) with their events placed. */
  readonly days = computed<DayColumn[]>(() => {
    const start = this.weekStart();
    const todayIso = this.toLocalDate(new Date());
    const byDay = this.eventsByDay();
    const phaseByDay = this.cyclePhaseByDay();
    const cols: DayColumn[] = [];
    for (let i = 0; i < 7; i++) {
      const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      const iso = this.toLocalDate(date);
      const evs = (byDay.get(iso) ?? []).slice().sort(this.compareDayEvents);
      cols.push({
        date, iso,
        weekdayLabel: date.toLocaleDateString(undefined, { weekday: 'short' }),
        dayNum: date.getDate(),
        isToday: iso === todayIso,
        events: evs,
        cyclePhase: phaseByDay.get(iso),
      });
    }
    return cols;
  });

  /** The week's events flattened + sorted for the agenda list, grouped by day. */
  readonly agendaDays = computed<DayColumn[]>(() => this.days().filter(d => d.events.length > 0));

  /** Max events shown in a month cell before the rest collapse into "+N more". */
  private static readonly MONTH_CELL_MAX = 3;

  /**
   * The 42 cells (6 rows × 7 columns, Sun→Sat) of the visible month grid. The grid begins on the Sunday on or
   * before the 1st and runs 42 days so the current month is always fully covered with leading/trailing days
   * from the adjacent months (flagged `inMonth:false`). Each cell shows up to MONTH_CELL_MAX events; the rest
   * become a "+N more" count. Overlay events are merged in exactly like the week view.
   */
  readonly monthCells = computed<MonthCell[]>(() => {
    const first = this.monthStart();
    const month = first.getMonth();
    const gridStart = this.sundayOf(first);
    const todayIso = this.toLocalDate(new Date());
    const byDay = this.eventsByDay();
    const phaseByDay = this.cyclePhaseByDay();
    const cells: MonthCell[] = [];
    for (let i = 0; i < 42; i++) {
      const date = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
      const iso = this.toLocalDate(date);
      const all = (byDay.get(iso) ?? []).slice().sort(this.compareDayEvents);
      const shown = all.slice(0, FamilyCalendar.MONTH_CELL_MAX);
      cells.push({
        date, iso,
        dayNum: date.getDate(),
        isToday: iso === todayIso,
        inMonth: date.getMonth() === month,
        events: shown,
        moreCount: Math.max(0, all.length - shown.length),
        cyclePhase: phaseByDay.get(iso),
      });
    }
    return cells;
  });

  /** Sun..Sat weekday header labels for the week + month grids (in the browser's locale). */
  readonly weekdayHeaders = computed<string[]>(() => {
    const labels: string[] = [];
    // Jan 4 2026 is a Sunday — a stable anchor for locale-aware short weekday names.
    const sunday = new Date(2026, 0, 4);
    for (let i = 0; i < 7; i++) {
      const d = new Date(sunday.getFullYear(), sunday.getMonth(), sunday.getDate() + i);
      labels.push(d.toLocaleDateString(undefined, { weekday: 'short' }));
    }
    return labels;
  });

  /** A friendly "June 2026" label for the visible month. */
  readonly monthLabel = computed<string>(() =>
    this.monthStart().toLocaleDateString(undefined, { month: 'long', year: 'numeric' }));

  /** A friendly "Jun 16 – 22, 2026" label for the visible week. */
  readonly rangeLabel = computed<string>(() => {
    const start = this.weekStart();
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
    const sameMonth = start.getMonth() === end.getMonth();
    const sameYear = start.getFullYear() === end.getFullYear();
    const fmtStart = start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const fmtEnd = end.toLocaleDateString(undefined,
      sameMonth ? { day: 'numeric', year: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
    return sameYear ? `${fmtStart} – ${fmtEnd}` : `${fmtStart}, ${start.getFullYear()} – ${fmtEnd}`;
  });

  /** The auto-poll interval handle (browser timer id), or null when not polling. */
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  /** Re-renders the "updated Xm ago" label every ~30s without re-fetching. */
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  /** Bound visibilitychange handler so we can detach it on destroy. */
  private readonly onVisibility = (): void => {
    if (document.visibilityState === 'visible') {
      this.startPolling();
      // Catch up immediately on becoming visible again (skipped while hidden).
      if (this.connected()) void this.loadEvents({ silent: true });
    } else {
      this.stopPolling();
    }
  };

  constructor() {
    document.addEventListener('visibilitychange', this.onVisibility);
    // Keep the relative "updated" label fresh while mounted.
    this.tickTimer = setInterval(() => this.nowTick.set(Date.now()), 30_000);
    void this.loadStatus();
  }

  ngOnDestroy(): void {
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.stopPolling();
    if (this.tickTimer !== null) { clearInterval(this.tickTimer); this.tickTimer = null; }
  }

  // ---- Auto-poll (every ~60s while connected AND the tab is visible) ----

  /** Begin polling the visible week if connected + visible + not already running. */
  private startPolling(): void {
    if (this.pollTimer !== null) return;
    if (!this.connected() || document.visibilityState !== 'visible') return;
    this.pollTimer = setInterval(() => {
      if (this.connected() && document.visibilityState === 'visible') {
        void this.loadEvents({ silent: true });
      }
    }, FamilyCalendar.POLL_MS);
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) { clearInterval(this.pollTimer); this.pollTimer = null; }
  }

  /** Manual refresh: re-fetch the visible week now (with the toolbar spinner). */
  async refresh(): Promise<void> {
    if (!this.connected()) return;
    await this.loadEvents();
  }

  // ---- Status + connection lifecycle ----

  private async loadStatus(): Promise<void> {
    this.loadingStatus.set(true);
    this.statusError.set(false);
    try {
      const s = await firstValueFrom(this.api.calendarStatus());
      this.status.set(s);
      if (s.connected) {
        await this.loadEvents();
        void this.loadMembers();
      }
    } catch {
      this.statusError.set(true);
    } finally {
      this.loadingStatus.set(false);
    }
  }

  /** Best-effort: load household members so Find-a-time can offer them as chips. A failure just hides them. */
  private async loadMembers(): Promise<void> {
    try {
      const household = await firstValueFrom(this.api.getHousehold());
      this.members.set(household.members ?? []);
    } catch {
      this.members.set([]);
    }
  }

  /** Run the GIS OAuth code flow, then exchange the code on the server. */
  async connect(): Promise<void> {
    if (this.connecting()) return;
    this.connecting.set(true);
    try {
      const cfg = await firstValueFrom(this.auth.config());
      if (!cfg.googleClientId) {
        this.snack.open('Google sign-in is not configured on this server.', 'OK', { duration: 4000 });
        return;
      }
      await this.waitForGis();
      const code = await this.requestAuthCode(cfg.googleClientId);
      await firstValueFrom(this.api.connectCalendar(code, 'postmessage'));
      // Re-read status rather than hard-setting it, so we keep the server's scopeOk (a connection that
      // didn't grant the calendar.events scope needs the reconnect hint) and load events/members from there.
      await this.loadStatus();
      this.snack.open('Calendar connected.', undefined, { duration: 2000 });
    } catch (e) {
      // A user-cancelled popup is not an error worth shouting about.
      const msg = (e as Error)?.message;
      if (msg !== 'cancelled') {
        this.snack.open(this.messageOf(e, "Couldn't connect your Google Calendar. Please try again."),
          'OK', { duration: 4500 });
      }
    } finally {
      this.connecting.set(false);
    }
  }

  /** Use the GIS code client to obtain a one-time auth code (offline access, calendar.events scope). */
  private requestAuthCode(clientId: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const client = google.accounts.oauth2.initCodeClient({
        client_id: clientId,
        scope: 'https://www.googleapis.com/auth/calendar.events',
        ux_mode: 'popup',
        access_type: 'offline',
        prompt: 'consent',
        callback: (resp: { code?: string; error?: string }) => {
          if (resp?.code) resolve(resp.code);
          else reject(new Error(resp?.error || 'no_code'));
        },
        error_callback: (err: { type?: string }) => {
          reject(new Error(err?.type === 'popup_closed' ? 'cancelled' : (err?.type || 'oauth_failed')));
        },
      });
      client.requestCode();
    });
  }

  async disconnect(): Promise<void> {
    const ok = await this.confirm({
      title: 'Disconnect Google Calendar?',
      message: 'We\'ll forget your calendar connection. Your events stay in Google — this just stops showing them here.',
      confirmLabel: 'Disconnect',
      destructive: true,
    });
    if (!ok) return;
    try {
      await firstValueFrom(this.api.disconnectCalendar());
      this.status.set({ configured: true, connected: false });
      this.events.set([]);
      this.familyEvents.set([]);
      this.cyclePhases.set([]);
      this.proposals.set([]);
      this.clearBest();
      this.lastUpdated.set(null);
      this.stopPolling();
      this.snack.open('Calendar disconnected.', undefined, { duration: 2000 });
    } catch {
      this.snack.open("Couldn't disconnect just now. Please try again.", 'OK', { duration: 4000 });
    }
  }

  private waitForGis(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let tries = 0;
      const timer = setInterval(() => {
        if ((window as unknown as { google?: any }).google?.accounts?.oauth2) {
          clearInterval(timer);
          resolve();
        } else if (++tries > 60) {
          clearInterval(timer);
          reject(new Error('Google Identity Services failed to load'));
        }
      }, 100);
    });
  }

  // ---- Events ----

  /**
   * The [start, end) the current view shows: the Sun-anchored 7-day week (week + agenda), or the full 42-cell
   * month grid (month view). Events + the family overlay are both fetched over this range.
   */
  private visibleRange(): { start: Date; end: Date } {
    if (this.view() === 'month') {
      const gridStart = this.sundayOf(this.monthStart());
      const end = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + 42);
      return { start: gridStart, end };
    }
    const start = this.weekStart();
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7);
    return { start, end };
  }

  /**
   * Fetch the visible range's events (own + the family overlay). A `silent` load (auto-poll / visibility
   * catch-up) skips the toolbar spinner and leaves the current events on screen if the fetch fails, so a
   * transient blip never blanks the planner. A manual/navigation load shows the spinner + surfaces an error.
   * The family overlay is best-effort: its failure never blocks the caller's own events.
   */
  private async loadEvents(opts: { silent?: boolean } = {}): Promise<void> {
    const silent = opts.silent === true;
    if (!silent) this.loadingEvents.set(true);
    this.eventsError.set(false);
    const { start, end } = this.visibleRange();
    try {
      const list = await firstValueFrom(this.api.calendarEvents(start.toISOString(), end.toISOString()));
      this.events.set(list);
      this.lastUpdated.set(Date.now());
      this.nowTick.set(Date.now());
      // First successful load kicks off the background poll.
      this.startPolling();
    } catch {
      if (!silent) {
        this.eventsError.set(true);
        this.events.set([]);
      }
      // A silent failure leaves the last-good week on screen; the next tick retries.
    } finally {
      if (!silent) this.loadingEvents.set(false);
    }
    // Best-effort overlays over the same range (never block / error the caller's own events).
    void this.loadFamilyEvents(start, end);
    void this.loadCyclePhases(start, end);
  }

  /** Best-effort fetch of the family overlay over a range; a failure just clears it (own events stand). */
  private async loadFamilyEvents(start: Date, end: Date): Promise<void> {
    try {
      const members = await firstValueFrom(this.api.familyEvents(start.toISOString(), end.toISOString()));
      this.familyEvents.set(members ?? []);
    } catch {
      this.familyEvents.set([]);
    }
  }

  /**
   * Best-effort fetch of the opted-in members' PREDICTED cycle phases over a range; a failure (or nobody
   * opted in) just clears the layer (everything else stands). Read-only — only predicted spans, never raw.
   */
  private async loadCyclePhases(start: Date, end: Date): Promise<void> {
    try {
      const members = await firstValueFrom(this.api.cycleOverlay(start.toISOString(), end.toISOString()));
      this.cyclePhases.set(members ?? []);
    } catch {
      this.cyclePhases.set([]);
    }
  }

  prevWeek(): void {
    if (this.view() === 'month') { this.shiftMonth(-1); return; }
    this.shiftWeek(-7);
  }

  nextWeek(): void {
    if (this.view() === 'month') { this.shiftMonth(1); return; }
    this.shiftWeek(7);
  }

  today(): void {
    const now = new Date();
    this.weekStart.set(this.sundayOf(now));
    this.monthStart.set(this.firstOfMonth(now));
    void this.loadEvents();
  }

  private shiftWeek(days: number): void {
    const s = this.weekStart();
    this.weekStart.set(new Date(s.getFullYear(), s.getMonth(), s.getDate() + days));
    void this.loadEvents();
  }

  private shiftMonth(months: number): void {
    const s = this.monthStart();
    this.monthStart.set(new Date(s.getFullYear(), s.getMonth() + months, 1));
    void this.loadEvents();
  }

  /** Switch view; re-fetch because the month grid covers a wider range than a single week. */
  setView(v: ViewMode): void {
    if (this.view() === v) return;
    const from = this.view();
    this.view.set(v);
    // Carry the visible period across the switch so navigating several months in month view then
    // switching to week doesn't snap back to a stale week (and vice-versa).
    if (v === 'month' && from !== 'month') this.monthStart.set(this.firstOfMonth(this.weekStart()));
    else if (v !== 'month' && from === 'month') this.weekStart.set(this.sundayOf(this.monthStart()));
    if (this.connected()) void this.loadEvents();
  }

  /** Show/hide the family overlay (legend toggle). No fetch — the overlay data is already loaded. */
  toggleOverlay(): void {
    this.showOverlay.set(!this.showOverlay());
  }

  /** Show/hide the predicted cycle-phase background layer. No fetch — the phase data is already loaded. */
  toggleCyclePhases(): void {
    this.showCyclePhases.set(!this.showCyclePhases());
  }

  /**
   * A "predicted" tooltip/aria sentence for a day's cycle phase, naming the opted-in member(s) — e.g.
   * "Predicted period · Ava" or "Predicted fertile window · Ava, Mia". Never an email; '' when no phase.
   */
  cyclePhaseLabel(phase: CyclePhaseDay | undefined): string {
    if (!phase) return '';
    const what = phase.kind === 'period' ? 'Predicted period' : 'Predicted fertile window';
    const who = phase.names.join(', ');
    return who ? `${what} · ${who}` : what;
  }

  /**
   * Opt the caller in/out of sharing their calendar with the household. Only enabled once connected. Optimistic
   * status update on success; a friendly snackbar + no state change on failure.
   */
  async toggleShare(): Promise<void> {
    if (this.sharingBusy() || !this.connected()) return;
    const next = !this.shareHousehold();
    this.sharingBusy.set(true);
    try {
      const res = await firstValueFrom(this.api.setCalendarShare(next));
      const s = this.status();
      if (s) this.status.set({ ...s, shareHousehold: res.shareHousehold });
      this.snack.open(
        res.shareHousehold ? 'Your calendar is now shared with your household.' : 'Calendar sharing turned off.',
        undefined, { duration: 2200 });
    } catch (e) {
      this.snack.open(this.messageOf(e, "Couldn't update calendar sharing. Please try again."), 'OK',
        { duration: 4000 });
    } finally {
      this.sharingBusy.set(false);
    }
  }

  // ---- Schedule with AI ----

  /**
   * Send the free-text scheduling request to Gemini and show the proposed event(s) as confirm cards. Creates
   * NOTHING — each card has its own "Add to calendar". Degrades gracefully: a 503 (AI unavailable / not
   * configured) or any error shows a friendly aria-live line; an empty result says so. Not-connected is
   * guarded by only rendering the box when connected.
   */
  async scheduleWithAi(): Promise<void> {
    const text = this.aiText().trim();
    if (text.length === 0 || this.aiBusy()) return;
    this.aiBusy.set(true);
    this.aiStatus.set('Reading your request…');
    this.proposals.set([]);
    try {
      const result = await firstValueFrom(this.api.scheduleAiEvents(text));
      const proposed = (result.events ?? []).map(ai => this.toProposed(ai));
      this.proposals.set(proposed);
      if (proposed.length === 0) {
        this.aiStatus.set(
          result.notes?.trim() || "I couldn't find an event in that. Try \"dentist next Friday at 9am\".");
      } else {
        const n = proposed.length;
        this.aiStatus.set(
          (result.notes?.trim() ? result.notes!.trim() + ' ' : '') +
          `Review ${n === 1 ? 'the event' : `these ${n} events`} below, then add ${n === 1 ? 'it' : 'them'} to your calendar.`);
      }
    } catch (e) {
      const status = (e as { status?: number })?.status;
      this.aiStatus.set(status === 503
        ? "AI scheduling isn't available right now. You can add the event yourself with the Event button."
        : this.messageOf(e, "I couldn't reach the AI just now. Please try again, or add the event manually."));
    } finally {
      this.aiBusy.set(false);
    }
  }

  /** Add one AI-proposed event to the calendar (passing its recurrence). Then drop the card. */
  async addProposal(p: ProposedEvent): Promise<void> {
    if (p.saving) return;
    this.setProposalSaving(p, true);
    try {
      await firstValueFrom(this.api.createEvent(this.inputFromProposal(p.ai)));
      this.dismissProposal(p);
      this.snack.open('Added to your calendar.', undefined, { duration: 2000 });
      await this.loadEvents();
    } catch (e) {
      this.setProposalSaving(p, false);
      this.snack.open(this.messageOf(e, "Couldn't add that event. Please try again."), 'OK', { duration: 4000 });
    }
  }

  /**
   * Bulk-add every proposed event. Loops {@link Api.createEvent} over each, DROPS each card on success and
   * KEEPS any that fail (so the user can retry just those), refreshes the calendar ONCE at the end, and
   * snackbars the tally. The per-card buttons + the AI boxes are disabled while this runs (`addingAll`).
   */
  async addAll(): Promise<void> {
    if (this.addingAll()) return;
    const all = this.proposals();
    if (all.length === 0) return;
    this.addingAll.set(true);
    const failed: ProposedEvent[] = [];
    let added = 0;
    try {
      for (const p of all) {
        try {
          await firstValueFrom(this.api.createEvent(this.inputFromProposal(p.ai)));
          added++;
        } catch {
          failed.push(p);
        }
      }
      // Keep only the ones that couldn't be added (cleared of any stale per-card saving flag).
      this.proposals.set(failed.map(p => ({ ...p, saving: false })));
      const msg = failed.length === 0
        ? `Added ${added} ${added === 1 ? 'event' : 'events'} to your calendar.`
        : `Added ${added} · ${failed.length} couldn't be added.`;
      this.snack.open(msg, undefined, { duration: 3000 });
    } finally {
      this.addingAll.set(false);
      // Refresh once at the end so a partial success still reflects what landed.
      if (added > 0) await this.loadEvents();
    }
  }

  /** Open the full editor prefilled from a proposed event so the user can tweak it before creating. */
  async editProposal(p: ProposedEvent): Promise<void> {
    const ai = p.ai;
    const result = await this.openEditor({
      event: null,
      seedTitle: ai.title,
      seedStartUtc: ai.startUtc,
      seedEndUtc: ai.endUtc,
      seedAllDay: ai.allDay,
      seedLocation: ai.location,
      seedDescription: ai.description,
      seedRecurrence: ai.recurrence,
    });
    if (result?.kind === 'save') {
      try {
        await firstValueFrom(this.api.createEvent(result.input));
        this.dismissProposal(p);
        await this.loadEvents();
      } catch (e) {
        this.snack.open(this.messageOf(e, "Couldn't save that event. Please try again."), 'OK', { duration: 4000 });
      }
    }
  }

  /** Discard a proposed event card without creating it. */
  dismissProposal(p: ProposedEvent): void {
    this.proposals.set(this.proposals().filter(x => x !== p));
  }

  /** Clear the AI box + any pending proposals. */
  clearAi(): void {
    this.aiText.set('');
    this.aiStatus.set('');
    this.proposals.set([]);
  }

  // ---- 📄 Upload a schedule (image / PDF → extracted proposed events) ----

  /** Open a throwaway multi-file picker (images + PDF), then extract events from the chosen files. */
  triggerUpload(): void {
    if (this.uploadBusy()) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = FamilyCalendar.UPLOAD_ACCEPT;
    input.multiple = true;
    input.style.display = 'none';
    input.addEventListener('change', () => {
      const files = input.files ? Array.from(input.files) : [];
      input.remove();
      if (files.length) void this.processScheduleFiles(files);
    });
    input.click();
  }

  /** Drag-over the drop zone: highlight + allow the drop (preventDefault so the browser doesn't open the file). */
  onUploadDragOver(ev: DragEvent): void {
    ev.preventDefault();
    if (!this.uploadBusy()) this.uploadDragOver.set(true);
  }

  /** Drag leaves the drop zone — clear the highlight. */
  onUploadDragLeave(ev: DragEvent): void {
    ev.preventDefault();
    this.uploadDragOver.set(false);
  }

  /** Drop image/PDF schedule files onto the zone → extract events from them. */
  onUploadDrop(ev: DragEvent): void {
    ev.preventDefault();
    this.uploadDragOver.set(false);
    if (this.uploadBusy()) return;
    const files = ev.dataTransfer?.files ? Array.from(ev.dataTransfer.files) : [];
    if (files.length) void this.processScheduleFiles(files);
  }

  /**
   * Prepare the chosen files and send them for extraction. Images are downscaled to a small JPEG (reusing the
   * tracker's {@link downscaleToJpeg}); PDFs are read as raw base64 and rejected with a friendly note when over
   * the ~10 MB cap. The extracted events render in the SAME proposal cards as Schedule-with-AI. Creates +
   * stores NOTHING — the upload is only read to pull out events. Degrades gracefully on 503/400/any error.
   */
  private async processScheduleFiles(chosen: File[]): Promise<void> {
    if (this.uploadBusy()) return;

    // Keep only supported types; cap to the endpoint's max so a friendly note beats a server 400.
    const supported = chosen.filter(f =>
      f.type === 'image/jpeg' || f.type === 'image/png' || f.type === 'image/webp' || f.type === 'application/pdf');
    if (supported.length === 0) {
      this.aiStatus.set('Please choose schedule images (JPG, PNG, WebP) or a PDF.');
      return;
    }
    const tooMany = supported.length > FamilyCalendar.UPLOAD_MAX_FILES;
    const files = tooMany ? supported.slice(0, FamilyCalendar.UPLOAD_MAX_FILES) : supported;

    this.uploadBusy.set(true);
    this.aiStatus.set('Reading your schedule…');
    this.proposals.set([]);
    try {
      const payload: ScheduleImageFile[] = [];
      for (const file of files) {
        if (file.type === 'application/pdf') {
          if (file.size > FamilyCalendar.UPLOAD_MAX_PDF_BYTES) {
            this.aiStatus.set(`“${file.name}” is too large — PDFs need to be under 10 MB. Try a smaller file.`);
            return;
          }
          const imageBase64 = await readFileAsBase64(file);
          payload.push({ imageBase64, mime: 'application/pdf' });
        } else {
          // Downscale images to a small JPEG to stay well under the cap + cheap on the wire.
          const img = await downscaleToJpeg(file);
          payload.push({ imageBase64: img.imageBase64, mime: img.mimeType });
        }
      }

      const result = await firstValueFrom(this.api.scheduleFromImage(payload));
      const proposed = (result.events ?? []).map(ai => this.toProposed(ai));
      this.proposals.set(proposed);

      const tooManyNote = tooMany
        ? `I read the first ${FamilyCalendar.UPLOAD_MAX_FILES} files. `
        : '';
      if (proposed.length === 0) {
        this.aiStatus.set(
          tooManyNote +
          (result.notes?.trim() || "I couldn't find any events in that. Try a clearer photo or a schedule PDF."));
      } else {
        const n = proposed.length;
        this.aiStatus.set(
          tooManyNote +
          (result.notes?.trim() ? result.notes!.trim() + ' ' : '') +
          `Review ${n === 1 ? 'the event' : `these ${n} events`} below, then add ${n === 1 ? 'it' : 'them'} to your calendar.`);
      }
    } catch (e) {
      const status = (e as { status?: number })?.status;
      if (status === 503) {
        this.aiStatus.set(
          "AI scheduling isn't available right now. You can add the event yourself with the Event button.");
      } else if (status === 400) {
        this.aiStatus.set(this.messageOf(e,
          'That file didn’t work — attach up to 5 schedule images (under 5 MB each) or PDFs (under 10 MB).'));
      } else {
        this.aiStatus.set(this.messageOf(e,
          "I couldn't read that schedule just now. Please try again, or add the event manually."));
      }
    } finally {
      this.uploadBusy.set(false);
    }
  }

  // ---- ✨ Best time for X ----

  /**
   * Send the free-text "best time" request to Gemini (which only fills the find-time form), then surface the
   * candidate slots the existing deterministic engine found. Books NOTHING — picking a slot opens the event
   * editor prefilled. Degrades gracefully: a 503 (AI/calendar unavailable / not configured) or any error shows
   * a friendly aria-live line; unconnected members are flagged; no openings says so. Guarded by `connected`.
   */
  async findBestTime(): Promise<void> {
    const text = this.bestText().trim();
    if (text.length === 0 || this.bestBusy()) return;
    this.bestBusy.set(true);
    this.bestStatus.set('Reading your request…');
    this.bestInterpreted.set(null);
    this.bestSlots.set([]);
    this.bestNotConnected.set([]);
    this.bestNoneConnected.set(false);
    try {
      const result = await firstValueFrom(this.api.findTimeAi(text));
      this.bestInterpreted.set(result.interpreted);
      const considered = result.consideredMembers ?? [];
      const noneConnected = considered.length > 0 && considered.every(m => !m.connected);
      this.bestNoneConnected.set(noneConnected);
      this.bestNotConnected.set(considered.filter(m => !m.connected));
      this.bestSlots.set(result.slots ?? []);

      if (noneConnected) {
        this.bestStatus.set(
          "No one's connected their calendar yet, so I can't check availability. Once someone connects, this lights up.");
      } else if ((result.slots ?? []).length === 0) {
        this.bestStatus.set(
          (result.interpreted.note?.trim() ? result.interpreted.note!.trim() + ' ' : '') +
          'No common openings in that window. Try a wider range, a shorter slot, or broader hours.');
      } else {
        const n = result.slots.length;
        this.bestStatus.set(
          (result.interpreted.note?.trim() ? result.interpreted.note!.trim() + ' ' : '') +
          `Pick ${n === 1 ? 'the slot' : 'a slot'} below to create the event prefilled.`);
      }
    } catch (e) {
      const status = (e as { status?: number })?.status;
      this.bestStatus.set(status === 503
        ? "AI or calendar isn't available right now. You can use Find a time to look manually."
        : this.messageOf(e, "I couldn't reach the AI just now. Please try again, or use Find a time."));
    } finally {
      this.bestBusy.set(false);
    }
  }

  /** Pick a best-time slot → open the event editor prefilled to it (reuses the create-from-slot flow). */
  async pickBestSlot(slot: FindTimeSlot): Promise<void> {
    await this.createFromSlot(slot);
  }

  /** Clear the best-time box + its results. */
  clearBest(): void {
    this.bestText.set('');
    this.bestStatus.set('');
    this.bestInterpreted.set(null);
    this.bestSlots.set([]);
    this.bestNotConnected.set([]);
    this.bestNoneConnected.set(false);
  }

  // ---- Best-time slot display (browser local zone) ----

  /** "Thu, Jun 20" day label for a slot. */
  slotDay(slot: FindTimeSlot): string {
    return new Date(slot.startUtc).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  }

  /** "9:00 AM – 10:00 AM" local time range for a slot. */
  slotRange(slot: FindTimeSlot): string {
    const opts: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };
    const start = new Date(slot.startUtc).toLocaleTimeString(undefined, opts);
    const end = new Date(slot.endUtc).toLocaleTimeString(undefined, opts);
    return `${start} – ${end}`;
  }

  /** "45-minute" / "1-hour" / "90-minute" duration label for the "what I understood" line. */
  private durationLabel(min: number): string {
    if (min % 60 === 0) {
      const h = min / 60;
      return h === 1 ? '1-hour' : `${h}-hour`;
    }
    return `${min}-minute`;
  }

  /** "from Jun 20 to Jun 27" window label (local) for the "what I understood" line. */
  private windowLabel(fromUtc: string, toUtc: string): string {
    const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
    const from = new Date(fromUtc).toLocaleDateString(undefined, opts);
    const to = new Date(toUtc).toLocaleDateString(undefined, opts);
    return `from ${from} to ${to}`;
  }

  /** "9 AM" style label for a workday-hour bound (0–23). */
  private hourLabel(h: number): string {
    const ampm = h < 12 ? 'AM' : 'PM';
    const twelve = h % 12 === 0 ? 12 : h % 12;
    return `${twelve} ${ampm}`;
  }

  private setProposalSaving(p: ProposedEvent, saving: boolean): void {
    this.proposals.set(this.proposals().map(x => x === p ? { ...x, saving } : x));
  }

  /** Build a confirm-card view-model from a raw AI-proposed event. */
  private toProposed(ai: ScheduleAiEvent): ProposedEvent {
    return {
      ai,
      whenLabel: this.proposalWhenLabel(ai),
      repeatLabel: this.recurrenceLabel(ai.recurrence),
      saving: false,
    };
  }

  /** Map a proposed event to the create payload (carrying recurrence through to POST /events). */
  private inputFromProposal(ai: ScheduleAiEvent): CalendarEventInput {
    return {
      title: ai.title,
      startUtc: ai.startUtc,
      endUtc: ai.endUtc,
      allDay: ai.allDay,
      location: ai.location,
      description: ai.description,
      recurrence: ai.recurrence,
    };
  }

  /** "Tue, Jun 23 · 4:00 – 5:00 PM" (timed) or "Tue, Jun 23 · All day" in the viewer's local zone. */
  private proposalWhenLabel(ai: ScheduleAiEvent): string {
    const start = new Date(ai.startUtc);
    if (Number.isNaN(start.getTime())) return '';
    const day = start.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    if (ai.allDay) return `${day} · All day`;
    const from = start.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    const endDate = ai.endUtc ? new Date(ai.endUtc) : null;
    const to = endDate && !Number.isNaN(endDate.getTime())
      ? endDate.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : null;
    return to ? `${day} · ${from} – ${to}` : `${day} · ${from}`;
  }

  /** A short, friendly repeat label for a recurrence chip ('' for a one-off). */
  recurrenceLabel(r: CalendarRecurrence | undefined): string {
    switch (r) {
      case 'daily': return 'Every day';
      case 'weekly': return 'Every week';
      case 'weekdays': return 'Weekdays';
      case 'monthly': return 'Every month';
      default: return '';
    }
  }

  /** Open the editor to create a new event, optionally seeded to a clicked day. */
  async create(seedDate?: string): Promise<void> {
    const result = await this.openEditor({ event: null, seedDate });
    if (result?.kind === 'save') {
      try {
        await firstValueFrom(this.api.createEvent(result.input));
        await this.loadEvents();
      } catch (e) {
        this.snack.open(this.messageOf(e, "Couldn't save that event. Please try again."), 'OK', { duration: 4000 });
      }
    }
  }

  /**
   * Open the Find-a-time tool. When the caller picks a candidate slot, flow straight into the event editor
   * prefilled to that slot so they can name + create it. Degrades cleanly when no members/calendars connect.
   */
  async openFindTime(): Promise<void> {
    const ref = this.dialog.open<FindTimeDialog, FindTimeData, FindTimeResultSlot>(
      FindTimeDialog, { data: { members: this.members() }, width: '520px', maxWidth: '94vw', autoFocus: false, panelClass: 'family-dialog' });
    const slot = await firstValueFrom(ref.afterClosed());
    if (!slot) return;
    await this.createFromSlot(slot);
  }

  /** Open the event editor seeded to a Find-a-time slot, then create it on save. */
  private async createFromSlot(slot: FindTimeResultSlot): Promise<void> {
    const result = await this.openEditor({
      event: null, seedStartUtc: slot.startUtc, seedEndUtc: slot.endUtc,
    });
    if (result?.kind === 'save') {
      try {
        await firstValueFrom(this.api.createEvent(result.input));
        await this.loadEvents();
      } catch (e) {
        this.snack.open(this.messageOf(e, "Couldn't save that event. Please try again."), 'OK', { duration: 4000 });
      }
    }
  }

  /**
   * Click a day/month/agenda event. The caller's OWN events open the editor; a read-only family-overlay event
   * (another member's) can't be edited, so we just show a gentle note of whose it is.
   */
  openDayEvent(de: DayEvent): void {
    if (de.overlay) {
      this.snack.open(`${de.ev.title} — ${de.memberName ?? 'a family member'}'s event (view only).`,
        undefined, { duration: 2600 });
      return;
    }
    void this.edit(de.ev);
  }

  /** Click an event to edit (or delete from within the editor). */
  async edit(ev: CalendarEvent): Promise<void> {
    const result = await this.openEditor({ event: ev });
    if (!result) return;
    if (result.kind === 'delete') {
      await this.remove(ev);
      return;
    }
    try {
      await firstValueFrom(this.api.updateEvent(ev.id, result.input));
      await this.loadEvents();
    } catch (e) {
      this.snack.open(this.messageOf(e, "Couldn't save that event. Please try again."), 'OK', { duration: 4000 });
    }
  }

  private async remove(ev: CalendarEvent): Promise<void> {
    const ok = await this.confirm({
      title: 'Delete this event?',
      message: `“${ev.title}” will be removed from your calendar.`,
      destructive: true,
    });
    if (!ok) return;
    try {
      await firstValueFrom(this.api.deleteEvent(ev.id));
      await this.loadEvents();
    } catch {
      this.snack.open("Couldn't delete that event.", 'OK', { duration: 4000 });
    }
  }

  private openEditor(data: EventEditorData): Promise<EventEditorResult | undefined> {
    const ref = this.dialog.open<EventEditorDialog, EventEditorData, EventEditorResult>(
      EventEditorDialog, { data, width: '460px', maxWidth: '94vw', autoFocus: false, panelClass: 'family-dialog' });
    return firstValueFrom(ref.afterClosed());
  }

  private confirm(data: ConfirmData): Promise<boolean | undefined> {
    const ref = this.dialog.open<FamilyConfirmDialog, ConfirmData, boolean>(FamilyConfirmDialog, {
      data, width: '420px', maxWidth: '92vw', panelClass: 'family-dialog',
    });
    return firstValueFrom(ref.afterClosed());
  }

  // ---- Date helpers (browser local zone) ----

  /** The Sunday (local midnight) of the week containing `d` (weeks run Sunday→Saturday). */
  private sundayOf(d: Date): Date {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() - d.getDay());
  }

  /** The first day (local midnight) of the month containing `d`. */
  private firstOfMonth(d: Date): Date {
    return new Date(d.getFullYear(), d.getMonth(), 1);
  }

  /**
   * Adapt a read-only overlay event (title + time only) into the CalendarEvent shape so it can reuse
   * {@link spannedDays}/{@link timeLabel}. The id is synthetic + clearly non-editable; clicking it never opens
   * the editor (the template guards on `overlay`). No location/notes/links are ever carried for another member.
   */
  private overlayToEvent(item: { title: string; startUtc: string | null; endUtc: string | null; allDay: boolean },
                         userId: number): CalendarEvent {
    return {
      id: `overlay:${userId}:${item.startUtc ?? ''}:${item.title}`,
      title: item.title,
      startUtc: item.startUtc,
      endUtc: item.endUtc,
      allDay: item.allDay,
      location: null,
      description: null,
      htmlLink: null,
      hangoutLink: null,
      isRecurring: false,
    };
  }

  private toLocalDate(d: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  /** The set of local "YYYY-MM-DD" days an event touches (handles multi-day + all-day spans). */
  private spannedDays(ev: CalendarEvent): string[] {
    if (!ev.startUtc) return [];
    const start = new Date(ev.startUtc);
    let end = ev.endUtc ? new Date(ev.endUtc) : new Date(start.getTime() + 60 * 60 * 1000);
    // The API's all-day end is exclusive — step back so the final day isn't double-counted.
    if (ev.allDay) end = new Date(end.getTime() - 1);
    const days: string[] = [];
    const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    const last = new Date(end.getFullYear(), end.getMonth(), end.getDate());
    // Guard against pathological ranges.
    let guard = 0;
    while (cursor.getTime() <= last.getTime() && guard++ < 366) {
      days.push(this.toLocalDate(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }
    return days.length ? days : [this.toLocalDate(start)];
  }

  /**
   * The set of local "YYYY-MM-DD" days an INCLUSIVE predicted phase span ("YYYY-MM-DD" start..end) touches.
   * The span dates are calendar dates (no time-of-day), so we parse them locally + walk day-by-day.
   */
  private spannedPhaseDays(start: string, end: string): string[] {
    const s = this.parseIsoDate(start);
    const e = this.parseIsoDate(end) ?? s;
    if (!s) return [];
    const last = e && e.getTime() >= s.getTime() ? e : s;
    const days: string[] = [];
    const cursor = new Date(s.getFullYear(), s.getMonth(), s.getDate());
    let guard = 0;
    while (cursor.getTime() <= last.getTime() && guard++ < 366) {
      days.push(this.toLocalDate(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }
    return days;
  }

  /** Parse a "YYYY-MM-DD" calendar date as a LOCAL midnight Date (avoids the UTC shift of `new Date(str)`). */
  private parseIsoDate(iso: string): Date | null {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '');
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }

  /** "All day" or a "h:mm a" local start label. */
  private timeLabel(ev: CalendarEvent): string {
    if (ev.allDay) return 'All day';
    if (!ev.startUtc) return '';
    return new Date(ev.startUtc).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  /** A friendly "h:mm a – h:mm a" (or "All day") range for the agenda/edit hint. */
  rangeFor(ev: CalendarEvent): string {
    if (ev.allDay) return 'All day';
    if (!ev.startUtc) return '';
    const start = new Date(ev.startUtc).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    if (!ev.endUtc) return start;
    const end = new Date(ev.endUtc).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    return `${start} – ${end}`;
  }

  dayHeading(col: DayColumn): string {
    return col.date.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  }

  /** Friendly "Monday, Jun 22" label for a month cell (used in tooltips/labels). */
  monthCellHeading(cell: MonthCell): string {
    return cell.date.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  }

  /** Jump from a month cell into that day's agenda so overflow ("+N more") events are reachable. */
  openMonthDay(cell: MonthCell): void {
    // Set the view signal DIRECTLY (not via setView) so its month→week re-anchor doesn't clobber the
    // clicked day's week back to the month's first week — then anchor on the clicked day + load once.
    if (this.view() !== 'agenda') this.view.set('agenda');
    this.weekStart.set(this.sundayOf(cell.date));
    if (this.connected()) void this.loadEvents();
  }

  private compareDayEvents = (a: DayEvent, b: DayEvent): number => {
    if (a.ev.allDay !== b.ev.allDay) return a.ev.allDay ? -1 : 1;
    const byTime = (a.ev.startUtc ?? '').localeCompare(b.ev.startUtc ?? '');
    if (byTime !== 0) return byTime;
    // Tie-break: the caller's own events sort before read-only overlay events at the same time.
    if (a.overlay !== b.overlay) return a.overlay ? 1 : -1;
    return 0;
  };

  private messageOf(e: unknown, fallback: string): string {
    const msg = (e as { error?: { message?: string } })?.error?.message;
    return typeof msg === 'string' && msg ? msg : fallback;
  }
}
