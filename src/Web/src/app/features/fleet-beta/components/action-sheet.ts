import {
  ChangeDetectionStrategy, Component, computed, inject, input, model, output, signal,
} from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { MatIconModule } from '@angular/material/icon';

import { Api } from '../../../core/api';
import { CompactPipe } from '../../../shared/format';
import { BetaBottomSheet, BetaSegmentedControl, Segment } from '../../beta-ui';
import { FleetAction, FleetActionRequest } from '../fleet-beta.model';

/** What the sheet reports on success — fed straight into the page's toast. */
export interface FleetActionResult { action: FleetAction; count: number; }

/**
 * BETA FLEET · ActionSheet — the mobile bottom-sheet equivalent of the desktop FleetActionDialog. One
 * sheet drives all three fleet mutations (combine/move, delete, revoke key). It owns the API call and
 * emits a {@link FleetActionResult} on success so the page can refresh + toast; on error it surfaces the
 * message inline and stays open. Reuses the EXISTING `Api.reassignFleet`/`deleteFleet`/`revokeFleetKeys`
 * endpoints (identical bodies to the live page) — no server contract changes.
 *
 * The reassign target picker mirrors the dialog: an "Existing / New" segmented (MACHINE only — a user
 * has no typeable email on the client), an existing-bucket picker, and a free-text new-name field.
 */
@Component({
  selector: 'app-fleet-action-sheet',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, CompactPipe, BetaBottomSheet, BetaSegmentedControl],
  template: `
    <app-bs-sheet [(open)]="open" detent="half" [label]="sheetLabel()" [dismissable]="!busy()">
      @if (request(); as r) {
        <div class="fas" [class.is-danger]="r.action !== 'reassign'">
          <!-- Hero -->
          <header class="fas__hero">
            <span class="fas__ico" [class.is-danger]="r.action !== 'reassign'" aria-hidden="true">
              <mat-icon>{{ heroIcon() }}</mat-icon>
            </span>
            <div class="fas__id">
              <h2 class="fas__title">{{ heroTitle() }}</h2>
              <p class="fas__from">{{ r.label }} · {{ r.records | compact }} record{{ r.records === 1 ? '' : 's' }}</p>
            </div>
          </header>

          @switch (r.action) {
            @case ('reassign') {
              <p class="fas__note">
                Move every record reported under <b>{{ r.label }}</b> to another {{ kindNoun() }}. Pick an
                existing {{ kindNoun() }} to <strong>combine</strong>, or type a name to
                <strong>transfer / re-label</strong>. This rewrites the records — it can't be undone automatically.
              </p>

              <div class="fas__target">
                <span class="fas__lbl">Target {{ kindNoun() }}</span>

                <!-- "New / other name" is MACHINE-only: a user has no email to type on the client. -->
                @if (r.others.length && r.dimension === 'machine') {
                  <app-bs-segmented class="fas__mode" [segments]="modes" [(value)]="targetMode" label="Target mode" />
                }

                @if (targetMode() === 'existing' && r.others.length) {
                  <div class="fas__opts" role="radiogroup" aria-label="Combine into">
                    @for (o of r.others; track $index) {
                      <button type="button" class="fas__opt" role="radio"
                              [class.is-on]="targetExistingIdx() === $index"
                              [attr.aria-checked]="targetExistingIdx() === $index"
                              (click)="targetExistingIdx.set($index)">
                        <mat-icon aria-hidden="true">{{ targetExistingIdx() === $index ? 'radio_button_checked' : 'radio_button_unchecked' }}</mat-icon>
                        <span class="fas__opt-t">{{ o.label }}</span>
                      </button>
                    }
                  </div>
                } @else if (r.dimension === 'machine') {
                  <input class="fas__input" type="text" maxlength="200"
                         [value]="targetNew()" (input)="targetNew.set($any($event.target).value)"
                         placeholder="e.g. build-server" aria-label="New machine name" />
                  <p class="fas__tip"><mat-icon aria-hidden="true">info</mat-icon> Leave empty to re-label to the local (file-sync) bucket.</p>
                } @else {
                  <p class="fas__tip"><mat-icon aria-hidden="true">info</mat-icon> No other users to combine into.</p>
                }
              </div>
            }
            @case ('delete') {
              <p class="fas__note">
                This <strong>permanently deletes</strong> every usage record reported under <b>{{ r.label }}</b>.
                The spend they contributed disappears from every chart and total. This <strong>cannot be undone</strong>.
              </p>
              <div class="fas__danger">
                <mat-icon aria-hidden="true">warning</mat-icon>
                <span><b>{{ r.records | compact }}</b> record{{ r.records === 1 ? '' : 's' }} will be erased.</span>
              </div>
            }
            @case ('revoke') {
              <p class="fas__note">
                Revoke <strong>every active ingest key</strong> owned by <b>{{ r.label }}</b>. Any reporter using
                one stops being accepted on its next request. Existing usage records are <strong>kept</strong> —
                this only cuts off future reporting until a new key is issued.
              </p>
            }
          }

          @if (error()) {
            <div class="fas__error"><mat-icon aria-hidden="true">error</mat-icon><span>{{ error() }}</span></div>
          }

          <div class="fas__actions">
            <button type="button" class="fas__btn fas__btn--ghost" [disabled]="busy()" (click)="open.set(false)">Cancel</button>
            <button type="button" class="fas__btn fas__btn--go" [class.is-danger]="r.action !== 'reassign'"
                    [disabled]="busy() || !canConfirm()" (click)="confirm()">
              <mat-icon aria-hidden="true">{{ heroIcon() }}</mat-icon> {{ confirmLabel() }}
            </button>
          </div>
        </div>
      }
    </app-bs-sheet>
  `,
  styleUrl: './action-sheet.scss',
})
export class FleetActionSheet {
  private readonly api = inject(Api);

