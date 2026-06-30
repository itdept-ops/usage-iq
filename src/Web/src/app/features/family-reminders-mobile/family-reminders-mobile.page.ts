import {
  ChangeDetectionStrategy, Component, computed, inject, signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { catchError, firstValueFrom, of } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatIconModule } from '@angular/material/icon';

import { Api } from '../../core/api';
import {
  FamilyRecurrence, FamilyReminder, Household, HouseholdMember, ReminderAiProposal,
} from '../../core/models';
import {
  BetaPullRefresh, BetaSegmentedControl, BetaBottomSheet, BetaSwipeRow, BetaSkeleton,
  BetaFab, BetaToaster, BetaEmptyState, BetaErrorState, ToastController, type Segment,
} from '../beta-ui';

/** Friendly labels for the recurrence chip (mirrors the live page's RECURRENCE_LABEL). */
const RECURRENCE_LABEL: Record<FamilyRecurrence, string> = {
  none: 'One-time',
  daily: 'Daily',
  weekdays: 'Weekdays',
  weekly: 'Weekly',
};

/** The recurrence choices offered in the editor sheet (mirrors the live editor dialog). */
const RECURRENCES: { value: FamilyRecurrence; label: string }[] = [
  { value: 'none', label: 'Does not repeat' },
  { value: 'daily', label: 'Every day' },
  { value: 'weekdays', label: 'Weekdays (Mon–Fri)' },
  { value: 'weekly', label: 'Every week' },
];

/** Snooze options offered on the detail sheet (minutes) — same set as the live page. */
const SNOOZE_OPTIONS = [
  { label: '10 min', minutes: 10 },
  { label: '1 hour', minutes: 60 },
  { label: 'Tomorrow', minutes: 24 * 60 },
];

/** One AI-proposed reminder awaiting the user's confirm — a confirm-card view-model. */
interface ProposedReminder {
  ai: ReminderAiProposal;
  whenLabel: string;
  repeatLabel: string;
  saving: boolean;
}

/**
 * Family Reminders — the mobile-first twin of the live /family/reminders page, rebuilt on the shared
 * beta-ui "Strata" kit (`@use '../beta-ui/beta-kit'`). A signature CORAL → ROSE accent re-skins the whole
 * screen via the per-page accent contract. An immersive scrolling header (accent bloom + a tiny
 * upcoming/repeating stat strip), a {@link BetaSegmentedControl} flipping between UPCOMING reminders
 * (next-due first) and PAST (fired one-shots kept visible to re-schedule), a list of glassy reminder cards
 * (each a {@link BetaSwipeRow}: swipe left to delete, right to edit), a {@link BetaBottomSheet} DETAIL with
 * snooze/edit/delete, a second sheet that is the ADD/EDIT form (text + a native datetime-local + a
 * recurrence + a household-member target), and a {@link BetaFab} to create. An "Add with AI" box turns free
 * text into proposed cards the user confirms. Pull-to-refresh, skeleton loaders, and elevated empty/error
 * states round it out.
 *
 * DATA PARITY + PRIVACY: every reminder comes straight from the SAME household-scoped `/api/family/reminders`
 * endpoints the live page uses — {@link Api.familyReminders} (list), {@link Api.createFamilyReminder} /
 * {@link Api.updateFamilyReminder} / {@link Api.snoozeFamilyReminder} / {@link Api.deleteFamilyReminder}
 * VERBATIM, and {@link Api.parseReminderAi} for the AI box. The household member picker comes from {@link
 * Api.getHousehold}. People are ALWAYS rendered by display name + initials avatar only — never an email
 * (email-privacy). The local date+time picker is converted to a UTC instant EXACTLY like the live editor
 * dialog (`new Date(local).toISOString()`), and back to local when seeding an edit.
 *
 * ISOLATION: gated by `platform.mobile` + the SAME route as the live /family/reminders page; it consumes the
 * kit + the SAME Api/models VERBATIM. No live page is imported or modified. Mobile-first (44px targets,
 * safe-area insets, no 390px overflow), centers on desktop; reduced motion collapses kit animation.
 */
