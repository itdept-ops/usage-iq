import {
  ChangeDetectionStrategy, Component, DestroyRef, OnDestroy, computed, inject, signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatIconModule } from '@angular/material/icon';
import { MatSnackBar } from '@angular/material/snack-bar';
import { catchError, firstValueFrom, of } from 'rxjs';

import { Api } from '../../core/api';
import { FamilyAssistantResult, FamilyBriefing, FamilyToday } from '../../core/models';

import { PullToRefreshDirective } from '../beta/widgets/pull-to-refresh';
import { BottomSheet } from '../tracker-beta/ui/bottom-sheet';
import { NowHero } from './cards/now-hero';
import { TodayRail } from './rail/today-rail';
import { ChoresCard } from './cards/chores-card';
import { ListsCard } from './cards/lists-card';
import { NotesCard } from './cards/notes-card';
import { HouseholdCard } from './cards/household-card';
import { RoomsDrawer } from './drawer/rooms-drawer';
import { WeatherCard } from './cards/weather-card';

/**
 * Family "Hearth" — a NEW, beta-only mobile-first glance surface for the household. It inverts the live
 * family-home's "13-tile nav grid first" into "glanceable today first, navigation last" for 390px: a
 * fixed glass greeting strip (server `greeting` + friendly `dateLabel` + a presence-style household chip),
 * a warm "Now" hero (next event → soonest timer → AI narrative, never empty), a horizontal today rail
 * (reminders + timers, urgency-first), then vertical glance cards (Chores, Lists, Who's home, Pinned
 * notes, Weather when present), a collapsed Rooms drawer, and a fixed bottom action bar ("✨ Ask" + a
 * quick-add `+`).
 *
 * HARD ISOLATION: purely additive. It reuses the family {@link Api} READ-mostly (the Today snapshot +
 * briefing here; chores/household/presence inside their cards) and the existing fast-action WRITE
 * endpoints (quick-add, add list item, chore tick) only — it NEVER modifies any live family page, imports
 * NO `FamilyHome` internals (the `nextEvent`/`dateLabel`/`initials` helpers are COPIED into the cards),
 * and defines its OWN `--*` Hearth-ember tokens on `:host` (see family-beta.page.scss) — never `--tech-*`.
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
  imports: [
    FormsModule, RouterLink, MatIconModule, PullToRefreshDirective, BottomSheet,
    NowHero, TodayRail, ChoresCard, ListsCard, NotesCard, HouseholdCard, WeatherCard, RoomsDrawer,
  ],
  template: `
    <!-- Fixed glass greeting strip: greeting + date + a link to the family-finder. -->
    <header class="bar">
      <div class="bar__text">
        <span class="bar__greet">{{ greeting() || 'Hi there' }}</span>
        @if (dateLabel(); as dl) { <span class="bar__date">{{ dl }}</span> }
      </div>
      <a class="bar__finder" routerLink="/family/locations" aria-label="Where's everyone">
        <mat-icon aria-hidden="true">person_pin_circle</mat-icon>
      </a>
    </header>

    <!-- Thumb-scroll column. Pull-to-refresh re-runs all loads. -->
    <main class="scroll" (atrPullRefresh)="refreshAll()">
      <fb-now-hero [today]="today()" [briefing]="briefing()" />

      <fb-today-rail [today]="today()" />

      <fb-chores-card />

      <fb-lists-card [today]="today()" [loading]="loadingToday()" [failed]="failedToday()" />

      <fb-household-card />

      <fb-notes-card [today]="today()" [loading]="loadingToday()" [failed]="failedToday()" />

      @if (today()?.weather; as w) { <fb-weather-card [weather]="w" /> }

      <fb-rooms-drawer />

      <div class="scroll__foot" aria-hidden="true"></div>
    </main>

    <!-- Fixed bottom action bar: dominant Ask + secondary quick-add. -->
    <nav class="actions" aria-label="Quick actions">
      <button type="button" class="actions__ask" (click)="openAsk()">
        <mat-icon aria-hidden="true">auto_awesome</mat-icon> Ask
      </button>
      <button type="button" class="actions__add" (click)="openQuickAdd()" aria-label="Quick add">
        <mat-icon aria-hidden="true">add</mat-icon>
      </button>
    </nav>

    <!-- ✨ Ask sheet — asks the assistant (read-only; it writes NOTHING). Isolated, no live-page styles. -->
    <app-bottom-sheet [(open)]="askOpen" detent="half" label="Ask the family assistant">
      <div class="sheet">
        <h2 class="sheet__title">Ask anything</h2>
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
    </app-bottom-sheet>

    <!-- + Quick-add sheet — one-line capture via the existing /family/quick-add endpoint. -->
    <app-bottom-sheet [(open)]="addOpen" detent="peek" label="Quick add">
      <div class="sheet">
        <h2 class="sheet__title">Quick add</h2>
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
    </app-bottom-sheet>
  `,
})
export class FamilyBetaPage implements OnDestroy {
  private readonly api = inject(Api);
  private readonly snack = inject(MatSnackBar);
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
  refreshAll(): void {
    this.loadToday();
    this.loadBriefing();
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
      this.snack.open(res.summary || 'Added.', 'OK', { duration: 4000, politeness: 'polite' });
      // A list quick-add changes today's counts — re-pull the snapshot so the Lists card reflects it.
      if (res.kind === 'list' || res.kind === 'reminder') this.loadToday();
    } catch {
      this.snack.open('Couldn’t add that', 'Retry', { duration: 5000, politeness: 'polite' })
        .onAction().subscribe(() => void this.quickAdd(ev));
    } finally {
      this.adding.set(false);
    }
  }
}
