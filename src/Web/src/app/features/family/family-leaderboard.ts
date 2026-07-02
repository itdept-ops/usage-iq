import {
  ChangeDetectionStrategy, Component, computed, inject, signal,
} from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { catchError, of } from 'rxjs';

import { Api } from '../../core/api';
import { LeaderboardMetric, LeaderboardRowDto } from '../../core/models';

/** The three rankable metrics, with the humane label + glyph the segmented switch uses. */
const METRICS: readonly { key: LeaderboardMetric; label: string; icon: string; unit: string }[] = [
  { key: 'workout', label: 'Workouts', icon: 'fitness_center', unit: 'logged' },
  { key: 'challenge', label: '75 Hard', icon: 'military_tech', unit: 'days' },
  { key: 'hydration', label: 'Water', icon: 'local_drink', unit: 'goals' },
];

/**
 * <app-family-leaderboard> — a household leaderboard panel on the Family Hub. Ranks the caller's OWN household
 * members over a switchable SHAREABLE activity metric (workouts / 75 Hard days / water goals) via
 * {@link Api.familyLeaderboard} (GET /api/family/leaderboard?metric=, gated family.use).
 *
 * PRIVACY: every row is an AppUser id + DisplayName-formatted name (never an email); the ranked figure is a
 * COUNT of already-shareable ActivityEvents only — NEVER a private tracker amount or any health figure. Ties
 * share a rank (competition ranking). Self-contained + read-only; a fetch failure simply hides the panel.
 */
@Component({
  selector: 'app-family-leaderboard',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule],
  styleUrl: './family-leaderboard.scss',
  template: `
    <section class="lb" aria-label="Family leaderboard">
      <div class="lb__head">
        <h2 class="lb__title"><mat-icon aria-hidden="true">leaderboard</mat-icon> Leaderboard</h2>
        <div class="lb__switch" role="group" aria-label="Metric">
          @for (m of metrics; track m.key) {
            <button type="button" class="lb__tab" [class.is-on]="metric() === m.key"
                    [attr.aria-pressed]="metric() === m.key" (click)="setMetric(m.key)">
              <mat-icon aria-hidden="true">{{ m.icon }}</mat-icon>
              <span class="lb__tab-label">{{ m.label }}</span>
            </button>
          }
        </div>
      </div>

      @if (loading()) {
        <div class="lb__state" role="status">
          <mat-icon aria-hidden="true">hourglass_empty</mat-icon>
          <p>Tallying the standings…</p>
        </div>
      } @else if (rows().length === 0) {
        <div class="lb__state lb__empty">
          <mat-icon class="lb__empty-icon" aria-hidden="true">leaderboard</mat-icon>
          <p>No shareable activity yet. As household members log workouts, complete challenge days, or hit water goals (with activity sharing on), the leaderboard fills in.</p>
        </div>
      } @else {
        <ol class="lb__rows">
          @for (r of rows(); track r.userId) {
            <li class="lb__row" [class.is-podium]="r.rank <= 3">
              <span class="lb__rank" [attr.data-rank]="r.rank">{{ r.rank }}</span>
              <span class="lb__avatar" aria-hidden="true">{{ initials(r.name) }}</span>
              <span class="lb__name">{{ r.name }}</span>
              <span class="lb__value">{{ r.intValue }} <span class="lb__unit">{{ unit() }}</span></span>
            </li>
          }
        </ol>
      }
    </section>
  `,
})
export class FamilyLeaderboard {
  private api = inject(Api);

  readonly metrics = METRICS;
  readonly metric = signal<LeaderboardMetric>('workout');
  readonly rows = signal<LeaderboardRowDto[]>([]);
  readonly loading = signal(true);

  readonly unit = computed(() => this.metrics.find((m) => m.key === this.metric())?.unit ?? '');

  constructor() {
    this.load();
  }

  setMetric(m: LeaderboardMetric): void {
    if (m === this.metric()) return;
    this.metric.set(m);
    this.load();
  }

  private load(): void {
    this.loading.set(true);
    this.api
      .familyLeaderboard(this.metric())
      .pipe(catchError(() => of<LeaderboardRowDto[]>([])))
      .subscribe((rows) => {
        this.rows.set(rows);
        this.loading.set(false);
      });
  }

  initials(name: string): string {
    const parts = (name || '').split(/\s+/).filter(Boolean);
    return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || 'U';
  }
}