@Component({
  selector: 'app-family-reminders-mobile',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [ToastController],
  imports: [
    FormsModule, MatIconModule,
    BetaPullRefresh, BetaSegmentedControl, BetaBottomSheet, BetaSwipeRow, BetaSkeleton,
    BetaFab, BetaToaster, BetaEmptyState, BetaErrorState,
  ],
  template: `
    <!-- ─────────────── PULL-TO-REFRESH OWNS THE SCROLL ─────────────── -->
    <app-bs-pull-refresh class="fr-ptr" [busy]="refreshing()" (refresh)="reload()">
      <div class="fr-scroll" aria-live="polite">

        <!-- ─── IMMERSIVE HEADER: title + a tiny stat strip ─── -->
        <header class="fr-hero">
          <p class="fr-hero__kicker"><mat-icon aria-hidden="true">notifications_active</mat-icon> Reminders</p>
          <h1 class="fr-hero__title">Family nudges</h1>
          <p class="fr-hero__sub">Household reminders that ping the right person when due.</p>

          @if (!loading() && !errored()) {
            <div class="fr-stats">
              <div class="fr-stat">
                <span class="fr-stat__n mono-num">{{ upcomingCount() }}</span>
                <span class="fr-stat__l">{{ upcomingCount() === 1 ? 'upcoming' : 'upcoming' }}</span>
              </div>
              @if (overdueCount(); as od) {
                <div class="fr-stat fr-stat--warn">
                  <span class="fr-stat__n mono-num">{{ od }}</span>
                  <span class="fr-stat__l">overdue</span>
                </div>
              }
              @if (repeatingCount(); as rp) {
                <div class="fr-stat">
                  <span class="fr-stat__n mono-num">{{ rp }}</span>
                  <span class="fr-stat__l">repeating</span>
                </div>
              }
            </div>
          }
        </header>

        <!-- ─── ADD WITH AI ─── -->
        @if (!loading() && !errored()) {
          <section class="fr-ai" aria-label="Add a reminder with AI">
            <div class="fr-ai__bar">
              <mat-icon class="fr-ai__spark" aria-hidden="true">auto_awesome</mat-icon>
              <input class="fr-ai__input" type="text"
                     [ngModel]="aiText()" (ngModelChange)="aiText.set($event)"
                     name="ai" autocomplete="off"
                     placeholder="“call the dentist next Tuesday at 3, every month”"
                     (keydown.enter)="addWithAi()" [disabled]="aiBusy()" />
              <button type="button" class="fr-ai__go" (click)="addWithAi()"
                      [disabled]="aiBusy() || !aiText().trim()" aria-label="Parse with AI">
                @if (aiBusy()) { <span class="fr-spin" aria-hidden="true"></span> }
                @else { <mat-icon aria-hidden="true">arrow_forward</mat-icon> }
              </button>
            </div>
            @if (aiStatus()) { <p class="fr-ai__status" aria-live="polite">{{ aiStatus() }}</p> }

            @if (proposals().length) {
              <div class="fr-prop-list">
                @for (p of proposals(); track p.ai) {
                  <div class="fr-prop">
                    <div class="fr-prop__body">
                      <span class="fr-prop__text">{{ p.ai.text }}</span>
                      <span class="fr-prop__meta">
                        <mat-icon aria-hidden="true">schedule</mat-icon>{{ p.whenLabel || 'No time set' }}
                        @if (p.repeatLabel) { <span class="fr-chip fr-chip--rep">{{ p.repeatLabel }}</span> }
                      </span>
                    </div>
                    <div class="fr-prop__acts">
                      <button type="button" class="fr-prop__btn fr-prop__btn--ghost"
                              (click)="dismissProposal(p)" aria-label="Discard">
                        <mat-icon aria-hidden="true">close</mat-icon>
                      </button>
                      <button type="button" class="fr-prop__btn fr-prop__btn--add"
                              [disabled]="p.saving" (click)="addProposal(p)">
                        @if (p.saving) { <span class="fr-spin" aria-hidden="true"></span> }
                        @else { <mat-icon aria-hidden="true">add</mat-icon> Add }
                      </button>
                    </div>
                  </div>
                }
              </div>
            }
          </section>
        }

        @if (loading()) {
          <div class="fr-seg-wrap" aria-hidden="true">
            <app-bs-skeleton width="100%" height="44px" radius="var(--r-pill)" />
          </div>
          <div class="fr-list" aria-hidden="true">
            @for (n of skeletonCells; track n) {
              <app-bs-skeleton height="84px" radius="var(--r-tile)" />
            }
          </div>

        } @else if (errored()) {
          <app-bs-error
            icon="cloud_off"
            title="Couldn't load reminders"
            body="Something went wrong fetching your household's reminders. Give it another go."
            (retry)="reload()" />

        } @else {
          <!-- ─── TAB SWITCH: Upcoming | Past ─── -->
          <div class="fr-seg-wrap">
            <app-bs-segmented class="fr-seg"
              [segments]="tabSegments()" [value]="tab()" label="Show reminders"
              (change)="setTab($event)" />
          </div>

          @if (activeList(); as list) {
            @if (list.length) {
              <div class="fr-list">
                @for (r of list; track r.id; let i = $index) {
                  <app-bs-swipe-row class="fr-swipe fr-reveal" [style.--ri]="i"
                    leftLabel="Delete" rightLabel="Edit" [disabled]="isBusy(r.id)"
                    [label]="r.text" (swipe)="onSwipe(r, $event)">
                    <button type="button" class="fr-card" (click)="openDetail(r)"
                            [class.is-busy]="isBusy(r.id)"
                            [class.is-overdue]="isOverdue(r)"
                            [attr.aria-label]="cardAria(r)">
                      <span class="fr-card__glyph" aria-hidden="true">
                        <mat-icon>{{ isOverdue(r) ? 'notification_important' : (r.recurrence === 'none' ? 'event' : 'repeat') }}</mat-icon>
                      </span>
                      <span class="fr-card__body">
                        <span class="fr-card__title">{{ r.text }}</span>
                        <span class="fr-card__meta">
                          <span class="fr-card__when" [class.is-overdue]="isOverdue(r)">{{ whenLabel(r.dueUtc) }}</span>
                          @if (r.recurrence !== 'none') {
                            <span class="fr-chip fr-chip--rep">{{ recurrenceLabel(r.recurrence) }}</span>
                          }
                          @if (isOverdue(r)) { <span class="fr-chip fr-chip--over">Overdue</span> }
                        </span>
                        <span class="fr-card__target">
                          <span class="fr-ava" aria-hidden="true">{{ initials(r.targetName) }}</span>
                          {{ r.targetName || 'You' }}
                        </span>
                      </span>
                      <mat-icon class="fr-card__go" aria-hidden="true">chevron_right</mat-icon>
                    </button>
                  </app-bs-swipe-row>
                }
              </div>
              @if (tab() === 'upcoming') {
                <p class="fr-foot" aria-hidden="true">Swipe a reminder left to delete · right to edit</p>
              }

            } @else {
              <app-bs-empty
                [icon]="tab() === 'upcoming' ? 'notifications_off' : 'history'"
                [title]="tab() === 'upcoming' ? 'No upcoming reminders' : 'Nothing in the past'"
                [body]="tab() === 'upcoming' ? 'Tap the + or use ✨ above to schedule your first nudge.' : 'Fired one-time reminders live here so you can re-schedule them.'"
                [ctaLabel]="tab() === 'upcoming' ? 'New reminder' : ''" ctaIcon="add"
                (action)="openCreate()" />
            }
          }
        }
      </div>
    </app-bs-pull-refresh>

    <!-- ─── CREATE FAB (only on the upcoming tab) ─── -->
    @if (!loading() && !errored() && tab() === 'upcoming') {
      <app-bs-fab icon="add" label="New reminder" [extended]="true" [fixed]="true" (action)="openCreate()" />
    }

    <!-- ─────────────── DETAIL BOTTOM SHEET ─────────────── -->
    <app-bs-sheet [(open)]="detailOpen" detent="half" [label]="selected()?.text || 'Reminder'">
      @if (selected(); as r) {
        <div class="rd">
          <div class="rd__head">
            <span class="rd__glyph" aria-hidden="true">
              <mat-icon>{{ r.recurrence === 'none' ? 'event' : 'repeat' }}</mat-icon>
            </span>
            <div class="rd__titles">
              <h3 class="rd__title">{{ r.text }}</h3>
              <span class="rd__sub" [class.is-overdue]="isOverdue(r)">
                <mat-icon aria-hidden="true">schedule</mat-icon> {{ whenLabel(r.dueUtc) }}
                @if (isOverdue(r)) { · Overdue }
              </span>
            </div>
          </div>

          <div class="rd__chips">
            <span class="fr-chip fr-chip--rep">{{ recurrenceLabel(r.recurrence) }}</span>
            <span class="fr-chip">
              <span class="fr-ava fr-ava--sm" aria-hidden="true">{{ initials(r.targetName) }}</span>
              {{ r.targetName || 'You' }}
            </span>
          </div>

          @if (r.createdByName) {
            <p class="rd__by"><mat-icon aria-hidden="true">person_add</mat-icon> Added by {{ r.createdByName }}</p>
          }

          <!-- snooze -->
          <div class="rd__block">
            <span class="rd__block-title"><mat-icon aria-hidden="true">snooze</mat-icon> Snooze</span>
            <div class="rd__snooze">
              @for (s of snoozeOptions; track s.minutes) {
                <button type="button" class="rd__snooze-btn" [disabled]="isBusy(r.id)" (click)="snooze(r, s.minutes)">
                  {{ s.label }}
                </button>
              }
            </div>
          </div>

          <div class="rd__actions">
            <button type="button" class="rd__btn" [disabled]="isBusy(r.id)" (click)="openEdit(r)">
              <mat-icon aria-hidden="true">edit</mat-icon> Edit
            </button>
            <button type="button" class="rd__btn rd__btn--del" [disabled]="isBusy(r.id)" (click)="remove(r)">
              <mat-icon aria-hidden="true">delete_outline</mat-icon> Delete
            </button>
          </div>
        </div>
      }
    </app-bs-sheet>

    <!-- ─────────────── ADD / EDIT FORM SHEET ─────────────── -->
    <app-bs-sheet [(open)]="formOpen" detent="full" [dismissable]="!saving()"
                  [label]="editing() ? 'Edit reminder' : 'New reminder'">
      <form class="rf" (ngSubmit)="save()">
        <div class="rf__head">
          <h3 class="rf__title">{{ editing() ? 'Edit reminder' : 'New reminder' }}</h3>
          <button type="button" class="rf__close" (click)="closeForm()" aria-label="Cancel" [disabled]="saving()">
            <mat-icon aria-hidden="true">close</mat-icon>
          </button>
        </div>

        <label class="rf__field">
          <span class="rf__label">Reminder</span>
          <input class="rf__input" type="text" [ngModel]="fText()" (ngModelChange)="fText.set($event)"
                 name="text" placeholder="e.g. Take out the recycling" autocomplete="off" maxlength="200" required />
        </label>

        <label class="rf__field">
          <span class="rf__label"><mat-icon class="rf__label-ic" aria-hidden="true">schedule</mat-icon> When</span>
          <input class="rf__input" type="datetime-local" [ngModel]="fWhen()" (ngModelChange)="fWhen.set($event)"
                 name="when" required />
        </label>

        <label class="rf__field">
          <span class="rf__label"><mat-icon class="rf__label-ic" aria-hidden="true">repeat</mat-icon> Repeat</span>
          <div class="rf__seg">
            @for (rc of recurrences; track rc.value) {
              <button type="button" class="rf__seg-btn" [class.is-on]="fRecurrence() === rc.value"
                      (click)="fRecurrence.set(rc.value)">{{ recurrenceLabel(rc.value) }}</button>
            }
          </div>
        </label>

        @if (members().length > 1) {
          <label class="rf__field">
            <span class="rf__label"><mat-icon class="rf__label-ic" aria-hidden="true">person</mat-icon> Remind</span>
            <div class="rf__targets">
              @for (m of members(); track m.userId) {
                <button type="button" class="rf__target" [class.is-on]="fTarget() === m.userId"
                        (click)="fTarget.set(m.userId)">
                  <span class="fr-ava fr-ava--sm" aria-hidden="true">{{ initials(m.name) }}</span>
                  {{ m.isSelf ? 'You' : m.name }}
                </button>
              }
            </div>
          </label>
        }

        <div class="rf__actions">
          <button type="button" class="rf__btn rf__btn--ghost" (click)="closeForm()" [disabled]="saving()">Cancel</button>
          <button type="submit" class="rf__btn rf__btn--save" [disabled]="!canSave()">
            @if (saving()) { <span class="fr-spin" aria-hidden="true"></span> Saving… }
            @else { <mat-icon aria-hidden="true">check</mat-icon> {{ editing() ? 'Save changes' : 'Create reminder' }} }
          </button>
        </div>
      </form>
    </app-bs-sheet>

    <app-bs-toaster />
  `,
  styleUrl: './family-reminders-mobile.page.scss',
})
export class FamilyRemindersMobilePage {
  private api = inject(Api);
  private toast = inject(ToastController);

