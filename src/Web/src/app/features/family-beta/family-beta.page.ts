import {
  ChangeDetectionStrategy, Component, DestroyRef, OnDestroy, computed, inject, signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatIconModule } from '@angular/material/icon';
import { catchError, firstValueFrom, of } from 'rxjs';

import { Api } from '../../core/api';
import { AuthService } from '../../core/auth';
import {
  FamilyAssistantAction, FamilyAssistantResult, FamilyBriefing, FamilyList, FamilyToday, Household,
  HouseholdMember, PERM,
} from '../../core/models';

import { OptimisticFamily } from './state/optimistic-family';
import {
  BetaBottomSheet, BetaFab, BetaPullRefresh, BetaToaster, ToastController,
} from '../beta-ui';
import { NowHero } from './cards/now-hero';
import { TodayRail } from './rail/today-rail';
import { ChoresCard } from './cards/chores-card';
import { ListsCard } from './cards/lists-card';
import { NotesCard } from './cards/notes-card';
import { HouseholdCard } from './cards/household-card';
import { RoomsDrawer } from './drawer/rooms-drawer';
import { WeatherCard } from './cards/weather-card';
import { LeaderboardCard } from './cards/leaderboard-card';

/** The execution status of a single proposed action card. */
type FbActionStatus = 'idle' | 'running' | 'done' | 'error';

/** One AI-proposed action plus its live tap state. Card identity is the stable `id` (track key). */
interface FbActionCard {
  id: number;
  action: FamilyAssistantAction;
  status: FbActionStatus;
  /** A short success/error line shown under the title once tapped. */
  note: string;
}

/**
 * Family "Hearth" — a NEW, beta-only mobile-first glance surface for the household, REBUILT on the shared
 * beta-ui "Strata" foundation (`@use '../beta-ui/beta-kit'`). It inverts the live family-home's "13-tile
 * nav grid first" into "glanceable today first, navigation last" for 390px: an immersive scrolling header
 * (server `greeting` + friendly `dateLabel` + quick-action chips + a family-finder button, safe-area
 * aware), a warm "Now" hero (next event → soonest timer → AI narrative → calm, with a live countdown +
 * mini today-timeline), a horizontal today rail (reminders + timers, urgency-first), then DEPTH glance
 * cards (Chores with a progress ring + swipe-to-done rows, Lists, Who's home avatars, Pinned notes,
 * Weather when present) with a staggered spring entrance, a collapsed Rooms drawer, and a fixed bottom
 * action bar — a prominent gradient "✨ Ask" {@link BetaFab} pill + a quick-add `+`. The scroll column IS
 * the kit {@link BetaPullRefresh} (a live accent ring tracks the pull). HOME-style toasts via
 * {@link ToastController}/{@link BetaToaster}; the Ask/Quick-add sheets are the kit {@link BetaBottomSheet}.
 *
 * Family-Hearth owns its SIGNATURE ACCENT — a warm AMBER → ROSE gradient — overriding the kit default on
 * its `:host`, so every kit component + every card reads it off the cascade and the whole screen re-skins.
 *
 * HARD ISOLATION: purely additive + gated by `platform.mobile` (+ `family.use`). It reuses the family
 * {@link Api} READ-mostly (the Today snapshot + briefing here; chores/household/presence inside their
 * cards) and the existing fast-action WRITE endpoints (quick-add, add list item, chore tick) only — it
 * NEVER modifies any live family page, imports NO `FamilyHome` internals (the `nextEvent`/`dateLabel`/
 * `initials` helpers are COPIED into the cards), does NOT touch the flagship tracker-beta or the kit
 * itself (it consumes them), and adds no npm deps.
 *
 * RESILIENCE: the shared Today snapshot + briefing load best-effort here (each its own `catchError`); each
 * self-loading card (chores / household) owns its own per-stream catch + skeleton/empty/failed; one dead
 * domain never blanks the page. Pull-to-refresh re-runs everything; a `visibilitychange` day-rollover
 * re-pulls the snapshot + briefing.
 *
 * SENSITIVE-DATA RULE: this mirrors the family-home LANDING, which excludes private overlays — so cycle
 * (mood/symptoms/intimacy), identity-map, and money totals are NEVER surfaced as glance data here. Finance
 * / Allowance appear only as perm-gated nav links inside the collapsed Rooms drawer.
 */
