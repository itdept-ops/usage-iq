import {
  ChangeDetectionStrategy, Component, computed, input, model, output,
} from '@angular/core';
import { MatIconModule } from '@angular/material/icon';

import { FleetUser } from '../../../core/models';
import { CompactPipe, timeAgo } from '../../../shared/format';
import { BetaBottomSheet, BetaStatTile } from '../../beta-ui';
import { compactUsd, FleetAction, isLocalName } from '../fleet-beta.model';

/**
 * BETA FLEET · UserSheet — the tap-through detail BottomSheet for one fleet user, wrapping the kit
 * {@link BetaBottomSheet}. A hero (icon + display name + last-seen), spend/tokens/records StatTiles, the
 * "Machines this user reported from" chip list (the FULL `FleetUser.machines`), and — when the caller
 * holds `reporter.manage` — combine/move + revoke-key + delete management actions (the page opens the
 * shared confirm sheet). Identity is the resolved display name only; the raw owner email never reaches
 * the client. Pure presentation over the EXISTING `FleetUser` DTO — no fetch, no writes here.
 */
@Component({
  selector: 'app-fleet-user-sheet',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, CompactPipe, BetaBottomSheet, BetaStatTile],
  template: `
    <app-bs-sheet [(open)]="open" detent="half" [label]="sheetLabel()">
      @if (user(); as u) {
        <div class="us">
          <!-- Hero -->
          <header class="us__hero">
            <span class="us__ico" aria-hidden="true">
              <mat-icon>{{ isLocal() ? 'home' : 'person' }}</mat-icon>
            </span>
            <div class="us__id">
              <h2 class="us__name">{{ displayName() }}</h2>
              <p class="us__state">
                <span>Last seen {{ seen() }}</span>
                <span class="us__sep" aria-hidden="true">·</span>
                <span>{{ u.machines.length }} {{ u.machines.length === 1 ? 'machine' : 'machines' }}</span>
              </p>
            </div>
          </header>

          <div class="us__tiles">
            <app-bs-stat-tile [value]="spendLabel()" label="Spend" />
            <app-bs-stat-tile [value]="(u.tokens | compact)" unit="tok" label="Tokens" />
            <app-bs-stat-tile [value]="(u.records | compact)" label="Records" />
          </div>

          <!-- Linked machines -->
          <section class="us__sec">
            <span class="us__sec-h">Machines this user reported from</span>
            @if (u.machines.length) {
              <div class="us__chips">
                @for (m of u.machines; track m) {
                  <span class="us__chip"><mat-icon aria-hidden="true">dns</mat-icon>{{ isLocalName(m) ? 'local' : m }}</span>
                }
              </div>
            } @else {
              <span class="us__none">No linked machines.</span>
            }
          </section>

          <!-- Management (reporter.manage) -->
          @if (canManage()) {
            <section class="us__sec">
              <span class="us__sec-h">Manage</span>
              <div class="us__actions">
                <button type="button" class="us__action" (click)="manage.emit('reassign')">
                  <mat-icon aria-hidden="true">merge_type</mat-icon>
                  <span class="us__action-t">Combine / move…</span>
                </button>
                <button type="button" class="us__action" (click)="manage.emit('revoke')">
                  <mat-icon aria-hidden="true">block</mat-icon>
                  <span class="us__action-t">Revoke key</span>
                </button>
                <button type="button" class="us__action is-danger" (click)="manage.emit('delete')">
                  <mat-icon aria-hidden="true">delete_forever</mat-icon>
                  <span class="us__action-t">Delete…</span>
                </button>
              </div>
            </section>
          }
        </div>
      }
    </app-bs-sheet>
  `,
  styleUrl: './user-sheet.scss',
})
export class FleetUserSheet {
  protected readonly isLocalName = isLocalName;

  /** Two-way open state — the page flips this when a leaderboard row is tapped. */
  readonly open = model<boolean>(false);
  /** The user being detailed (null collapses the sheet body). */
  readonly user = input<FleetUser | null>(null);
  /** reporter.manage — reveals the combine/move + revoke + delete management actions. */
  readonly canManage = input<boolean>(false);
  /** Fired when a management action is chosen — the page opens the confirm sheet for this user. */
  readonly manage = output<FleetAction>();

  protected readonly isLocal = computed(() => {
    const u = this.user();
    return !!u && isLocalName(u.name);
  });
  protected readonly displayName = computed(() => {
    const u = this.user();
    if (!u) return '';
    return isLocalName(u.name) ? 'local (file sync)' : u.name;
  });
  protected readonly seen = computed(() => timeAgo(this.user()?.lastSeenUtc ?? null));
  protected readonly spendLabel = computed(() => compactUsd(this.user()?.costUsd ?? 0));
  protected readonly sheetLabel = computed(() => `${this.displayName()} details`);
}
