import {
  ChangeDetectionStrategy, Component, computed, input, output, signal,
} from '@angular/core';

/**
 * Strata swipe-to-delete row — a pointer-event primitive that wraps a single logged entry (food,
 * exercise, hydration, coffee, supplement). Swipe LEFT past the threshold reveals a red delete affordance
 * and, on release, emits `delete`. The caller is responsible for the optimistic remove + undo snackbar
 * (see optimistic-tracker.ts) — this primitive only detects the gesture and reveals the action.
 *
 * Honors reduced-motion via the page-host killswitch (the spring snap-back collapses to instant). Targets
 * stay >=44px tall; touch-action keeps vertical scroll free while capturing horizontal drags.
 *
 * Contract (component agents depend on this VERBATIM):
 *   selector:  app-swipe-row
 *   inputs:    disabled (boolean, default false — read-only views pass true), label (string, aria)
 *   outputs:   delete (void) — fired when the user swipes past threshold and releases
 *   content:   projected row body via <ng-content>
 *
 * Usage: `<app-swipe-row [disabled]="store.readOnly()" (delete)="opt.deleteFood(f.id)"> … </app-swipe-row>`
 */
@Component({
  selector: 'app-swipe-row',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="tb-swipe-underlay" aria-hidden="true">
      <span class="tb-swipe-trash" [class.armed]="armed()">Delete</span>
    </div>
    <div class="tb-swipe-content"
         [style.transform]="'translateX(' + offset() + 'px)'"
         [style.transition]="dragging() ? 'none' : null"
         (pointerdown)="onDown($event)"
         (pointermove)="onMove($event)"
         (pointerup)="onUp($event)"
         (pointercancel)="onUp($event)">
      <ng-content></ng-content>
    </div>
  `,
  styles: [`
    :host {
      display: block; position: relative; overflow: hidden;
      border-radius: var(--r-tile); min-height: 44px;
      touch-action: pan-y;
    }
    .tb-swipe-underlay {
      position: absolute; inset: 0; display: flex; align-items: center; justify-content: flex-end;
      padding-right: 18px; background: var(--warn);
      border-radius: var(--r-tile);
    }
    .tb-swipe-trash {
      font-size: 13px; font-weight: 600; color: #1a0e00; opacity: .7;
      transition: opacity 120ms var(--ease-out), transform 120ms var(--ease-out);
    }
    .tb-swipe-trash.armed { opacity: 1; transform: scale(1.08); }
    .tb-swipe-content {
      position: relative; background: var(--bg-rise);
      border-radius: var(--r-tile);
      transition: transform 220ms var(--ease-spring);
      will-change: transform;
      -webkit-tap-highlight-color: transparent;
    }
  `],
})
export class SwipeRow {
  /** When true the row cannot be swiped (read-only / shared views). */
  readonly disabled = input<boolean>(false);
  /** aria label describing what would be deleted. */
  readonly label = input<string>('');
  /** Fired when the user swipes past the delete threshold and releases. */
  readonly delete = output<void>();

  /** px past which a release commits the delete. */
  private static readonly THRESHOLD = 96;

  protected readonly dragging = signal(false);
  protected readonly offset = signal(0);
  /** True once dragged past threshold (drives the underlay "armed" emphasis). */
  protected readonly armed = computed(() => -this.offset() >= SwipeRow.THRESHOLD);

  private startX = 0;
  private startY = 0;
  private pointerId = -1;
  private axisLocked: 'x' | 'y' | null = null;

  protected onDown(e: PointerEvent): void {
    if (this.disabled()) return;
    this.pointerId = e.pointerId;
    this.startX = e.clientX;
    this.startY = e.clientY;
    this.axisLocked = null;
    this.dragging.set(true);
  }

  protected onMove(e: PointerEvent): void {
    if (!this.dragging() || e.pointerId !== this.pointerId) return;
    const dx = e.clientX - this.startX;
    const dy = e.clientY - this.startY;
    // Lock to the dominant axis on first meaningful movement; let vertical scroll win.
    if (!this.axisLocked && (Math.abs(dx) > 6 || Math.abs(dy) > 6)) {
      this.axisLocked = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      if (this.axisLocked === 'x') (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    }
    if (this.axisLocked !== 'x') return;
    // Left swipes only (clamp positive drags to a tiny rubber-band of 0).
    this.offset.set(Math.min(0, dx));
  }

  protected onUp(e: PointerEvent): void {
    if (!this.dragging() || e.pointerId !== this.pointerId) return;
    this.dragging.set(false);
    const committed = this.armed();
    this.offset.set(0);
    this.axisLocked = null;
    if (committed) this.delete.emit();
  }
}
