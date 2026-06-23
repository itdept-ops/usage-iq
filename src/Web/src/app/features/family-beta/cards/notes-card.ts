import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';

import { FamilyToday, FamilyTodayNote } from '../../../core/models';
import { HearthCard, HearthPhase } from './hearth-card';

/**
 * Hearth "Pinned notes" glance card — the household's pinned notes (id + title only, per the DTO) as a
 * stacked-paper list deep-linking to the live `/family/notes`. Glance data comes from the page-owned
 * `today` snapshot, so this card owns no network; it shows the same skeleton/empty/failed lifecycle
 * driven by the page's `loading`/`failed` inputs.
 */
@Component({
  selector: 'fb-notes-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HearthCard, RouterLink, MatIconModule],
  template: `
    <fb-hearth-card
      title="Pinned notes" route="/family/notes" accentVar="--note"
      [phase]="phase()" emptyText="Nothing pinned right now.">

      @if (phase() === 'ready') {
        <ul body class="notes">
          @for (n of notes(); track n.id) {
            <li>
              <a class="note" routerLink="/family/notes">
                <mat-icon class="note__icon" aria-hidden="true">sticky_note_2</mat-icon>
                <span class="note__title">{{ n.title || 'Untitled note' }}</span>
              </a>
            </li>
          }
        </ul>
      }
    </fb-hearth-card>
  `,
  styles: [`
    .notes { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
    .note {
      display: flex; align-items: center; gap: 10px; min-height: 44px;
      text-decoration: none; color: var(--ink);
    }
    .note__icon { flex: 0 0 auto; color: var(--note); font-size: 20px; width: 20px; height: 20px; }
    .note__title { font-size: 15px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .note:focus-visible { outline: 2px solid var(--note); outline-offset: 2px; border-radius: 8px; }
  `],
})
export class NotesCard {
  /** The shared Today snapshot (page-owned, best-effort). */
  readonly today = input<FamilyToday | null>(null);
  /** Whether the shared snapshot is still loading (page-owned). */
  readonly loading = input<boolean>(true);
  /** Whether the shared snapshot load failed (page-owned). */
  readonly failed = input<boolean>(false);

  readonly notes = computed<FamilyTodayNote[]>(() => this.today()?.pinnedNotes ?? []);

  readonly phase = computed<HearthPhase>(() => {
    if (this.loading()) return 'loading';
    if (this.failed()) return 'failed';
    return this.notes().length ? 'ready' : 'empty';
  });
}
