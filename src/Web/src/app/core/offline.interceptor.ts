import {
  HttpErrorResponse,
  HttpHeaders,
  HttpInterceptorFn,
  HttpResponse,
} from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, of, throwError } from 'rxjs';
import { OfflineQueue } from './offline-queue';

/**
 * URL substrings of the ONLY mutations we'll queue+optimistically-ack when offline. Deliberately
 * narrow: each is an APPEND-style, owner-scoped, replay-safe write where logging the same thing once
 * more later is harmless and never destroys data. Everything NOT on this list (auth, payments, any
 * DELETE/record-edit, share-links, location-share start/stop, AI calls, anything irreversible or
 * order-sensitive) is left completely untouched and errors normally.
 */
const QUEUEABLE_URL_SUBSTRINGS = [
  '/api/tracker/food',        // log a food
  '/api/tracker/exercise',    // log an exercise
  '/api/tracker/hydration',   // log a drink
  '/api/tracker/coffee',      // log a coffee
  '/api/tracker/supplement',  // log a supplement
  '/api/tracker/sleep',       // log a night of sleep
  '/api/tracker/weight',      // log today's weight
  '/api/tracker/activity',    // upsert the day's watch/activity stats
  '/api/chat/channels/',      // send a chat message: POST /api/chat/channels/{id}/messages
];

// POST ONLY: every whitelisted append-style write above is a POST (log food/exercise/…/weight, send a
// chat message). PUT/PATCH/DELETE on these paths are record EDITS or DELETES (e.g. `PUT /api/tracker/food/{id}`
// updateFood, `PUT /api/tracker/activity` upsert, `DELETE /api/tracker/*/{id}`) — order-sensitive, not
// replay-safe — so they are deliberately excluded and error normally when offline, per the invariant above.
const QUEUEABLE_METHODS = new Set(['POST']);

/** Only the chat *messages* sub-route is queueable under /api/chat/channels/ — never read/AI/etc. */
function isQueueableUrl(url: string): boolean {
  for (const sub of QUEUEABLE_URL_SUBSTRINGS) {
    if (!url.includes(sub)) continue;
    if (sub === '/api/chat/channels/') return url.includes('/messages');
    return true;
  }
  return false;
}

/**
 * Offline write-queue interceptor. For a whitelisted mutation that fails with a TRUE network error
 * (HttpErrorResponse `status === 0` — the request never reached the server), it snapshots the request
 * into the {@link OfflineQueue} and completes the stream with a synthetic 202 "queued" response, so
 * the UI shows an optimistic success instead of an error. The queue then replays it once the device
 * is back online (window "online" / Background-Sync wake).
 *
 * status===0 ONLY is the safety hinge: a 0 means the bytes never left the client, so a later replay
 * cannot double-apply. Any real server status (4xx/5xx) may have PARTIALLY applied on the server, so
 * we must NOT silently re-send it — those (and every non-whitelisted request, and non-network errors)
 * are rethrown untouched.
 */
export const offlineInterceptor: HttpInterceptorFn = (req, next) => {
  const queueable = QUEUEABLE_METHODS.has(req.method) && isQueueableUrl(req.url);
  if (!queueable) return next(req);

  const queue = inject(OfflineQueue);

  return next(req).pipe(
    catchError((err: unknown) => {
      // True network failure only — the request never reached the server, so replay can't double-submit.
      if (err instanceof HttpErrorResponse && err.status === 0) {
        const headers: Record<string, string> = {};
        for (const name of req.headers.keys()) {
          // Don't persist Authorization — the queue re-attaches a fresh bearer at replay time.
          if (name.toLowerCase() === 'authorization') continue;
          const value = req.headers.get(name);
          if (value !== null) headers[name] = value;
        }

        void queue.enqueue({
          method: req.method,
          url: req.url,
          body: req.body ?? null,
          headers,
        });
        queue.registerSync();

        // Optimistic ack: a 202 with an empty body so callers that map the response don't choke.
        return of(
          new HttpResponse({
            url: req.url,
            status: 202,
            statusText: 'Queued (offline)',
            body: null,
            headers: new HttpHeaders({ 'X-UsageIQ-Queued': '1' }),
          }),
        );
      }
      // Whitelisted but a real server error (4xx/5xx) — may have applied; rethrow untouched.
      return throwError(() => err);
    }),
  );
};
