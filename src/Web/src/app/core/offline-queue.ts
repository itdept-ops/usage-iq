import { Injectable, signal } from '@angular/core';

/**
 * One queued mutation, as snapshotted by the offline interceptor. `body` is the already-serialised
 * JSON (HttpClient hands us the parsed object; we keep it as-is and re-stringify on replay) and
 * `headers` is a flat name→value map of the request's own headers (Authorization is NOT stored —
 * it's re-attached fresh at replay time from the live session, see {@link OfflineQueue.flush}).
 */
export interface QueuedRequest {
  id: number;
  method: string;
  url: string;
  body: unknown;
  headers: Record<string, string>;
  enqueuedAt: number;
  /**
   * Owner of this queued write (the signed-in user's id/email at enqueue time), used so a flush on a
   * SHARED device only replays rows belonging to the CURRENT user — a different user's queued writes
   * would otherwise replay authenticated as whoever is now signed in (the auth cookie rides along
   * automatically). Undefined on legacy rows / when no session metadata was available at enqueue.
   */
  owner?: string;
}

/** Snapshot the interceptor passes to {@link OfflineQueue.enqueue} (everything except the auto id/timestamp). */
export type QueuedRequestInput = Pick<QueuedRequest, 'method' | 'url' | 'body' | 'headers'>;

const DB_NAME = 'usageiq-offline';
const STORE = 'queue';
const DB_VERSION = 1;

/**
 * The SAME localStorage key the {@link AuthService} persists its session under, and the SAME
 * expiry guard. The queue lives OUTSIDE Angular DI for replay (raw fetch from a window/SW message
 * handler), so it can't inject AuthService without a circular dep through the http interceptor;
 * instead it reads the persisted session metadata directly to decide WHETHER to flush. The actual
 * credential is the HttpOnly auth cookie (sent automatically via credentials:'include' on the replay);
 * JS never sees the token. Kept in lock-step with auth.ts by hand (both are tiny).
 */
const SESSION_KEY = 'usage_iq_session';

/** True if a non-expired session is persisted. Auth itself rides the HttpOnly cookie (unreadable here). */
function sessionActive(): boolean {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return false;
    const s = JSON.parse(raw) as { expiresAtUtc?: string };
    return !!s?.expiresAtUtc && new Date(s.expiresAtUtc).getTime() > Date.now();
  } catch {
    return false;
  }
}

/**
 * A stable identity key for the currently-signed-in user, read from the SAME persisted session blob
 * (userId preferred, email as a fallback), or null if none can be derived. Used to stamp queued rows
 * on enqueue and to gate replay on flush so one user's offline writes never replay as another's on a
 * shared device. Not a security boundary (the server still authorizes every replay by the cookie) —
 * it's a correctness guard against cross-user attribution.
 */
function currentUserKey(): string | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as { userId?: string | null; email?: string | null };
    const key = s?.userId ?? s?.email ?? null;
    return key ? String(key) : null;
  } catch {
    return null;
  }
}

/**
 * Offline write queue for whitelisted, replay-safe mutations (see offline.interceptor.ts). When a
 * mutation can't reach the server (true network failure), the interceptor stashes it here and the UI
 * gets an optimistic success; the queue then drains automatically whenever connectivity returns —
 * on the window "online" event, on a Background-Sync "flush-queue" wake (relayed by the SW as a
 * `usageiq-flush-queue` postMessage), or on a periodic-refresh wake.
 *
 * IndexedDB-backed (a tiny promise wrapper — no new deps) so the queue survives reloads and tab
 * closes. Every browser API is feature-detected and guarded: on a platform without IndexedDB /
 * service workers the service degrades to a no-op rather than throwing.
 */
@Injectable({ providedIn: 'root' })
export class OfflineQueue {
  /** Number of requests currently waiting in the queue (drives any "N pending" UI hint). */
  readonly size = signal(0);

  private dbPromise: Promise<IDBDatabase | null> | null = null;
  private flushing = false;

