import { Injectable } from '@angular/core';

/**
 * Screen Wake Lock helper — keeps the device screen on while something is actively running
 * (e.g. a household countdown the family is watching). Wraps the Screen Wake Lock API
 * (`navigator.wakeLock.request('screen')`).
 *
 * Robustness is paramount: the API is feature-detected and every call is wrapped in try/catch,
 * so on browsers that lack it (notably iOS Safari and older browsers) every method NO-OPS
 * silently — it never throws, never blocks, never prompts.
 *
 * Two behaviours make it correct in practice:
 *
 *  1. REFERENCE-COUNTED: {@link acquire}/{@link release} are balanced. Multiple independent
 *     callers (several running timers, a timer + a stopwatch) can each hold the lock; the
 *     underlying sentinel is requested on the first acquire and released only when the last
 *     caller releases. Each caller MUST pair its acquire with exactly one release.
 *
 *  2. AUTO-RE-ACQUIRES: the platform automatically drops a screen wake lock whenever the tab/app
 *     is hidden (backgrounded). We listen for `visibilitychange` and, when the document becomes
 *     visible again with a non-zero ref count, transparently re-request the lock.
 *
 * Wired in app.config? No — it self-arms lazily on first {@link acquire} and is `providedIn: 'root'`,
 * so it costs nothing until a consumer actually needs the screen to stay awake.
 */
@Injectable({ providedIn: 'root' })
export class WakeLockService {
  /** Outstanding acquire() callers; the sentinel is held while this is > 0. */
  private refs = 0;
  /** The live sentinel, or null when we don't currently hold the lock. */
  private sentinel: WakeLockSentinel | null = null;
  /** Whether we've attached the visibilitychange re-acquire listener (attach once, lazily). */
  private listening = false;
  /** Guards against overlapping request() calls racing each other. */
  private requesting = false;

  /** True only where the Screen Wake Lock API is actually present. */
  private get supported(): boolean {
    try {
      return typeof navigator !== 'undefined' && 'wakeLock' in navigator;
    } catch {
      return false;
    }
  }

  /**
   * Register interest in keeping the screen on. Reference-counted: the first caller requests the
   * lock; later callers just bump the count. NO-OP (but still counted) where unsupported, so the
   * paired {@link release} stays balanced regardless of platform.
   */
  acquire(): void {
    this.refs++;
    if (!this.supported) return;
    this.armVisibilityListener();
    void this.request();
  }

  /**
   * Drop one caller's interest. When the count reaches zero the underlying sentinel is released.
   * Never goes negative; extra release() calls are harmless no-ops.
   */
  release(): void {
    if (this.refs > 0) this.refs--;
    if (this.refs === 0) void this.releaseSentinel();
  }

  /** Request the sentinel if we want one and don't already hold it. Silent on any failure. */
  private async request(): Promise<void> {
    if (!this.supported || this.refs === 0 || this.sentinel || this.requesting) return;
    this.requesting = true;
    try {
      const sentinel = await navigator.wakeLock!.request('screen');
      // If everyone released while we were awaiting, immediately let it go again.
      if (this.refs === 0) {
        await sentinel.release().catch(() => {});
        return;
      }
      this.sentinel = sentinel;
      // The platform also releases on its own (e.g. tab hidden); reflect that so we can re-acquire.
      this.sentinel.addEventListener?.('release', () => {
        this.sentinel = null;
      });
    } catch {
      /* not permitted / not visible / unsupported — silently do nothing */
    } finally {
      this.requesting = false;
    }
  }

  /** Release + forget the current sentinel. Silent on any failure. */
  private async releaseSentinel(): Promise<void> {
    const sentinel = this.sentinel;
    this.sentinel = null;
    if (!sentinel) return;
    try {
      await sentinel.release();
    } catch {
      /* already gone — ignore */
    }
  }

  /**
   * Screen wake locks are dropped whenever the document is hidden; when it becomes visible again
   * and we still have callers, transparently re-request. Attached once, lazily, on first acquire.
   */
  private armVisibilityListener(): void {
    if (this.listening) return;
    try {
      if (typeof document === 'undefined') return;
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && this.refs > 0 && !this.sentinel) {
          void this.request();
        }
      });
      this.listening = true;
    } catch {
      /* no document / listeners unavailable — re-acquire simply won't fire */
    }
  }
}
