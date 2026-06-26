import {
  ChangeDetectionStrategy, Component, computed, inject, input, output, signal,
} from '@angular/core';
import { Haptics } from '../../core/haptics';

/** Which side was committed by a past-threshold swipe + release. */
export type SwipeSide = 'left' | 'right';

/**
 * BETA-KIT SwipeRow — a pointer-event swipe-to-reveal primitive, generalized from the
 * flagship Strata `app-swipe-row` (which was left-only delete) to reveal actions on
 * EITHER side. Swiping LEFT past threshold reveals the trailing action (default: a
 * destructive --warn affordance) and emits `swipe('left')`; swiping RIGHT reveals the
 * leading action (accent-tinted) and emits `swipe('right')`. The caller owns the
 * optimistic mutation + undo snackbar — this primitive only detects the gesture and
 * reveals the action.
 *
 * Axis-locks to the dominant direction on first movement so vertical scroll always wins.
 * Snap-back uses --ease-spring. Targets stay >=44px tall. Honors reduced-motion via the
 * page-host killswitch. No flagship imports; dependency-free + tree-shakeable.
 *
 * CONTRACT (next phase depends on this VERBATIM):
 *   selector:  app-bs-swipe-row
 *   inputs:    disabled (boolean, default false), label (string, aria),
 *              leftLabel (string, default 'Delete' — the action shown on a LEFT swipe),
 *              rightLabel (string, default '' — the action shown on a RIGHT swipe; empty disables the right side),
 *              leftDestructive (boolean, default true — LEFT underlay uses --warn; false uses accent)
 *   outputs:   swipe (SwipeSide) — the committed side, and `delete` (void) convenience alias for a left commit
 *   content:   projected row body via <ng-content>
 *
 * Usage: `<app-bs-swipe-row rightLabel="Pin" (swipe)="onSwipe($event)" (delete)="remove(x)"> … </app-bs-swipe-row>`
 */
@Component({
  selector: 'app-bs-swipe-row',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <!-- leading (revealed by a RIGHT swipe) -->
    @if (rightLabel()) {
      <div class="bs-underlay bs-underlay--lead" aria-hidden="true">
        <span class="bs-action" [class.armed]="armedRight()">{{ rightLabel() }}</span>
      </div>
    }
    <!-- trailing (revealed by a LEFT swipe) -->
    <div class="bs-underlay bs-underlay--trail" [class.is-destructive]="leftDestructive()" aria-hidden="true">
      <span class="bs-action" [class.armed]="armedLeft()">{{ leftLabel() }}</span>
    </div>

    <div class="bs-content"
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
    .bs-underlay {
      position: absolute; inset: 0; display: flex; align-items: center;
      border-radius: var(--r-tile);
    }
    .bs-underlay--trail { justify-content: flex-end; padding-right: 18px;
      background: linear-gradient(135deg, var(--accent-a), var(--accent-b)); }
    .bs-underlay--trail.is-destructive { background: var(--warn); }
    .bs-underlay--lead { justify-content: flex-start; padding-left: 18px;
      background: linear-gradient(135deg, var(--accent-a), var(--accent-b)); }
    .bs-action {
      font-size: 13px; font-weight: 700; color: #1a0e00; opacity: .7;
      transition: opacity 120ms var(--ease-out), transform 120ms var(--ease-out);
    }
    .bs-action.armed { opacity: 1; transform: scale(1.08); }
    .bs-content {
      position: relative; background: var(--bg-rise);
      border-radius: var(--r-tile);
      transition: transform 220ms var(--ease-spring);
      will-change: transform;
      -webkit-tap-highlight-color: transparent;
    }
  `],
})
export class BetaSwipeRow {
  /** When true the row cannot be swiped (read-only / shared views). */
  readonly disabled = input<boolean>(false);
  /** aria label describing the row. */
  readonly label = input<string>('');
  /** Action text shown on a LEFT swipe (the trailing reveal). */
  readonly leftLabel = input<string>('Delete');
  /** Action text shown on a RIGHT swipe (the leading reveal). Empty string disables the right side. */
  readonly rightLabel = input<string>('');
  /** LEFT underlay uses the warm destructive --warn when true; the page accent gradient when false. */
  readonly leftDestructive = input<boolean>(true);
  /** Fired with the committed side when the user swipes past threshold and releases. */
  readonly swipe = output<SwipeSide>();
  /** Convenience alias: fires (void) when a LEFT swipe commits (mirrors the flagship `delete`). */
  readonly delete = output<void>();

  /** px past which a release commits. */
  private static readonly THRESHOLD = 96;

  private readonly haptics = inject(Haptics);

  protected readonly dragging = signal(false);
  protected readonly offset = signal(0);
  /** True once dragged left past threshold. */
  protected readonly armedLeft = computed(() => -this.offset() >= BetaSwipeRow.THRESHOLD);
  /** True once dragged right past threshold. */
  protected readonly armedRight = computed(() => this.offset() >= BetaSwipeRow.THRESHOLD);

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
    // Right swipes only allowed when a right action exists; otherwise clamp to 0.
    const next = this.rightLabel() ? dx : Math.min(0, dx);
    this.offset.set(next);
  }

  protected onUp(e: PointerEvent): void {
    if (!this.dragging() || e.pointerId !== this.pointerId) return;
    this.dragging.set(false);
    const left = this.armedLeft();
    const right = this.armedRight();
    this.offset.set(0);
    this.axisLocked = null;
    // A committed swipe is a deliberate action — confirm it with a gentle double-tick
    // (no-ops on iOS / unsupported). Snap-back without a commit stays silent.
    if (left) { this.haptics.success(); this.swipe.emit('left'); this.delete.emit(); }
    else if (right) { this.haptics.success(); this.swipe.emit('right'); }
  }
}
