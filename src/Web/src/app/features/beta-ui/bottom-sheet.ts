import {
  ChangeDetectionStrategy, Component, DestroyRef, ElementRef, computed, effect, inject,
  input, model, output, signal, viewChild,
} from '@angular/core';
import { Haptics } from '../../core/haptics';

/** The rest heights a sheet can snap to, as a fraction of the dynamic viewport height. */
export type SheetDetent = 'peek' | 'half' | 'full';

const DETENT_FRACTION: Record<SheetDetent, number> = { peek: 0.32, half: 0.62, full: 0.94 };

/**
 * BETA-KIT BottomSheet — a reusable draggable bottom sheet, generalized from the flagship
 * Strata `app-bottom-sheet`. Rises with translateY only (320ms --ease-out bs-rise), supports
 * peek/half/full snap detents, swipe-down + scrim-tap + Escape dismiss, overscroll
 * containment, dvh/keyboard awareness, and a full reduced-motion collapse (the page-host
 * killswitch from beta-kit handles the instant swap).
 *
 * FOCUS TRAP: on open, focus moves to the first focusable in the body (or the panel itself
 * when the body has none); Tab / Shift+Tab wrap within the panel so focus can't escape behind
 * the scrim; on dismiss, focus returns to the opener element. (role=dialog + aria-modal.)
 *
 * DISMISS is IMMEDIATE: the panel is removed via the `@if (open())` the moment open flips
 * false (there is no out-animation — only the rise-in is animated); `closed` fires synchronously.
 *
 * Inherits all visuals from the beta-kit tokens on the host page (var(--glass), --r-glass,
 * --lift-3, --ease-out, safe-area). No flagship imports; dependency-free + tree-shakeable.
 *
 * CONTRACT (next phase depends on this VERBATIM):
 *   selector:  app-bs-sheet
 *   inputs:    open (model<boolean>, two-way), detent (model<SheetDetent>, default 'half'),
 *              label (string, aria-label), dismissable (boolean, default true)
 *   outputs:   closed (void) — fired after a dismiss settles
 *   content:   projected via <ng-content> (the sheet body scrolls internally)
 *
 * Usage: `<app-bs-sheet [(open)]="sheetOpen" detent="half" label="Add item"> … </app-bs-sheet>`
 */
