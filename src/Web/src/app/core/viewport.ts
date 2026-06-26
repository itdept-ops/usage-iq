import { Injectable, Signal, WritableSignal, signal } from '@angular/core';

/**
 * The primary mobile breakpoint, in px. Matches the app's CSS convention (the global `styles.scss` mobile
 * cutoff at 640px), so a component asking {@link ViewportService.isMobile} flips at the SAME width the
 * stylesheets restack — no drift between "the CSS thinks it's mobile" and "the TS thinks it's mobile".
 */
export const MOBILE_MAX_WIDTH = 640;

/**
 * A tiny, reactive "what kind of viewport am I on?" service — the app's single source of truth for
 * runtime device/size detection. Before this, the app only knew "mobile" through CSS media queries; a
 * component had no way to *ask*. This exposes it as signals so any template/computed can branch on it.
 *
 * - {@link isMobile} — true at/below {@link MOBILE_MAX_WIDTH} (≤640px). Live: updates on resize + rotate
 *   via a `matchMedia` change listener (no resize-spam; the media query only fires when it crosses).
 * - {@link isTouch} — true when the primary pointer is coarse (a finger), used to pick touch-friendly
 *   affordances (e.g. drag handles vs hover).
 *
 * SSR / no-`window` safe: if `matchMedia` is unavailable the signals just stay at their `false` default.
 * Mirrors the `matchMedia` idiom already used by {@link ThemeService} (addEventListener with the legacy
 * addListener fallback for old Safari).
 */
@Injectable({ providedIn: 'root' })
export class ViewportService {
  private readonly _isMobile = signal(false);
  private readonly _isTouch = signal(false);

  /** True when the viewport is at/below the mobile breakpoint (≤640px). Updates live on resize/rotate. */
  readonly isMobile: Signal<boolean> = this._isMobile.asReadonly();

  /** True when the primary pointer is coarse (touch) — drives touch-first affordances. */
  readonly isTouch: Signal<boolean> = this._isTouch.asReadonly();

  constructor() {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    this.bind(`(max-width: ${MOBILE_MAX_WIDTH}px)`, this._isMobile);
    this.bind('(pointer: coarse)', this._isTouch);
  }

  /** Seed a signal from a media query and keep it live. */
  private bind(query: string, target: WritableSignal<boolean>): void {
    const mq = window.matchMedia(query);
    target.set(mq.matches);
    const onChange = (e: MediaQueryListEvent): void => target.set(e.matches);
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', onChange);
    } else if (typeof mq.addListener === 'function') {
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      mq.addListener(onChange);
    }
  }
}
