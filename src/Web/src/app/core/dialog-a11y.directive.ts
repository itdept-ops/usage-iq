import {
  DestroyRef, Directive, ElementRef, inject, output,
} from '@angular/core';

/**
 * dialogA11y — the missing modal-a11y quartet for the pre-kit, hand-rolled
 * `role="dialog"` overlays (habits editor/calendar, meds sheet, finance
 * savings-goal modal) that predate the beta bottom-sheet kit.
 *
 * Apply to the dialog panel element (the one carrying role="dialog"). On init it:
 *   1. remembers the element that had focus (the opener) so it can be restored,
 *   2. moves focus to the first focusable control inside the panel (or the panel
 *      itself, which it makes programmatically focusable via tabindex=-1),
 *   3. traps Tab / Shift+Tab so focus wraps within the panel and never falls out
 *      behind the scrim,
 *   4. emits `dismiss` on Escape — the host wires this to its own close handler.
 * On destroy (the @if drops the panel on close) it restores focus to the opener.
 *
 * This mirrors the focus behaviour of the shared `app-bs-sheet`/`app-bottom-sheet`
 * primitives without changing the legacy overlays' visuals or layout. The host
 * keeps owning open/close state + aria-modal; this only manages focus + Escape.
 *
 * Usage:
 *   <aside role="dialog" aria-modal="true" dialogA11y (dismiss)="closeSheet()"> … </aside>
 */
@Directive({
  selector: '[dialogA11y]',
  standalone: true,
  host: {
    tabindex: '-1',
    '(keydown)': 'onKeydown($event)',
  },
})
export class DialogA11yDirective {
  /** Fired when the user presses Escape inside the dialog. Host closes the overlay. */
  readonly dismiss = output<void>();

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  /** The element focused just before the dialog opened — focus returns here on close. */
  private readonly opener: HTMLElement | null =
    (typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null);

  constructor() {
    const el = this.host.nativeElement;
    // Move focus into the panel once it's in the DOM (after this microtask the
    // projected content / @if children are rendered).
    queueMicrotask(() => {
      const target = this.focusables()[0] ?? el;
      target?.focus?.();
    });

    // Restore focus to the opener when the panel is torn down (close).
    inject(DestroyRef).onDestroy(() => {
      const opener = this.opener;
      if (opener?.isConnected) queueMicrotask(() => opener.focus?.());
    });
  }

  protected onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.dismiss.emit();
      return;
    }
    if (e.key === 'Tab') this.trapTab(e);
  }

  /** The tabbable elements inside the panel, in DOM order (visible ones only). */
  private focusables(): HTMLElement[] {
    const sel = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]),'
      + ' select:not([disabled]), [tabindex]:not([tabindex="-1"])';
    return Array.from(this.host.nativeElement.querySelectorAll<HTMLElement>(sel))
      .filter((node) => node.offsetParent !== null || node === document.activeElement);
  }

  /** Wrap Tab / Shift+Tab focus within the panel so it can't escape behind the scrim. */
  private trapTab(e: KeyboardEvent): void {
    const panel = this.host.nativeElement;
    const els = this.focusables();
    if (els.length === 0) {
      e.preventDefault();
      panel.focus();
      return;
    }
    const first = els[0];
    const last = els[els.length - 1];
    const active = document.activeElement as HTMLElement | null;
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
}
