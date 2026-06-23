import {
  AfterViewInit, ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject,
  input, model, output, signal, viewChild,
} from '@angular/core';

import { BottomSheet } from '../ui/bottom-sheet';
import { OptimisticTracker } from '../state/optimistic-tracker';
import { TrackerProfileDto, WeightSlot } from '../../../core/models';
import { weightFromKg, weightToKg, weightUnit } from '../util/units';

/**
 * Strata weight-log sheet — a tactile scroll-snap "number wheel" weigh-in.
 *
 * The wheel is two coupled vertical scroll-snap columns: a WHOLE-number column and a TENTHS column
 * (0–9), so a thumb-flick spins to e.g. `181 . 2`. Each column is its own snap scroller; the selected
 * value is whichever cell is centred under the fixed selection band — read back from `scrollTop` on a
 * debounced scroll (no JS-driven kinetic loop, the browser's native momentum + snap does the physics).
 * It is fully unit-aware: the range, suffix, and the value↔kg conversion all route through util/units
 * (the wire stays metric kg). Logging goes through the optimistic wrapper's `logWeight`, which patches
 * `profile.weightKg` instantly; the weight card pulls fresh history and animates the new point in.
 *
 * Contract:
 *   selector:  app-weight-sheet
 *   inputs:    open (model<boolean>, two-way)
 *   outputs:   logged (TrackerProfileDto) — emitted after a successful weigh-in (sheet then closes)
 *
 * Usage: `<app-weight-sheet [(open)]="weightOpen" (logged)="onWeighed($event)" />`
 */