  /** Two-way open state — the page flips this when a management action is chosen. */
  readonly open = model<boolean>(false);
  /** The action to run (null collapses the sheet body). */
  readonly request = input<FleetActionRequest | null>(null);
  /** Emitted on a successful mutation — the page refreshes + toasts. */
  readonly done = output<FleetActionResult>();

  readonly busy = signal(false);
  readonly error = signal<string | null>(null);

  readonly modes: Segment[] = [
    { key: 'existing', label: 'Existing' },
    { key: 'new', label: 'New / other' },
  ];
  readonly targetMode = signal<string>('existing');
  readonly targetExistingIdx = signal<number>(0);
  readonly targetNew = signal<string>('');

  constructor() {
    // Reset transient state whenever a fresh request arrives (via effect on the input would re-run on
    // every CD; instead the page passes a new request object and reopens, so we reset on open below).
  }

  /** Reset the picker to defaults for the incoming request. Called by the page right before it opens. */
  reset(): void {
    const r = this.request();
    this.busy.set(false);
    this.error.set(null);
    this.targetMode.set(r && r.others.length ? 'existing' : 'new');
    this.targetExistingIdx.set(0);
    this.targetNew.set('');
  }

  protected readonly kindNoun = computed(() => (this.request()?.dimension === 'machine' ? 'machine' : 'user'));

  protected readonly heroIcon = computed(() => {
    switch (this.request()?.action) {
      case 'delete': return 'delete_forever';
      case 'revoke': return 'block';
      default: return 'merge_type';
    }
  });

  protected readonly heroTitle = computed(() => {
    switch (this.request()?.action) {
      case 'delete': return `Delete ${this.kindNoun()}`;
      case 'revoke': return 'Revoke ingest keys';
      default: return `Combine / move ${this.kindNoun()}`;
    }
  });

  protected readonly sheetLabel = computed(() => `${this.heroTitle()} · ${this.request()?.label ?? ''}`);

  protected readonly confirmLabel = computed(() => {
    const b = this.busy();
    switch (this.request()?.action) {
      case 'delete': return b ? 'Deleting…' : 'Delete permanently';
      case 'revoke': return b ? 'Revoking…' : 'Revoke keys';
      default: return b ? 'Moving…' : 'Move records';
    }
  });

  private chosenExisting() {
    return this.request()?.others[this.targetExistingIdx()];
  }

  /** Whether the current selection is a valid, non-self action. Delete/revoke are always confirmable. */
  protected readonly canConfirm = computed(() => {
    const r = this.request();
    if (!r) return false;
    if (r.action !== 'reassign') return true;
    if (this.targetMode() === 'existing') return r.others.length > 0;
    if (r.dimension !== 'machine') return false;
    const t = this.targetNew().trim();
    return t.length > 0 && t.toLowerCase() !== r.label.toLowerCase();
  });

  confirm(): void {
    const r = this.request();
    if (!r || this.busy() || !this.canConfirm()) return;
    this.busy.set(true);
    this.error.set(null);

    const fail = (e: HttpErrorResponse) => {
      this.busy.set(false);
      this.error.set(e.error?.message ?? 'The action could not be completed. Please try again.');
    };
    const isUser = r.dimension === 'user';
    const userIds = r.userId != null ? [r.userId] : [];

    if (r.action === 'reassign') {
      const body = isUser
        ? { dimension: 'user' as const, userIds, toUserId: this.chosenExisting()?.userId ?? null }
        : {
            dimension: 'machine' as const,
            from: [r.rawValue],
            to: this.targetMode() === 'existing' ? (this.chosenExisting()?.rawValue ?? '') : this.targetNew().trim(),
          };
      this.api.reassignFleet(body).subscribe({
        next: (res) => this.finish({ action: 'reassign', count: res.affected }),
        error: fail,
      });
    } else if (r.action === 'delete') {
      const body = isUser
        ? { dimension: 'user' as const, userIds }
        : { dimension: 'machine' as const, names: [r.rawValue] };
      this.api.deleteFleet(body).subscribe({
        next: (res) => this.finish({ action: 'delete', count: res.deleted }),
        error: fail,
      });
    } else {
      this.api.revokeFleetKeys({ userId: r.userId ?? 0 }).subscribe({
        next: (res) => this.finish({ action: 'revoke', count: res.revoked }),
        error: fail,
      });
    }
  }

  private finish(result: FleetActionResult): void {
    this.busy.set(false);
    this.open.set(false);
    this.done.emit(result);
  }
}
