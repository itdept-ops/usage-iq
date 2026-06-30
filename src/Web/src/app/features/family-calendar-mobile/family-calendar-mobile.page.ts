import {
  ChangeDetectionStrategy, Component, OnDestroy, computed, inject, signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { MatIconModule } from '@angular/material/icon';

import { Api } from '../../core/api';
import { AuthService } from '../../core/auth';
import { ensureGis } from '../../core/gis-loader';
import {
  CalendarEvent,
  CalendarEventInput,
  CalendarRecurrence,
  CalendarStatus,
  CycleOverlayMember,
  FamilyMemberEvents,
  PERM,
  ScheduleAiEvent,
} from '../../core/models';
import {
  BetaPullRefresh, BetaBottomSheet, BetaSwipeRow, BetaSkeleton,
  BetaFab, BetaToaster, ToastController,
} from '../beta-ui';

/** One event placed on a day in the agenda — own (editable) or a read-only family-overlay row. */
interface AgendaEvent {
  ev: CalendarEvent;
  /** "All day" or a "h:mm a – h:mm a" local range. */
  timeLabel: string;
  /** True for a READ-ONLY family-overlay event (another member's). */
  overlay: boolean;
  /** The owning member's display name (overlay only) — never an email. */
  memberName?: string;
  /** The overlay member's stable color (overlay only). */
  color?: string;
}

/** A predicted cycle phase covering a day (soft background tag) — name(s) only, never an email. */
interface CyclePhaseDay {
  kind: 'period' | 'fertile';
  names: string[];
}

/** One day section of the agenda list: its date + the events that fall on it. */
interface AgendaDay {
  iso: string;            // "YYYY-MM-DD" local
  date: Date;
  heading: string;        // "Monday, Jun 22"
  isToday: boolean;
  events: AgendaEvent[];
  cyclePhase?: CyclePhaseDay;
}

/** One AI-proposed event awaiting confirmation. */
interface ProposedEvent {
  ai: ScheduleAiEvent;
  whenLabel: string;
  repeatLabel: string;
  saving: boolean;
}

/** Per-member stable overlay color. */
interface OverlayMember {
  userId: number;
  name: string;
  color: string;
}

/**
 * Family Calendar "Agenda" — the mobile-first twin of the live /family/calendar page, rebuilt on the shared
 * beta-ui "Strata" kit (`@use '../beta-ui/beta-kit'`). A phone-friendly AGENDA (a scrolling day-by-day list
 * of the visible 7-day window) replaces the desktop month/week grid: each day is a section with its events,
 * the read-only family overlay (color-coded per member, never an email), and a soft predicted cycle-phase
 * tag. Prev/next/today navigation walks the window a week at a time. A {@link BetaFab} + add-event
 * {@link BetaBottomSheet} create events; own events swipe to edit/delete; an optional "Schedule with AI"
 * box (gated on family.ai) turns free text into confirm cards. Pull-to-refresh, skeleton + empty + error +
 * "connect your Google Calendar" states round it out.
 *
 * DATA PARITY + PRIVACY: every byte comes from the SAME family-calendar Api the live page uses —
 * {@link Api.calendarStatus}, {@link Api.calendarEvents} (own), {@link Api.familyEvents} (read-only overlay,
 * display NAME only), {@link Api.cycleOverlay} (predicted spans only). Writes go through
 * {@link Api.createEvent} / {@link Api.updateEvent} / {@link Api.deleteEvent} / {@link Api.scheduleAiEvents}
 * VERBATIM; the input body is built exactly like the live editor. Connecting reuses the live Google OAuth
 * code flow ({@link Api.connectCalendar}); the secret + token never touch the client. The family overlay +
 * cycle layer are best-effort — a failure clears just that layer, the caller's own events stand.
 *
 * ISOLATION: gated by platform.mobile + the SAME family.use the live route carries; consumes the kit + the
 * SAME Api. No live page is imported or modified. Mobile-first (44px targets, safe-area), centers on
 * desktop, renders cleanly with ZERO data (the harness mocks the API).
 */
@Component({
  selector: 'app-family-calendar-mobile',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [ToastController],
  imports: [
    FormsModule, MatIconModule,
    BetaPullRefresh, BetaBottomSheet, BetaSwipeRow, BetaSkeleton,
    BetaFab, BetaToaster,
  ],
  template: `
    <!-- ─────────────── PULL-TO-REFRESH OWNS THE SCROLL ─────────────── -->
    <app-bs-pull-refresh class="fc-ptr" [busy]="refreshing()" (refresh)="reload()">
      <div class="fc-scroll" aria-live="polite">

        <!-- ─── IMMERSIVE HEADER ─── -->
        <header class="fc-hero">
          <p class="fc-hero__kicker"><mat-icon aria-hidden="true">event</mat-icon> Family</p>
          <h1 class="fc-hero__title">Calendar</h1>
          <p class="fc-hero__sub">Your week at a glance — events and family overlays in one agenda.</p>
        </header>

        @if (loadingStatus()) {
          <div class="fc-list" aria-hidden="true">
            <app-bs-skeleton width="60%" height="20px" radius="var(--r-pill)" />
            @for (n of skeletonCells; track n) {
              <app-bs-skeleton height="76px" radius="var(--r-tile)" />
            }
          </div>

        } @else if (statusError()) {
          <div class="fc-state">
            <span class="fc-state__orb"><mat-icon aria-hidden="true">cloud_off</mat-icon></span>
            <h2 class="fc-state__title">Couldn't load your calendar</h2>
            <p class="fc-state__body">Something went wrong reaching the calendar. Give it another go.</p>
            <button type="button" class="fc-state__cta" (click)="reload()">
              <mat-icon aria-hidden="true">refresh</mat-icon> Try again
            </button>
          </div>

        } @else if (!configured()) {
          <!-- server has no Google OAuth secret -->
          <div class="fc-state">
            <span class="fc-state__orb"><mat-icon aria-hidden="true">link_off</mat-icon></span>
            <h2 class="fc-state__title">Calendar isn't set up yet</h2>
            <p class="fc-state__body">Google Calendar connections aren't configured on this server. Once they are, you can connect here.</p>
          </div>

        } @else if (!connected()) {
          <!-- warm connect panel -->
          <div class="fc-connect">
            <span class="fc-connect__orb"><mat-icon aria-hidden="true">calendar_month</mat-icon></span>
            <h2 class="fc-connect__title">Connect your Google Calendar</h2>
            <p class="fc-connect__body">
              See your events here and (when you choose) share them with your household. We only request the
              minimal calendar access — your account stays in Google.
            </p>
            <button type="button" class="fc-connect__cta" [disabled]="connecting()" (click)="connect()">
              @if (connecting()) { <span class="fc-spin" aria-hidden="true"></span> Connecting… }
              @else { <mat-icon aria-hidden="true">link</mat-icon> Connect calendar }
            </button>
          </div>

        } @else {
          <!-- ─── WEEK NAV ─── -->
          <div class="fc-nav">
            <button type="button" class="fc-nav__btn" aria-label="Previous week" (click)="prevWeek()">
              <mat-icon aria-hidden="true">chevron_left</mat-icon>
            </button>
            <button type="button" class="fc-nav__range" (click)="today()" [class.is-today]="isCurrentWeek()">
              <span class="fc-nav__range-label">{{ rangeLabel() }}</span>
              @if (!isCurrentWeek()) { <span class="fc-nav__today-hint">Today</span> }
            </button>
            <button type="button" class="fc-nav__btn" aria-label="Next week" (click)="nextWeek()">
              <mat-icon aria-hidden="true">chevron_right</mat-icon>
            </button>
          </div>

          @if (scopeWarn()) {
            <p class="fc-scopewarn">
              <mat-icon aria-hidden="true">warning_amber</mat-icon>
              Calendar access wasn't fully granted. Disconnect &amp; reconnect to fix it.
            </p>
          }

          <!-- overlay legend (only when someone shares) -->
          @if (overlayMembers().length) {
            <button type="button" class="fc-legend" [class.is-off]="!showOverlay()" (click)="toggleOverlay()"
                    [attr.aria-pressed]="showOverlay()">
              <mat-icon aria-hidden="true">{{ showOverlay() ? 'visibility' : 'visibility_off' }}</mat-icon>
              <span class="fc-legend__chips">
                @for (m of overlayMembers(); track m.userId) {
                  <span class="fc-legend__chip">
                    <span class="fc-legend__dot" [style.background]="m.color"></span>{{ m.name }}
                  </span>
                }
              </span>
            </button>
          }

          @if (loadingEvents()) {
            <div class="fc-list" aria-hidden="true">
              @for (n of skeletonCells; track n) {
                <app-bs-skeleton height="76px" radius="var(--r-tile)" />
              }
            </div>

          } @else if (eventsError()) {
            <div class="fc-state">
              <span class="fc-state__orb"><mat-icon aria-hidden="true">error_outline</mat-icon></span>
              <h2 class="fc-state__title">Couldn't load events</h2>
              <p class="fc-state__body">We hit a snag loading this week. Try again.</p>
              <button type="button" class="fc-state__cta" (click)="refresh()">
                <mat-icon aria-hidden="true">refresh</mat-icon> Try again
              </button>
            </div>

          } @else if (agendaDays().length) {
            <!-- ─── AGENDA: day-by-day sections ─── -->
            <div class="fc-agenda">
              @for (day of agendaDays(); track day.iso) {
                <section class="fc-day">
                  <div class="fc-day__head" [class.is-today]="day.isToday">
                    <span class="fc-day__heading">{{ day.heading }}</span>
                    @if (day.isToday) { <span class="fc-day__badge">Today</span> }
                    @if (day.cyclePhase; as ph) {
                      <span class="fc-day__phase" [class.is-period]="ph.kind === 'period'"
                            [title]="cyclePhaseLabel(ph)">
                        <mat-icon aria-hidden="true">{{ ph.kind === 'period' ? 'water_drop' : 'spa' }}</mat-icon>
                      </span>
                    }
                  </div>

                  <div class="fc-day__events">
                    @for (e of day.events; track $index) {
                      @if (!e.overlay) {
                        <app-bs-swipe-row class="fc-swipe" leftLabel="Delete" rightLabel="Edit"
                          [disabled]="isBusy(e.ev.id)" [label]="e.ev.title"
                          (swipe)="onSwipe(e.ev, $event)">
                          <button type="button" class="fc-ev" (click)="openEdit(e.ev)"
                                  [class.is-busy]="isBusy(e.ev.id)" [attr.aria-label]="evAria(e)">
                            <span class="fc-ev__rail" aria-hidden="true"></span>
                            <span class="fc-ev__body">
                              <span class="fc-ev__title">{{ e.ev.title }}</span>
                              <span class="fc-ev__meta">
                                <mat-icon aria-hidden="true">schedule</mat-icon>{{ e.timeLabel }}
                                @if (e.ev.isRecurring) { <mat-icon class="fc-ev__rep" aria-hidden="true" title="Repeats">repeat</mat-icon> }
                                @if (e.ev.location) { · {{ e.ev.location }} }
                              </span>
                            </span>
                            <mat-icon class="fc-ev__go" aria-hidden="true">chevron_right</mat-icon>
                          </button>
                        </app-bs-swipe-row>
                      } @else {
                        <!-- read-only family-overlay event -->
                        <div class="fc-ev fc-ev--overlay" [attr.aria-label]="evAria(e)">
                          <span class="fc-ev__rail" aria-hidden="true" [style.background]="e.color"></span>
                          <span class="fc-ev__body">
                            <span class="fc-ev__title">{{ e.ev.title }}</span>
                            <span class="fc-ev__meta">
                              <mat-icon aria-hidden="true">schedule</mat-icon>{{ e.timeLabel }}
                              · <mat-icon class="fc-ev__owner-ic" aria-hidden="true">person</mat-icon>{{ e.memberName }}
                            </span>
                          </span>
                          <mat-icon class="fc-ev__lock" aria-hidden="true" title="View only">lock</mat-icon>
                        </div>
                      }
                    }
                  </div>
                </section>
              }
            </div>
            <p class="fc-foot" aria-hidden="true">Swipe your event left to delete · right to edit</p>

          } @else {
            <!-- EMPTY week -->
            <div class="fc-empty">
              <span class="fc-empty__orb"><mat-icon aria-hidden="true">event_available</mat-icon></span>
              <h2 class="fc-empty__title">Nothing this week</h2>
              <p class="fc-empty__body">No events {{ rangeLabel() }}. Tap the + to add one.</p>
              <button type="button" class="fc-empty__cta" (click)="openCreate()">
                <mat-icon aria-hidden="true">add</mat-icon> New event
              </button>
            </div>
          }
        }
      </div>
    </app-bs-pull-refresh>

    <!-- ─── CREATE FAB (only when connected) ─── -->
    @if (connected() && !loadingStatus() && !statusError()) {
      <app-bs-fab icon="add" label="New event" [extended]="true" [fixed]="true" (action)="openCreate()" />
    }

    <!-- ─────────────── ADD / EDIT EVENT SHEET ─────────────── -->
    <app-bs-sheet [(open)]="formOpen" detent="full" [dismissable]="!saving()"
                  [label]="editing() ? 'Edit event' : 'New event'">
      <form class="ef" (ngSubmit)="save()">
        <div class="ef__head">
          <h3 class="ef__title">{{ editing() ? 'Edit event' : 'New event' }}</h3>
          <button type="button" class="ef__close" (click)="closeForm()" aria-label="Cancel" [disabled]="saving()">
            <mat-icon aria-hidden="true">close</mat-icon>
          </button>
        </div>

        <!-- Schedule with AI (gated) -->
        @if (canScheduleAi() && !editing()) {
          <div class="ef__ai">
            <label class="ef__label" for="fc-ai">
              <mat-icon class="ef__label-ic" aria-hidden="true">auto_awesome</mat-icon> Quick add with AI
            </label>
            <div class="ef__ai-row">
              <input id="fc-ai" class="ef__input" type="text" [ngModel]="aiText()" name="aitext"
                     (ngModelChange)="aiText.set($event)" placeholder="soccer every Tuesday at 4pm"
                     autocomplete="off" [disabled]="aiBusy()" />
              <button type="button" class="ef__ai-go" [disabled]="aiBusy() || !aiText().trim()" (click)="scheduleWithAi()">
                @if (aiBusy()) { <span class="fc-spin" aria-hidden="true"></span> }
                @else { <mat-icon aria-hidden="true">arrow_upward</mat-icon> }
              </button>
            </div>
            @if (aiStatus()) { <p class="ef__ai-status" aria-live="polite">{{ aiStatus() }}</p> }
            @for (p of proposals(); track $index) {
              <div class="ef__prop">
                <div class="ef__prop-body">
                  <span class="ef__prop-title">{{ p.ai.title }}</span>
                  <span class="ef__prop-when">{{ p.whenLabel }}@if (p.repeatLabel) { · {{ p.repeatLabel }} }</span>
                </div>
                <button type="button" class="ef__prop-add" [disabled]="p.saving" (click)="addProposal(p)">
                  @if (p.saving) { <span class="fc-spin" aria-hidden="true"></span> }
                  @else { <mat-icon aria-hidden="true">add</mat-icon> }
                </button>
                <button type="button" class="ef__prop-x" [disabled]="p.saving" (click)="dismissProposal(p)" aria-label="Discard">
                  <mat-icon aria-hidden="true">close</mat-icon>
                </button>
              </div>
            }
            <div class="ef__or"><span>or enter it yourself</span></div>
          </div>
        }

        <label class="ef__field">
          <span class="ef__label">Title</span>
          <input class="ef__input" type="text" [ngModel]="fTitle()" (ngModelChange)="fTitle.set($event)"
                 name="title" placeholder="e.g. Dentist" autocomplete="off" maxlength="200" required />
        </label>

        <button type="button" class="ef__toggle" [class.is-on]="fAllDay()" (click)="fAllDay.set(!fAllDay())">
          <mat-icon aria-hidden="true">{{ fAllDay() ? 'event' : 'schedule' }}</mat-icon>
          <span class="ef__toggle-txt">All-day event</span>
          <span class="ef__switch" [class.is-on]="fAllDay()" aria-hidden="true"><span class="ef__switch-knob"></span></span>
        </button>

        <div class="ef__row">
          <label class="ef__field ef__field--sm">
            <span class="ef__label">Date</span>
            <input class="ef__input" type="date" [ngModel]="fDate()" (ngModelChange)="fDate.set($event)" name="date" required />
          </label>
          @if (!fAllDay()) {
            <label class="ef__field ef__field--sm">
              <span class="ef__label">Start</span>
              <input class="ef__input" type="time" [ngModel]="fStart()" (ngModelChange)="fStart.set($event)" name="start" />
            </label>
            <label class="ef__field ef__field--sm">
              <span class="ef__label">End</span>
              <input class="ef__input" type="time" [ngModel]="fEnd()" (ngModelChange)="fEnd.set($event)" name="end" />
            </label>
          }
        </div>

        <label class="ef__field">
          <span class="ef__label">Repeats</span>
          <select class="ef__input" [ngModel]="fRecurrence()" (ngModelChange)="fRecurrence.set($event)" name="recur">
            <option value="none">Doesn't repeat</option>
            <option value="daily">Every day</option>
            <option value="weekly">Every week</option>
            <option value="weekdays">Weekdays (Mon–Fri)</option>
            <option value="monthly">Every month</option>
          </select>
        </label>

        <label class="ef__field">
          <span class="ef__label">Location</span>
          <input class="ef__input" type="text" [ngModel]="fLocation()" (ngModelChange)="fLocation.set($event)"
                 name="loc" placeholder="Optional" autocomplete="off" maxlength="300" />
        </label>

        <label class="ef__field">
          <span class="ef__label">Notes</span>
          <textarea class="ef__input ef__area" rows="2" [ngModel]="fNotes()" (ngModelChange)="fNotes.set($event)"
                    name="notes" placeholder="Optional"></textarea>
        </label>

        <div class="ef__actions">
          @if (editing()) {
            <button type="button" class="ef__btn ef__btn--del" [disabled]="saving()" (click)="removeEditing()">
              <mat-icon aria-hidden="true">delete_outline</mat-icon> Delete
            </button>
          } @else {
            <button type="button" class="ef__btn ef__btn--ghost" (click)="closeForm()" [disabled]="saving()">Cancel</button>
          }
          <button type="submit" class="ef__btn ef__btn--save" [disabled]="!canSave()">
            @if (saving()) { <span class="fc-spin" aria-hidden="true"></span> Saving… }
            @else { <mat-icon aria-hidden="true">check</mat-icon> {{ editing() ? 'Save' : 'Add event' }} }
          </button>
        </div>
      </form>
    </app-bs-sheet>

    <app-bs-toaster />
  `,
  styleUrl: './family-calendar-mobile.page.scss',
})
export class FamilyCalendarMobilePage implements OnDestroy {
  private api = inject(Api);
  private auth = inject(AuthService);
  private toast = inject(ToastController);

  /** The OAuth code client lives on window via GIS, loaded on demand by ensureGis() before connect(). */
  private get gis(): any {
    return (window as unknown as { google?: any }).google;
  }

  /** Schedule-from-text is generative → needs family.ai (else the server 403s). */
  readonly canScheduleAi = computed(() => {
    this.auth.permissions();
    return this.auth.hasPermission(PERM.familyAi);
  });

  readonly status = signal<CalendarStatus | null>(null);
  readonly loadingStatus = signal(true);
  readonly statusError = signal(false);
  readonly connecting = signal(false);

  readonly events = signal<CalendarEvent[]>([]);
  readonly loadingEvents = signal(false);
  readonly eventsError = signal(false);
  readonly refreshing = signal(false);

  readonly familyEvents = signal<FamilyMemberEvents[]>([]);
  readonly cyclePhases = signal<CycleOverlayMember[]>([]);
  readonly showOverlay = signal(true);

  /** The Sunday (local midnight) anchoring the visible 7-day window. */
  readonly weekStart = signal<Date>(this.sundayOf(new Date()));

  readonly skeletonCells = Array.from({ length: 5 }, (_, i) => i);

  private static readonly OVERLAY_PALETTE = [
    '#f59e0b', '#a855f7', '#ec4899', '#10b981', '#3b82f6', '#ef4444', '#14b8a6', '#f97316',
  ];

  readonly connected = computed(() => this.status()?.connected === true);
  readonly configured = computed(() => this.status()?.configured !== false);
  readonly scopeWarn = computed(() => this.connected() && this.status()?.scopeOk === false);

  /** userId → stable overlay color, derived from the sharing members (sorted by userId). */
  readonly overlayMembers = computed<OverlayMember[]>(() => {
    const sorted = [...this.familyEvents()].sort((a, b) => a.userId - b.userId);
    return sorted.map((m, i) => ({
      userId: m.userId,
      name: m.name,
      color: FamilyCalendarMobilePage.OVERLAY_PALETTE[i % FamilyCalendarMobilePage.OVERLAY_PALETTE.length],
    }));
  });

  /** "YYYY-MM-DD" → predicted phase covering the day (period beats fertile). */
  private readonly cyclePhaseByDay = computed<Map<string, CyclePhaseDay>>(() => {
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
    const byDay = new Map<string, CyclePhaseDay>();
    for (const [iso, day] of acc) {
      if (day.period.length) byDay.set(iso, { kind: 'period', names: day.period });
      else if (day.fertile.length) byDay.set(iso, { kind: 'fertile', names: day.fertile });
    }
    return byDay;
  });

  /** "YYYY-MM-DD" → all events (own + overlay when shown). */
  private readonly eventsByDay = computed<Map<string, AgendaEvent[]>>(() => {
    const byDay = new Map<string, AgendaEvent[]>();
    const push = (iso: string, e: AgendaEvent) => {
      const arr = byDay.get(iso) ?? [];
      arr.push(e);
      byDay.set(iso, arr);
    };
    for (const ev of this.events()) {
      for (const iso of this.spannedDays(ev)) {
        push(iso, { ev, timeLabel: this.rangeFor(ev), overlay: false });
      }
    }
    if (this.showOverlay()) {
      const colorOf = new Map(this.overlayMembers().map((m) => [m.userId, m.color]));
      for (const member of this.familyEvents()) {
        const color = colorOf.get(member.userId);
        for (const item of member.events) {
          const ev = this.overlayToEvent(item, member.userId);
          for (const iso of this.spannedDays(ev)) {
            push(iso, { ev, timeLabel: this.rangeFor(ev), overlay: true, memberName: member.name, color });
          }
        }
      }
    }
    return byDay;
  });

  /** The visible week's days that have at least one event, in order, each with its events sorted. */
  readonly agendaDays = computed<AgendaDay[]>(() => {
    const start = this.weekStart();
    const todayIso = this.toLocalDate(new Date());
    const byDay = this.eventsByDay();
    const phaseByDay = this.cyclePhaseByDay();
    const out: AgendaDay[] = [];
    for (let i = 0; i < 7; i++) {
      const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      const iso = this.toLocalDate(date);
      const events = (byDay.get(iso) ?? []).slice().sort(this.compareEvents);
      if (events.length === 0) continue;
      out.push({
        iso,
        date,
        heading: date.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }),
        isToday: iso === todayIso,
        events,
        cyclePhase: phaseByDay.get(iso),
      });
    }
    return out;
  });

  /** "Jun 16 – 22, 2026" label for the visible week. */
  readonly rangeLabel = computed<string>(() => {
    const start = this.weekStart();
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
    const sameMonth = start.getMonth() === end.getMonth();
    const fmtStart = start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const fmtEnd = end.toLocaleDateString(undefined,
      sameMonth ? { day: 'numeric', year: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
    return `${fmtStart} – ${fmtEnd}`;
  });

  readonly isCurrentWeek = computed<boolean>(() =>
    this.toLocalDate(this.weekStart()) === this.toLocalDate(this.sundayOf(new Date())));

  // ---- per-event busy + edit form ----
  private readonly busyIds = signal<Set<string>>(new Set());

  readonly formOpen = signal(false);
  readonly editing = signal<CalendarEvent | null>(null);
  readonly saving = signal(false);

  readonly fTitle = signal('');
  readonly fDate = signal('');
  readonly fStart = signal('09:00');
  readonly fEnd = signal('10:00');
  readonly fAllDay = signal(false);
  readonly fLocation = signal('');
  readonly fNotes = signal('');
  readonly fRecurrence = signal<CalendarRecurrence>('none');

  readonly canSave = computed(() => this.fTitle().trim().length > 0 && this.fDate().length > 0 && !this.saving());

  // ---- Schedule with AI ----
  readonly aiText = signal('');
  readonly aiBusy = signal(false);
  readonly aiStatus = signal('');
  readonly proposals = signal<ProposedEvent[]>([]);

  constructor() {
    void this.loadStatus();
  }

  ngOnDestroy(): void {}

  // ─────────────── LOAD ───────────────

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

  /** Pull-to-refresh: re-check status + reload the week. */
  async reload(): Promise<void> {
    const initial = this.loadingStatus();
    if (!initial) this.refreshing.set(true);
    try {
      const s = await firstValueFrom(this.api.calendarStatus());
      this.status.set(s);
      this.statusError.set(false);
      if (s.connected) await this.loadEvents({ silent: true });
    } catch {
      if (initial) this.statusError.set(true);
    } finally {
      this.loadingStatus.set(false);
      if (!initial) {
        this.refreshing.set(false);
        this.toast.show('Calendar refreshed', { tone: 'success', durationMs: 1500 });
      }
    }
  }

  /** Manual refresh of just the events (after an error). */
  async refresh(): Promise<void> {
    if (this.connected()) await this.loadEvents();
  }

  private visibleRange(): { start: Date; end: Date } {
    const start = this.weekStart();
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7);
    return { start, end };
  }

  private async loadEvents(opts: { silent?: boolean } = {}): Promise<void> {
    const silent = opts.silent === true;
    if (!silent) this.loadingEvents.set(true);
    this.eventsError.set(false);
    const { start, end } = this.visibleRange();
    try {
      const list = await firstValueFrom(this.api.calendarEvents(start.toISOString(), end.toISOString()));
      this.events.set(list ?? []);
    } catch {
      if (!silent) { this.eventsError.set(true); this.events.set([]); }
    } finally {
      if (!silent) this.loadingEvents.set(false);
    }
    // Best-effort overlays — a failure clears just that layer.
    void this.loadFamilyEvents(start, end);
    void this.loadCyclePhases(start, end);
  }

  private async loadFamilyEvents(start: Date, end: Date): Promise<void> {
    try {
      const members = await firstValueFrom(this.api.familyEvents(start.toISOString(), end.toISOString()));
      this.familyEvents.set(members ?? []);
    } catch {
      this.familyEvents.set([]);
    }
  }

  private async loadCyclePhases(start: Date, end: Date): Promise<void> {
    try {
      const members = await firstValueFrom(this.api.cycleOverlay(start.toISOString(), end.toISOString()));
      this.cyclePhases.set(members ?? []);
    } catch {
      this.cyclePhases.set([]);
    }
  }

  // ─────────────── WEEK NAV ───────────────

  prevWeek(): void { this.shiftWeek(-7); }
  nextWeek(): void { this.shiftWeek(7); }

  today(): void {
    this.weekStart.set(this.sundayOf(new Date()));
    void this.loadEvents();
  }

  private shiftWeek(days: number): void {
    const s = this.weekStart();
    this.weekStart.set(new Date(s.getFullYear(), s.getMonth(), s.getDate() + days));
    void this.loadEvents();
  }

  toggleOverlay(): void { this.showOverlay.set(!this.showOverlay()); }

  // ─────────────── CONNECT (reuse the live Google OAuth code flow) ───────────────

  async connect(): Promise<void> {
    if (this.connecting()) return;
    this.connecting.set(true);
    try {
      const cfg = await firstValueFrom(this.auth.config());
      if (!cfg.googleClientId) {
        this.toast.show('Google sign-in isn’t configured on this server.', { tone: 'warn' });
        return;
      }
      await ensureGis();
      const code = await this.requestAuthCode(cfg.googleClientId);
      await firstValueFrom(this.api.connectCalendar(code, 'postmessage'));
      await this.loadStatus();
      this.toast.show('Calendar connected', { tone: 'success', durationMs: 1800 });
    } catch (e) {
      if ((e as Error)?.message !== 'cancelled') {
        this.toast.show(this.messageOf(e, "Couldn't connect your calendar — try again."), { tone: 'warn' });
      }
    } finally {
      this.connecting.set(false);
    }
  }

  private requestAuthCode(clientId: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const client = this.gis.accounts.oauth2.initCodeClient({
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
          reject(new Error(err?.type === 'popup_closed' ? 'cancelled' : err?.type || 'oauth_failed'));
        },
      });
      client.requestCode();
    });
  }

  // ─────────────── per-event busy ───────────────

  isBusy(id: string): boolean { return this.busyIds().has(id); }

  private setBusy(id: string, on: boolean): void {
    this.busyIds.update((set) => {
      const next = new Set(set);
      if (on) next.add(id); else next.delete(id);
      return next;
    });
  }

  // ─────────────── ADD / EDIT FORM ───────────────

  openCreate(): void {
    this.editing.set(null);
    this.seedForm(null);
    this.clearAi();
    this.formOpen.set(true);
  }

  openEdit(ev: CalendarEvent): void {
    this.editing.set(ev);
    this.seedForm(ev);
    this.clearAi();
    this.formOpen.set(true);
  }

  closeForm(): void {
    if (this.saving()) return;
    this.formOpen.set(false);
  }

  /** A swipe on an own event: left = delete, right = edit. */
  onSwipe(ev: CalendarEvent, side: 'left' | 'right'): void {
    if (side === 'left') void this.remove(ev);
    else this.openEdit(ev);
  }

  private seedForm(ev: CalendarEvent | null): void {
    if (ev) {
      const start = ev.startUtc ? new Date(ev.startUtc) : new Date();
      const end = ev.endUtc ? new Date(ev.endUtc) : new Date(start.getTime() + 60 * 60 * 1000);
      this.fTitle.set(ev.title ?? '');
      this.fDate.set(this.toLocalDate(start));
      this.fAllDay.set(ev.allDay === true);
      this.fStart.set(this.toLocalTime(start));
      this.fEnd.set(this.toLocalTime(end));
      this.fLocation.set(ev.location ?? '');
      this.fNotes.set(ev.description ?? '');
      this.fRecurrence.set('none');
    } else {
      // Seed to the first visible day (or today if it's in range), 9–10am.
      const seed = this.isCurrentWeek() ? new Date() : this.weekStart();
      this.fTitle.set('');
      this.fDate.set(this.toLocalDate(seed));
      this.fAllDay.set(false);
      this.fStart.set('09:00');
      this.fEnd.set('10:00');
      this.fLocation.set('');
      this.fNotes.set('');
      this.fRecurrence.set('none');
    }
  }

  /** Build the create/update body exactly like the live editor (local date/time → UTC ISO). */
  private buildInput(): CalendarEventInput {
    const date = this.fDate();
    const allDay = this.fAllDay();
    let startIso: string;
    let endIso: string;
    if (allDay) {
      const s = this.parseLocal(date, '00:00');
      // All-day end is exclusive (next midnight).
      const e = new Date(s.getFullYear(), s.getMonth(), s.getDate() + 1);
      startIso = s.toISOString();
      endIso = e.toISOString();
    } else {
      const s = this.parseLocal(date, this.fStart() || '09:00');
      let e = this.parseLocal(date, this.fEnd() || '10:00');
      // Guard a non-positive range: default to +1h.
      if (e.getTime() <= s.getTime()) e = new Date(s.getTime() + 60 * 60 * 1000);
      startIso = s.toISOString();
      endIso = e.toISOString();
    }
    return {
      title: this.fTitle().trim(),
      startUtc: startIso,
      endUtc: endIso,
      allDay,
      location: this.fLocation().trim() || null,
      description: this.fNotes().trim() || null,
      recurrence: this.fRecurrence(),
    };
  }

  async save(): Promise<void> {
    if (!this.canSave()) {
      if (!this.fTitle().trim()) this.toast.show('Give the event a title first.', { tone: 'warn' });
      return;
    }
    this.saving.set(true);
    const input = this.buildInput();
    const editRow = this.editing();
    try {
      if (editRow) {
        await firstValueFrom(this.api.updateEvent(editRow.id, input));
        this.toast.show('Event updated', { tone: 'success', durationMs: 1600 });
      } else {
        await firstValueFrom(this.api.createEvent(input));
        this.toast.show('Event added', { tone: 'success', durationMs: 1600 });
      }
      this.formOpen.set(false);
      await this.loadEvents({ silent: true });
    } catch (e) {
      this.toast.show(this.messageOf(e, "Couldn't save that event — try again."), { tone: 'warn' });
    } finally {
      this.saving.set(false);
    }
  }

  /** Delete the event currently open in the editor. */
  async removeEditing(): Promise<void> {
    const ev = this.editing();
    if (ev) await this.remove(ev);
  }

  async remove(ev: CalendarEvent): Promise<void> {
    if (this.isBusy(ev.id)) return;
    if (typeof confirm === 'function' && !confirm(`Delete “${ev.title}”? It'll be removed from your calendar.`)) return;
    this.setBusy(ev.id, true);
    try {
      await firstValueFrom(this.api.deleteEvent(ev.id));
      if (this.editing()?.id === ev.id) this.formOpen.set(false);
      this.toast.show('Event deleted', { tone: 'success', durationMs: 1600 });
      await this.loadEvents({ silent: true });
    } catch {
      this.toast.show("Couldn't delete that event — try again.", { tone: 'warn' });
    } finally {
      this.setBusy(ev.id, false);
    }
  }

  // ─────────────── SCHEDULE WITH AI ───────────────

  async scheduleWithAi(): Promise<void> {
    const text = this.aiText().trim();
    if (text.length === 0 || this.aiBusy()) return;
    this.aiBusy.set(true);
    this.aiStatus.set('Reading your request…');
    this.proposals.set([]);
    try {
      const result = await firstValueFrom(this.api.scheduleAiEvents(text));
      const proposed = (result.events ?? []).map((ai) => this.toProposed(ai));
      this.proposals.set(proposed);
      if (proposed.length === 0) {
        this.aiStatus.set(result.notes?.trim() || 'I couldn\'t find an event in that. Try "dentist next Friday at 9am".');
      } else {
        this.aiStatus.set(result.notes?.trim() || `Review ${proposed.length === 1 ? 'the event' : 'these events'}, then add to your calendar.`);
      }
    } catch (e) {
      const status = (e as { status?: number })?.status;
      this.aiStatus.set(status === 503
        ? "AI scheduling isn't available right now. Add the event below instead."
        : this.messageOf(e, "I couldn't reach the AI just now. Add the event below instead."));
    } finally {
      this.aiBusy.set(false);
    }
  }

  async addProposal(p: ProposedEvent): Promise<void> {
    if (p.saving) return;
    this.setProposalSaving(p, true);
    try {
      await firstValueFrom(this.api.createEvent(this.inputFromProposal(p.ai)));
      this.dismissProposal(p);
      this.toast.show('Added to your calendar', { tone: 'success', durationMs: 1600 });
      await this.loadEvents({ silent: true });
    } catch (e) {
      this.setProposalSaving(p, false);
      this.toast.show(this.messageOf(e, "Couldn't add that event — try again."), { tone: 'warn' });
    }
  }

  dismissProposal(p: ProposedEvent): void {
    this.proposals.set(this.proposals().filter((x) => x !== p));
  }

  private clearAi(): void {
    this.aiText.set('');
    this.aiStatus.set('');
    this.proposals.set([]);
  }

  private setProposalSaving(p: ProposedEvent, saving: boolean): void {
    this.proposals.set(this.proposals().map((x) => (x === p ? { ...x, saving } : x)));
  }

  private toProposed(ai: ScheduleAiEvent): ProposedEvent {
    return { ai, whenLabel: this.proposalWhenLabel(ai), repeatLabel: this.recurrenceLabel(ai.recurrence), saving: false };
  }

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

  private recurrenceLabel(r: CalendarRecurrence | undefined): string {
    switch (r) {
      case 'daily': return 'Every day';
      case 'weekly': return 'Every week';
      case 'weekdays': return 'Weekdays';
      case 'monthly': return 'Every month';
      default: return '';
    }
  }

  // ─────────────── labels ───────────────

  evAria(e: AgendaEvent): string {
    if (e.overlay) {
      return `${e.ev.title}, ${e.timeLabel}, ${e.memberName ?? 'a family member'}'s event, view only.`;
    }
    return `${e.ev.title}, ${e.timeLabel}. Open to edit.`;
  }

  cyclePhaseLabel(phase: CyclePhaseDay | undefined): string {
    if (!phase) return '';
    const what = phase.kind === 'period' ? 'Predicted period' : 'Predicted fertile window';
    const who = phase.names.join(', ');
    return who ? `${what} · ${who}` : what;
  }

  // ─────────────── date/time helpers (browser local zone) ───────────────

  private sundayOf(d: Date): Date {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() - d.getDay());
  }

  private toLocalDate(d: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  private toLocalTime(d: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  /** Parse a local "YYYY-MM-DD" + "HH:mm" to a Date in the browser's local zone. */
  private parseLocal(date: string, time: string): Date {
    const dm = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
    const tm = /^(\d{2}):(\d{2})/.exec(time);
    const y = dm ? Number(dm[1]) : new Date().getFullYear();
    const mo = dm ? Number(dm[2]) - 1 : 0;
    const da = dm ? Number(dm[3]) : 1;
    const h = tm ? Number(tm[1]) : 0;
    const mi = tm ? Number(tm[2]) : 0;
    return new Date(y, mo, da, h, mi, 0, 0);
  }

  /** The local "YYYY-MM-DD" days an event touches (handles multi-day + all-day spans). */
  private spannedDays(ev: CalendarEvent): string[] {
    if (!ev.startUtc) return [];
    const start = new Date(ev.startUtc);
    let end = ev.endUtc ? new Date(ev.endUtc) : new Date(start.getTime() + 60 * 60 * 1000);
    if (ev.allDay) end = new Date(end.getTime() - 1);
    const days: string[] = [];
    const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    const last = new Date(end.getFullYear(), end.getMonth(), end.getDate());
    let guard = 0;
    while (cursor.getTime() <= last.getTime() && guard++ < 366) {
      days.push(this.toLocalDate(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }
    return days.length ? days : [this.toLocalDate(start)];
  }

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

  private parseIsoDate(iso: string): Date | null {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '');
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }

  /** "All day" or a "h:mm a – h:mm a" local range. */
  private rangeFor(ev: CalendarEvent): string {
    if (ev.allDay) return 'All day';
    if (!ev.startUtc) return '';
    const start = new Date(ev.startUtc).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    if (!ev.endUtc) return start;
    const end = new Date(ev.endUtc).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    return `${start} – ${end}`;
  }

  /** Adapt a read-only overlay item into the CalendarEvent shape (synthetic, non-editable id). */
  private overlayToEvent(
    item: { title: string; startUtc: string | null; endUtc: string | null; allDay: boolean },
    userId: number,
  ): CalendarEvent {
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

  private compareEvents = (a: AgendaEvent, b: AgendaEvent): number => {
    if (a.ev.allDay !== b.ev.allDay) return a.ev.allDay ? -1 : 1;
    const byTime = (a.ev.startUtc ?? '').localeCompare(b.ev.startUtc ?? '');
    if (byTime !== 0) return byTime;
    if (a.overlay !== b.overlay) return a.overlay ? 1 : -1;
    return 0;
  };

  private messageOf(e: unknown, fallback: string): string {
    const msg = (e as { error?: { message?: string } })?.error?.message;
    return typeof msg === 'string' && msg ? msg : fallback;
  }
}
