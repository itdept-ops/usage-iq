import {
  ChangeDetectionStrategy, Component, input, output, signal,
} from '@angular/core';
import { MatIconModule } from '@angular/material/icon';

/** One tile in the quick-rail. `key` is the caller's identifier echoed back on tap/long-press. */
export interface QuickTile {
  /** Stable identifier echoed back on (tap)/(longPress), e.g. 'water' | 'coffee' | 'weigh' | 'meal'. */
  key: string;
  /** Material icon ligature name. */
  icon: string;
  /** Short label under the glyph (e.g. "+250 ml"). */
  label: string;
  /** Optional CSS gradient stops for the tile accent (defaults to calorie violet→blue). */
  accentA?: string;
  accentB?: string;
}

/**
 * Strata quick-rail — a horizontal scroll-snap rail of one-tap tiles (water/coffee/weigh/meal). A tap
 * fires `tap(key)` (the host runs the optimistic mutation — e.g. addHydration({amountMl:250})); a
 * long-press fires `longPress(key)` (the host opens the adjust sheet). Each tile press-sinks
 * (--press + scale .97 + translateY 1px) and pulses navigator.vibrate(10) (a no-op on iOS).
 *
 * The rail itself is x-scroll-snap-mandatory with a hidden scrollbar and contained overscroll; tiles are
 * >=64px wide and >=44px tall. Reduced-motion collapses the sink via the page-host killswitch.
 *
 * Contract (component agents depend on this VERBATIM):
 *   selector:  app-quick-rail
 *   inputs:    tiles (QuickTile[], required), disabled (boolean, default false)
 *   outputs:   tap (string — the tile key), longPress (string — the tile key)
 *
 * Usage: `<app-quick-rail [tiles]="rail" (tap)="onQuick($event)" (longPress)="onAdjust($event)" />`
 */
@Component({
  selector: 'app-quick-rail',
  standalone: true,
  imports: [MatIconModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'tb-quick-rail' },
  template: `
    @for (t of tiles(); track t.key) {
      <button type="button" class="tb-qtile" [class.sink]="pressed() === t.key"
              [disabled]="disabled()" [attr.aria-label]="t.label"
              [style.--qa]="t.accentA || 'var(--cal-a)'"
              [style.--qb]="t.accentB || 'var(--cal-b)'"
              (pointerdown)="onDown(t.key)"
              (pointerup)="onUp(t.key)"
              (pointercancel)="onCancel()"
              (pointerleave)="onCancel()">
        <mat-icon class="tb-qicon" aria-hidden="true">{{ t.icon }}</mat-icon>
        <span class="tb-qlabel">{{ t.label }}</span>
      </button>
    }
  `,
  styles: [`
    .tb-qtile {
      flex: 0 0 auto; scroll-snap-align: start;
      min-width: 64px; min-height: 64px;
      display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px;
      padding: 10px 12px;
      border: 1px solid var(--glass-edge); border-radius: var(--r-tile);
      background: var(--bg-rise); color: var(--ink);
      box-shadow: var(--lift-1);
      cursor: pointer; touch-action: manipulation; -webkit-tap-highlight-color: transparent;
      transition: transform 120ms var(--ease-out), box-shadow 120ms var(--ease-out);
    }
    .tb-qtile:disabled { opacity: .45; pointer-events: none; }
    .tb-qtile.sink {
      transform: scale(.97) translateY(1px);
      box-shadow: var(--press);
    }
    .tb-qicon {
      width: 24px; height: 24px; font-size: 24px; line-height: 24px;
      background: linear-gradient(135deg, var(--qa), var(--qb));
      -webkit-background-clip: text; background-clip: text; color: transparent;
    }
    .tb-qlabel {
      font-size: 11px; font-weight: 600; letter-spacing: .02em; color: var(--ink-dim);
      white-space: nowrap;
    }
  `],
})
export class QuickRail {
  /** The tiles, leftmost = highest frequency (water first in the thumb arc). */
  readonly tiles = input.required<QuickTile[]>();
  /** When true (read-only views) the rail is inert. */
  readonly disabled = input<boolean>(false);
  /** Fired on a clean tap (no long-press) — the tile key. */
  readonly tap = output<string>();
  /** Fired when the press is held past the long-press window — the tile key. */
  readonly longPress = output<string>();

  /** ms a press must be held to count as a long-press. */
  private static readonly LONG_MS = 450;

  /** The key currently press-sunk (drives the sink class). */
  protected readonly pressed = signal<string | null>(null);
  private timer: ReturnType<typeof setTimeout> | null = null;
  private firedLong = false;

  protected onDown(key: string): void {
    if (this.disabled()) return;
    this.pressed.set(key);
    this.firedLong = false;
    this.timer = setTimeout(() => {
      this.firedLong = true;
      this.vibrate(15);
      this.longPress.emit(key);
    }, QuickRail.LONG_MS);
  }

  protected onUp(key: string): void {
    if (this.pressed() !== key) return;
    this.clearTimer();
    this.pressed.set(null);
    if (!this.firedLong) {
      this.vibrate(10);
      this.tap.emit(key);
    }
  }

  protected onCancel(): void {
    this.clearTimer();
    this.pressed.set(null);
  }

  private clearTimer(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  private vibrate(ms: number): void {
    try { navigator.vibrate?.(ms); } catch { /* no-op (iOS / unsupported) */ }
  }
}
