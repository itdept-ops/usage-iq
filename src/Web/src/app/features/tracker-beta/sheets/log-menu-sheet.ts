import {
  ChangeDetectionStrategy, Component, inject, model, output, signal,
} from '@angular/core';
import { MatIconModule } from '@angular/material/icon';

import { BottomSheet } from '../ui/bottom-sheet';
import { OptimisticTracker } from '../state/optimistic-tracker';

/**
 * The canonical set of log destinations the "+ LOG" fan-out routes to. The page owns the per-domain
 * sheets (food/water/coffee/exercise/weight/supplement) and the three fast lanes (scan/snap/brain-dump);
 * this menu only *chooses* one and emits it. Other sheets/components depend on this union VERBATIM.
 *
 *   domain tiles : 'food' | 'water' | 'coffee' | 'exercise' | 'weight' | 'supplement'
 *   fast lanes   : 'scan' (barcode) | 'snap' (photo meal) | 'brain' (AI brain-dump)
 */
export type LogTarget =
  | 'food' | 'water' | 'coffee' | 'exercise' | 'weight' | 'supplement'
  | 'scan' | 'snap' | 'brain';

/** One pickable cell in the fan-out (domain tile or fast lane). */
interface LogOption {
  /** The target echoed back on (choose). */
  readonly target: LogTarget;
  /** Material icon ligature name. */
  readonly icon: string;
  /** Visible label / aria-label. */
  readonly label: string;
  /** CSS gradient stops for the glyph (domain-accent coded). */
  readonly accentA: string;
  readonly accentB: string;
}

/**
 * Strata "+ LOG" fan-out — the bottom-sheet that replaces every center dialog. A top fast-lane row
 * (Scan / Snap / Brain-dump) sits above a 2-row × 3-col domain grid (Food / Water / Coffee / Exercise /
 * Weight / Supplement). Tapping any cell closes the sheet and emits the chosen {@link LogTarget}; the
 * page then opens the matching per-domain sheet. This component performs NO mutation itself — it is a
 * pure router of intent (water's optimistic quick-add lives on the rail, not here).
 *
 * Built on the shared {@link BottomSheet} (peek/half/full, swipe-down + scrim dismiss, focus-trap,
 * reduced-motion collapse via the page-host killswitch). Self-styled with `var(--*)` Strata tokens only
 * — no global `--tech-*`. 44px+ targets, gradient-coded glyphs, full aria, staggered reduced-motion-safe
 * rise. Read-only (shared-user) views disable mutating tiles but keep the AI/read-safe lanes tappable.
 *
 * Contract:
 *   selector : app-log-menu-sheet
 *   inputs   : open (model<boolean>, two-way — the action bar's "+ LOG" sets it true)
 *   outputs  : choose (LogTarget — the picked destination; emitted as the sheet dismisses)
 *
 * Usage: `<app-log-menu-sheet [(open)]="logOpen" (choose)="route($event)" />`
 */
