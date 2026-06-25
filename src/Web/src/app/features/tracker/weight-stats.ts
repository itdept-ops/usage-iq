import { Component, computed, inject, input, ChangeDetectionStrategy } from '@angular/core';

import { WeightSlot, WeightStatsDto } from '../../core/models';
import { MatIconModule } from '@angular/material/icon';
import { UnitService } from '../../core/unit.service';

/** One per-slot row for the template (already formatted into the user's display units). */
interface SlotRow {
  slot: WeightSlot;
  label: string;
  avg: string;
  count: number;
}

/** Display order + friendly labels for the slots we surface (Unspecified is folded in last). */
const SLOT_LABELS: { slot: WeightSlot; label: string }[] = [
  { slot: 'Morning', label: 'Morning' },
  { slot: 'Afternoon', label: 'Afternoon' },
  { slot: 'Evening', label: 'Evening' },
  { slot: 'Unspecified', label: 'Unspecified' },
];

/**
 * Weight-by-time-of-day stats card for the tracker dashboard. Renders the per-slot averages (Morning /
 * Afternoon / Evening) and the typical morning→evening delta from GET /api/tracker/weight/stats, sitting
 * alongside the trend chart. All weights respect the user's unit preference via {@link formatWeight}.
 * Renders nothing when there are no slotted readings yet (the trend chart's own empty state covers that).
 */
@Component({
  selector: 'app-weight-stats',
  imports: [MatIconModule],
  template: `
    @if (rows().length > 0) {
      <div class="ws" role="group" aria-label="Weight by time of day">
        <div class="ws-grid">
          @for (r of rows(); track r.slot) {
            <div class="ws-slot">
              <span class="ws-slot__l">{{ r.label }} avg</span>
              <span class="ws-slot__v mono-num">{{ r.avg }}</span>
              <span class="ws-slot__c">{{ r.count }} reading{{ r.count === 1 ? '' : 's' }}</span>
            </div>
          }
        </div>
        @if (deltaText(); as d) {
          <p class="ws-delta">
            <mat-icon aria-hidden="true">{{ d.icon }}</mat-icon>
            <span>{{ d.text }}</span>
          </p>
        }
      </div>
    }
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: `
    .ws {
      display: flex;
      flex-direction: column;
      gap: var(--tech-space-2);
      margin-top: var(--tech-space-3);
      padding: var(--tech-space-3);
      border: 1px solid var(--tech-border);
      border-radius: var(--tech-r-control);
      background: var(--tech-bg-sunken);
    }
    .ws-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
      gap: var(--tech-space-2) var(--tech-space-3);
    }
    .ws-slot {
      display: flex;
      flex-direction: column;
      gap: 1px;
    }
    .ws-slot__l {
      font-size: var(--tech-fs-micro);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--tech-text-tertiary);
    }
    .ws-slot__v {
      font-size: var(--tech-fs-h2, var(--tech-fs-body));
      font-weight: 700;
      color: var(--tech-text);
    }
    .ws-slot__c {
      font-size: var(--tech-fs-micro);
      color: var(--tech-text-tertiary);
    }
    .ws-delta {
      display: flex;
      align-items: center;
      gap: 6px;
      margin: 0;
      font-size: var(--tech-fs-label);
      color: var(--tech-text-secondary);
      mat-icon {
        font-size: 18px;
        width: 18px;
        height: 18px;
        color: var(--tech-accent);
      }
    }
  `,
})
export class WeightStats {
  readonly units = inject(UnitService);

  readonly stats = input.required<WeightStatsDto | null>();
  /**
   * The page's display preference, still bound by the parent for clarity. NOTE: this component no longer
   * writes the global preference itself — the parent tracker page seeds the shared UnitService from the
   * profile, and all formatting below reads that single shared signal. Kept as an input so the existing
   * [imperial] binding stays valid.
   */
  readonly imperial = input<boolean>(false);

  /** Per-slot rows in display order, formatted into the user's units. Unspecified is only shown if present. */
  readonly rows = computed<SlotRow[]>(() => {
    const s = this.stats();
    if (!s) return [];
    const out: SlotRow[] = [];
    for (const { slot, label } of SLOT_LABELS) {
      const row = s.bySlot.find((b) => b.slot === slot);
      if (!row || row.count === 0) continue;
      out.push({ slot, label, avg: this.units.formatWeight(row.avgKg) ?? '—', count: row.count });
    }
    return out;
  });

  /**
   * The morning→evening delta as a directional sentence in the user's units (e.g. "Evening reads 0.8 kg
   * heavier than morning on average"), or null when either slot is missing the delta server-side.
   */
  readonly deltaText = computed<{ text: string; icon: string } | null>(() => {
    const s = this.stats();
    const d = s?.morningEveningDeltaKg;
    if (s == null || d == null) return null;
    const mag = this.units.formatWeight(Math.abs(d)) ?? '—';
    if (Math.abs(d) < 0.05)
      return {
        text: 'Morning and evening weights are about the same on average.',
        icon: 'drag_handle',
      };
    if (d > 0)
      return { text: `Evening reads ${mag} heavier than morning on average.`, icon: 'trending_up' };
    return { text: `Evening reads ${mag} lighter than morning on average.`, icon: 'trending_down' };
  });
}
