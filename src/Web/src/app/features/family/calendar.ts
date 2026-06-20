import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';

import { Api } from '../../core/api';
import { AuthService } from '../../core/auth';
import { CalendarEvent, CalendarStatus } from '../../core/models';
import { FamilyConfirmDialog, ConfirmData } from './confirm-dialog';
import { EventEditorDialog, EventEditorData, EventEditorResult } from './event-editor-dialog';

/* The Google OAuth code client (loaded via the GIS script in index.html). */
declare const google: any;

/** An event positioned within a single day of the week grid. */
interface DayEvent {
  ev: CalendarEvent;
  /** "h:mm a" local start (timed) or "All day". */
  timeLabel: string;
}

/** One column of the week view: its date + the events that fall on it (all-day first, then by start). */
interface DayColumn {
  date: Date;
  iso: string;            // "YYYY-MM-DD" local
  weekdayLabel: string;   // "Mon"
  dayNum: number;         // 1..31
  isToday: boolean;
  events: DayEvent[];
}

type ViewMode = 'week' | 'agenda';

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
    RouterLink, MatIconModule, MatButtonModule, MatButtonToggleModule, MatTooltipModule,
    MatProgressSpinnerModule, MatSnackBarModule,
  ],
  templateUrl: './calendar.html',
  styleUrls: ['./family.scss', './calendar.scss'],
})
export class FamilyCalendar {
  private api = inject(Api);
  private auth = inject(AuthService);
  private dialog = inject(MatDialog);
  private snack = inject(MatSnackBar);

  /** null while the initial status check is in flight. */
  readonly status = signal<CalendarStatus | null>(null);
  readonly loadingStatus = signal(true);
  readonly statusError = signal(false);
  readonly connecting = signal(false);

  readonly events = signal<CalendarEvent[]>([]);
  readonly loadingEvents = signal(false);
  readonly eventsError = signal(false);

  readonly view = signal<ViewMode>('week');

  /** The Monday (local midnight) that anchors the visible week. */
  readonly weekStart = signal<Date>(this.mondayOf(new Date()));

  readonly connected = computed(() => this.status()?.connected === true);
  readonly configured = computed(() => this.status()?.configured !== false);

  /** The seven day-columns of the visible week with their events placed. */
  readonly days = computed<DayColumn[]>(() => {
    const start = this.weekStart();
    const todayIso = this.toLocalDate(new Date());
    const byDay = new Map<string, DayEvent[]>();
    for (const ev of this.events()) {
      for (const iso of this.spannedDays(ev)) {
        const arr = byDay.get(iso) ?? [];
        arr.push({ ev, timeLabel: this.timeLabel(ev) });
        byDay.set(iso, arr);
      }
    }
    const cols: DayColumn[] = [];
    for (let i = 0; i < 7; i++) {
      const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      const iso = this.toLocalDate(date);
      const evs = (byDay.get(iso) ?? []).sort(this.compareDayEvents);
      cols.push({
        date, iso,
        weekdayLabel: date.toLocaleDateString(undefined, { weekday: 'short' }),
        dayNum: date.getDate(),
        isToday: iso === todayIso,
        events: evs,
      });
    }
    return cols;
  });

  /** The week's events flattened + sorted for the agenda list, grouped by day. */
  readonly agendaDays = computed<DayColumn[]>(() => this.days().filter(d => d.events.length > 0));

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

  constructor() {
    void this.loadStatus();
  }

  // ---- Status + connection lifecycle ----

  private async loadStatus(): Promise<void> {
    this.loadingStatus.set(true);
    this.statusError.set(false);
    try {
      const s = await firstValueFrom(this.api.calendarStatus());
      this.status.set(s);
      if (s.connected) await this.loadEvents();
    } catch {
      this.statusError.set(true);
    } finally {
      this.loadingStatus.set(false);
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
      this.status.set({ configured: true, connected: true });
      await this.loadEvents();
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

  private async loadEvents(): Promise<void> {
    this.loadingEvents.set(true);
    this.eventsError.set(false);
    const start = this.weekStart();
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7);
    try {
      const list = await firstValueFrom(this.api.calendarEvents(start.toISOString(), end.toISOString()));
      this.events.set(list);
    } catch {
      this.eventsError.set(true);
      this.events.set([]);
    } finally {
      this.loadingEvents.set(false);
    }
  }

  prevWeek(): void {
    this.shiftWeek(-7);
  }

  nextWeek(): void {
    this.shiftWeek(7);
  }

  today(): void {
    this.weekStart.set(this.mondayOf(new Date()));
    void this.loadEvents();
  }

  private shiftWeek(days: number): void {
    const s = this.weekStart();
    this.weekStart.set(new Date(s.getFullYear(), s.getMonth(), s.getDate() + days));
    void this.loadEvents();
  }

  setView(v: ViewMode): void {
    this.view.set(v);
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
      EventEditorDialog, { data, width: '460px', maxWidth: '94vw', autoFocus: false });
    return firstValueFrom(ref.afterClosed());
  }

  private confirm(data: ConfirmData): Promise<boolean | undefined> {
    const ref = this.dialog.open<FamilyConfirmDialog, ConfirmData, boolean>(FamilyConfirmDialog, {
      data, width: '420px', maxWidth: '92vw',
    });
    return firstValueFrom(ref.afterClosed());
  }

  // ---- Date helpers (browser local zone) ----

  /** The Monday (local midnight) of the week containing `d`. */
  private mondayOf(d: Date): Date {
    const day = (d.getDay() + 6) % 7; // 0 = Monday
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() - day);
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

  private compareDayEvents = (a: DayEvent, b: DayEvent): number => {
    if (a.ev.allDay !== b.ev.allDay) return a.ev.allDay ? -1 : 1;
    return (a.ev.startUtc ?? '').localeCompare(b.ev.startUtc ?? '');
  };

  private messageOf(e: unknown, fallback: string): string {
    const msg = (e as { error?: { message?: string } })?.error?.message;
    return typeof msg === 'string' && msg ? msg : fallback;
  }
}