  readonly snoozeOptions = SNOOZE_OPTIONS;
  readonly recurrences = RECURRENCES;

  readonly reminders = signal<FamilyReminder[]>([]);
  readonly members = signal<HouseholdMember[]>([]);

  readonly loading = signal(true);
  readonly errored = signal(false);
  readonly refreshing = signal(false);

  /** Which list the segmented control shows. */
  readonly tab = signal<'upcoming' | 'past'>('upcoming');

  /** Per-reminder in-flight ids (snooze / delete) so only that card's controls disable. */
  private readonly busyIds = signal<Set<number>>(new Set());

  /** Detail sheet state + the reminder it's showing. */
  readonly detailOpen = signal(false);
  readonly selected = signal<FamilyReminder | null>(null);

  /** Form sheet state. `editing` is the reminder being edited, or null for a create. */
  readonly formOpen = signal(false);
  readonly editing = signal<FamilyReminder | null>(null);
  readonly saving = signal(false);

  // ---- form fields (mirror the live editor dialog) ----
  readonly fText = signal('');
  readonly fWhen = signal('');                       // "YYYY-MM-DDTHH:mm" local, datetime-local
  readonly fRecurrence = signal<FamilyRecurrence>('none');
  readonly fTarget = signal<number>(0);

  // ---- Add with AI ----
  readonly aiText = signal('');
  readonly aiBusy = signal(false);
  readonly aiStatus = signal('');
  readonly proposals = signal<ProposedReminder[]>([]);

