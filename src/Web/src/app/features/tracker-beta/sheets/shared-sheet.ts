import {
  ChangeDetectionStrategy, Component, computed, inject, model,
} from '@angular/core';

import { TrackerStore } from '../../../core/tracker-store';
import { BottomSheet } from '../ui/bottom-sheet';

/*
 * sheets/shared-sheet.ts — the "view someone's tracker" picker for Tracker Beta ("Strata"), the mobile twin
 * of the desktop shared-view selector (features/tracker/tracker.ts viewSelf/viewOther + store.shared).
 *
 * Lists the people whose tracker the caller may view read-only (TrackerStore.shared — GET /tracker/shared,
 * seeded by the page's loadShared()). Picking one calls store.viewUserTracker(userId) which reloads the day
 * for that target; the whole page then flips to read-only (store.readOnly). Picking "You" returns to the
 * caller's own editable tracker. The client holds NO other-user emails (email-privacy) — only userId + name.
 *
 * Self-styled with the page-host Strata tokens (var(--*) only — no global --tech-*), mobile-first with >=44px
 * targets + aria. Reuses the EXISTING store methods (no new API surface).
 *
 * Contract (the page binds these VERBATIM):
 *   <app-shared-sheet [(open)]="sharedOpen" />
 */
@Component({
  selector: 'app-shared-sheet',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BottomSheet],
  template: `
    <app-bottom-sheet [(open)]="open" detent="half" label="View a tracker">
      <div class="sh-head">
        <h2 class="sh-title">Whose tracker?</h2>
      </div>

      <ul class="sh-list" role="listbox" aria-label="People whose tracker you can view">
        <li>
          <button type="button" class="sh-row" role="option" [attr.aria-selected]="viewUser() == null"
                  [class.on]="viewUser() == null" (click)="pick(null)">
            <span class="sh-avatar sh-avatar--self" aria-hidden="true">{{ selfInitial() }}</span>
            <span class="sh-name">You</span>
            @if (viewUser() == null) { <span class="sh-tick" aria-hidden="true">✓</span> }
          </button>
        </li>
        @for (s of shared(); track s.userId) {
          <li>
            <button type="button" class="sh-row" role="option" [attr.aria-selected]="viewUser() === s.userId"
                    [class.on]="viewUser() === s.userId" (click)="pick(s.userId)">
              <span class="sh-avatar" aria-hidden="true">{{ initial(s.name) }}</span>
              <span class="sh-name">{{ s.name }}</span>
              @if (viewUser() === s.userId) { <span class="sh-tick" aria-hidden="true">✓</span> }
            </button>
          </li>
        }
      </ul>

      @if (!shared().length) {
        <p class="sh-empty">No one has shared their tracker with you yet.</p>
      }
    </app-bottom-sheet>
  `,
  styles: [`
    :host { display: contents; }

    .sh-head { padding: 4px 2px 12px; }
    .sh-title { margin: 0; font-family: var(--font-ui); font-weight: 700; font-size: 19px; color: var(--ink); letter-spacing: -.01em; }

    .sh-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
    .sh-row {
      width: 100%; min-height: 56px; padding: 0 14px;
      display: flex; align-items: center; gap: 12px;
      font-family: var(--font-ui); font-size: 15px; font-weight: 600; color: var(--ink);
      background: var(--bg-sink); border: 1px solid var(--hairline); border-radius: var(--r-tile);
      touch-action: manipulation; -webkit-tap-highlight-color: transparent; cursor: pointer;
      transition: border-color 160ms var(--ease-out), background 160ms var(--ease-out);
    }
    .sh-row.on { border-color: color-mix(in srgb, var(--tech-accent, var(--cal-a)) 55%, transparent); }
    .sh-row:active { background: var(--bg-rise); }
    .sh-row:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }

    .sh-avatar {
      flex: 0 0 auto; width: 36px; height: 36px; border-radius: var(--r-pill);
      display: grid; place-items: center;
      font-family: var(--font-display); font-weight: 700; font-size: 15px; color: #fff;
      background: linear-gradient(135deg, var(--cal-a), var(--cal-b));
    }
    .sh-avatar--self { background: linear-gradient(135deg, var(--tech-accent, var(--pro-a)), var(--tech-accent-2, var(--pro-b))); }

    .sh-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sh-tick { flex: 0 0 auto; color: var(--signal); font-weight: 700; }

    .sh-empty { margin: 16px 2px 0; font-size: 13px; color: var(--ink-faint); }
  `],
})
export class SharedSheet {
  private readonly store = inject(TrackerStore);

  readonly open = model<boolean>(false);

  protected readonly shared = this.store.shared;
  protected readonly viewUser = this.store.viewUser;
  protected readonly selfInitial = computed(() => {
    // The caller's own name isn't on the shared list; fall back to a neutral glyph.
    const name = this.store.day()?.userName;
    return (name?.trim()[0] ?? 'Y').toUpperCase();
  });

  protected initial(name: string): string {
    return (name.trim()[0] ?? '?').toUpperCase();
  }

  /** Switch the viewed tracker (null = own). The store reloads the day; the page flips read-only. Then close. */
  protected pick(userId: number | null): void {
    void this.store.viewUserTracker(userId);
    this.open.set(false);
  }
}