@Component({
  selector: 'app-bs-sheet',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (open()) {
      <div class="bs-scrim" (click)="onScrim()" aria-hidden="true"
           [style.opacity]="dragging() ? scrimOpacity() : null"></div>
      <div #panel class="bs-panel" role="dialog" aria-modal="true" tabindex="-1" [attr.aria-label]="label()"
           (keydown)="onKeydown($event)"
           [style.transform]="panelTransform()"
           [style.transition]="dragging() ? 'none' : null"
           [style.--sheet-frac]="DETENT_FRACTION[detent()]">
        <div class="bs-grip" (pointerdown)="onGripDown($event)"
             (pointermove)="onGripMove($event)" (pointerup)="onGripUp($event)"
             (pointercancel)="onGripUp($event)">
          <span class="bs-handle" aria-hidden="true"></span>
        </div>
        <div class="bs-body" (focusin)="onFocusIn($event)">
          <ng-content></ng-content>
        </div>
      </div>
    }
  `,
  styles: [`
    :host { position: fixed; inset: 0; z-index: 50; pointer-events: none; }
    :host([hidden]) { display: none; }

    .bs-scrim {
      position: absolute; inset: 0; pointer-events: auto;
      /* touch-action:none stops a drag on the scrim from scrolling the page BEHIND the sheet on iOS
         (which otherwise reads as a second scrollbar). The panel body keeps its own scroll. Tap-to-
         dismiss still fires (touch-action blocks scroll/zoom gestures, not clicks). */
      touch-action: none;
      background: rgba(4, 6, 20, .5);
      animation: bs-scrim-in 320ms var(--ease-out) both;
    }
    @keyframes bs-scrim-in { from { opacity: 0; } to { opacity: 1; } }

    .bs-panel {
      position: absolute; left: 0; right: 0; pointer-events: auto;
      /* Sit above the iOS soft keyboard: --kb-inset (0 when none) lifts the panel and caps its height to
         the space above the keyboard, so inputs in the body are never hidden under it. */
      bottom: var(--kb-inset, 0px);
      height: min(calc(var(--sheet-frac, .62) * 100dvh), calc(100dvh - var(--kb-inset, 0px)));
      /* Never rise behind the fixed mobile top bar (52px + safe-area-top): a full-detent sheet otherwise
         tucks its grip + header under the bar. --mobile-bar-h is inherited from the shell frame (0 off-shell). */
      max-height: calc(100dvh - var(--mobile-bar-h, 0px));
      display: flex; flex-direction: column;
      background: var(--glass);
      backdrop-filter: blur(var(--blur-glass)) saturate(1.4);
      -webkit-backdrop-filter: blur(var(--blur-glass)) saturate(1.4);
      border-radius: var(--r-glass) var(--r-glass) 0 0;
      box-shadow: var(--lift-3);
      border-top: 1px solid var(--glass-edge);
      transition: transform 320ms var(--ease-out), bottom 240ms var(--ease-out), height 240ms var(--ease-out);
      will-change: transform;
      overscroll-behavior: contain;
      animation: bs-rise 320ms var(--ease-out) both;
    }
    @keyframes bs-rise { from { transform: translateY(100%); } to { transform: translateY(0); } }
    .bs-grip {
      flex: 0 0 auto; height: 28px; display: flex; align-items: center; justify-content: center;
      cursor: grab; touch-action: none;
    }
    .bs-handle {
      width: 40px; height: 4px; border-radius: var(--r-pill); background: var(--ink-faint);
    }
    .bs-body {
      flex: 1 1 auto; overflow-y: auto; overscroll-behavior: contain;
      -webkit-overflow-scrolling: touch;
      padding: 0 max(16px, env(safe-area-inset-left)) max(16px, env(safe-area-inset-bottom));
    }
    @media (prefers-reduced-motion: reduce) {
      .bs-panel, .bs-scrim { animation: none; }
    }
  `],
})
export class BetaBottomSheet {
  /** Two-way open state. Setting false animates the sheet out, then fires `closed`. */
  readonly open = model<boolean>(false);
  /** The active rest detent. Two-way so the host can read where the user dragged it. */
  readonly detent = model<SheetDetent>('half');
  /** aria-label for the dialog (icon-only sheets must still name themselves). */
  readonly label = input<string>('');
  /** When false the grip/scrim/Escape cannot dismiss (e.g. a committing flow). */
  readonly dismissable = input<boolean>(true);
  /** Fired once a dismiss has settled. */
  readonly closed = output<void>();

  protected readonly DETENT_FRACTION = DETENT_FRACTION;
  private readonly panel = viewChild<ElementRef<HTMLDivElement>>('panel');
  private host = inject(ElementRef<HTMLElement>);
  private readonly haptics = inject(Haptics);
  /** Tracks the last seen open() so we haptic-tick only on the false→true (open) transition. */
  private wasOpen = false;

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

  /** The element focused when the sheet opened — focus returns here on close. */
  private opener: HTMLElement | null = null;

  /** How many sheets are currently open (across all instances). When > 0 the document carries
   *  `bs-sheet-open` so the global bottom tab bar hides — it sits behind the sheet anyway, and on iOS a
   *  backdrop-filter stacking context can otherwise let it show through the scrim. */
  private static openCount = 0;
  private static adjustOpenCount(delta: number): void {
    BetaBottomSheet.openCount = Math.max(0, BetaBottomSheet.openCount + delta);
    if (typeof document !== 'undefined') {
      document.documentElement.classList.toggle('bs-sheet-open', BetaBottomSheet.openCount > 0);
    }
  }

  constructor() {
    // If this sheet is torn down (page nav) while still open, release its hold on the tab-bar hide.
    inject(DestroyRef).onDestroy(() => { if (this.wasOpen) BetaBottomSheet.adjustOpenCount(-1); });

    // Mirror open() onto the [hidden] host attr so the fixed overlay never traps taps when closed.
    effect(() => {
      this.host.nativeElement.toggleAttribute('hidden', !this.open());
    });
    // Move focus into the panel on open (focus-trap entry); remember the opener to restore later.
    effect(() => {
      const isOpen = this.open();
      // Faint tick + hide the tab bar only on the open transition (not on detent changes / re-renders).
      if (isOpen && !this.wasOpen) { this.haptics.select(); BetaBottomSheet.adjustOpenCount(1); }
      else if (!isOpen && this.wasOpen) BetaBottomSheet.adjustOpenCount(-1);
      this.wasOpen = isOpen;
      if (isOpen) {
        const active = (typeof document !== 'undefined' ? document.activeElement : null) as HTMLElement | null;
        if (active && !this.host.nativeElement.contains(active)) this.opener = active;
        // Prefer the first focusable in the body; fall back to the panel (tabindex=-1) so a
        // body with no controls still pulls focus off the page behind the sheet.
        queueMicrotask(() => {
          const target = this.focusables()[0] ?? this.panel()?.nativeElement;
          target?.focus?.();
        });
      }
    });
  }

  protected onScrim(): void {
    if (this.dismissable()) this.dismiss();
  }

  /** When a field in the body is focused, scroll it into the visible area once the keyboard has
   *  animated in (the panel is already lifted by --kb-inset; this centres the active input). */
  protected onFocusIn(e: FocusEvent): void {
    const t = e.target as HTMLElement | null;
    if (!t || !/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    setTimeout(() => t.scrollIntoView({ block: 'center', behavior: 'smooth' }), 80);
  }

  protected onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape' && this.dismissable()) {
      e.preventDefault();
      e.stopPropagation();
      this.dismiss();
      return;
    }
    if (e.key === 'Tab') this.trapTab(e);
  }

  /** The focusable elements inside the panel, in DOM order. The panel itself (tabindex=-1)
   *  is the fallback target when the body has none. */
  private focusables(): HTMLElement[] {
    const panel = this.panel()?.nativeElement;
    if (!panel) return [];
    const sel = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]),'
      + ' select:not([disabled]), [tabindex]:not([tabindex="-1"])';
    return Array.from(panel.querySelectorAll<HTMLElement>(sel))
      .filter(el => el.offsetParent !== null || el === document.activeElement);
  }

  /** Wrap Tab / Shift+Tab focus within the panel so focus never escapes the sheet. */
  private trapTab(e: KeyboardEvent): void {
    const panel = this.panel()?.nativeElement;
    if (!panel) return;
    const els = this.focusables();
    // No focusable body content => keep focus on the panel.
    if (els.length === 0) {
      e.preventDefault();
      panel.focus();
      return;
    }
    const first = els[0];
    const last = els[els.length - 1];
    const active = document.activeElement as HTMLElement | null;
    // Out of (or at the edge of) the panel => wrap to the opposite end.
    if (e.shiftKey) {
      if (active === first || active === panel || !panel.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else if (active === last || active === panel || !panel.contains(active)) {
      e.preventDefault();
      first.focus();
    }
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
    // Downward only (clamp negatives to 0 — small rubber-band).
    this.dragY.set(Math.max(0, e.clientY - this.startY));
  }

  protected onGripUp(e: PointerEvent): void {
    if (!this.dragging() || e.pointerId !== this.pointerId) return;
    this.dragging.set(false);
    const h = this.panel()?.nativeElement.offsetHeight ?? 600;
    const dragged = this.dragY();
    this.dragY.set(0);
    // Past ~22% of panel height => dismiss; else snap back to the current detent.
    if (dragged > h * 0.22) this.dismiss();
  }

  /** Clear open + fire closed, returning focus to the opener (focus-trap exit). */
  private dismiss(): void {
    this.open.set(false);
    this.closed.emit();
    const opener = this.opener;
    this.opener = null;
    if (opener?.isConnected) queueMicrotask(() => opener.focus?.());
  }
}
