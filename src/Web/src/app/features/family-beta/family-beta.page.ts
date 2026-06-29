import {
  ChangeDetectionStrategy, Component, DestroyRef, OnDestroy, computed, inject, signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatIconModule } from '@angular/material/icon';
import { catchError, firstValueFrom, of } from 'rxjs';

import { Api } from '../../core/api';
import { FamilyAssistantResult, FamilyBriefing, FamilyToday } from '../../core/models';

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

        <!-- Immersive page header — greeting + date + quick actions, with an accent bloom; scrolls with
             the column (not the global app bar), reserving safe-area at the top. -->
        <header class="hh">
          <div class="hh__bloom" aria-hidden="true"></div>
          <div class="hh__row">
            <div class="hh__text">
              <span class="hh__eyebrow"><span class="hh__spark" aria-hidden="true"></span> Family · Hearth</span>
              @if (dateLabel(); as dl) { <span class="hh__date">{{ dl }}</span> }
              <h1 class="hh__greet">{{ greeting() || 'Hi there' }}</h1>
            </div>
            <a class="hh__finder" routerLink="/family/locations" aria-label="Where's everyone">
              <mat-icon aria-hidden="true">person_pin_circle</mat-icon>
            </a>
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

    <!-- Fixed bottom action bar: a prominent gradient Ask pill + a secondary quick-add. -->
    <nav class="actions" aria-label="Quick actions">
      <app-bs-fab class="actions__ask" icon="auto_awesome" label="Ask" [extended]="true" (action)="openAsk()" />
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
        <p class="sheet__hint">The assistant only answers — nothing is changed until you act on it in a room.</p>
        @if (asking()) { <p class="sheet__answer sheet__answer--load">Thinking…</p> }
        @else if (askAnswer(); as a) { <p class="sheet__answer" aria-live="polite">{{ a }}</p> }
        @else if (askError(); as e) { <p class="sheet__answer sheet__answer--err" aria-live="polite">{{ e }}</p> }
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
  private readonly toasts = inject(ToastController);
  private readonly destroyRef = inject(DestroyRef);

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
    this.askOpen.set(true);
  }

  async ask(ev: Event): Promise<void> {
    ev.preventDefault();
    const q = this.askDraft.trim();
    if (!q || this.asking()) return;
    this.asking.set(true);
    this.askAnswer.set(null);
    this.askError.set(null);
    try {
      const res: FamilyAssistantResult = await firstValueFrom(this.api.familyAssistant(q));
      this.askAnswer.set(res.answer ?? 'No answer.');
    } catch {
      this.askError.set('The assistant is unavailable right now — try a room from the drawer.');
    } finally {
      this.asking.set(false);
    }
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
