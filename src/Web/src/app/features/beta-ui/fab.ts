import {
  ChangeDetectionStrategy, Component, inject, input, output, signal,
} from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { Haptics } from '../../core/haptics';

/**
 * BETA-KIT Fab — a floating action button / action pill. A new beta-kit primitive. Two shapes:
 * a round icon-only FAB (default) or an extended action pill (`extended` with a label). The
 * surface is the page accent gradient (--accent-a/--accent-b) with --lift-3 so it reads as the
 * top floating layer; pressing press-sinks (--press + scale .96) and pulses navigator.vibrate.
 * Honors safe-area when used as a fixed thumb anchor (apply `fixed` for bottom-right docking).
 * Honors reduced-motion via the page-host killswitch. Dependency-free + tree-shakeable.
 *
 * CONTRACT (next phase depends on this VERBATIM):
 *   selector:  app-bs-fab
 *   inputs:    icon (string Material ligature, default 'add'), label (string — required for a11y; shown when extended),
 *              extended (boolean, default false — render as an action pill with the label visible),
 *              fixed (boolean, default false — dock fixed at the bottom-right thumb arc, safe-area aware),
 *              disabled (boolean, default false)
 *   outputs:   action (void) — fired on tap
 *
 * Usage: `<app-bs-fab icon="add" label="Log" extended fixed (action)="openSheet()" />`
 */
@Component({
  selector: 'app-bs-fab',
  standalone: true,
  imports: [MatIconModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[class.bs-fab-fixed]': 'fixed()' },
  template: `
    <button type="button" class="bs-fab"
            [class.extended]="extended()"
            [class.sink]="pressed()"
            [disabled]="disabled()"
            [attr.aria-label]="label()"
            (pointerdown)="onDown()"
            (pointerup)="onUp()"
            (pointercancel)="onCancel()"
            (pointerleave)="onCancel()"
            (click)="onClick()">
      <mat-icon class="bs-fab-icon" aria-hidden="true">{{ icon() }}</mat-icon>
      @if (extended()) { <span class="bs-fab-label">{{ label() }}</span> }
    </button>
  `,
  styles: [`
    :host { display: inline-block; }
    :host(.bs-fab-fixed) {
      position: fixed; z-index: 40;
      right: max(16px, env(safe-area-inset-right, 0px));
      /* Reads the shell's clearance token so the FAB clears the global bottom tab bar (the mobile shell
         overrides --fab-clear on .content--mobile). Falls back to a plain 16px dock for the standalone case. */
      bottom: var(--fab-clear, calc(16px + env(safe-area-inset-bottom, 0px)));
    }
    .bs-fab {
      display: inline-flex; align-items: center; justify-content: center; gap: 8px;
      min-width: 56px; min-height: 56px; padding: 0;
      border: none; border-radius: var(--r-pill);
      background: linear-gradient(135deg, var(--accent-a), var(--accent-b));
      color: var(--ink-on-accent); box-shadow: var(--lift-3);
      cursor: pointer; touch-action: manipulation; -webkit-tap-highlight-color: transparent;
      transition: transform 120ms var(--ease-out), box-shadow 120ms var(--ease-out);
    }
    .bs-fab.extended { padding: 0 22px 0 18px; }
    .bs-fab.sink { transform: scale(.96) translateY(1px); box-shadow: var(--press); }
    .bs-fab:disabled { opacity: .5; pointer-events: none; }
    .bs-fab:focus-visible { outline: 2px solid var(--focus); outline-offset: 3px; }
    .bs-fab-icon { width: 26px; height: 26px; font-size: 26px; line-height: 26px; }
    .bs-fab-label {
      font-family: var(--font-ui); font-size: 15px; font-weight: 700; letter-spacing: .01em;
      white-space: nowrap;
    }
  `],
})
export class BetaFab {
  /** Material icon ligature. */
  readonly icon = input<string>('add');
  /** aria-label (required for the icon-only form) + visible text when `extended`. */
  readonly label = input<string>('');
  /** Render as an extended action pill (label visible). */
  readonly extended = input<boolean>(false);
  /** Dock fixed at the bottom-right thumb arc (safe-area aware). */
  readonly fixed = input<boolean>(false);
  /** When true the button is inert. */
  readonly disabled = input<boolean>(false);
  /** Fired on tap. */
  readonly action = output<void>();

  protected readonly pressed = signal(false);
  private readonly haptics = inject(Haptics);

  protected onDown(): void { if (!this.disabled()) this.pressed.set(true); }
  protected onUp(): void { this.pressed.set(false); }
  protected onCancel(): void { this.pressed.set(false); }
  protected onClick(): void {
    if (this.disabled()) return;
    this.haptics.tap(); // light tick on a deliberate FAB press (no-ops on iOS / unsupported)
    this.action.emit();
  }
}