  readonly skeletonCells = Array.from({ length: 4 }, (_, i) => i);

  /** The caller's own userId (default target for a new reminder). */
  private readonly selfUserId = computed(() => this.members().find((m) => m.isSelf)?.userId ?? 0);

  /** Active reminders, next-due first (mirrors the live `upcoming`). */
  readonly upcoming = computed(() =>
    this.reminders().filter((r) => r.active).sort((a, b) => a.dueUtc.localeCompare(b.dueUtc)),
  );
  /** Fired one-time reminders kept visible so they can be re-scheduled (mirrors the live `past`). */
  readonly past = computed(() =>
    this.reminders().filter((r) => !r.active).sort((a, b) => b.dueUtc.localeCompare(a.dueUtc)),
  );

  readonly upcomingCount = computed(() => this.upcoming().length);
  readonly overdueCount = computed(() => this.upcoming().filter((r) => this.isOverdue(r)).length);
  readonly repeatingCount = computed(() => this.upcoming().filter((r) => r.recurrence !== 'none').length);

  readonly tabSegments = computed<Segment[]>(() => [
    { key: 'upcoming', label: `Upcoming${this.upcomingCount() ? ' · ' + this.upcomingCount() : ''}` },
    { key: 'past', label: `Past${this.past().length ? ' · ' + this.past().length : ''}` },
  ]);

