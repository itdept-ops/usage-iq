import {
  ChangeDetectionStrategy, Component, computed, input, output,
} from '@angular/core';
import { MatIconModule } from '@angular/material/icon';

import { FleetUser } from '../../../core/models';
import { CompactPipe } from '../../../shared/format';
import { compactUsd, isLocalName } from '../fleet-beta.model';

/** A leaderboard row: the user + its rank, share of total spend, and the relative-bar width. */
interface LbRow {
  key: string;
  /** The full source user — passed through on tap so the page can open a detail/manage sheet. */
  user: FleetUser;
  name: string;
  isLocal: boolean;
  costUsd: number;
  tokens: number;
  records: number;
  machines: number;
  rank: number;
  /** Share of the board's total spend (0..1). */
  share: number;
  /** Bar width % relative to the top spender. */
  pct: number;
}

/**
 * BETA FLEET · UserLeaderboard — the per-user spend ranking: each user as a ranked row with an accent
 * bar (width = spend vs the top spender) and a share-% chip. Sorted cost-desc, mirroring the live
 * fleet's Users board. Pure presentation over the EXISTING `FleetUser[]` — no fetch, no writes.
 */
@Component({
  selector: 'app-fleet-user-leaderboard',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, CompactPipe],
  template: `
    @if (rows().length) {
      <ol class="lb">
        @for (r of rows(); track r.key; let i = $index) {
          <li class="lb__row" [style.--i]="i">
            <button type="button" class="lb__tap" (click)="select.emit(r.user)"
                    [attr.aria-label]="r.name + ', ' + costLabel(r.costUsd) + ' spend. Tap for details.'">
              <span class="lb__rank" aria-hidden="true">{{ r.rank }}</span>
              <span class="lb__body">
                <span class="lb__top">
                  <span class="lb__name" [title]="r.name">
                    <mat-icon class="lb__kind" aria-hidden="true">{{ r.isLocal ? 'home' : 'person' }}</mat-icon>
                    {{ r.isLocal ? 'local (file sync)' : r.name }}
                  </span>
                  <span class="lb__cost">{{ costLabel(r.costUsd) }}</span>
                </span>
                <span class="lb__bar" aria-hidden="true"><i [style.width.%]="r.pct"></i></span>
                <span class="lb__foot">
                  <span class="lb__share">{{ sharePct(r.share) }}% of spend</span>
                  <span class="lb__nums">
                    <span class="lb__num">{{ r.records | compact }} rec</span>
                    <span class="lb__num">{{ r.tokens | compact }} tok</span>
                    <span class="lb__num">{{ r.machines }} {{ r.machines === 1 ? 'machine' : 'machines' }}</span>
                  </span>
                </span>
              </span>
              <mat-icon class="lb__chev" aria-hidden="true">chevron_right</mat-icon>
            </button>
          </li>
        }
      </ol>
    } @else {
      <div class="lb__empty">
        <span class="lb__empty-orb" aria-hidden="true"><mat-icon>group_off</mat-icon></span>
        <p class="lb__empty-title">No users found</p>
        <p class="lb__empty-hint">No users reported activity in this range.</p>
      </div>
    }
  `,
  styleUrl: './user-leaderboard.scss',
})
export class FleetUserLeaderboard {
  /** The users to rank (the page passes them pre-fetched; this orders + bars them). */
  readonly users = input.required<FleetUser[]>();
  /** Fired when a row is tapped — the page opens the user detail sheet with the full FleetUser. */
  readonly select = output<FleetUser>();

  /** Stable, non-email key for a user row (the userId when present, else the bucket name). */
  private userKey(u: FleetUser): string {
    return u.userId != null ? 'u' + u.userId : 'n:' + u.name;
  }

  protected readonly rows = computed<LbRow[]>(() => {
    const sorted = [...this.users()].sort((a, b) => b.costUsd - a.costUsd);
    const total = sorted.reduce((s, u) => s + u.costUsd, 0);
    const max = sorted.reduce((m, u) => Math.max(m, u.costUsd), 0) || 1;
    return sorted.map((u, i) => ({
      key: this.userKey(u),
      user: u,
      name: u.name,
      isLocal: isLocalName(u.name),
      costUsd: u.costUsd,
      tokens: u.tokens,
      records: u.records,
      machines: u.machines.length,
      rank: i + 1,
      share: total > 0 ? u.costUsd / total : 0,
      pct: Math.max(3, Math.round((u.costUsd / max) * 100)),
    }));
  });

  protected costLabel(v: number): string { return compactUsd(v); }
  protected sharePct(share: number): string { return (share * 100).toFixed(share >= 0.1 ? 0 : 1); }
}
