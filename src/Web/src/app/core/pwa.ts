import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { SwPush } from '@angular/service-worker';

/**
 * Client-side PWA capability bundle (app-badge, persistent-storage, idle→presence, online/offline,
 * notification-click routing). Each capability is FEATURE-DETECTED and wrapped in try/catch so it
 * NO-OPs silently where unsupported — iOS Safari and older browsers lack most of these. Nothing here
 * ever throws, blocks startup, or prompts the user aggressively.
 *
 * This is purely a CLIENT-SIDE web-API layer — it does NOT touch the service worker / ngsw-config; the
 * SW (push/offline/update) is already wired elsewhere. {@link init} is called once from the app shell.
 */
@Injectable({ providedIn: 'root' })
export class PwaService {
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  /**
   * SwPush is optional — it's provided by @angular/service-worker only when the SW is enabled (prod). We
   * resolve it leniently so the service still constructs (and every other capability still works) in dev /
   * unsupported browsers where the SwPush provider is a no-op shell.
   */
  private readonly swPush = inject(SwPush, { optional: true });

  /** Reactive online/offline state, seeded from navigator.onLine and kept fresh by the window events. */
  private readonly _online = signal(PwaService.readOnline());
  /** True while the browser reports a network connection (drives the offline banner). */
  readonly online = this._online.asReadonly();

  /** Guard so {@link init} only wires its listeners/effects once per app instance. */
  private started = false;

  /** Running IdleDetector instance (kept so we can abort it on teardown). */
  private idleAbort: AbortController | null = null;

  /**
   * One-time initialization, called from the app shell. Best-effort across the board: each capability is
   * independently feature-detected and guarded, so a missing/unsupported API simply contributes nothing.
   *
   * @param onPresenceIdle Optional sink the shell wires in to receive the device's idle/away state from the
   *   IdleDetector (true = user idle or screen locked). Left undefined when the shell has no presence hook.
   */
  init(onPresenceIdle?: (idle: boolean) => void): void {
    if (this.started) return;
    this.started = true;

    this.requestPersistentStorage();
    this.wireOnlineOffline();
    this.wireNotificationClicks();
    void this.startIdleDetection(onPresenceIdle);
  }

  // =========================================================================
  // 1) App badge — navigator.setAppBadge / clearAppBadge (Badging API)
  // =========================================================================

  /** Set the installed-app badge to `n` (clears it when `n` <= 0). No-op where the Badging API is absent. */
  setBadge(n: number): void {
    if (!Number.isFinite(n) || n <= 0) {
      this.clearBadge();
      return;
    }
    try {
      const nav = navigator as Navigator & { setAppBadge?: (count?: number) => Promise<void> };
      if (typeof nav.setAppBadge === 'function') {
        void nav.setAppBadge(Math.floor(n)).catch(() => { /* unsupported / not installed */ });
      }
    } catch { /* Badging API absent */ }
  }

  /** Clear the installed-app badge. No-op where the Badging API is absent. */
  clearBadge(): void {
    try {
      const nav = navigator as Navigator & { clearAppBadge?: () => Promise<void> };
      if (typeof nav.clearAppBadge === 'function') {
        void nav.clearAppBadge().catch(() => { /* unsupported / not installed */ });
      }
    } catch { /* Badging API absent */ }
  }

  // =========================================================================
  // 2) Persistent storage — best-effort, once on init (keeps the offline cache from being evicted)
  // =========================================================================

  private requestPersistentStorage(): void {
    try {
      const storage = navigator?.storage as StorageManager | undefined;
      if (storage && typeof storage.persist === 'function') {
        void storage.persist().catch(() => { /* denied / unsupported — the cache is just evictable */ });
      }
    } catch { /* Storage API absent */ }
  }

  // =========================================================================
  // 3) Idle detection → presence (IdleDetector). Pure best-effort: only when the API exists AND permission
  //    is ALREADY granted (we never surface an intrusive prompt).
  // =========================================================================