  readonly activeList = computed<FamilyReminder[]>(() => (this.tab() === 'upcoming' ? this.upcoming() : this.past()));

  readonly canSave = computed(() => this.fText().trim().length > 0 && this.fWhen().length > 0 && !this.saving());

  constructor() {
    void this.reload();
    this.api
      .getHousehold()
      .pipe(catchError(() => of<Household | null>(null)), takeUntilDestroyed())
      .subscribe((h) => { if (h) this.members.set(h.members); });
  }

  // ─────────────── LOAD ───────────────

  async reload(): Promise<void> {
    const wasLoaded = !this.loading();
    if (wasLoaded) this.refreshing.set(true); else this.loading.set(true);
    this.errored.set(false);
    try {
      const list = await firstValueFrom(this.api.familyReminders());
      this.reminders.set(list ?? []);
      // Keep the open detail sheet in sync with the freshly loaded row (if still present).
      const sel = this.selected();
      if (sel) {
        const next = (list ?? []).find((r) => r.id === sel.id);
        this.selected.set(next ?? null);
        if (!next) this.detailOpen.set(false);
      }
    } catch {
      this.errored.set(true);
    } finally {
      this.loading.set(false);
      if (wasLoaded) {
        this.refreshing.set(false);
        this.toast.show('Reminders refreshed', { tone: 'success', durationMs: 1600 });
      }
    }
  }

