import { Pipe, PipeTransform } from '@angular/core';

/** Relative "time ago" label, e.g. "just now", "5m ago", "2h ago", "3d ago". */
export function timeAgo(iso: string | null | undefined, nowMs: number = Date.now()): string {
  if (!iso) return 'never';
  const diff = Math.max(0, nowMs - new Date(iso).getTime());
  const s = Math.floor(diff / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Humanize a number of seconds into a short cadence, e.g. 300 -> "5m". */
export function humanizeInterval(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

/** Compact large numbers: 11_309_160_279 -> "11.3B". */
@Pipe({ name: 'compact', standalone: true })
export class CompactPipe implements PipeTransform {
  transform(value: number | null | undefined, digits = 1): string {
    if (value == null) return '—';
    const abs = Math.abs(value);
    const units: ReadonlyArray<readonly [number, string]> = [
      [1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K'],
    ];
    for (const [n, suffix] of units) {
      if (abs >= n) return (value / n).toFixed(digits).replace(/\.0+$/, '') + suffix;
    }
    return value.toLocaleString();
  }
}