@Component({
  selector: 'app-family-beta',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './family-beta.page.scss',
  // Component-scoped so the page + every child card shares ONE optimistic store. Provided HERE rather than
  // on the route so the eager page-registry never references the value and the store stays inside this lazy
  // chunk. The /beta/family route file provides it too — both paths land on the same component-tree instance.
  providers: [ToastController, OptimisticFamily],
  imports: [
    FormsModule, RouterLink, MatIconModule,
    BetaPullRefresh, BetaBottomSheet, BetaFab, BetaToaster,
    NowHero, TodayRail, ChoresCard, ListsCard, NotesCard, HouseholdCard, WeatherCard, RoomsDrawer,
    LeaderboardCard,
  ],
  template: `
    <!-- The scroll column IS the kit pull-to-refresh (it owns overflow + the live accent spinner). -->
    <app-bs-pull-refresh class="fb-ptr" [busy]="refreshing()" (refresh)="refreshAll()">
      <div class="scroll">

        <!-- Immersive page header — greeting + date + quick actions; scrolls with
             the column (not the global app bar), reserving safe-area at the top. -->
        <header class="hh">
          <div class="hh__row">
            <div class="hh__text">
              <span class="hh__eyebrow"><span class="hh__spark" aria-hidden="true"></span> Family · Hearth</span>
              @if (dateLabel(); as dl) { <span class="hh__date">{{ dl }}</span> }
              <h1 class="hh__greet">{{ greeting() || 'Hi there' }}</h1>
            </div>
            <div class="hh__tools">
              <a class="hh__finder" routerLink="/family/household" aria-label="Household settings">
                <mat-icon aria-hidden="true">settings</mat-icon>
              </a>
              <a class="hh__finder" routerLink="/family/locations" aria-label="Where's everyone">
                <mat-icon aria-hidden="true">person_pin_circle</mat-icon>
              </a>
            </div>
          </div>
          <div class="hh__quick">
            <a class="hh__chip" routerLink="/family/calendar"><mat-icon aria-hidden="true">event</mat-icon> Calendar</a>
            <a class="hh__chip" routerLink="/family/lists"><mat-icon aria-hidden="true">checklist</mat-icon> Lists</a>
            <a class="hh__chip" routerLink="/family/chores"><mat-icon aria-hidden="true">cleaning_services</mat-icon> Chores</a>
            <a class="hh__chip" routerLink="/family/meals"><mat-icon aria-hidden="true">restaurant</mat-icon> Meals</a>
          </div>
        </header>

        <!-- Staggered spring entrance: each block animates in on a per-index delay (--i). -->
        <div class="rise" [style.--i]="0"><fb-now-hero [today]="today()" [briefing]="briefing()" /></div>
        <div class="rise" [style.--i]="1"><fb-today-rail [today]="today()" /></div>
        <div class="rise" [style.--i]="2"><fb-chores-card /></div>
        <div class="rise rise--defer" [style.--i]="3"><fb-lists-card [today]="today()" [loading]="loadingToday()" [failed]="failedToday()" /></div>
        <div class="rise rise--defer" [style.--i]="4"><fb-household-card /></div>
        <div class="rise rise--defer" [style.--i]="5"><fb-notes-card [today]="today()" [loading]="loadingToday()" [failed]="failedToday()" /></div>
        <div class="rise rise--defer" [style.--i]="6"><fb-leaderboard-card /></div>
        @if (today()?.weather; as w) {
          <div class="rise rise--defer" [style.--i]="7"><fb-weather-card [weather]="w" /></div>
        }
        <div class="rise rise--defer" [style.--i]="8"><fb-rooms-drawer /></div>

        <div class="scroll__foot" aria-hidden="true"></div>
      </div>
    </app-bs-pull-refresh>

    <!-- Fixed bottom action bar: a prominent gradient Ask pill + a secondary quick-add. The Ask pill is
         gated on family.ai.assistant — without it every ask 403s (a dead end), so we hide it (mirrors the
         desktop family-home, which hides the whole assistant box for those users). -->
    <nav class="actions" [class.actions--noai]="!canUseFamilyAssistant()" aria-label="Quick actions">
      @if (canUseFamilyAssistant()) {
        <app-bs-fab class="actions__ask" icon="auto_awesome" label="Ask" [extended]="true" (action)="openAsk()" />
      }
      <button type="button" class="actions__add" (click)="openQuickAdd()" aria-label="Quick add">
        <mat-icon aria-hidden="true">add</mat-icon>
      </button>
    </nav>

    <!-- ✨ Ask sheet — asks the assistant (read-only; it writes NOTHING). Kit bottom sheet. -->
    <app-bs-sheet [(open)]="askOpen" detent="half" label="Ask the family assistant">
      <div class="sheet">
        <h2 class="sheet__title"><mat-icon aria-hidden="true">auto_awesome</mat-icon> Ask anything</h2>
        <form class="sheet__form" (submit)="ask($event)">
          <input class="sheet__input" type="text" [(ngModel)]="askDraft" name="askDraft"
                 placeholder="What's on for today?" aria-label="Ask the family assistant"
                 autocomplete="off" enterkeyhint="send" />
          <button type="submit" class="sheet__send" [disabled]="!askDraft.trim() || asking()"
                  aria-label="Send">
            <mat-icon aria-hidden="true">arrow_upward</mat-icon>
          </button>
        </form>
        <p class="sheet__hint">The assistant answers — nothing changes until you tap an action below.</p>
        @if (asking()) { <p class="sheet__answer sheet__answer--load">Thinking…</p> }
        @else if (askError(); as e) { <p class="sheet__answer sheet__answer--err" aria-live="polite">{{ e }}</p> }
        @else if (askAnswer(); as a) {
          <p class="sheet__answer" aria-live="polite">{{ a }}</p>

          <!-- Proposed ACTION cards — each a tappable row that performs the write via the EXISTING endpoint
               (never the assistant). Nothing runs until the user taps. Per-row status + inline note/error. -->
          @if (askActions().length) {
            <ul class="acts" aria-label="Suggested actions">
              @for (c of askActions(); track c.id) {
                <li class="acts__row" [class.is-done]="c.status === 'done'" [class.is-err]="c.status === 'error'">
                  <button type="button" class="acts__btn"
                          [disabled]="c.status === 'running' || c.status === 'done'"
                          (click)="runAction(c)">
                    <span class="acts__ic" aria-hidden="true"><mat-icon>{{ iconFor(c.action.type) }}</mat-icon></span>
                    <span class="acts__body">
                      <span class="acts__title">{{ c.action.title }}</span>
                      @if (c.note) { <span class="acts__note">{{ c.note }}</span> }
                      @else { <span class="acts__verb">{{ buttonLabel(c.action.type) }}</span> }
                    </span>
                    <span class="acts__end" aria-hidden="true">
                      @if (c.status === 'running') { <mat-icon class="acts__spin">progress_activity</mat-icon> }
                      @else if (c.status === 'done') { <mat-icon>check_circle</mat-icon> }
                      @else if (c.status === 'error') { <mat-icon>refresh</mat-icon> }
                      @else { <mat-icon>chevron_right</mat-icon> }
                    </span>
                  </button>
                </li>
              }
            </ul>
          }
        }
      </div>
    </app-bs-sheet>

    <!-- + Quick-add sheet — one-line capture via the existing /family/quick-add endpoint. -->
    <app-bs-sheet [(open)]="addOpen" detent="peek" label="Quick add">
      <div class="sheet">
        <h2 class="sheet__title"><mat-icon aria-hidden="true">add_circle</mat-icon> Quick add</h2>
        <form class="sheet__form" (submit)="quickAdd($event)">
          <input class="sheet__input" type="text" [(ngModel)]="addDraft" name="addDraft"
                 placeholder="Milk, or 'remind me to call the dentist Tuesday'" aria-label="Quick add"
                 autocomplete="off" enterkeyhint="done" />
          <button type="submit" class="sheet__send" [disabled]="!addDraft.trim() || adding()"
                  aria-label="Add">
            <mat-icon aria-hidden="true">check</mat-icon>
          </button>
        </form>
        <p class="sheet__hint">We'll file it as a list item, reminder, or note automatically.</p>
      </div>
    </app-bs-sheet>

    <!-- One toaster host for the page's optimistic success/undo toasts. -->
    <app-bs-toaster />
  `,
})
export class FamilyBetaPage implements OnDestroy {
  private readonly api = inject(Api);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly optimistic = inject(OptimisticFamily);
  private readonly toasts = inject(ToastController);
  private readonly destroyRef = inject(DestroyRef);