  setTab(key: string): void {
    this.tab.set(key === 'past' ? 'past' : 'upcoming');
  }

  // ─────────────── helpers ───────────────

  isBusy(id: number): boolean {
    return this.busyIds().has(id);
  }

  private setBusy(id: number, on: boolean): void {
    this.busyIds.update((set) => {
      const next = new Set(set);
      if (on) next.add(id); else next.delete(id);
      return next;
    });
  }

  recurrenceLabel(r: FamilyRecurrence): string {
    return RECURRENCE_LABEL[r] ?? 'One-time';
  }

  /** True when the reminder's next fire is in the past (mirrors the live `isOverdue`). */
  isOverdue(r: FamilyReminder): boolean {
    return r.active && Date.parse(r.dueUtc) < Date.now();
  }

  initials(name: string): string {
    const parts = (name || '').split(/\s+/).filter(Boolean);
    return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?';
  }

  /** "Tue, Jun 23 · 3:00 PM" in the viewer's LOCAL zone, or 'No time set' for an unparseable instant. */
  whenLabel(dueUtc: string): string {
    const d = new Date(dueUtc);
    if (Number.isNaN(d.getTime())) return 'No time set';
    const day = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    return `${day} · ${time}`;
  }

  cardAria(r: FamilyReminder): string {
    const repeat = r.recurrence === 'none' ? '' : `, repeats ${this.recurrenceLabel(r.recurrence).toLowerCase()}`;
    const over = this.isOverdue(r) ? ', overdue' : '';
    return `${r.text}, ${this.whenLabel(r.dueUtc)}${repeat}${over}, for ${r.targetName || 'you'}. Open details.`;
  }

