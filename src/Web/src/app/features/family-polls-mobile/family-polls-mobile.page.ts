import {
  ChangeDetectionStrategy, Component, computed, inject, signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { MatIconModule } from '@angular/material/icon';

import { Api } from '../../core/api';
import { AuthService } from '../../core/auth';
import {
  FamilyPoll,
  FamilyPollCreate,
  FamilyPollKind,
  FamilyPollOption,
  FamilyPollOptionInput,
  FamilyPollVoter,
} from '../../core/models';
import {
  BetaPullRefresh, BetaSegmentedControl, BetaBottomSheet, BetaSkeleton,
  BetaFab, BetaToaster, BetaEmptyState, BetaErrorState, ToastController, type Segment,
} from '../beta-ui';

/** One editable option row in the create-poll sheet — a stable key keeps @for + inputs stable while typing. */
interface OptionRow {
  key: number;
  /** TEXT poll choice label. */
  label: string;
  /** TIME poll local-datetime strings (bound to <input type="datetime-local">). */
  start: string;
  end: string;
}

/**
 * Family PLAN POLLS — the mobile-first twin of the live /family/polls page (Doodle-style household polls),
 * rebuilt on the shared beta-ui "Strata" kit (`@use '../beta-ui/beta-kit'`). One signature accent — a cool
 * VIOLET → INDIGO ramp — re-skins the whole screen via the per-page accent contract.
 *
 * A compact scrolling header (title + an open/closed stat strip), a {@link BetaSegmentedControl}
 * flipping the list between OPEN polls and CLOSED ones, a list of glassy poll cards (each option a big
 * tap-to-vote target with a live tally bar, voter initials, the caller's own multi-select highlighted, and
 * — once closed — the winner crowned), and a {@link BetaBottomSheet} CREATE form (Time or Choices, editable
 * option rows). Pull-to-refresh, skeleton loaders, and elevated empty/error states round it out.
 *
 * DATA PARITY: every poll comes straight from the SAME household-scoped endpoints the live page uses —
 * {@link Api.familyPolls} (newest-first). Writes go through {@link Api.createFamilyPoll} (build the body
 * EXACTLY like the live create dialog), {@link Api.voteFamilyPoll} (REPLACE the caller's selection set),
 * {@link Api.closeFamilyPoll} (server picks the most-voted winner), and {@link Api.deleteFamilyPoll}
 * VERBATIM. Voter identity is display NAME / initials only — NEVER an email (email-privacy). The server
 * enforces all ownership; the UI only offers Close/Delete on polls the caller created.
 *
 * ISOLATION: gated by `platform.mobile` + the SAME family permission the live /family/polls route carries;
 * it consumes the kit + the SAME Api/models as the live counterpart. No live page is imported or modified.
 */
@Component({
  selector: 'app-family-polls-mobile',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [ToastController],
  imports: [
    FormsModule, MatIconModule,
    BetaPullRefresh, BetaSegmentedControl, BetaBottomSheet, BetaSkeleton,
    BetaFab, BetaToaster, BetaEmptyState, BetaErrorState,
  ],
  template: `
    <!-- ─────────────── PULL-TO-REFRESH OWNS THE SCROLL ─────────────── -->
    <app-bs-pull-refresh class="pl-ptr" [busy]="refreshing()" (refresh)="reload()">
      <div class="pl-scroll" aria-live="polite">

        <!-- ─── HEADER: title + stat strip ─── -->
        <header class="pl-hero">
          <p class="pl-hero__kicker"><mat-icon aria-hidden="true">how_to_vote</mat-icon> Plan together</p>
          <h1 class="pl-hero__title">Polls</h1>
          <p class="pl-hero__sub">Float a time or choice, everyone votes, you lock in the winner.</p>

          @if (!loading() && !errored()) {
            <div class="pl-stats">
              <div class="pl-stat">
                <span class="pl-stat__n mono-num">{{ openCount() }}</span>
                <span class="pl-stat__l">open</span>
              </div>
              <div class="pl-stat">
                <span class="pl-stat__n mono-num">{{ closedCount() }}</span>
                <span class="pl-stat__l">decided</span>
              </div>
            </div>
          }
        </header>

        @if (loading()) {
          <!-- skeleton list -->
          <div class="pl-seg-wrap" aria-hidden="true">
            <app-bs-skeleton width="100%" height="44px" radius="var(--r-pill)" />
          </div>
          <div class="pl-list" aria-hidden="true">
            @for (n of skeletonCells; track n) {
              <app-bs-skeleton height="148px" radius="var(--r-tile)" />
            }
          </div>

        } @else if (errored()) {
          <app-bs-error
            icon="cloud_off"
            title="Couldn't load your polls"
            body="Something went wrong fetching the household polls. Give it another go."
            (retry)="reload()" />

        } @else {
          <!-- ─── TAB SWITCH: Open | Decided ─── -->
          <div class="pl-seg-wrap">
            <app-bs-segmented class="pl-seg"
              [segments]="tabSegments()" [value]="tab()" label="Show polls"
              (change)="setTab($event)" />
          </div>

          @if (activeList(); as list) {
            @if (list.length) {
              <div class="pl-list">
                @for (poll of list; track poll.id; let i = $index) {
                  <article class="pl-card pl-reveal" [style.--ri]="i" [class.is-closed]="poll.closed">
                    <!-- card head -->
                    <div class="pl-card__head">
                      <span class="pl-card__glyph" aria-hidden="true">
                        <mat-icon>{{ poll.kind === 'time' ? 'schedule' : 'ballot' }}</mat-icon>
                      </span>
                      <div class="pl-card__titles">
                        <h3 class="pl-card__title">{{ poll.title }}</h3>
                        <span class="pl-card__meta">
                          {{ poll.kind === 'time' ? 'Time poll' : 'Choices' }}
                          · by {{ poll.createdByName }}
                          · {{ createdLabel(poll) }}
                        </span>
                      </div>
                      @if (poll.closed) {
                        <span class="pl-card__badge" aria-label="Closed">
                          <mat-icon aria-hidden="true">lock</mat-icon> Closed
                        </span>
                      }
                    </div>

                    <!-- options -->
                    <ul class="pl-opts">
                      @for (opt of poll.options; track opt.id) {
                        <li class="pl-opt"
                            [class.is-picked]="!poll.closed && isPicked(poll, opt)"
                            [class.is-winner]="isWinner(poll, opt)">
                          <button type="button" class="pl-opt__btn"
                                  [disabled]="poll.closed || isBusy(poll.id)"
                                  [attr.aria-pressed]="isPicked(poll, opt)"
                                  [attr.aria-label]="optAria(poll, opt)"
                                  (click)="toggleVote(poll, opt)">
                            <span class="pl-opt__bar" aria-hidden="true"
                                  [style.width.%]="barPct(poll, opt)"></span>
                            <span class="pl-opt__check" aria-hidden="true">
                              @if (isWinner(poll, opt)) {
                                <mat-icon>emoji_events</mat-icon>
                              } @else if (isPicked(poll, opt)) {
                                <mat-icon>check_circle</mat-icon>
                              } @else if (!poll.closed) {
                                <mat-icon>radio_button_unchecked</mat-icon>
                              } @else {
                                <mat-icon>circle</mat-icon>
                              }
                            </span>
                            <span class="pl-opt__label">{{ optionLabel(poll, opt) }}</span>
                            <span class="pl-opt__count mono-num">{{ opt.voteCount }}</span>
                          </button>
                          @if (opt.voters.length) {
                            <div class="pl-opt__voters" [attr.aria-label]="votersLabel(opt.voters)">
                              @for (v of opt.voters.slice(0, 5); track v.userId) {
                                <span class="pl-opt__avatar" [title]="v.name">{{ initials(v.name) }}</span>
                              }
                              @if (opt.voters.length > 5) {
                                <span class="pl-opt__avatar pl-opt__avatar--more">+{{ opt.voters.length - 5 }}</span>
                              }
                            </div>
                          }
                        </li>
                      }
                    </ul>

                    <!-- footer / owner controls -->
                    <div class="pl-card__foot">
                      @if (!poll.closed) {
                        <span class="pl-card__hint">
                          <mat-icon aria-hidden="true">touch_app</mat-icon>
                          Tap every option that works for you
                        </span>
                      } @else {
                        <span class="pl-card__hint pl-card__hint--won">
                          <mat-icon aria-hidden="true">emoji_events</mat-icon>
                          {{ winnerLabel(poll) }}
                        </span>
                      }
                      @if (isMine(poll)) {
                        <div class="pl-card__acts">
                          @if (!poll.closed) {
                            <button type="button" class="pl-mini" [disabled]="isBusy(poll.id)"
                                    (click)="close(poll)">
                              <mat-icon aria-hidden="true">how_to_reg</mat-icon> Close
                            </button>
                          }
                          <button type="button" class="pl-mini pl-mini--del" [disabled]="isBusy(poll.id)"
                                  (click)="remove(poll)" aria-label="Delete poll">
                            <mat-icon aria-hidden="true">delete_outline</mat-icon>
                          </button>
                        </div>
                      }
                    </div>
                  </article>
                }
              </div>

            } @else {
              <!-- EMPTY for the active tab -->
              <app-bs-empty
                [icon]="tab() === 'open' ? 'how_to_vote' : 'task_alt'"
                [title]="tab() === 'open' ? 'No open polls' : 'Nothing decided yet'"
                [body]="tab() === 'open' ? 'Tap the + to float a time or a choice for the household to vote on.' : 'When you close an open poll, its winner shows up here.'"
                [ctaLabel]="tab() === 'open' ? 'New poll' : ''" ctaIcon="add"
                (action)="openCreate()" />
            }
          }
        }
      </div>
    </app-bs-pull-refresh>

    <!-- ─── CREATE FAB ─── -->
    @if (!loading() && !errored()) {
      <app-bs-fab icon="add" label="New poll" [extended]="true" [fixed]="true" (action)="openCreate()" />
    }

    <!-- ─────────────── CREATE BOTTOM SHEET ─────────────── -->
    <app-bs-sheet [(open)]="formOpen" detent="full" [dismissable]="!saving()" label="New poll">
      <form class="pf" (ngSubmit)="save()">
        <div class="pf__head">
          <h3 class="pf__title">New poll</h3>
          <button type="button" class="pf__close" (click)="closeForm()" aria-label="Cancel" [disabled]="saving()">
            <mat-icon aria-hidden="true">close</mat-icon>
          </button>
        </div>

        <label class="pf__field">
          <span class="pf__label">Question</span>
          <input class="pf__input" type="text" [ngModel]="fTitle()" (ngModelChange)="fTitle.set($event)"
                 name="title" placeholder="e.g. When works for game night?" autocomplete="off"
                 maxlength="160" required />
        </label>

        <!-- kind switch -->
        <div class="pf__kind">
          <button type="button" class="pf__kind-btn" [class.is-on]="fKind() === 'time'"
                  (click)="setKind('time')">
            <mat-icon aria-hidden="true">schedule</mat-icon> Times
          </button>
          <button type="button" class="pf__kind-btn" [class.is-on]="fKind() === 'text'"
                  (click)="setKind('text')">
            <mat-icon aria-hidden="true">ballot</mat-icon> Choices
          </button>
        </div>

        <!-- option rows -->
        <div class="pf__section">
          <span class="pf__section-title">
            <mat-icon aria-hidden="true">list</mat-icon>
            {{ fKind() === 'time' ? 'Time slots' : 'Choices' }}
            <i>(2–30)</i>
          </span>

          @for (row of fRows(); track row.key; let i = $index) {
            <div class="pf__opt" [class.pf__opt--time]="fKind() === 'time'">
              @if (fKind() === 'time') {
                <div class="pf__opt-times">
                  <label class="pf__sub">
                    <span class="pf__sub-l">Start</span>
                    <input class="pf__input pf__input--dt" type="datetime-local"
                           [ngModel]="row.start" (ngModelChange)="setRowStart(row.key, $event)"
                           [name]="'opt-start-' + row.key" />
                  </label>
                  <label class="pf__sub">
                    <span class="pf__sub-l">End</span>
                    <input class="pf__input pf__input--dt" type="datetime-local"
                           [ngModel]="row.end" (ngModelChange)="setRowEnd(row.key, $event)"
                           [name]="'opt-end-' + row.key" />
                  </label>
                </div>
              } @else {
                <input class="pf__input" type="text" placeholder="Choice {{ i + 1 }}"
                       [ngModel]="row.label" (ngModelChange)="setRowLabel(row.key, $event)"
                       [name]="'opt-label-' + row.key" autocomplete="off" maxlength="120" />
              }
              <button type="button" class="pf__opt-del" (click)="removeRow(row.key)"
                      [disabled]="fRows().length <= 2" aria-label="Remove option">
                <mat-icon aria-hidden="true">remove_circle_outline</mat-icon>
              </button>
            </div>
          }

          <button type="button" class="pf__add" (click)="addRow()" [disabled]="fRows().length >= 30">
            <mat-icon aria-hidden="true">add</mat-icon>
            {{ fKind() === 'time' ? 'Add a time' : 'Add a choice' }}
          </button>
        </div>

        <div class="pf__actions">
          <button type="button" class="pf__btn pf__btn--ghost" (click)="closeForm()" [disabled]="saving()">Cancel</button>
          <button type="submit" class="pf__btn pf__btn--save" [disabled]="!canSave()">
            @if (saving()) { <span class="pf__spin" aria-hidden="true"></span> Creating… }
            @else { <mat-icon aria-hidden="true">check</mat-icon> Create poll }
          </button>
        </div>
      </form>
    </app-bs-sheet>

    <app-bs-toaster />
  `,
  styleUrl: './family-polls-mobile.page.scss',
})
export class FamilyPollsMobilePage {
  private api = inject(Api);
  private auth = inject(AuthService);
  private toast = inject(ToastController);

  /** The household's polls (newest-first from the server). */
  readonly polls = signal<FamilyPoll[]>([]);

  readonly loading = signal(true);
  readonly errored = signal(false);
  readonly refreshing = signal(false);

  /** Which subset the segmented control shows. */
  readonly tab = signal<'open' | 'closed'>('open');

  /** Per-poll in-flight ids (vote / close / delete) so only that card's controls disable. */
  private readonly busyIds = signal<Set<number>>(new Set());

  // ---- create form ----
  readonly formOpen = signal(false);
  readonly saving = signal(false);
  readonly fTitle = signal('');
  readonly fKind = signal<FamilyPollKind>('time');
  private keySeq = 0;
  readonly fRows = signal<OptionRow[]>([]);

  readonly skeletonCells = Array.from({ length: 3 }, (_, i) => i);

  readonly myUserId = computed(() => this.auth.userId());

  readonly openPolls = computed(() => this.polls().filter((p) => !p.closed));
  readonly closedPolls = computed(() => this.polls().filter((p) => p.closed));
  readonly openCount = computed(() => this.openPolls().length);
  readonly closedCount = computed(() => this.closedPolls().length);

  readonly tabSegments = computed<Segment[]>(() => [
    { key: 'open', label: `Open${this.openCount() ? ' · ' + this.openCount() : ''}` },
    { key: 'closed', label: `Decided${this.closedCount() ? ' · ' + this.closedCount() : ''}` },
  ]);

  readonly activeList = computed<FamilyPoll[]>(() =>
    this.tab() === 'open' ? this.openPolls() : this.closedPolls());

  readonly canSave = computed(() => {
    if (this.saving()) return false;
    if (!this.fTitle().trim()) return false;
    return this.validOptionCount() >= 2;
  });

  constructor() {
    void this.reload();
  }

  // ─────────────── LOAD ───────────────

  async reload(): Promise<void> {
    const wasLoaded = !this.loading();
    if (wasLoaded) this.refreshing.set(true); else this.loading.set(true);
    this.errored.set(false);
    try {
      const list = await firstValueFrom(this.api.familyPolls());
      this.polls.set(list ?? []);
    } catch {
      this.errored.set(true);
    } finally {
      this.loading.set(false);
      if (wasLoaded) {
        this.refreshing.set(false);
        this.toast.show('Polls refreshed', { tone: 'success', durationMs: 1600 });
      }
    }
  }

  setTab(key: string): void {
    this.tab.set(key === 'closed' ? 'closed' : 'open');
  }

  // ─────────────── helpers ───────────────

  isBusy(id: number): boolean {
    return this.busyIds().has(id);
  }

  private setBusy(id: number, on: boolean): void {
    this.busyIds.update((set) => {
      const next = new Set(set);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  isMine(poll: FamilyPoll): boolean {
    return this.myUserId() != null && poll.createdByUserId === this.myUserId();
  }

  isPicked(poll: FamilyPoll, option: FamilyPollOption): boolean {
    return poll.myVotes.includes(option.id);
  }

  isWinner(poll: FamilyPoll, option: FamilyPollOption): boolean {
    return poll.closed && poll.winningOptionId === option.id;
  }

  /** The most votes any single option holds, used to scale the per-option tally bars. */
  private maxVotes(poll: FamilyPoll): number {
    return poll.options.reduce((m, o) => Math.max(m, o.voteCount), 0);
  }

  barPct(poll: FamilyPoll, option: FamilyPollOption): number {
    const max = this.maxVotes(poll);
    if (max <= 0) return 0;
    return Math.round((option.voteCount / max) * 100);
  }

  /** The label for a poll option: a local time range for TIME polls, the text label for TEXT polls. */
  optionLabel(poll: FamilyPoll, option: FamilyPollOption): string {
    if (poll.kind === 'text') return option.label ?? '';
    if (!option.startUtc) return option.label ?? '';
    const date = new Date(option.startUtc).toLocaleDateString(undefined, {
      weekday: 'short', month: 'short', day: 'numeric',
    });
    const opts: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };
    const start = new Date(option.startUtc).toLocaleTimeString(undefined, opts);
    const end = option.endUtc ? new Date(option.endUtc).toLocaleTimeString(undefined, opts) : '';
    return end ? `${date} · ${start} – ${end}` : `${date} · ${start}`;
  }

  winnerLabel(poll: FamilyPoll): string {
    const win = poll.options.find((o) => o.id === poll.winningOptionId);
    return win ? `Winner: ${this.optionLabel(poll, win)}` : 'Closed';
  }

  /** Two-letter initials for a voter avatar (from the name; never an email). */
  initials(name: string): string {
    const parts = (name || '').split(/\s+/).filter(Boolean);
    return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?';
  }

  votersLabel(voters: FamilyPollVoter[]): string {
    if (!voters.length) return 'No votes yet';
    return voters.map((v) => v.name).join(', ');
  }

  createdLabel(poll: FamilyPoll): string {
    return new Date(poll.createdUtc).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  optAria(poll: FamilyPoll, option: FamilyPollOption): string {
    const label = this.optionLabel(poll, option);
    const n = option.voteCount;
    const votes = `${n} vote${n === 1 ? '' : 's'}`;
    if (poll.closed) {
      return `${label}, ${votes}${this.isWinner(poll, option) ? ', winner' : ''}.`;
    }
    return `${label}, ${votes}. ${this.isPicked(poll, option) ? 'Your pick — tap to remove.' : 'Tap to vote.'}`;
  }

  // ─────────────── VOTE (reuse the live Api verbatim — REPLACE the caller's selection set) ───────────────

  async toggleVote(poll: FamilyPoll, option: FamilyPollOption): Promise<void> {
    if (poll.closed || this.isBusy(poll.id)) return;
    const current = new Set(poll.myVotes);
    if (current.has(option.id)) current.delete(option.id);
    else current.add(option.id);
    this.setBusy(poll.id, true);
    try {
      const updated = await firstValueFrom(this.api.voteFamilyPoll(poll.id, [...current]));
      this.replace(updated);
    } catch {
      this.toast.show("Couldn't save your vote — try again", { tone: 'warn' });
    } finally {
      this.setBusy(poll.id, false);
    }
  }

  // ─────────────── CLOSE (server picks the most-voted winner) ───────────────

  async close(poll: FamilyPoll): Promise<void> {
    if (!this.isMine(poll) || this.isBusy(poll.id)) return;
    if (typeof confirm === 'function'
      && !confirm("Close this poll? We'll lock in the most-voted option as the winner.")) return;
    this.setBusy(poll.id, true);
    try {
      const updated = await firstValueFrom(this.api.closeFamilyPoll(poll.id));
      this.replace(updated);
      this.tab.set('closed');
      this.toast.show('Poll closed', { tone: 'success', durationMs: 1800 });
    } catch {
      this.toast.show("Couldn't close the poll — try again", { tone: 'warn' });
    } finally {
      this.setBusy(poll.id, false);
    }
  }

  // ─────────────── DELETE ───────────────

  async remove(poll: FamilyPoll): Promise<void> {
    if (!this.isMine(poll) || this.isBusy(poll.id)) return;
    if (typeof confirm === 'function'
      && !confirm(`Delete “${poll.title}”? Its votes will be removed for everyone.`)) return;
    this.setBusy(poll.id, true);
    try {
      await firstValueFrom(this.api.deleteFamilyPoll(poll.id));
      this.polls.update((list) => list.filter((p) => p.id !== poll.id));
      this.toast.show('Poll deleted', { tone: 'success', durationMs: 1800 });
    } catch {
      this.toast.show("Couldn't delete the poll — try again", { tone: 'warn' });
    } finally {
      this.setBusy(poll.id, false);
    }
  }

  // ─────────────── CREATE FORM ───────────────

  openCreate(): void {
    this.fTitle.set('');
    this.fKind.set('time');
    this.fRows.set([this.blankRow(), this.blankRow()]);
    this.formOpen.set(true);
  }

  closeForm(): void {
    if (this.saving()) return;
    this.formOpen.set(false);
  }

  setKind(kind: FamilyPollKind): void {
    if (this.fKind() === kind) return;
    this.fKind.set(kind);
    // Reset the rows so a half-filled time/text set doesn't leak into the other shape.
    this.fRows.set([this.blankRow(), this.blankRow()]);
  }

  private blankRow(): OptionRow {
    return { key: this.keySeq++, label: '', start: '', end: '' };
  }

  addRow(): void {
    if (this.fRows().length >= 30) return;
    this.fRows.update((rs) => [...rs, this.blankRow()]);
  }

  removeRow(key: number): void {
    if (this.fRows().length <= 2) return;
    this.fRows.update((rs) => rs.filter((r) => r.key !== key));
  }

  setRowLabel(key: number, label: string): void {
    this.fRows.update((rs) => rs.map((r) => (r.key === key ? { ...r, label } : r)));
  }

  setRowStart(key: number, start: string): void {
    this.fRows.update((rs) => rs.map((r) => (r.key === key ? { ...r, start } : r)));
  }

  setRowEnd(key: number, end: string): void {
    this.fRows.update((rs) => rs.map((r) => (r.key === key ? { ...r, end } : r)));
  }

  /** How many rows are currently valid for the active kind (gates the Create button). */
  private validOptionCount(): number {
    return this.buildOptions().length;
  }

  /**
   * Build the option inputs EXACTLY like the live create dialog: TEXT polls send trimmed non-empty labels;
   * TIME polls send ISO UTC start/end (end defaults to start + 1h when omitted), dropping rows with no start.
   */
  private buildOptions(): FamilyPollOptionInput[] {
    if (this.fKind() === 'text') {
      return this.fRows()
        .map((r) => r.label.trim())
        .filter((label) => label.length > 0)
        .map((label) => ({ label }));
    }
    return this.fRows()
      .filter((r) => !!r.start)
      .map((r) => {
        const startUtc = new Date(r.start).toISOString();
        const endUtc = r.end
          ? new Date(r.end).toISOString()
          : new Date(new Date(r.start).getTime() + 60 * 60 * 1000).toISOString();
        return { startUtc, endUtc } as FamilyPollOptionInput;
      });
  }

  async save(): Promise<void> {
    if (!this.canSave()) {
      if (!this.fTitle().trim()) this.toast.show('Give the poll a question first.', { tone: 'warn' });
      else this.toast.show('Add at least two options.', { tone: 'warn' });
      return;
    }
    const req: FamilyPollCreate = {
      title: this.fTitle().trim(),
      kind: this.fKind(),
      options: this.buildOptions(),
    };
    this.saving.set(true);
    try {
      const created = await firstValueFrom(this.api.createFamilyPoll(req));
      this.polls.update((list) => [created, ...list]);
      this.tab.set('open');
      this.formOpen.set(false);
      this.toast.show(`Created “${created.title}”`, { tone: 'success', durationMs: 2000 });
    } catch {
      this.toast.show("Couldn't create that poll — try again", { tone: 'warn' });
    } finally {
      this.saving.set(false);
    }
  }

  // ─────────────── internals ───────────────

  private replace(poll: FamilyPoll): void {
    this.polls.update((list) => list.map((p) => (p.id === poll.id ? poll : p)));
  }
}
