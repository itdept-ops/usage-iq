import { Pipe, PipeTransform } from '@angular/core';

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
