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
 * instead it reads the persisted session directly — identical source of truth as the auth
 * interceptor's `Bearer ${token}`. Kept in lock-step with auth.ts by hand (both are tiny).
 */
const SESSION_KEY = 'usage_iq_session';

/** Read the current, non-expired bearer token straight off the persisted session (or null). */
function currentToken(): string | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as { token?: string; expiresAtUtc?: string };
    if (!s?.token || !s.expiresAtUtc) return null;
    return new Date(s.expiresAtUtc).getTime() > Date.now() ? s.token : null;
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
    const record: Omit<QueuedRequest, 'id'> = {
      method: req.method,
      url: req.url,
      body: req.body,
      headers: req.headers ?? {},
      enqueuedAt: Date.now(),
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

      // No valid bearer (session expired / logged out / force-logged-out) — do NOT flush: replaying
      // now would hit the server with no Authorization, get a 401/403, and (below) risk discarding
      // optimistically-acked writes. Leave everything queued for a later wake once re-authenticated.
      const token = currentToken();
      if (!token) return;

      for (const item of pending) {
        try {
          const headers: Record<string, string> = { ...(item.headers ?? {}) };
          // Always replay with the FRESH bearer (never the possibly-stale one we snapshotted).
          delete headers['Authorization'];
          delete headers['authorization'];
          if (token) headers['Authorization'] = `Bearer ${token}`;

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