@Component({
  selector: 'app-log-menu-sheet',
  standalone: true,
  imports: [MatIconModule, BottomSheet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-bottom-sheet [(open)]="open" detent="half" label="Log something">
      <div class="lm">
        <h2 class="lm-title">Log something</h2>

        <!-- Fast lanes: capture-first paths. AI/photo/scan are read-safe (no direct write here). -->
        <div class="lm-fast" role="group" aria-label="Quick capture">
          @for (o of fastLanes; track o.target) {
            <button type="button" class="lm-lane"
                    [style.--ga]="o.accentA" [style.--gb]="o.accentB"
                    [attr.aria-label]="o.label"
                    [class.sink]="pressed() === o.target"
                    (pointerdown)="pressed.set(o.target)"
                    (pointerup)="pressed.set(null)"
                    (pointercancel)="pressed.set(null)"
                    (pointerleave)="pressed.set(null)"
                    (click)="pick(o.target)">
              <mat-icon class="lm-lane-icon" aria-hidden="true">{{ o.icon }}</mat-icon>
              <span class="lm-lane-label">{{ o.label }}</span>
            </button>
          }
        </div>

        <!-- 2×3 domain grid. Mutating tiles disable under read-only shared views. -->
        <div class="lm-grid" role="group" aria-label="Log by category">
          @for (o of domains; track o.target) {
            <button type="button" class="lm-tile"
                    [style.--ga]="o.accentA" [style.--gb]="o.accentB"
                    [disabled]="readOnly()"
                    [attr.aria-label]="o.label"
                    [class.sink]="pressed() === o.target"
                    (pointerdown)="pressed.set(o.target)"
                    (pointerup)="pressed.set(null)"
                    (pointercancel)="pressed.set(null)"
                    (pointerleave)="pressed.set(null)"
                    (click)="pick(o.target)">
              <span class="lm-tile-glyph" aria-hidden="true">
                <mat-icon class="lm-tile-icon">{{ o.icon }}</mat-icon>
              </span>
              <span class="lm-tile-label">{{ o.label }}</span>
            </button>
          }
        </div>

        @if (readOnly()) {
          <p class="lm-readonly" aria-live="polite">Viewing someone else’s day — logging is off.</p>
        }
      </div>
    </app-bottom-sheet>
  `,
  styles: [`
    .lm {
      display: flex; flex-direction: column; gap: 16px;
      padding-top: 4px;
    }
    .lm-title {
      margin: 0; padding: 0 2px;
      font-family: var(--font-ui);
      font-size: 17px; font-weight: 600; letter-spacing: -.01em;
      color: var(--ink);
    }

    /* ---- Fast-lane row (Scan / Snap / Brain-dump) ---- */
    .lm-fast {
      display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px;
    }
    .lm-lane {
      display: flex; align-items: center; justify-content: center; gap: 8px;
      min-height: 48px; padding: 0 10px;
      border: 1px solid var(--glass-edge); border-radius: var(--r-pill);
      background: var(--bg-rise); color: var(--ink);
      box-shadow: var(--lift-1);
      font-family: var(--font-ui); font-size: 13px; font-weight: 600; letter-spacing: .01em;
      cursor: pointer; touch-action: manipulation; -webkit-tap-highlight-color: transparent;
      transition: transform 120ms var(--ease-out), box-shadow 120ms var(--ease-out);
    }
    .lm-lane-icon {
      width: 20px; height: 20px; font-size: 20px; line-height: 20px;
      background: linear-gradient(135deg, var(--ga), var(--gb));
      -webkit-background-clip: text; background-clip: text; color: transparent;
    }
    .lm-lane-label { white-space: nowrap; }

    /* ---- 2×3 domain grid ---- */
    .lm-grid {
      display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px;
    }
    .lm-tile {
      display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px;
      min-height: 92px; padding: 14px 8px;
      border: 1px solid var(--glass-edge); border-radius: var(--r-tile);
      background: var(--bg-rise); color: var(--ink);
      box-shadow: var(--lift-1);
      cursor: pointer; touch-action: manipulation; -webkit-tap-highlight-color: transparent;
      transition: transform 120ms var(--ease-out), box-shadow 120ms var(--ease-out);
    }
    .lm-tile:disabled { opacity: .42; pointer-events: none; }
    .lm-tile-glyph {
      display: flex; align-items: center; justify-content: center;
      width: 44px; height: 44px; border-radius: var(--r-pill);
      background: linear-gradient(135deg, var(--ga), var(--gb));
      box-shadow: var(--lift-1);
    }
    .lm-tile-icon {
      width: 24px; height: 24px; font-size: 24px; line-height: 24px;
      color: #fff;
    }
    .lm-tile-label {
      font-family: var(--font-ui); font-size: 13px; font-weight: 600; letter-spacing: .01em;
      color: var(--ink-dim);
    }

    /* Shared press-sink (the depth verb) — collapses to instant under the host killswitch. */
    .lm-lane.sink, .lm-tile.sink {
      transform: scale(.97) translateY(1px);
      box-shadow: var(--press);
    }

    .lm-readonly {
      margin: 0; padding: 2px 4px 0;
      font-size: 12px; color: var(--ink-faint); text-align: center;
    }

    /* Staggered rise of the grid cells (decorative; gated by the host reduced-motion killswitch). */
    .lm-lane, .lm-tile {
      animation: lm-rise 320ms var(--ease-out) both;
    }
    @keyframes lm-rise {
      from { opacity: 0; transform: translateY(8px); }
      to   { opacity: 1; transform: translateY(0); }
    }
  `],
})
export class LogMenuSheet {
  private readonly tracker = inject(OptimisticTracker);

  /** Two-way open state — the action bar's "+ LOG" button sets this true. */
  readonly open = model<boolean>(false);
  /** Fired with the chosen destination as the sheet dismisses. */
  readonly choose = output<LogTarget>();

  /** Shared-user views disable the mutating domain tiles. */
  protected readonly readOnly = this.tracker.readOnly;

  /** The currently press-sunk cell (drives the depth sink). */
  protected readonly pressed = signal<LogTarget | null>(null);

  /** Top fast-lane row — capture-first paths. */
  protected readonly fastLanes: readonly LogOption[] = [
    { target: 'scan',  icon: 'barcode_reader', label: 'Scan',  accentA: 'var(--cal-a)',    accentB: 'var(--cal-b)' },
    { target: 'snap',  icon: 'photo_camera',   label: 'Snap',  accentA: 'var(--pro-a)',    accentB: 'var(--pro-b)' },
    { target: 'brain', icon: 'auto_awesome',   label: 'Brain-dump', accentA: 'var(--cal-a)', accentB: 'var(--move-a)' },
  ];

  /** 2×3 domain grid — frequency-ordered top-left to bottom-right. */
  protected readonly domains: readonly LogOption[] = [
    { target: 'food',       icon: 'restaurant',   label: 'Food',       accentA: 'var(--cal-a)',    accentB: 'var(--cal-b)' },
    { target: 'water',      icon: 'water_drop',   label: 'Water',      accentA: 'var(--water-a)',  accentB: 'var(--water-b)' },
    { target: 'coffee',     icon: 'local_cafe',   label: 'Coffee',     accentA: 'var(--coffee-a)', accentB: 'var(--coffee-b)' },
    { target: 'exercise',   icon: 'fitness_center', label: 'Exercise', accentA: 'var(--move-a)',   accentB: 'var(--move-b)' },
    { target: 'weight',     icon: 'monitor_weight', label: 'Weight',   accentA: 'var(--pro-a)',    accentB: 'var(--pro-b)' },
    { target: 'supplement', icon: 'medication',   label: 'Supplement', accentA: 'var(--pro-a)',    accentB: 'var(--cal-b)' },
  ];

  /** Close the sheet and emit the chosen destination for the page to route. */
  protected pick(target: LogTarget): void {
    this.pressed.set(null);
    this.open.set(false);
    this.choose.emit(target);
  }
}
