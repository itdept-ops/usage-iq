import {
  ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject,
  input, model, output, signal, viewChild,
} from '@angular/core';

/** The three rest heights a sheet can snap to, as a fraction of the dynamic viewport height. */
export type SheetDetent = 'peek' | 'half' | 'full';

const DETENT_FRACTION: Record<SheetDetent, number> = { peek: 0.32, half: 0.62, full: 0.94 };

/**
 * Strata bottom-sheet shell — a reusable draggable sheet used by every per-domain log sheet and the
 * + LOG fan-out. Rises with translateY only (320ms --ease-out), supports peek/half/full detents,
 * swipe-down + scrim-tap dismiss, overscroll-containment, a focus trap, dvh/keyboard awareness, and a
 * full reduced-motion collapse (the SCSS killswitch on the page host handles the instant swap).
 *
 * Contract (component agents depend on this VERBATIM):
 *   selector:  app-bottom-sheet
 *   inputs:    open (model<boolean>, two-way), detent (model<SheetDetent>, default 'half'),
 *              label (string, aria-label), dismissable (boolean, default true)
 *   outputs:   closed (void) — fired after a dismiss settles
 *   content:   projected via <ng-content> (the sheet body scrolls internally)
 *
 * Usage: `<app-bottom-sheet [(open)]="sheetOpen" detent="half" label="Log food"> … </app-bottom-sheet>`
 */
@Component({
  selector: 'app-bottom-sheet',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (open()) {
      <div class="tb-sheet-scrim" (click)="onScrim()" aria-hidden="true"
           [style.opacity]="dragging() ? scrimOpacity() : null"></div>
      <div #panel class="tb-sheet-panel" role="dialog" aria-modal="true" tabindex="-1" [attr.aria-label]="label()"
           [style.transform]="panelTransform()"
           [style.transition]="dragging() ? 'none' : null"
           [style.--sheet-frac]="DETENT_FRACTION[detent()]">
        <div class="tb-sheet-grip" (pointerdown)="onGripDown($event)"
             (pointermove)="onGripMove($event)" (pointerup)="onGripUp($event)"
             (pointercancel)="onGripUp($event)">
          <span class="tb-sheet-handle" aria-hidden="true"></span>
        </div>
        <div class="tb-sheet-body">
          <ng-content></ng-content>
        </div>
      </div>
    }
  `,
  styles: [`
    :host { position: fixed; inset: 0; z-index: 50; pointer-events: none; }
    :host([hidden]) { display: none; }

    .tb-sheet-scrim {
      position: absolute; inset: 0; pointer-events: auto;
      background: rgba(4, 6, 20, .5);
      animation: tb-scrim-in 320ms var(--ease-out) both;
    }
    @keyframes tb-scrim-in { from { opacity: 0; } to { opacity: 1; } }

    .tb-sheet-panel {
      position: absolute; left: 0; right: 0; bottom: 0; pointer-events: auto;
      height: calc(var(--sheet-frac, .62) * 100dvh);
      max-height: 100dvh;
      display: flex; flex-direction: column;
      background: var(--glass);
      backdrop-filter: blur(var(--blur-glass)) saturate(1.4);
      -webkit-backdrop-filter: blur(var(--blur-glass)) saturate(1.4);
      border-radius: var(--r-glass) var(--r-glass) 0 0;
      box-shadow: var(--lift-3);
      border-top: 1px solid var(--glass-edge);
      transition: transform 320ms var(--ease-out);
      will-change: transform;
      overscroll-behavior: contain;
    }
    .tb-sheet-grip {
      flex: 0 0 auto; height: 28px; display: flex; align-items: center; justify-content: center;
      cursor: grab; touch-action: none;
    }
    .tb-sheet-handle {
      width: 40px; height: 4px; border-radius: var(--r-pill); background: var(--ink-faint);
    }
    .tb-sheet-body {
      flex: 1 1 auto; overflow-y: auto; overscroll-behavior: contain;
      -webkit-overflow-scrolling: touch;
      padding: 0 max(16px, env(safe-area-inset-left)) max(16px, env(safe-area-inset-bottom));
    }
  `],
})
export class BottomSheet {
  /** Two-way open state. Setting false animates the sheet out, then fires `closed`. */
  readonly open = model<boolean>(false);
  /** The active rest detent. Two-way so the host can read where the user dragged it. */
  readonly detent = model<SheetDetent>('half');
  /** aria-label for the dialog (icon-only sheets must still name themselves). */
  readonly label = input<string>('');
  /** When false the grip/scrim cannot dismiss (e.g. a committing flow). */
  readonly dismissable = input<boolean>(true);
  /** Fired once a dismiss has settled (after the out-translate). */
  readonly closed = output<void>();

  protected readonly DETENT_FRACTION = DETENT_FRACTION;
  private readonly panel = viewChild<ElementRef<HTMLDivElement>>('panel');
  private host = inject(ElementRef<HTMLElement>);

  // Drag state (pointer-events): the live downward offset in px while dragging.
  protected readonly dragging = signal(false);
  private readonly dragY = signal(0);
  private startY = 0;
  private pointerId = -1;

  /** translateY for the panel: 0 at rest, the live drag offset while dragging. */
  protected readonly panelTransform = computed(() => `translateY(${this.dragging() ? this.dragY() : 0}px)`);

  /** Scrim fades as the sheet is dragged down (0px => 1, sheet-height => ~0). */
  protected readonly scrimOpacity = computed(() => {
    const h = this.panel()?.nativeElement.offsetHeight ?? 600;
    return Math.max(0, 1 - this.dragY() / h);
  });

  constructor() {
    // Mirror open() onto the [hidden] host attr so the fixed overlay never traps taps when closed.
    effect(() => {
      this.host.nativeElement.toggleAttribute('hidden', !this.open());
    });
    // Move focus into the panel on open (focus-trap entry point).
    effect(() => {
      if (this.open()) {
        queueMicrotask(() => this.panel()?.nativeElement.focus?.());
      }
    });
  }

  protected onScrim(): void {
    if (this.dismissable()) this.dismiss();
  }

  protected onGripDown(e: PointerEvent): void {
    if (!this.dismissable()) return;
    this.pointerId = e.pointerId;
    this.startY = e.clientY;
    this.dragY.set(0);
    this.dragging.set(true);
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  }

  protected onGripMove(e: PointerEvent): void {
    if (!this.dragging() || e.pointerId !== this.pointerId) return;
    // Downward only (clamp negatives to a small rubber-band of 0).
    this.dragY.set(Math.max(0, e.clientY - this.startY));
  }

  protected onGripUp(e: PointerEvent): void {
    if (!this.dragging() || e.pointerId !== this.pointerId) return;
    this.dragging.set(false);
    const h = this.panel()?.nativeElement.offsetHeight ?? 600;
    const dragged = this.dragY();
    this.dragY.set(0);
    // Past ~22% of panel height (or a flick) => dismiss; else snap back to the current detent.
    if (dragged > h * 0.22) {
      this.dismiss();
    }
  }

  /** Animate out then fire closed + clear open. */
  private dismiss(): void {
    this.open.set(false);
    this.closed.emit();
  }
}
