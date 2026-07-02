import type { InsightKind } from './models';

/**
 * SHARED INSIGHTS HELPERS — framework-light (no Angular) primitives used by BOTH the desktop `/insights`
 * page and its mobile twin, so the deterministic stat-parsing and the kind metadata live in exactly one place.
 *
 * `parseR` / `axisX` / `axisY` back the ILLUSTRATIVE correlation scatter (they read only the published
 * aggregate stat + title — never raw logged values). `KIND_ORDER` / `KIND_META` / `KIND_COLORS` are the
 * canonical section order, labels/icons/blurbs, and donut hues for the five insight kinds.
 */

/** Metadata for one insight-kind section (label + icon + blurb). */
export interface InsightKindMeta {
  readonly label: string;
  readonly icon: string;
  readonly blurb: string;
}

/** The canonical display order of the five insight kinds. */
export const KIND_ORDER: readonly InsightKind[] = [
  'correlation', 'trend', 'streak', 'anomaly', 'bestworst',
];

/** Per-kind section label, icon and blurb — shared verbatim by both twins. */
export const KIND_META: Record<InsightKind, InsightKindMeta> = {
  correlation: {
    label: 'Correlations', icon: 'sync_alt',
    blurb: 'Paired-day associations across domains (≥10 days). Association, not causation.',
  },
  trend: {
    label: 'Trends', icon: 'trending_up',
    blurb: 'Where a metric is drifting — with a bounded estimate, not a prediction.',
  },
  streak: {
    label: 'Streaks', icon: 'local_fire_department',
    blurb: 'Your longest & current qualifying runs.',
  },
  anomaly: {
    label: 'Anomalies', icon: 'warning_amber',
    blurb: 'Statistical outlier days (|z| ≥ 2).',
  },
  bestworst: {
    label: 'Best & worst', icon: 'emoji_events',
    blurb: 'Your standout high & low days per metric.',
  },
};

/** Per-kind ring hues for the summary donut — the page's indigo→violet family plus warm accents. */
export const KIND_COLORS: Record<InsightKind, string> = {
  correlation: '#a78bfa',
  trend: '#7dd3fc',
  streak: '#f9a8d4',
  anomaly: '#fbbf24',
  bestworst: '#5eead4',
};

/**
 * Extract the (signed) correlation coefficient out of a card's `stat`/`detail` text — e.g. "r=0.61 · moderate"
 * or "r=-0.43 …". Falls back to 0.5 when absent/unparseable, honours an explicit "negative" magnitude even if
 * the printed r is unsigned, and clamps to [-1, 1].
 */
export function parseR(stat: string, detail: string, magnitude: string | null | undefined): number {
  const m = `${stat} ${detail}`.match(/r\s*=\s*(-?\d*\.?\d+)/i);
  let r = m ? Number(m[1]) : 0.5;
  if (!Number.isFinite(r)) r = 0.5;
  if (r > 0 && (magnitude ?? '').toLowerCase().includes('negative')) r = -r;
  return Math.max(-1, Math.min(1, r));
}

/** Split a "A vs B" title into a rough X-axis label (illustrative). */
export function axisX(title: string): string {
  const parts = title.split(/\bvs\b|→|↔/i);
  return (parts[0] ?? 'A').trim().slice(0, 22) || 'A';
}

/** Split a "A vs B" title into a rough Y-axis label (illustrative). */
export function axisY(title: string): string {
  const parts = title.split(/\bvs\b|→|↔/i);
  return (parts[1] ?? parts[0] ?? 'B').trim().slice(0, 22) || 'B';
}
