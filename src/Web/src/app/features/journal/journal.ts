import {
  ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';

import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';

import { Api } from '../../core/api';
import { AuthService } from '../../core/auth';
import {
  JournalDto, JournalEntryDto, JournalReflectionDto, JournalSummaryDto, PERM,
} from '../../core/models';
import { BetaErrorState } from '../beta-ui';

interface MoodChoice { value: string; label: string; emoji: string; }

/**
 * Journal & Mood (the desktop `/journal` page) — a PRIVATE owner day-log, a near-sibling of the Family Hub
 * cycle day-log. Gated by the SAME `tracker.self` (NO dedicated permission) and OWNER-SCOPED: a caller only
 * ever reads/edits their OWN entries. The left rail is a quick day-picker over the recent entries; the right
 * pane is the day editor — a mood + energy quick-picker, a vocab tag chooser, and the gratitude + reflection
 * free-text fields (autosaved via the PARTIAL upsert, so an untouched field is preserved). A "weekly
 * reflection" card narrates the gentle floored-AI one-liner.
 *
 * FREE-TEXT PRIVACY (the core invariant): the gratitude + reflection text is owner-only — it NEVER reaches
 * the AI. The weekly reflection ({@link Api.journalReflection}) narrates ONLY an aggregate projection
 * (mood/energy/tag frequencies + counts) and ALWAYS 200s with a deterministic plain floor when `tracker.ai`
 * is absent or Gemini is off.
 */
@Component({
  selector: 'app-journal',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule, MatIconModule, MatButtonModule, MatSnackBarModule, MatProgressSpinnerModule,
    BetaErrorState,
  ],
  templateUrl: './journal.html',
  styleUrl: './journal.scss',
})
export class Journal {
  private api = inject(Api);
  private auth = inject(AuthService);
  private snack = inject(MatSnackBar);
  private destroyRef = inject(DestroyRef);

  // ---- page state ----
  readonly loading = signal(true);
  readonly errored = signal(false);
  readonly entries = signal<JournalEntryDto[]>([]);
  readonly summary = signal<JournalSummaryDto | null>(null);
  readonly reflection = signal<JournalReflectionDto | null>(null);
  readonly reflectionLoading = signal(false);

  /** Whether the caller may get the warm AI upgrade (the card always renders the floor regardless). */
  readonly canReflectAi = computed(() => {
    this.auth.permissions();
    return this.auth.hasPermission(PERM.trackerAi);
  });

  // ---- vocab ----
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

  // ---- the selected day + its editor model ----
  readonly logDate = signal<string>(this.todayIso());
  readonly today = this.todayIso();

  readonly editMood = signal<string | null>(null);
  readonly editEnergy = signal<number | null>(null);
  readonly editTags = signal<Set<string>>(new Set());
  readonly editGratitude = signal<string>('');
  readonly editReflection = signal<string>('');

  readonly daySaving = signal(false);
  readonly daySaved = signal(false);

  /** The entries keyed by date for quick editor hydration. */
  private readonly entryByDate = computed(() => {
    const map = new Map<string, JournalEntryDto>();
    for (const e of this.entries() ?? []) map.set(e.date, e);
    return map;
  });

  readonly hasDayEntry = computed(() => this.entryByDate().has(this.logDate()));

  readonly logDateLabel = computed(() =>
    this.logDate() === this.today ? 'Today' : this.friendlyDate(this.logDate()),
  );

  /** The recent entries as picker rows (already newest-first from the server). */
  readonly pickerRows = computed(() =>
    this.entries().map((e) => ({
      raw: e,
      label: this.friendlyDate(e.date),
      mood: e.mood,
      emoji: this.moodEmoji(e.mood),
    })),
  );

  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private savedFlagTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    void this.reload();

    // Re-hydrate the editor whenever the loaded entries change for the selected day.
    effect(() => {
      this.entryByDate();
      this.loadDayIntoEditor(this.logDate());
    });

