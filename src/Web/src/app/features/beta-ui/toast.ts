import {
  ChangeDetectionStrategy, Component, Injectable, computed, inject, signal,
} from '@angular/core';
import { Haptics } from '../../core/haptics';

/** The tone of a toast — drives its accent stripe + role. */
export type ToastTone = 'neutral' | 'success' | 'warn';

/** A live toast record. `id` is monotonic; the controller dedupes dismissals by it. */
export interface ToastMsg {
  id: number;
  text: string;
  tone: ToastTone;
  /** Optional inline action (e.g. an "Undo"); clicking it runs `onAction` then dismisses. */
  actionLabel?: string;
  onAction?: () => void;
}

/**
 * BETA-KIT ToastController — an injectable, dependency-free snackbar controller. A new beta-kit
 * primitive (the flagship used an ad-hoc undo bar). Drop ONE `<app-bs-toaster />` host near a
 * page root; inject this controller anywhere under it and call `show(...)` / `undo(...)`. Toasts
 * auto-dismiss after a duration (paused while an action is offered a bit longer), stack newest at
 * the bottom above the safe-area, and announce via aria-live. The host reads `toasts()`.
 *
 * Provide it at the page (route) level so each beta page gets its own queue:
 *   providers: [ToastController]
 *
 * CONTROLLER API (next phase depends on this VERBATIM):
 *   show(text, opts?: { tone?, durationMs?, actionLabel?, onAction? }) => id
 *   undo(text, onUndo, durationMs?) => id          // convenience: a warn-toned toast with an "Undo" action
 *   dismiss(id) => void
 *   clear() => void
 *   toasts: Signal<ToastMsg[]>                      // read by the toaster host
 */
@Injectable()
export class ToastController {
  private seq = 0;
  private readonly _toasts = signal<ToastMsg[]>([]);
  /** The live toast stack (oldest → newest), read by the toaster host. */
  readonly toasts = this._toasts.asReadonly();
  private timers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly haptics = inject(Haptics);

  /** Push a toast; returns its id. */
  show(
    text: string,
    opts: { tone?: ToastTone; durationMs?: number; actionLabel?: string; onAction?: () => void } = {},
  ): number {
    const id = ++this.seq;
    const msg: ToastMsg = {
      id, text,
      tone: opts.tone ?? 'neutral',
      actionLabel: opts.actionLabel,
      onAction: opts.onAction,
    };
    this._toasts.update(list => [...list, msg]);
    // Confirm a success outcome with a gentle double-tick (no-ops on iOS / unsupported).
    if (msg.tone === 'success') this.haptics.success();
    const dur = opts.durationMs ?? (opts.actionLabel ? 5000 : 3200);
    this.timers.set(id, setTimeout(() => this.dismiss(id), dur));
    return id;
  }

  /** Convenience: a warn-toned toast with an "Undo" action that runs `onUndo`. */
  undo(text: string, onUndo: () => void, durationMs = 5000): number {
    return this.show(text, { tone: 'warn', actionLabel: 'Undo', onAction: onUndo, durationMs });
  }

  /** Remove a toast by id (also clears its timer). */
  dismiss(id: number): void {
    const t = this.timers.get(id);
    if (t) { clearTimeout(t); this.timers.delete(id); }
    this._toasts.update(list => list.filter(m => m.id !== id));
  }

  /** Run a toast's action (if any) then dismiss it. */
  runAction(id: number): void {
    const msg = this._toasts().find(m => m.id === id);
    msg?.onAction?.();
    this.dismiss(id);
  }

  /** Drop every toast. */
  clear(): void {
    this.timers.forEach(t => clearTimeout(t));
    this.timers.clear();
    this._toasts.set([]);
  }
}

/**
 * BETA-KIT Toaster host — renders the {@link ToastController}'s stack. Place ONE near a page root.
 * Glass surface, --lift-3, accent stripe per tone, bottom-docked above the safe-area, aria-live
 * polite (assertive for warn). Slide+fade in is gated by the page-host reduced-motion killswitch.
 *
 * CONTRACT (next phase depends on this VERBATIM):
 *   selector:  app-bs-toaster
 *   inputs:    (none — reads the injected ToastController)
 *   note:      requires ToastController provided in an ancestor injector (page providers).
 *
 * Usage: `<app-bs-toaster />`  (+ `providers: [ToastController]` on the page)
 */