  private async startIdleDetection(onPresenceIdle?: (idle: boolean) => void): Promise<void> {
    if (!onPresenceIdle) return;
    try {
      const Ctor = (window as unknown as { IdleDetector?: IdleDetectorCtor }).IdleDetector;
      if (typeof Ctor !== 'function') return;

      // Only proceed if the user has ALREADY granted idle-detection — never force an intrusive prompt. The
      // static requestPermission must run from a user gesture and would prompt, so we don't call it here;
      // we just consult the existing permission and skip otherwise.
      let granted = false;
      try {
        const status = await navigator.permissions?.query({
          name: 'idle-detection' as PermissionName,
        });
        granted = status?.state === 'granted';
      } catch {
        granted = false; // 'idle-detection' not a queryable name here → treat as not granted, skip.
      }
      if (!granted) return;

      const abort = new AbortController();
      this.idleAbort = abort;
      this.destroyRef.onDestroy(() => this.stopIdleDetection());

      const detector = new Ctor();
      detector.addEventListener('change', () => {
        try {
          const idle = detector.userState === 'idle' || detector.screenState === 'locked';
          onPresenceIdle(idle);
        } catch { /* reading state failed — ignore this tick */ }
      });
      await detector.start({ threshold: 60_000, signal: abort.signal });
    } catch {
      // Permission revoked between the check and start(), unsupported, or any other failure — skip silently.
      this.stopIdleDetection();
    }
  }

  private stopIdleDetection(): void {
    try { this.idleAbort?.abort(); } catch { /* already aborted */ }
    this.idleAbort = null;
  }

  // =========================================================================
  // 4) Online / offline — navigator.onLine + window online/offline events
  // =========================================================================

  private wireOnlineOffline(): void {
    try {
      if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
      const onOnline = () => this._online.set(true);
      const onOffline = () => this._online.set(false);
      window.addEventListener('online', onOnline);
      window.addEventListener('offline', onOffline);
      this.destroyRef.onDestroy(() => {
        try {
          window.removeEventListener('online', onOnline);
          window.removeEventListener('offline', onOffline);
        } catch { /* ignore */ }
      });
      // Re-sync once now in case the state changed between construction and wiring.
      this._online.set(PwaService.readOnline());
    } catch { /* window/events absent */ }
  }

  /** Read navigator.onLine defensively (treats an absent navigator as online — fail open). */
  private static readOnline(): boolean {
    try {
      return typeof navigator === 'undefined' || navigator.onLine !== false;
    } catch {
      return true;
    }
  }

  // =========================================================================
  // 5) Notification-click routing — SwPush.notificationClicks → Router.navigateByUrl(payload target)
  // =========================================================================

  private wireNotificationClicks(): void {
    try {
      const push = this.swPush;
      if (!push || !push.isEnabled) return; // SW disabled (dev) or unsupported — nothing to subscribe to.
      const sub = push.notificationClicks.subscribe(event => this.onNotificationClick(event));
      this.destroyRef.onDestroy(() => {
        try { sub.unsubscribe(); } catch { /* ignore */ }
      });
    } catch { /* SwPush not injectable / push unsupported */ }
  }

  /** Route to the clicked notification's target (payload `data.url` or `data.route`); ignore if absent. */
  private onNotificationClick(event: { notification?: { data?: unknown } }): void {
    try {
      const data = event?.notification?.data as { url?: unknown; route?: unknown } | undefined;
      const raw = data?.url ?? data?.route;
      const target = typeof raw === 'string' ? raw.trim() : '';
      // Only follow same-origin in-app paths (a leading "/") — never an absolute/cross-origin URL.
      if (target.startsWith('/')) {
        void this.router.navigateByUrl(target).catch(() => { /* stale/invalid route — ignore */ });
      }
    } catch { /* malformed payload — ignore */ }
  }
}

/** Minimal structural types for the experimental IdleDetector API (no DOM lib typings ship for it). */
interface IdleDetectorInstance {
  readonly userState: 'active' | 'idle' | null;
  readonly screenState: 'locked' | 'unlocked' | null;
  addEventListener(type: 'change', listener: () => void): void;
  start(opts: { threshold: number; signal?: AbortSignal }): Promise<void>;
}
interface IdleDetectorCtor {
  new (): IdleDetectorInstance;
  requestPermission?: () => Promise<PermissionState>;
}