  private upsert(reminder: FamilyReminder): void {
    this.reminders.update((list) =>
      list.some((r) => r.id === reminder.id)
        ? list.map((r) => (r.id === reminder.id ? reminder : r))
        : [...list, reminder],
    );
    const sel = this.selected();
    if (sel?.id === reminder.id) this.selected.set(reminder);
  }

  // ─────────────── DETAIL SHEET ───────────────

  openDetail(r: FamilyReminder): void {
    this.selected.set(r);
    this.detailOpen.set(true);
  }

  /** A swipe-row commit: left = delete, right = edit. */
  onSwipe(r: FamilyReminder, side: 'left' | 'right'): void {
    if (side === 'left') void this.remove(r);
    else this.openEdit(r);
  }

  // ─────────────── ACTIONS (reuse the live Api verbatim) ───────────────

  /** Snooze a reminder out by N minutes from now. */
  async snooze(r: FamilyReminder, minutes: number): Promise<void> {
    if (this.isBusy(r.id)) return;
    this.setBusy(r.id, true);
    try {
      const updated = await firstValueFrom(this.api.snoozeFamilyReminder(r.id, minutes));
      this.upsert(updated);
      this.toast.show('Snoozed', { tone: 'success', durationMs: 1600 });
    } catch {
      this.toast.show("Couldn't snooze that reminder", { tone: 'warn' });
    } finally {
      this.setBusy(r.id, false);
    }
  }

  /** Delete a reminder (with a confirm). */
  async remove(r: FamilyReminder): Promise<void> {
    if (this.isBusy(r.id)) return;
    if (typeof confirm === 'function'
        && !confirm(`Delete “${r.text}”? It'll stop nudging ${r.targetName || 'you'}.`)) return;
    this.setBusy(r.id, true);
    try {
      await firstValueFrom(this.api.deleteFamilyReminder(r.id));
      this.reminders.update((list) => list.filter((x) => x.id !== r.id));
      if (this.selected()?.id === r.id) this.detailOpen.set(false);
      this.toast.show('Reminder deleted', { tone: 'success', durationMs: 1600 });
    } catch {
      this.toast.show("Couldn't delete that reminder", { tone: 'warn' });
    } finally {
      this.setBusy(r.id, false);
    }
  }

  // ─────────────── ADD / EDIT FORM ───────────────

  openCreate(): void {
    this.editing.set(null);
    this.seedForm(null);
    this.detailOpen.set(false);
    this.formOpen.set(true);
  }

  openEdit(r: FamilyReminder): void {
    this.editing.set(r);
    this.seedForm(r);
    this.detailOpen.set(false);
    this.formOpen.set(true);
  }

  closeForm(): void {
    if (this.saving()) return;
    this.formOpen.set(false);
  }

  private seedForm(r: FamilyReminder | null): void {
    this.fText.set(r?.text ?? '');
    const base = r ? new Date(r.dueUtc) : this.nextHalfHour();
    this.fWhen.set(this.toLocalInput(base));
    this.fRecurrence.set(r?.recurrence ?? 'none');
    this.fTarget.set(r?.targetUserId ?? this.selfUserId());
  }

  private nextHalfHour(): Date {
    const d = new Date();
    d.setSeconds(0, 0);
    d.setMinutes(d.getMinutes() < 30 ? 30 : 60);
    return d;
  }

