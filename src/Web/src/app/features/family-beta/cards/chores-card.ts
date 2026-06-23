import {
  ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatIconModule } from '@angular/material/icon';
import { catchError, of } from 'rxjs';

import { Api } from '../../../core/api';
import { FamilyChore, FamilyChores } from '../../../core/models';
import { HearthCard, HearthPhase } from './hearth-card';
import { OptimisticFamily } from '../state/optimistic-family';

/**
 * Hearth "Chores" glance card — open chore count + the next few still-open chores, with a one-tap "done"
 * tick (optimistic: the row flips + the count bumps instantly, then reconciles from the server board, and
 * rolls back + offers Retry on failure via {@link OptimisticFamily}). Best-effort: it owns its own cold
 * {@link Api.familyChores} subscription with `catchError(of(null))`, so a chores/network failure blanks
 * only THIS card. Deep-links to the live `/family/chores`.
 *
 * Tick semantics mirror the live page's role split WITHOUT importing it: a manager (parent) toggles the
 * legacy `done`; a child submits for approval. Names only (assignedToName) — never an email.
 */
@Component({
  selector: 'fb-chores-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HearthCard, MatIconModule],
  template: `
    <fb-hearth-card
      title="Chores" route="/family/chores" accentVar="--chore"
      [phase]="phase()" emptyText="All chores are done — nice."
      (retry)="reload()">

      <span head-trailing class="count" [class.count--zero]="openCount() === 0">
        {{ openCount() }} open
      </span>

      @if (phase() === 'ready') {
        <ul body class="list">
          @for (ch of topOpen(); track ch.id) {
            <li class="row">
              <button type="button" class="tick" [disabled]="busy().has(ch.id)"
                      (click)="tick(ch)" [attr.aria-label]="'Mark ' + ch.title + ' done'">
                <mat-icon aria-hidden="true">radio_button_unchecked</mat-icon>
              </button>
              <span class="row__text">
                <span class="row__title">{{ ch.title }}</span>
                @if (ch.assignedToName) { <span class="row__who">{{ ch.assignedToName }}</span> }
              </span>
              @if (ch.points) { <span class="row__pts" aria-label="points">★ {{ ch.points }}</span> }
            </li>
          }
          @if (openCount() > topOpen().length) {
            <li class="more">+{{ openCount() - topOpen().length }} more</li>
          }
        </ul>
      }
    </fb-hearth-card>
  `,
  styles: [`
    .count {
      margin-left: auto; font-size: 12px; font-weight: 700;
      padding: 3px 9px; border-radius: 999px;
      background: color-mix(in srgb, var(--chore) 20%, transparent); color: var(--chore);
    }
    .count--zero { background: rgba(255,255,255,.06); color: var(--ink-dim); }
    .list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
    .row { display: flex; align-items: center; gap: 12px; padding: 8px 0; min-height: 44px; }
    .tick {
      flex: 0 0 auto; display: grid; place-items: center;
      width: 44px; height: 44px; margin: -6px 0 -6px -10px;
      border: none; background: transparent; color: var(--chore); cursor: pointer; border-radius: 999px;
    }
    .tick:disabled { opacity: .5; }
    .tick:focus-visible { outline: 2px solid var(--chore); outline-offset: 2px; }
    .tick mat-icon { font-size: 24px; width: 24px; height: 24px; }
    .row__text { display: flex; flex-direction: column; min-width: 0; flex: 1 1 auto; }
    .row__title { font-size: 15px; color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .row__who { font-size: 12px; color: var(--ink-dim); }
    .row__pts { flex: 0 0 auto; font-size: 13px; color: var(--reminder); font-weight: 600; }
    .more { padding: 6px 0 0; font-size: 13px; color: var(--ink-dim); }
  `],
})
export class ChoresCard {
  private readonly api = inject(Api);
  private readonly optimistic = inject(OptimisticFamily);
  private readonly destroyRef = inject(DestroyRef);

  private readonly board = signal<FamilyChores | null>(null);
  private readonly failed = signal(false);
  private readonly loadingState = signal(true);
  /** Chore ids with an in-flight tick (so we disable the row + ignore double-taps). */
  readonly busy = signal<ReadonlySet<number>>(new Set());

  /** Still-open chores (not done and not already submitted/approved) in board order. */
  private readonly openChores = computed<FamilyChore[]>(() =>
    (this.board()?.chores ?? []).filter(c => !c.done && c.status !== 'submitted' && c.status !== 'approved'));

  readonly openCount = computed(() => this.openChores().length);
  readonly topOpen = computed(() => this.openChores().slice(0, 4));

  readonly phase = computed<HearthPhase>(() => {
    if (this.loadingState()) return 'loading';
    if (this.failed()) return 'failed';
    return this.board() ? 'ready' : 'empty';
  });

  constructor() {
    this.reload();
  }

  reload(): void {
    this.loadingState.set(true);
    this.failed.set(false);
    this.api.familyChores()
      .pipe(catchError(() => { this.failed.set(true); return of<FamilyChores | null>(null); }), takeUntilDestroyed(this.destroyRef))
      .subscribe(b => {
        if (b) this.board.set(b);
        this.loadingState.set(false);
      });
  }

  /** Optimistically remove the chore from the open list, then commit via the role-correct endpoint. */
  async tick(ch: FamilyChore): Promise<void> {
    if (this.busy().has(ch.id)) return;
    const prev = this.board();
    const canManage = prev?.canManage ?? false;

    // Optimistic local bump: drop the chore from the open set immediately.
    this.board.update(b => b ? { ...b, chores: b.chores.map(c =>
      c.id === ch.id ? { ...c, done: canManage ? true : c.done, status: canManage ? c.status : 'submitted' } : c) } : b);
    this.setBusy(ch.id, true);

    const rollback = () => this.board.set(prev);
    const retry = () => void this.tick(ch);
    const result = canManage
      ? await this.optimistic.toggleChore(ch.id, true, rollback, retry)
      : await this.optimistic.submitChore(ch.id, rollback, retry);

    if (result) this.board.set(result); // reconcile from the authoritative board
    this.setBusy(ch.id, false);
  }

  private setBusy(id: number, on: boolean): void {
    this.busy.update(s => {
      const next = new Set(s);
      if (on) next.add(id); else next.delete(id);
      return next;
    });
  }
}
