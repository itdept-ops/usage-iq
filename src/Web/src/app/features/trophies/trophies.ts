import { CommonModule } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { catchError, of } from 'rxjs';

import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatTooltipModule } from '@angular/material/tooltip';

import { Api } from '../../core/api';
import { TrophyBadgeDto, TrophiesResponse } from '../../core/models';

/** Map a badge's catalog icon token (a lucide-ish name from the API) to a Material Symbols glyph. */
const ICON: Record<string, string> = {
  dumbbell: 'fitness_center',
  'calendar-check': 'event_available',
  droplet: 'water_drop',
  waves: 'waves',
  scale: 'monitor_weight',
  coffee: 'coffee',
  pill: 'medication',
  flame: 'local_fire_department',
  'check-circle': 'check_circle',
  star: 'star',
  trophy: 'emoji_events',
  receipt: 'receipt_long',
};

/**
 * The Trophy Wall — the caller's OWN milestone badges, DERIVED at read time on the server from existing
 * tracker / 75-Hard / bills data (GET /api/trophies). Personal-only in V1 (no sharing). Each badge shows its
 * earned tier (bronze/silver/gold or a one-shot "complete"), the measured value, and a progress bar toward the
 * next unearned tier. Read-only + purely additive — gated by the same tracker.self permission as the tracker.
 */
@Component({
  selector: 'app-trophies',
  standalone: true,
  imports: [CommonModule, MatIconModule, MatProgressSpinnerModule, MatProgressBarModule, MatTooltipModule],
  templateUrl: './trophies.html',
  styleUrl: './trophies.scss',
})
export class Trophies {
  private api = inject(Api);

  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly data = signal<TrophiesResponse | null>(null);

  /** Badges grouped by their `group` field, preserving the catalog order within each group. */
  readonly groups = computed(() => {
    const d = this.data();
    if (!d) return [] as { name: string; badges: TrophyBadgeDto[] }[];
    const order: string[] = [];
    const byGroup = new Map<string, TrophyBadgeDto[]>();
    for (const b of d.badges) {
      if (!byGroup.has(b.group)) { byGroup.set(b.group, []); order.push(b.group); }
      byGroup.get(b.group)!.push(b);
    }
    return order.map(name => ({ name, badges: byGroup.get(name)! }));
  });

  constructor() {
    this.api.trophies().pipe(
      catchError(() => { this.error.set('Could not load your trophies.'); return of(null); }),
      takeUntilDestroyed(),
    ).subscribe(resp => {
      if (resp) this.data.set(resp);
      this.loading.set(false);
    });
  }

  icon(badge: TrophyBadgeDto): string {
    return ICON[badge.icon] ?? 'emoji_events';
  }

  /** A short caption for a badge's standing: the earned tier, or the path to the next one. */
  caption(b: TrophyBadgeDto): string {
    if (b.nextTier === null) return b.earned ? 'Maxed out' : 'Complete';
    const remaining = Math.max(0, b.nextTier.threshold - b.value);
    return `${this.fmt(b.value)} / ${this.fmt(b.nextTier.threshold)} · ${this.fmt(remaining)} to ${b.nextTier.name}`;
  }

  /** Whole numbers render without a decimal; fractional points keep one place. */
  fmt(n: number): string {
    return Number.isInteger(n) ? String(n) : n.toFixed(1);
  }

  /** Progress 0..100 for the Material bar. */
  pct(b: TrophyBadgeDto): number {
    return Math.round(b.progressToNext * 100);
  }
}