  /** A Date → "YYYY-MM-DDTHH:mm" in the browser's local zone (what datetime-local expects). */
  private toLocalInput(d: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  async save(): Promise<void> {
    if (!this.canSave()) {
      if (!this.fText().trim()) this.toast.show('Give the reminder some text first.', { tone: 'warn' });
      else if (!this.fWhen()) this.toast.show('Pick a date and time.', { tone: 'warn' });
      return;
    }
    this.saving.set(true);
    // The datetime-local string is local wall-clock; `new Date(local).toISOString()` is the local→UTC the API wants.
    const dueUtc = new Date(this.fWhen()).toISOString();
    const recurrence = this.fRecurrence();
    const targetUserId = this.fTarget() || this.selfUserId();
    const editRow = this.editing();
    try {
      const saved = editRow
        ? await firstValueFrom(this.api.updateFamilyReminder(editRow.id, {
            text: this.fText().trim(), dueUtc, recurrence, targetUserId,
          }))
        : await firstValueFrom(this.api.createFamilyReminder({
            text: this.fText().trim(), dueUtc, recurrence, targetUserId,
          }));
      this.upsert(saved);
      this.tab.set('upcoming');
      this.toast.show(editRow ? 'Reminder updated' : 'Reminder added',
        { tone: 'success', durationMs: 1800 });
      this.formOpen.set(false);
    } catch {
      this.toast.show("Couldn't save the reminder — try again", { tone: 'warn' });
    } finally {
      this.saving.set(false);
    }
  }

  // ─────────────── ADD WITH AI (reuse parseReminderAi + createFamilyReminder verbatim) ───────────────

  /** Send the free-text request to Gemini and show the proposed reminder(s) as confirm cards. Creates nothing. */
  async addWithAi(): Promise<void> {
    const text = this.aiText().trim();
    if (text.length === 0 || this.aiBusy()) return;
    this.aiBusy.set(true);
    this.aiStatus.set('Reading your request…');
    this.proposals.set([]);
    try {
      const result = await firstValueFrom(this.api.parseReminderAi(text));
      const proposed = (result.reminders ?? []).map((ai) => this.toProposed(ai));
      this.proposals.set(proposed);
      if (proposed.length === 0) {
        this.aiStatus.set(
          result.notes?.trim() || 'I couldn\'t find a reminder in that. Try "call mom tomorrow at 6pm".');
      } else {
        const n = proposed.length;
        this.aiStatus.set(
          (result.notes?.trim() ? result.notes!.trim() + ' ' : '') +
            `Review ${n === 1 ? 'the reminder' : `these ${n} reminders`} below, then add ${n === 1 ? 'it' : 'them'}.`);
      }
    } catch (e) {
      const status = (e as { status?: number })?.status;
      this.aiStatus.set(
        status === 503
          ? "AI reminders aren't available right now — add it manually with the + button."
          : "I couldn't reach the AI just now. Please try again, or add the reminder manually.");
    } finally {
      this.aiBusy.set(false);
    }
  }

  /** Add one AI-proposed reminder via the existing create endpoint (target stays self). Then drop the card. */
  async addProposal(p: ProposedReminder): Promise<void> {
    if (p.saving) return;
    this.setProposalSaving(p, true);
    try {
      const created = await firstValueFrom(this.api.createFamilyReminder({
        text: p.ai.text, dueUtc: p.ai.dueUtc, recurrence: p.ai.recurrence,
      }));
      this.upsert(created);
      this.dismissProposal(p);
      this.tab.set('upcoming');
      this.toast.show('Reminder added', { tone: 'success', durationMs: 1800 });
    } catch {
      this.setProposalSaving(p, false);
      this.toast.show("Couldn't add that reminder — try again", { tone: 'warn' });
    }
  }

  dismissProposal(p: ProposedReminder): void {
    this.proposals.set(this.proposals().filter((x) => x !== p));
  }

  private setProposalSaving(p: ProposedReminder, saving: boolean): void {
    this.proposals.set(this.proposals().map((x) => (x === p ? { ...x, saving } : x)));
  }

  private toProposed(ai: ReminderAiProposal): ProposedReminder {
    return {
      ai,
      whenLabel: this.whenLabel(ai.dueUtc),
      repeatLabel: ai.recurrence === 'none' ? '' : this.recurrenceLabel(ai.recurrence),
      saving: false,
    };
  }
}
