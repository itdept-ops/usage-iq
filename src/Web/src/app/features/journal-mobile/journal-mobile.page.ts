import {
  ChangeDetectionStrategy, Component, OnDestroy, computed, inject, signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { MatIconModule } from '@angular/material/icon';

import { Api } from '../../core/api';
import { AuthService } from '../../core/auth';
import {
  JournalDto, JournalEntryDto, JournalReflectionDto, JournalSummaryDto, PERM,
} from '../../core/models';
import {
  BetaPullRefresh, BetaBottomSheet, BetaSkeleton, BetaFab, BetaToaster, ToastController,
} from '../beta-ui';

interface MoodChoice { value: string; label: string; emoji: string; }

/**
 * Journal & Mood — the mobile-first twin of the live `/journal` page, rebuilt on the shared beta-ui "Strata"
 * kit (`@use '../beta-ui/beta-kit'`). One signature accent (a calm INDIGO → TEAL ramp) re-skins the whole
 * screen via the per-page accent contract. PRIVATE: a "this week" floored-AI reflection card + a deterministic
 * summary at the top, a compact scrollable recent-days list that doubles as the day picker, and a
 * {@link BetaBottomSheet} LOG-ENTRY editor (a mood + energy quick-picker, a vocab tag chooser, and the
 * gratitude + reflection free-text). Pull-to-refresh, skeletons, and elevated empty/error states round it out.
 *
 * DATA PARITY + PRIVACY: every read/write reuses the SAME owner-scoped, tracker.self-gated `/api/journal`
 * endpoints the live page uses — {@link Api.journal}, the partial day upsert {@link Api.upsertJournalDay} /
 * {@link Api.deleteJournalDay}, and the gentle floored {@link Api.journalReflection}. FREE-TEXT PRIVACY: the
 * gratitude + reflection text is owner-only and NEVER reaches the AI; only mood/energy/tag frequencies do.
 *
 * ISOLATION: gated by `platform.mobile` + the SAME `tracker.self` the live route carries; imports only the kit
 * + the shared Api/models. No live page is imported or modified.
 */
@Component({
  selector: 'app-journal-mobile',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [ToastController],
  imports: [
    FormsModule, MatIconModule,
    BetaPullRefresh, BetaBottomSheet, BetaSkeleton, BetaFab, BetaToaster,
  ],
  template: `
    <app-bs-pull-refresh class="jr-ptr" [busy]="refreshing()" (refresh)="reload()">
      <div class="jr-scroll" aria-live="polite">

        <header class="jr-hero">
          <div class="jr-hero__bloom" aria-hidden="true"></div>
          <p class="jr-hero__kicker"><mat-icon aria-hidden="true">menu_book</mat-icon> Journal</p>
          <h1 class="jr-hero__title">How was your day?</h1>
          <p class="jr-hero__sub">A gentle, private check-in — only you ever see your notes.</p>
        </header>

        @if (loading()) {
          <div class="jr-card" aria-hidden="true"><app-bs-skeleton height="96px" radius="var(--r-tile)" /></div>
          <div class="jr-card" aria-hidden="true"><app-bs-skeleton height="240px" radius="var(--r-tile)" /></div>

        } @else if (errored()) {
          <div class="jr-state">
            <span class="jr-state__orb"><mat-icon aria-hidden="true">cloud_off</mat-icon></span>
            <h2 class="jr-state__title">Couldn't load your journal</h2>
            <p class="jr-state__body">Something went wrong fetching your entries. Give it another go.</p>
            <button type="button" class="jr-state__cta" (click)="reload()">
              <mat-icon aria-hidden="true">refresh</mat-icon> Try again
            </button>
          </div>

        } @else {
          <!-- weekly reflection -->
          <section class="jr-reflect" aria-label="This week's reflection">
            <span class="jr-reflect__ic" aria-hidden="true"><mat-icon>auto_awesome</mat-icon></span>
            <div class="jr-reflect__body">
              <span class="jr-reflect__h">This week</span>
              @if (reflection(); as r) { <p class="jr-reflect__note">{{ r.note }}</p> }
              @else { <p class="jr-reflect__note is-muted">Log a few days to see a gentle reflection.</p> }
            </div>
          </section>

          <!-- summary -->
          @if (summary(); as s) {
            <section class="jr-summary" aria-label="Summary">
              <div class="jr-stat"><span class="jr-stat__v mono-num">{{ s.daysLogged }}</span><span class="jr-stat__l">days</span></div>
              <div class="jr-stat"><span class="jr-stat__v">{{ s.topMood ? moodEmoji(s.topMood) : '—' }}</span><span class="jr-stat__l">top mood</span></div>
              <div class="jr-stat"><span class="jr-stat__v mono-num">{{ s.avgEnergy != null ? s.avgEnergy : '—' }}</span><span class="jr-stat__l">avg energy</span></div>
              <div class="jr-stat"><span class="jr-stat__v">{{ s.topTag || '—' }}</span><span class="jr-stat__l">theme</span></div>
            </section>
          }

          <!-- recent days -->
          <section class="jr-recent" aria-label="Recent days">
            <h2 class="jr-recent__h"><mat-icon aria-hidden="true">history</mat-icon> Recent days</h2>
            @if (entries().length) {
              <div class="jr-recent__list">
                @for (e of entries(); track e.date) {
                  <button type="button" class="jr-row" (click)="pickDay(e.date)">
                    <span class="jr-row__emoji" aria-hidden="true">{{ moodEmoji(e.mood) || '·' }}</span>
                    <span class="jr-row__date">{{ friendlyDate(e.date) }}</span>
                    @if (e.mood) { <span class="jr-row__mood">{{ moodLabel(e.mood) }}</span> }
                    @if (e.tags?.length) { <span class="jr-row__tags">{{ e.tags?.length }} tag{{ e.tags?.length === 1 ? '' : 's' }}</span> }
                  </button>
                }
              </div>
            } @else {
              <div class="jr-empty">
                <span class="jr-empty__orb"><mat-icon aria-hidden="true">edit_note</mat-icon></span>
                <p class="jr-empty__body">No entries yet. Tap + to write your first one.</p>
              </div>
            }
          </section>
        }
      </div>
    </app-bs-pull-refresh>

    @if (!loading() && !errored()) {
      <app-bs-fab icon="add" label="Log entry" [extended]="true" [fixed]="true" (action)="openLog()" />
    }

    <!-- LOG ENTRY SHEET -->
    <app-bs-sheet [(open)]="logOpen" detent="full" [dismissable]="true" label="Log entry">
      <div class="ls">
        <div class="ls__head">
          <h3 class="ls__title">Log entry</h3>
          <button type="button" class="ls__close" (click)="logOpen.set(false)" aria-label="Close">
            <mat-icon aria-hidden="true">close</mat-icon>
          </button>
        </div>

        <div class="ls__daybar">
          <button type="button" class="ls__day-nav" (click)="prevDay()" aria-label="Previous day"><mat-icon aria-hidden="true">chevron_left</mat-icon></button>
          <div class="ls__day-now"><span class="ls__day-l">Editing</span><span class="ls__day-v">{{ logDateLabel() }}</span>
            @if (daySaving()) { <em class="ls__save">Saving…</em> } @else if (daySaved()) { <em class="ls__save is-ok">Saved</em> }
          </div>
          <button type="button" class="ls__day-nav" (click)="nextDay()" aria-label="Next day" [disabled]="logDate() >= today"><mat-icon aria-hidden="true">chevron_right</mat-icon></button>
        </div>
        @if (logDate() !== today) {
          <button type="button" class="ls__today" (click)="logToday()"><mat-icon aria-hidden="true">today</mat-icon> Jump to today</button>
        }

        <span class="ls__sub">Mood</span>
        <div class="ls__chips">
          @for (m of moodChoices; track m.value) {
            <button type="button" class="ls__chip" [class.is-on]="editMood() === m.value" (click)="toggleMood(m.value)">
              <span aria-hidden="true">{{ m.emoji }}</span> {{ m.label }}
            </button>
          }
        </div>

        <span class="ls__sub">Energy</span>
        <div class="ls__energy">
          @for (e of energyLevels; track e) {
            <button type="button" class="ls__dot" [class.is-on]="(editEnergy() ?? 0) >= e" (click)="selectEnergy(e)" [attr.aria-label]="'Energy ' + e + ' of 5'"></button>
          }
        </div>

        <span class="ls__sub">Tags</span>
        <div class="ls__chips">
          @for (t of tagChoices; track t) {
            <button type="button" class="ls__chip" [class.is-on]="isTagOn(t)" (click)="toggleTag(t)">{{ t }}</button>
          }
        </div>

        <label class="ls__field">
          <span class="ls__label">Grateful for <i>(private)</i></span>
          <textarea class="ls__input ls__area" rows="2" [ngModel]="editGratitude()" (ngModelChange)="onGratitudeChange($event)" name="jgrat" maxlength="500" placeholder="One thing you're grateful for…"></textarea>
        </label>
        <label class="ls__field">
          <span class="ls__label">Reflection <i>(private)</i></span>
          <textarea class="ls__input ls__area ls__area--lg" rows="4" [ngModel]="editReflection()" (ngModelChange)="onReflectionChange($event)" name="jrefl" maxlength="2000" placeholder="What happened, how it felt…"></textarea>
        </label>

        @if (hasDayEntry()) {
          <button type="button" class="ls__clear" (click)="clearDay()"><mat-icon aria-hidden="true">delete_outline</mat-icon> Clear this day</button>
        }

        <p class="ls__foot"><mat-icon aria-hidden="true">lock</mat-icon> Private to you — your notes are never sent to the AI.</p>
      </div>
    </app-bs-sheet>

    <app-bs-toaster />
  `,
  styleUrl: './journal-mobile.page.scss',
})
export class JournalMobilePage implements OnDestroy {
  private api = inject(Api);
  private auth = inject(AuthService);
  private toast = inject(ToastController);

  readonly loading = signal(true);
  readonly errored = signal(false);
  readonly refreshing = signal(false);

  readonly entries = signal<JournalEntryDto[]>([]);
  readonly summary = signal<JournalSummaryDto | null>(null);
  readonly reflection = signal<JournalReflectionDto | null>(null);

  readonly logOpen = signal(false);

  readonly moodChoices: readonly MoodChoice[] = [
    { value: 'great', label: 'Great', emoji: '😄' },
    { value: 'good', label: 'Good', emoji: '🙂' },
    { value: 'ok', label: 'Okay', emoji: '😐' },
    { value: 'low', label: 'Low', emoji: '😕' },
    { value: 'rough', label: 'Rough', emoji: '😣' },
  ];
  readonly tagChoices: readonly string[] = [
    'work', 'family', 'health', 'sleep', 'exercise', 'social',
    'rest', 'stress', 'creative', 'nature', 'learning', 'money',
  ];
  readonly energyLevels: readonly number[] = [1, 2, 3, 4, 5];

  readonly today = this.todayIso();
  readonly logDate = signal<string>(this.todayIso());

  readonly editMood = signal<string | null>(null);
  readonly editEnergy = signal<number | null>(null);
  readonly editTags = signal<Set<string>>(new Set());
  readonly editGratitude = signal<string>('');
  readonly editReflection = signal<string>('');

  readonly daySaving = signal(false);
  readonly daySaved = signal(false);

  private readonly entryByDate = computed(() => {
    const map = new Map<string, JournalEntryDto>();
    for (const e of this.entries() ?? []) map.set(e.date, e);
    return map;
  });
  readonly hasDayEntry = computed(() => this.entryByDate().has(this.logDate()));
  readonly logDateLabel = computed(() =>
    this.logDate() === this.today ? 'Today' : this.friendlyDate(this.logDate()));

  private readonly hasAi = computed(() => {
    this.auth.permissions();
    return this.auth.hasPermission(PERM.trackerAi);
  });

  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private savedFlagTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    void this.reload();
  }

  ngOnDestroy(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    if (this.savedFlagTimer) clearTimeout(this.savedFlagTimer);
  }

  async reload(): Promise<void> {
    const wasLoaded = !this.loading();
    if (wasLoaded) this.refreshing.set(true); else this.loading.set(true);
    this.errored.set(false);
    try {
      const data: JournalDto = await firstValueFrom(this.api.journal());
      this.entries.set(Array.isArray(data?.entries) ? data.entries : []);
      this.summary.set(data?.summary ?? null);
      this.loadDayIntoEditor(this.logDate());
    } catch {
      this.errored.set(true);
    } finally {
      this.loading.set(false);
      if (wasLoaded) {
        this.refreshing.set(false);
        if (!this.errored()) this.toast.show('Journal refreshed', { tone: 'success', durationMs: 1600 });
      }
    }
    if (!this.errored()) void this.loadReflection();
  }

  private async loadReflection(): Promise<void> {
    try {
      this.reflection.set(await firstValueFrom(this.api.journalReflection()));
    } catch {
      this.reflection.set(null);
    }
  }

  openLog(): void {
    this.selectDate(this.today);
    this.logOpen.set(true);
  }

  pickDay(iso: string): void {
    this.selectDate(iso);
    this.logOpen.set(true);
  }

  prevDay(): void { this.shiftDate(-1); }
  nextDay(): void { this.shiftDate(1); }
  logToday(): void { this.selectDate(this.today); }

  private shiftDate(delta: number): void {
    const d = this.parseIso(this.logDate());
    if (!d) return;
    const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + delta);
    this.selectDate(this.toLocalDate(next));
  }

  private selectDate(iso: string): void {
    if (iso === this.logDate()) return;
    this.flushPendingSave();
    this.logDate.set(iso);
    this.loadDayIntoEditor(iso);
  }

  private loadDayIntoEditor(iso: string): void {
    const e = this.entryByDate().get(iso);
    this.editMood.set(e?.mood ?? null);
    this.editEnergy.set(e?.energy ?? null);
    this.editTags.set(new Set(e?.tags ?? []));
    this.editGratitude.set(e?.gratitudeText ?? '');
    this.editReflection.set(e?.reflectionText ?? '');
  }

  toggleMood(value: string): void { this.editMood.update((m) => (m === value ? null : value)); this.scheduleSave(); }
  selectEnergy(value: number): void { this.editEnergy.update((e) => (e === value ? null : value)); this.scheduleSave(); }
  toggleTag(value: string): void {
    this.editTags.update((set) => { const n = new Set(set); n.has(value) ? n.delete(value) : n.add(value); return n; });
    this.scheduleSave();
  }
  isTagOn(value: string): boolean { return this.editTags().has(value); }
  onGratitudeChange(value: string): void { this.editGratitude.set(value); this.scheduleSave(); }
  onReflectionChange(value: string): void { this.editReflection.set(value); this.scheduleSave(); }

  private scheduleSave(): void {
    this.daySaved.set(false);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.saveDay(), 800);
  }
  private flushPendingSave(): void {
    if (!this.saveTimer) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    void this.saveDay();
  }

  private async saveDay(): Promise<void> {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    const date = this.logDate();
    this.daySaving.set(true);
    try {
      const saved = await firstValueFrom(this.api.upsertJournalDay({
        date,
        mood: this.editMood(),
        energy: this.editEnergy(),
        tags: [...this.editTags()],
        gratitudeText: this.editGratitude().trim() || null,
        reflectionText: this.editReflection().trim() || null,
      }));
      this.entries.update((prev) => {
        const without = prev.filter((e) => e.date !== saved.date);
        return [saved, ...without].sort((a, b) => (a.date < b.date ? 1 : -1));
      });
      this.daySaved.set(true);
      if (this.savedFlagTimer) clearTimeout(this.savedFlagTimer);
      this.savedFlagTimer = setTimeout(() => this.daySaved.set(false), 2200);
    } catch {
      this.toast.show("Couldn't save your log — try again.", { tone: 'warn' });
    } finally {
      this.daySaving.set(false);
    }
  }

  async clearDay(): Promise<void> {
    const date = this.logDate();
    if (!this.entryByDate().has(date)) { this.loadDayIntoEditor(date); return; }
    if (typeof confirm === 'function' && !confirm('Clear everything logged for this day?')) return;
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    try {
      await firstValueFrom(this.api.deleteJournalDay(date));
      this.entries.update((prev) => prev.filter((e) => e.date !== date));
      this.loadDayIntoEditor(date);
      this.daySaved.set(false);
      this.toast.show('Day cleared', { tone: 'success', durationMs: 1600 });
      void this.loadReflection();
    } catch {
      this.toast.show("Couldn't clear that day — try again.", { tone: 'warn' });
    }
  }

  moodEmoji(mood: string | null | undefined): string { return this.moodChoices.find((m) => m.value === mood)?.emoji ?? ''; }
  moodLabel(mood: string | null | undefined): string { return this.moodChoices.find((m) => m.value === mood)?.label ?? (mood ?? ''); }

  friendlyDate(iso: string): string {
    const d = this.parseIso(iso);
    return d ? d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) : iso;
  }
  private parseIso(iso: string): Date | null {
    if (!iso) return null;
    const d = new Date(`${iso}T00:00:00`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  private toLocalDate(d: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  private todayIso(): string { return this.toLocalDate(new Date()); }
}