  /**
   * The Ask FAB/sheet is gated on the permission the assistant endpoint requires — without
   * family.ai.assistant every ask 403s, a try-it-and-it-breaks dead end. Hide the FAB for those users
   * (mirrors the desktop family-home, which hides the whole assistant box). Re-runs on permission changes.
   */
  readonly canUseFamilyAssistant = computed(() => {
    this.auth.permissions();
    return this.auth.hasPermission(PERM.familyAiAssistant);
  });

  /** The household (lazy, best-effort) — used only to resolve a chore assignee NAME to a member userId. */
  private readonly household = signal<Household | null>(null);

  // ── shared best-effort sources (the page owns these; cards take them as inputs) ──
  private readonly _today = signal<FamilyToday | null>(null);
  private readonly _briefing = signal<FamilyBriefing | null>(null);
  readonly loadingToday = signal(true);
  readonly failedToday = signal(false);

  readonly today = computed(() => this._today());
  readonly briefing = computed(() => this._briefing());
  readonly greeting = computed(() => this._today()?.greeting ?? '');

  /** Friendly "Thursday, June 23" — COPIED from family-home.ts:127 (not imported). */
  readonly dateLabel = computed<string>(() => {
    const iso = this._today()?.dateLocal;
    if (!iso) return '';
    const d = new Date(`${iso}T00:00:00`);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  });