  constructor() {
    // Re-drain whenever connectivity returns or the SW nudges us. All guarded — a missing API
    // simply means that wake-source never fires.
    try {
      window.addEventListener('online', () => void this.flush());
    } catch { /* no window / addEventListener — ignore */ }

    try {
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
          const type = (event?.data as { type?: string } | undefined)?.type;
          if (type === 'usageiq-flush-queue' || type === 'usageiq-periodic-refresh') {
            void this.flush();
          }
        });
      }
    } catch { /* no serviceWorker — ignore */ }

    // Best-effort startup drain (covers the "app reopened while back online" case) + size priming.
    void this.refreshSize();
    void this.flush();
  }

  // ---- public queue API ----------------------------------------------------

  /** Append a request to the queue, refresh the size signal, and ask the SW to wake us when online. */
  async enqueue(req: QueuedRequestInput): Promise<void> {
    const db = await this.db();
    if (!db) return;
    const owner = currentUserKey();
    const record: Omit<QueuedRequest, 'id'> = {
      method: req.method,
      url: req.url,
      body: req.body,
      headers: req.headers ?? {},
      enqueuedAt: Date.now(),
      ...(owner ? { owner } : {}),
    };
    try {
      await this.tx(db, 'readwrite', store => store.add(record as QueuedRequest));
    } catch { /* quota / serialisation — drop silently rather than throw into the interceptor */ }
    await this.refreshSize();
    this.registerSync();
  }

  /** All queued requests, oldest first. */
  async all(): Promise<QueuedRequest[]> {
    const db = await this.db();
    if (!db) return [];
    try {
      const rows = await this.tx<QueuedRequest[]>(db, 'readonly', store => store.getAll() as IDBRequest<QueuedRequest[]>);
      return (rows ?? []).sort((a, b) => a.enqueuedAt - b.enqueuedAt);
    } catch {
      return [];
    }
  }

  /** Remove one request by id. */
  async remove(id: number): Promise<void> {
    const db = await this.db();
    if (!db) return;
    try {
      await this.tx(db, 'readwrite', store => store.delete(id));
    } catch { /* ignore */ }
    await this.refreshSize();
  }

  /**
   * Empty the ENTIRE queue (all pending rows) and reset the size signal to 0. Called on logout so a
   * subsequent different user on the same shared device never inherits the previous user's queued
   * offline writes. Fully guarded — a missing IndexedDB simply leaves the (empty) size at 0.
   */
  async clear(): Promise<void> {
    const db = await this.db();
    if (!db) { this.size.set(0); return; }
    try {
      await this.tx(db, 'readwrite', store => store.clear());
    } catch { /* ignore */ }
    await this.refreshSize();
  }

  /**
   * Replay every queued request with the CURRENT auth + credentials. A definitive response
   * (2xx OR 4xx — the server reached a verdict) removes the entry; a true network error keeps it
   * for the next wake. Re-entrancy-guarded so overlapping wakes don't double-replay.
   */
  async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      const pending = await this.all();
      if (!pending.length) return;

      // Not signed in (session expired / logged out / force-logged-out) — do NOT flush: the auth cookie
      // is gone, so replaying now would 401/403 and (below) risk discarding optimistically-acked writes.
      // Leave everything queued for a later wake once re-authenticated.
      if (!sessionActive()) return;

      // Shared-device guard: on a signed-in session, drop any row STAMPED for a DIFFERENT user before
      // replaying — its write would otherwise apply as the current user (the auth cookie rides along).
      // Legacy/unstamped rows (owner undefined) are still replayed, preserving prior behaviour.
      const me = currentUserKey();
      if (me) {
        for (const item of pending) {
          if (item.owner && item.owner !== me) {
            await this.remove(item.id);
          }
        }
      }

      const toReplay = me
        ? pending.filter(item => !item.owner || item.owner === me)
        : pending;

      for (const item of toReplay) {
        try {
          const headers: Record<string, string> = { ...(item.headers ?? {}) };
          // Auth rides the HttpOnly cookie (credentials:'include' below), not a header; strip any stale
          // Authorization that may have been captured so it can't shadow the cookie.
          delete headers['Authorization'];
          delete headers['authorization'];

          const hasBody = item.body !== undefined && item.body !== null && item.method !== 'GET';
          if (hasBody && !headers['Content-Type'] && !headers['content-type']) {
            headers['Content-Type'] = 'application/json';
          }

          const res = await fetch(item.url, {
            method: item.method,
            headers,
            body: hasBody ? JSON.stringify(item.body) : undefined,
            credentials: 'include',
          });

          // 401/403 = auth not ready (token expired mid-flush, session invalidated, force-logout).
          // This is NOT a data verdict — the write is still valid and a re-auth will replay it.
          // Keep it (and the rest) and stop the flush, mirroring the network-error branch below.
          if (res.status === 401 || res.status === 403) {
            break;
          }

          // 2xx = applied; other 4xx = definitively rejected (bad/duplicate data) — either way the
          // server has a data verdict, so stop retrying. Only 5xx / network errors are worth a retry.
          if (res.status < 500) {
            await this.remove(item.id);
          }
        } catch {
          // Network error (still offline) — keep this and the rest for the next wake.
          break;
        }
      }
    } finally {
      this.flushing = false;
      await this.refreshSize();
    }
  }

  /**
   * Register a Background-Sync wake so the browser drains the queue once it regains connectivity,
   * even if no tab is focused. Best-effort + fully guarded — unsupported browsers just rely on the
   * window "online" event instead. Also tries (once, best-effort) to register a periodic refresh;
   * that permission is usually NOT granted, which is fine.
   */
  registerSync(): void {
    try {
      if (!('serviceWorker' in navigator)) return;
      navigator.serviceWorker.ready
        .then(reg => {
          try {
            const sync = (reg as unknown as { sync?: { register(tag: string): Promise<void> } }).sync;
            sync?.register('flush-queue').catch(() => { /* ignore */ });
          } catch { /* no Background Sync — ignore */ }
          this.registerPeriodicSync(reg);
        })
        .catch(() => { /* SW not ready — ignore */ });
    } catch { /* ignore */ }
  }

  private periodicTried = false;

  /** Best-effort, once-per-session periodic-sync registration (only if its permission is granted). */
  private registerPeriodicSync(reg: ServiceWorkerRegistration): void {
    if (this.periodicTried) return;
    this.periodicTried = true;
    try {
      const periodic = (reg as unknown as {
        periodicSync?: { register(tag: string, opts: { minInterval: number }): Promise<void> };
      }).periodicSync;
      if (!periodic) return;
      const perms = (navigator as unknown as { permissions?: Permissions }).permissions;
      const tryRegister = () =>
        periodic.register('refresh', { minInterval: 12 * 3600 * 1000 }).catch(() => { /* ignore */ });
      if (perms?.query) {
        perms
          .query({ name: 'periodic-background-sync' as PermissionName })
          .then(status => { if (status.state === 'granted') void tryRegister(); })
          .catch(() => { /* permission name unsupported — skip */ });
      }
    } catch { /* no periodicSync — ignore */ }
  }

  // ---- tiny IndexedDB promise wrapper -------------------------------------

  private db(): Promise<IDBDatabase | null> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise<IDBDatabase | null>(resolve => {
      try {
        if (typeof indexedDB === 'undefined') { resolve(null); return; }
        const open = indexedDB.open(DB_NAME, DB_VERSION);
        open.onupgradeneeded = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains(STORE)) {
            db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
          }
        };
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
    return this.dbPromise;
  }

  /** Run one transaction and resolve with the request's result (or reject on error). */
  private tx<T>(
    db: IDBDatabase,
    mode: IDBTransactionMode,
    op: (store: IDBObjectStore) => IDBRequest,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      try {
        const transaction = db.transaction(STORE, mode);
        const request = op(transaction.objectStore(STORE));
        request.onsuccess = () => resolve(request.result as T);
        request.onerror = () => reject(request.error);
        transaction.onabort = () => reject(transaction.error);
      } catch (err) {
        reject(err);
      }
    });
  }

  private async refreshSize(): Promise<void> {
    const db = await this.db();
    if (!db) { this.size.set(0); return; }
    try {
      const count = await this.tx<number>(db, 'readonly', store => store.count());
      this.size.set(count ?? 0);
    } catch {
      /* leave the last known size */
    }
  }
}