    this.destroyRef.onDestroy(() => {
      if (this.saveTimer) clearTimeout(this.saveTimer);
      if (this.savedFlagTimer) clearTimeout(this.savedFlagTimer);
    });
  }

  // ============================================================== loading

  async reload(): Promise<void> {
    this.loading.set(true);
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
    }
    void this.loadReflection();
  }

  async loadReflection(): Promise<void> {
    this.reflectionLoading.set(true);
    try {
      this.reflection.set(await firstValueFrom(this.api.journalReflection()));
    } catch {
      this.reflection.set(null);
    } finally {
      this.reflectionLoading.set(false);
    }
  }

  // ============================================================== day navigation

  selectDate(iso: string): void {
    if (iso === this.logDate()) return;
    this.flushPendingSave();
    this.logDate.set(iso);
    this.loadDayIntoEditor(iso);
  }

  prevDay(): void { this.shiftDate(-1); }
  nextDay(): void { this.shiftDate(1); }
  goToday(): void { this.selectDate(this.today); }

  onDateInput(value: string): void {
    if (value) this.selectDate(value);
  }

  private shiftDate(delta: number): void {
    const d = this.parseIso(this.logDate());
    if (!d) return;
    const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + delta);
    this.selectDate(this.toLocalDate(next));
  }

  private loadDayIntoEditor(iso: string): void {
    const e = this.entryByDate().get(iso);
    this.editMood.set(e?.mood ?? null);
    this.editEnergy.set(e?.energy ?? null);
    this.editTags.set(new Set(e?.tags ?? []));
    this.editGratitude.set(e?.gratitudeText ?? '');
    this.editReflection.set(e?.reflectionText ?? '');
  }

  // ============================================================== editor mutations

  toggleMood(value: string): void {
    this.editMood.update((m) => (m === value ? null : value));
    this.scheduleSave();
  }

  selectEnergy(value: number): void {
    this.editEnergy.update((e) => (e === value ? null : value));
    this.scheduleSave();
  }

  toggleTag(value: string): void {
    this.editTags.update((set) => {
      const next = new Set(set);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
    this.scheduleSave();
  }

  isTagOn(value: string): boolean {
    return this.editTags().has(value);
  }

  onGratitudeChange(value: string): void {
    this.editGratitude.set(value);
    this.scheduleSave();
  }

  onReflectionChange(value: string): void {
    this.editReflection.set(value);
    this.scheduleSave();
  }

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
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const date = this.logDate();
    this.daySaving.set(true);
    try {
      // PARTIAL upsert — we always send every field we manage (so a cleared field clears), the date binds
      // the owner row server-side. Tags REPLACE the stored set. The free-text never leaves the owner.
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
    } catch (e) {
      this.snack.open(this.messageOf(e, 'Could not save — please try again.'), 'OK', { duration: 4000 });
    } finally {
      this.daySaving.set(false);
    }
  }

  async clearDay(): Promise<void> {
    const date = this.logDate();
    if (!this.entryByDate().has(date)) {
      this.loadDayIntoEditor(date);
      return;
    }
    if (typeof confirm === 'function' &&
        !confirm('Clear everything logged for this day? It only affects this one day.')) return;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    try {
      await firstValueFrom(this.api.deleteJournalDay(date));
      this.entries.update((prev) => prev.filter((e) => e.date !== date));
      this.loadDayIntoEditor(date);
      this.daySaved.set(false);
      this.snack.open('Day cleared.', 'OK', { duration: 1800 });
      void this.loadReflection();
    } catch (e) {
      this.snack.open(this.messageOf(e, 'Could not clear that day.'), 'OK', { duration: 4000 });
    }
  }

  // ============================================================== misc helpers

  moodEmoji(mood: string | null | undefined): string {
    return this.moodChoices.find((m) => m.value === mood)?.emoji ?? '';
  }

  moodLabel(mood: string | null | undefined): string {
    return this.moodChoices.find((m) => m.value === mood)?.label ?? (mood ?? '');
  }

  friendlyDate(iso: string): string {
    const d = this.parseIso(iso);
    return d
      ? d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
      : iso;
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

  private todayIso(): string {
    return this.toLocalDate(new Date());
  }

  private messageOf(e: unknown, fallback: string): string {
    const msg = (e as { error?: { message?: string } })?.error?.message;
    return typeof msg === 'string' && msg ? msg : fallback;
  }
}