  // ── bottom-sheet state ──
  readonly askOpen = signal(false);
  readonly addOpen = signal(false);
  askDraft = '';
  addDraft = '';
  readonly asking = signal(false);
  readonly adding = signal(false);
  readonly askAnswer = signal<string | null>(null);
  readonly askError = signal<string | null>(null);
  /** The proposed action cards for the latest ask (each independently tappable). */
  readonly askActions = signal<FbActionCard[]>([]);
  private nextActionId = 1;

  /** True while a pull-to-refresh is in flight — drives the kit pull-refresh spinner. */
  readonly refreshing = signal(false);

  /** The local "YYYY-MM-DD" the snapshot was last loaded for, to detect a day rollover. */
  private snapshotDay = '';

  private readonly onVisibility = (): void => {
    if (document.visibilityState !== 'visible') return;
    if (this.localDay() !== this.snapshotDay) { this.loadToday(); this.loadBriefing(); }
  };

  constructor() {
    this.loadToday();
    this.loadBriefing();
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  ngOnDestroy(): void {
    document.removeEventListener('visibilitychange', this.onVisibility);
  }

  private loadToday(): void {
    this.snapshotDay = this.localDay();
    this.loadingToday.set(true);
    this.failedToday.set(false);
    this.api.familyToday()
      .pipe(catchError(() => { this.failedToday.set(true); return of<FamilyToday | null>(null); }), takeUntilDestroyed(this.destroyRef))
      .subscribe(t => { if (t) this._today.set(t); this.loadingToday.set(false); });
  }

  private loadBriefing(): void {
    // Briefing is always-200 server-side; a network blip just leaves the hero on its event/timer fallback.
    this.api.familyBriefing()
      .pipe(catchError(() => of<FamilyBriefing | null>(null)), takeUntilDestroyed(this.destroyRef))
      .subscribe(b => this._briefing.set(b));
  }

  /** Today's local "YYYY-MM-DD" (browser zone) for day-rollover detection. */
  private localDay(): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  /** Pull-to-refresh: re-pull the shared sources. Self-loading cards re-fetch on their own retry. */
  async refreshAll(): Promise<void> {
    this.refreshing.set(true);
    try {
      this.loadToday();
      this.loadBriefing();
      // Give the in-flight loads a beat so the spinner reads as real work, then settle.
      await new Promise(r => setTimeout(r, 450));
    } finally {
      this.refreshing.set(false);
    }
  }

  // ── Ask sheet ──
  openAsk(): void {
    this.askAnswer.set(null);
    this.askError.set(null);
    this.askActions.set([]);
    this.askOpen.set(true);
    // Warm the household lazily so a chore action can resolve an assignee NAME → member id (best-effort).
    if (!this.household()) {
      this.api.getHousehold()
        .pipe(catchError(() => of<Household | null>(null)), takeUntilDestroyed(this.destroyRef))
        .subscribe(h => { if (h) this.household.set(h); });
    }
  }

  async ask(ev: Event): Promise<void> {
    ev.preventDefault();
    const q = this.askDraft.trim();
    if (!q || this.asking()) return;
    this.asking.set(true);
    this.askAnswer.set(null);
    this.askError.set(null);
    this.askActions.set([]);
    try {
      const res: FamilyAssistantResult = await firstValueFrom(this.api.familyAssistant(q));
      this.askAnswer.set(res.answer ?? 'No answer.');
      // Materialise the proposed actions as tappable cards. Nothing writes until the user taps one.
      this.askActions.set((res.actions ?? []).map(action => ({
        id: this.nextActionId++, action, status: 'idle' as FbActionStatus, note: '',
      })));
    } catch {
      this.askError.set('The assistant is unavailable right now — try a room from the drawer.');
    } finally {
      this.asking.set(false);
    }
  }

  // ── Ask action cards: each maps to an EXISTING family write endpoint (the assistant wrote nothing). ──

  /** Execute one proposed action card. Only runs on the user's tap; per-card status + inline note/error. */
  async runAction(card: FbActionCard): Promise<void> {
    if (card.status === 'running' || card.status === 'done') return;
    this.patchAction(card.id, { status: 'running', note: '' });
    try {
      const note = await this.executeAction(card.action);
      this.patchAction(card.id, { status: 'done', note });
      if (note) this.toasts.show(note, { tone: 'success' });
      // A list/reminder write changes today's counts — re-pull the snapshot so the cards reflect it.
      const t = card.action.type;
      if (t === 'list_add' || t === 'reminder') this.loadToday();
    } catch (e) {
      this.patchAction(card.id, {
        status: 'error',
        note: this.actionError(e, "Couldn't do that just now — tap to retry."),
      });
    }
  }

  private async executeAction(action: FamilyAssistantAction): Promise<string> {
    switch (action.type) {
      case 'list_add': return this.execListAdd(action.params.listName, action.params.items);
      case 'reminder': return this.execReminder(action.params.text, action.params.whenLocal);
      case 'timer': return this.execTimer(action.params.label, action.params.durationSeconds);
      case 'calendar_event': return this.execCalendarEvent(action.params);
      case 'chore': return this.execChore(
        action.params.title, action.params.points, action.params.recurrence, action.params.assigneeName);
      case 'meal': return this.execMeal(
        action.params.title, action.params.ingredients, action.params.mealDateLocal);
    }
  }

  /** list_add: find the list by name (create a shopping/todo list if missing), then add items via the store. */
  private async execListAdd(listName: string, items: string[]): Promise<string> {
    const name = (listName || '').trim();
    const toAdd = (items ?? []).map(i => i.trim()).filter(Boolean);
    if (!name || toAdd.length === 0) throw new Error('Nothing to add.');

    const lists = await firstValueFrom(this.api.familyLists());
    let list: FamilyList | undefined = lists.find(l => l.name.trim().toLowerCase() === name.toLowerCase());
    if (!list) {
      const kind = /shop|grocer|market|store/i.test(name) ? 'shopping' : 'todo';
      list = await firstValueFrom(this.api.createFamilyList(name, kind));
    }
    const target = list;
    for (const text of toAdd) {
      // Reuse the shared optimistic store (no local list snapshot to bump here → no-op patch/rollback).
      const res = await this.optimistic.addListItem(target.id, text, () => {}, () => {});
      if (!res) throw new Error("Couldn't add item.");
    }
    const n = toAdd.length;
    return `Added ${n} ${n === 1 ? 'item' : 'items'} to ${target.name}.`;
  }

  /** reminder: createFamilyReminder. An empty whenLocal defaults to one hour from now (still useful). */
  private async execReminder(text: string, whenLocal: string): Promise<string> {
    const t = (text || '').trim();
    if (!t) throw new Error('No reminder text.');
    const due = this.localToUtcIso(whenLocal) ?? new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await firstValueFrom(this.api.createFamilyReminder({ text: t, dueUtc: due, recurrence: 'none' }));
    return 'Reminder set.';
  }

  /** timer: createFamilyTimer (durationSeconds clamped 5..86400). */
  private async execTimer(label: string, durationSeconds: number): Promise<string> {
    const seconds = Math.max(5, Math.min(86400, Math.round(durationSeconds || 0)));
    await firstValueFrom(
      this.api.createFamilyTimer({ label: (label || 'Timer').trim(), durationSeconds: seconds }));
    return 'Timer started.';
  }

  /**
   * calendar_event: calendar writes go to the user's real Google Calendar, so we never create silently.
   * On mobile there's no editor dialog here — navigate to the family calendar with the proposal prefilled
   * as query params (the desktop opens a prefilled editor; this is the mobile substitute) and close the sheet.
   */
  private async execCalendarEvent(p: {
    title: string; startLocal: string; endLocal: string; allDay: boolean; location: string; notes: string;
  }): Promise<string> {
    const queryParams: Record<string, string> = { seedTitle: p.title };
    if (p.startLocal) queryParams['seedStart'] = p.startLocal;
    if (p.endLocal) queryParams['seedEnd'] = p.endLocal;
    if (p.allDay) queryParams['seedAllDay'] = '1';
    if (p.location) queryParams['seedLocation'] = p.location;
    if (p.notes) queryParams['seedNotes'] = p.notes;
    this.askOpen.set(false);
    await this.router.navigate(['/family/calendar'], { queryParams });
    return 'Opening your calendar…';
  }

  /** chore: createFamilyChore. Resolve the assignee NAME to a member; unknown/blank → unassigned. */
  private async execChore(
    title: string, points: number, recurrence: 'none' | 'daily' | 'weekly', assigneeName: string,
  ): Promise<string> {
    const t = (title || '').trim();
    if (!t) throw new Error('No chore title.');
    const assignedToUserId = this.resolveMemberId(assigneeName);
    await firstValueFrom(this.api.createFamilyChore({
      title: t, points: Math.max(0, Math.round(points || 0)),
      recurrence: recurrence || 'none', assignedToUserId,
    }));
    const who = assignedToUserId != null ? this.memberName(assignedToUserId) : null;
    return who ? `Chore added for ${who}.` : 'Chore added.';
  }

  /** meal: createFamilyMeal. A bare local date (or today) + the dinner slot (the assistant picks no slot). */
  private async execMeal(title: string, ingredients: string, mealDateLocal: string): Promise<string> {
    const t = (title || '').trim();
    if (!t) throw new Error('No meal title.');
    const localDate =
      (mealDateLocal && mealDateLocal.length >= 8 ? mealDateLocal.slice(0, 10) : '') || this.localDay();
    await firstValueFrom(this.api.createFamilyMeal({
      localDate, slot: 'dinner', title: t, ingredients: (ingredients || '').trim() || undefined,
    }));
    return 'Added to the meal plan.';
  }

  // ── Action helpers ──

  /** Resolve a display name to a household member's userId (case-insensitive); null when blank/unknown. */
  private resolveMemberId(name: string): number | null {
    const n = (name || '').trim().toLowerCase();
    if (!n) return null;
    const members: HouseholdMember[] = this.household()?.members ?? [];
    const exact = members.find(m => m.name.trim().toLowerCase() === n);
    if (exact) return exact.userId;
    const partial = members.find(m => m.name.trim().toLowerCase().split(/\s+/)[0] === n);
    return partial?.userId ?? null;
  }

  private memberName(userId: number): string | null {
    return this.household()?.members.find(m => m.userId === userId)?.name ?? null;
  }

  /** Convert an offset-less LOCAL ISO string ("2026-06-23T15:00:00" or "2026-06-23") to a UTC ISO instant, or null. */
  private localToUtcIso(local: string): string | null {
    const s = (local || '').trim();
    if (!s) return null;
    const d = new Date(s.length <= 10 ? `${s}T00:00:00` : s);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  /** A friendly icon per action type (the confirm-row glyph). */
  iconFor(type: FamilyAssistantAction['type']): string {
    switch (type) {
      case 'list_add': return 'add_shopping_cart';
      case 'reminder': return 'notifications_active';
      case 'timer': return 'timer';
      case 'calendar_event': return 'event';
      case 'chore': return 'cleaning_services';
      case 'meal': return 'restaurant';
    }
  }

  /** The verb each tap performs, per action type. */
  buttonLabel(type: FamilyAssistantAction['type']): string {
    switch (type) {
      case 'list_add': return 'Add to list';
      case 'reminder': return 'Set reminder';
      case 'timer': return 'Start timer';
      case 'calendar_event': return 'Add to calendar';
      case 'chore': return 'Add chore';
      case 'meal': return 'Add meal';
    }
  }

  /** Patch one action card by id, re-emitting the array so the OnPush template re-renders. */
  private patchAction(id: number, patch: Partial<FbActionCard>): void {
    this.askActions.update(list => list.map(c => (c.id === id ? { ...c, ...patch } : c)));
  }

  /** Best-effort friendly message from an HttpErrorResponse, else a fallback. */
  private actionError(e: unknown, fallback: string): string {
    const err = e as { status?: number; error?: { message?: string; detail?: string } };
    if (err?.status === 403) return "That isn't available on your account.";
    if (err?.status === 503) return "The assistant isn't available right now.";
    return err?.error?.detail ?? err?.error?.message ?? (e instanceof Error ? e.message : fallback) ?? fallback;
  }

  // ── Quick-add sheet ──
  openQuickAdd(): void {
    this.addOpen.set(true);
  }

  async quickAdd(ev: Event): Promise<void> {
    ev.preventDefault();
    const text = this.addDraft.trim();
    if (!text || this.adding()) return;
    this.adding.set(true);
    try {
      const res = await firstValueFrom(this.api.quickAdd(text));
      this.addDraft = '';
      this.addOpen.set(false);
      this.toasts.show(res.summary || 'Added.', { tone: 'success' });
      // A list quick-add changes today's counts — re-pull the snapshot so the Lists card reflects it.
      if (res.kind === 'list' || res.kind === 'reminder') this.loadToday();
    } catch {
      this.toasts.show('Couldn’t add that', {
        tone: 'warn', actionLabel: 'Retry', onAction: () => void this.quickAdd(ev),
      });
    } finally {
      this.adding.set(false);
    }
  }
}