@Component({
  selector: 'app-bs-toaster',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="bs-toaster" role="region" aria-label="Notifications">
      @for (t of ctrl.toasts(); track t.id) {
        <div class="bs-toast" [class.is-success]="t.tone === 'success'" [class.is-warn]="t.tone === 'warn'"
             [attr.role]="t.tone === 'warn' ? 'alert' : 'status'"
             [attr.aria-live]="t.tone === 'warn' ? 'assertive' : 'polite'">
          <span class="bs-toast-stripe" aria-hidden="true"></span>
          <span class="bs-toast-text">{{ t.text }}</span>
          @if (t.actionLabel) {
            <button type="button" class="bs-toast-action" (click)="ctrl.runAction(t.id)">{{ t.actionLabel }}</button>
          }
          <button type="button" class="bs-toast-close" aria-label="Dismiss" (click)="ctrl.dismiss(t.id)">×</button>
        </div>
      }
    </div>
  `,
  styles: [`
    :host { position: fixed; inset: 0; z-index: 60; pointer-events: none; }
    .bs-toaster {
      position: absolute; left: 0; right: 0;
      bottom: calc(16px + env(safe-area-inset-bottom, 0px));
      display: flex; flex-direction: column; align-items: center; gap: 8px;
      padding-inline: max(16px, env(safe-area-inset-left, 0px)) max(16px, env(safe-area-inset-right, 0px));
    }
    .bs-toast {
      pointer-events: auto;
      display: flex; align-items: center; gap: 10px;
      width: 100%; max-width: 440px; padding: 12px 12px 12px 14px;
      position: relative; overflow: hidden;
      background: var(--glass);
      backdrop-filter: blur(var(--blur-glass)) saturate(1.4);
      -webkit-backdrop-filter: blur(var(--blur-glass)) saturate(1.4);
      border: 1px solid var(--glass-edge); border-radius: var(--r-card);
      box-shadow: var(--lift-3);
      animation: bs-toast-in 320ms var(--ease-spring) both;
    }
    @keyframes bs-toast-in {
      from { opacity: 0; transform: translateY(16px) scale(.98); }
      to { opacity: 1; transform: none; }
    }
    .bs-toast-stripe {
      position: absolute; left: 0; top: 0; bottom: 0; width: 3px;
      background: linear-gradient(180deg, var(--accent-a), var(--accent-b));
    }
    .bs-toast.is-success .bs-toast-stripe { background: var(--signal); }
    .bs-toast.is-warn .bs-toast-stripe { background: var(--warn); }
    .bs-toast-text {
      flex: 1 1 auto; min-width: 0;
      font-family: var(--font-ui); font-size: 14px; font-weight: 600; color: var(--ink);
    }
    .bs-toast-action {
      flex: 0 0 auto; padding: 6px 12px; min-height: 36px;
      border: none; border-radius: var(--r-pill);
      background: linear-gradient(135deg, var(--accent-a), var(--accent-b));
      color: var(--ink-on-accent); font-family: var(--font-ui); font-size: 13px; font-weight: 700;
      cursor: pointer; touch-action: manipulation; -webkit-tap-highlight-color: transparent;
    }
    .bs-toast.is-warn .bs-toast-action { background: var(--warn); color: #1a0e00; }
    .bs-toast-action:focus-visible, .bs-toast-close:focus-visible {
      outline: 2px solid var(--focus); outline-offset: 2px;
    }
    .bs-toast-close {
      flex: 0 0 auto; width: 28px; height: 28px; display: grid; place-items: center;
      border: none; background: transparent; color: var(--ink-dim);
      font-size: 22px; line-height: 1; border-radius: var(--r-pill);
      cursor: pointer; touch-action: manipulation; -webkit-tap-highlight-color: transparent;
    }
    .bs-toast-close:hover { color: var(--ink); }
    @media (prefers-reduced-motion: reduce) { .bs-toast { animation: none; } }
  `],
})
export class BetaToaster {
  // Public so the template can read the stack; injected from the ancestor (page) injector.
  protected readonly ctrl: ToastController;
  constructor(ctrl: ToastController) { this.ctrl = ctrl; }
}