@Component({
  selector: 'app-weight-sheet',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BottomSheet],
  template: `
    <app-bottom-sheet [(open)]="open" detent="half" label="Log weight"
                      [dismissable]="!saving()">
      <div class="ws">
        <header class="ws__head">
          <h2 class="ws__title">Log weight</h2>
          <p class="ws__sub">{{ optimistic.date() }} · flick to dial in</p>
        </header>

        <!-- Time-of-day slot: lets several weigh-ins coexist on one day. -->
        <div class="ws__slots" role="radiogroup" aria-label="Time of day">
          @for (s of SLOTS; track s.value) {
            <button type="button" class="ws__slot" role="radio"
                    [class.is-on]="slot() === s.value"
                    [attr.aria-checked]="slot() === s.value"
                    (click)="slot.set(s.value)">{{ s.label }}</button>
          }
        </div>

        <!-- The number wheel: WHOLE . TENTHS, with a fixed centre selection band. -->
        <div class="ws__wheel" role="group"
             [attr.aria-label]="'Weight ' + display() + ' ' + unit()">
          <div class="ws__band" aria-hidden="true"></div>
          <div class="ws__top-fade" aria-hidden="true"></div>
          <div class="ws__bot-fade" aria-hidden="true"></div>

          <div #wholeCol class="ws__col ws__col--whole" tabindex="0"
               role="spinbutton" aria-label="Whole number"
               [attr.aria-valuemin]="min()" [attr.aria-valuemax]="max()"
               [attr.aria-valuenow]="whole()" [attr.aria-valuetext]="whole() + ' ' + unit()"
               (scroll)="onScroll('whole')"
               (keydown)="onKey('whole', $event)">
            <div class="ws__pad" aria-hidden="true"></div>
            @for (n of wholes(); track n) {
              <div class="ws__cell" [class.is-sel]="n === whole()">{{ n }}</div>
            }
            <div class="ws__pad" aria-hidden="true"></div>
          </div>

          <span class="ws__dot" aria-hidden="true">.</span>

          <div #tenthCol class="ws__col ws__col--tenth" tabindex="0"
               role="spinbutton" aria-label="Tenths"
               aria-valuemin="0" aria-valuemax="9" [attr.aria-valuenow]="tenth()"
               (scroll)="onScroll('tenth')"
               (keydown)="onKey('tenth', $event)">
            <div class="ws__pad" aria-hidden="true"></div>
            @for (n of TENTHS; track n) {
              <div class="ws__cell" [class.is-sel]="n === tenth()">{{ n }}</div>
            }
            <div class="ws__pad" aria-hidden="true"></div>
          </div>

          <span class="ws__unit" aria-hidden="true">{{ unit() }}</span>
        </div>

        <button type="button" class="ws__save" [disabled]="!canSave()" (click)="save()">
          {{ saving() ? 'Saving…' : 'Save ' + display() + ' ' + unit() }}
        </button>
      </div>
    </app-bottom-sheet>
  `,
  styles: [`
    :host { display: contents; }

    .ws {
      display: flex; flex-direction: column; gap: 16px;
      padding: 4px 2px 8px;
      font-family: var(--font-ui);
      color: var(--ink);
    }

    .ws__head { display: flex; flex-direction: column; gap: 2px; }
    .ws__title { margin: 0; font-size: 19px; font-weight: 600; letter-spacing: -.01em; }
    .ws__sub { margin: 0; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--ink-dim); }

    /* ---- slot radios (44px targets) ---- */
    .ws__slots { display: flex; gap: 8px; }
    .ws__slot {
      flex: 1 1 0; min-height: 44px;
      border: 1px solid var(--hairline); border-radius: var(--r-pill);
      background: var(--bg-sink); color: var(--ink-dim);
      font: inherit; font-size: 13px; font-weight: 500;
      cursor: pointer;
      touch-action: manipulation; -webkit-tap-highlight-color: transparent;
      transition: background 160ms var(--ease-out), color 160ms var(--ease-out),
                  box-shadow 160ms var(--ease-out), border-color 160ms var(--ease-out);
    }
    .ws__slot.is-on {
      color: var(--ink);
      border-color: transparent;
      background: linear-gradient(135deg, var(--cal-a), var(--cal-b));
      box-shadow: var(--lift-1);
    }
    .ws__slot:active { transform: translateY(1px) scale(.98); }

    /* ---- the wheel ---- */
    .ws__wheel {
      --cell-h: 48px;
      position: relative;
      display: flex; align-items: center; justify-content: center;
      gap: 2px;
      height: calc(var(--cell-h) * 5);            /* 5 cells visible, centre is the selection */
      border-radius: var(--r-tile);
      background: var(--bg-sink);
      box-shadow: var(--press);
      overflow: hidden;
    }

    /* the fixed centre selection band the snapped value lands in */
    .ws__band {
      position: absolute; left: 8px; right: 8px;
      top: 50%; height: var(--cell-h);
      transform: translateY(-50%);
      border-radius: 12px;
      background: var(--glass);
      box-shadow: inset 0 0 0 1px var(--glass-edge);
      pointer-events: none;
    }
    /* top/bottom gradient fades so off-centre numbers recede into the well */
    .ws__top-fade, .ws__bot-fade {
      position: absolute; left: 0; right: 0; height: calc(var(--cell-h) * 2);
      pointer-events: none; z-index: 2;
    }
    .ws__top-fade { top: 0; background: linear-gradient(var(--bg-sink), transparent); }
    .ws__bot-fade { bottom: 0; background: linear-gradient(transparent, var(--bg-sink)); }

    .ws__col {
      height: 100%;
      width: clamp(56px, 22vw, 96px);
      overflow-y: auto; overflow-x: hidden;
      scroll-snap-type: y mandatory;
      overscroll-behavior: contain;
      -webkit-overflow-scrolling: touch;
      scrollbar-width: none;
      touch-action: pan-y;
      text-align: center;
      outline-offset: -2px;
    }
    .ws__col::-webkit-scrollbar { display: none; }
    .ws__col--tenth { width: clamp(44px, 16vw, 72px); }

    /* top/bottom padding so the first & last numbers can reach the centre band */
    .ws__pad { height: calc(var(--cell-h) * 2); scroll-snap-align: none; }

    .ws__cell {
      height: var(--cell-h);
      display: flex; align-items: center; justify-content: center;
      scroll-snap-align: center;
      font-family: var(--font-display);
      font-variant-numeric: tabular-nums;
      font-size: 30px; font-weight: 600; letter-spacing: -.025em;
      color: var(--ink-faint);
      transition: color 160ms var(--ease-out), transform 160ms var(--ease-out);
    }
    .ws__cell.is-sel {
      color: var(--ink);
      transform: scale(1.06);
    }

    .ws__dot {
      font-family: var(--font-display); font-size: 30px; font-weight: 600;
      color: var(--ink); align-self: center; padding-bottom: 8px; z-index: 3;
    }
    .ws__unit {
      align-self: center; margin-left: 4px; z-index: 3;
      font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--ink-dim);
    }

    /* ---- save ---- */
    .ws__save {
      min-height: 52px; margin-top: 2px;
      border: 0; border-radius: var(--r-pill);
      background: linear-gradient(135deg, var(--cal-a), var(--cal-b));
      color: #fff; font: inherit; font-size: 16px; font-weight: 600;
      cursor: pointer;
      box-shadow: var(--lift-2);
      touch-action: manipulation; -webkit-tap-highlight-color: transparent;
      transition: transform 120ms var(--ease-out), box-shadow 120ms var(--ease-out), opacity 160ms var(--ease-out);
    }
    .ws__save:active:not(:disabled) { transform: translateY(1px) scale(.99); box-shadow: var(--press); }
    .ws__save:disabled { opacity: .5; cursor: default; }
  `],
})
export class WeightSheet implements AfterViewInit {
  protected readonly optimistic = inject(OptimisticTracker);

  /** Two-way open state forwarded to the bottom-sheet shell. */
  readonly open = model<boolean>(false);
  /** Emitted with the saved profile after a successful weigh-in (the sheet then closes itself). */
  readonly logged = output<TrackerProfileDto>();

  private readonly wholeCol = viewChild<ElementRef<HTMLDivElement>>('wholeCol');
  private readonly tenthCol = viewChild<ElementRef<HTMLDivElement>>('tenthCol');

  protected readonly SLOTS: { value: WeightSlot; label: string }[] = [
    { value: 'Morning', label: 'Morning' },
    { value: 'Afternoon', label: 'Afternoon' },
    { value: 'Evening', label: 'Evening' },
  ];
  protected readonly TENTHS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

  /** True when the active profile prefers imperial (the wheel shows lb; the wire stays kg). */
  protected readonly imperial = this.optimistic.imperial;
  protected readonly unit = computed(() => weightUnit(this.imperial()));

  /** Sane wheel range in the DISPLAYED unit. lb: 50–500, kg: 25–250. */
  protected readonly min = computed(() => (this.imperial() ? 50 : 25));
  protected readonly max = computed(() => (this.imperial() ? 500 : 250));
  protected readonly wholes = computed(() => {
    const lo = this.min(), hi = this.max();
    return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
  });

  /** Current dialled value, split into whole + tenth (the two columns). */
  protected readonly whole = signal(150);
  protected readonly tenth = signal(0);

  protected readonly slot = signal<WeightSlot>(currentSlot());
  protected readonly saving = signal(false);

  /** The full displayed value (one decimal), e.g. "181.2". */
  protected readonly display = computed(() =>
    (this.whole() + this.tenth() / 10).toFixed(1),
  );

  protected readonly canSave = computed(() => !this.saving() && !this.optimistic.readOnly());

  /** Debounce timer for snap-readback; re-armed on each native scroll event. */
  private snapTimers: Record<'whole' | 'tenth', ReturnType<typeof setTimeout> | undefined> = {
    whole: undefined, tenth: undefined,
  };
  /** Guards the initial programmatic scroll-to so it doesn't read itself back. */
  private positioning = false;

  constructor() {
    // Each time the sheet OPENS, seed the wheel from the profile's current weight and centre the columns.
    effect(() => {
      if (this.open()) {
        this.seedFromProfile();
        queueMicrotask(() => this.centerColumns());
      }
    });
    // If the unit system flips while open, the range changes — re-clamp + re-centre.
    effect(() => {
      this.imperial();
      if (this.open()) queueMicrotask(() => this.centerColumns());
    });
  }

  ngAfterViewInit(): void {
    if (this.open()) this.centerColumns();
  }

  /** Pull the profile weight (kg) into the displayed unit, split to whole + tenth, clamped to range. */
  private seedFromProfile(): void {
    const kg = this.optimistic.profile()?.weightKg;
    const disp = kg != null ? weightFromKg(kg, this.imperial()) : (this.imperial() ? 165 : 75);
    const clamped = Math.min(this.max(), Math.max(this.min(), disp));
    this.whole.set(Math.floor(clamped));
    this.tenth.set(Math.round((clamped - Math.floor(clamped)) * 10) % 10);
  }

  /** Scroll each column so its current value sits under the centre selection band (no animation). */
  private centerColumns(): void {
    this.positioning = true;
    const whole = this.wholeCol()?.nativeElement;
    const tenth = this.tenthCol()?.nativeElement;
    if (whole) whole.scrollTop = (this.whole() - this.min()) * this.cellH(whole);
    if (tenth) tenth.scrollTop = this.tenth() * this.cellH(tenth);
    // Release the guard after the (instant) scroll settles.
    queueMicrotask(() => { this.positioning = false; });
  }

  /** Resolve the px height of one snap cell from the live --cell-h custom property (fallback 48). */
  private cellH(el: HTMLElement): number {
    const v = parseFloat(getComputedStyle(el).getPropertyValue('--cell-h'));
    return Number.isFinite(v) && v > 0 ? v : 48;
  }

  /** Native scroll fired — debounce, then read the snapped index back into the signal + haptic tick. */
  protected onScroll(which: 'whole' | 'tenth'): void {
    if (this.positioning) return;
    clearTimeout(this.snapTimers[which]);
    this.snapTimers[which] = setTimeout(() => this.readSnap(which), 90);
  }

  private readSnap(which: 'whole' | 'tenth'): void {
    const ref = which === 'whole' ? this.wholeCol() : this.tenthCol();
    const el = ref?.nativeElement;
    if (!el) return;
    const idx = Math.round(el.scrollTop / this.cellH(el));
    if (which === 'whole') {
      const next = Math.min(this.max(), Math.max(this.min(), this.min() + idx));
      if (next !== this.whole()) { this.whole.set(next); this.tick(); }
    } else {
      const next = Math.min(9, Math.max(0, idx));
      if (next !== this.tenth()) { this.tenth.set(next); this.tick(); }
    }
  }

  /** Keyboard stepping for the non-touch path (arrow up/down move one cell, with snap re-centre). */
  protected onKey(which: 'whole' | 'tenth', e: KeyboardEvent): void {
    const dir = e.key === 'ArrowUp' ? 1 : e.key === 'ArrowDown' ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    if (which === 'whole') {
      this.whole.set(Math.min(this.max(), Math.max(this.min(), this.whole() + dir)));
    } else {
      this.tenth.set((this.tenth() + dir + 10) % 10);
    }
    this.tick();
    this.centerColumns();
  }

  /** Light haptic detent as the wheel ticks past a value (no-op where unsupported / on iOS). */
  private tick(): void {
    try { navigator.vibrate?.(8); } catch { /* unsupported */ }
  }

  async save(): Promise<void> {
    if (!this.canSave()) return;
    this.saving.set(true);
    const display = this.whole() + this.tenth() / 10;
    const kg = Math.round(weightToKg(display, this.imperial()) * 100) / 100;
    try {
      const profile = await this.optimistic.logWeight({
        date: this.optimistic.date(), weightKg: kg, slot: this.slot(),
      });
      this.logged.emit(profile);
      this.open.set(false);
    } catch {
      // The optimistic wrapper already surfaced a Retry snackbar + rolled back; keep the sheet open.
    } finally {
      this.saving.set(false);
    }
  }
}

/** Pick the slot that matches the current local hour so the default reflects when the user is logging. */
function currentSlot(now = new Date()): WeightSlot {
  const h = now.getHours();
  if (h < 12) return 'Morning';
  if (h < 18) return 'Afternoon';
  return 'Evening';
}
