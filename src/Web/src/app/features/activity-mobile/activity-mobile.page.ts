import {
  ChangeDetectionStrategy, Component, computed, inject, signal,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { MatIconModule } from '@angular/material/icon';

import { Api } from '../../core/api';
import { RequestLogEntry } from '../../core/models';
import {
  BetaPullRefresh, BetaSegmentedControl, BetaBottomSheet, BetaSkeleton,
  BetaToaster, ToastController, type Segment,
} from '../beta-ui';

/**
 * Activity "Request log" — the MOBILE twin of the live admin `/activity` page (logs.ts), rebuilt on the
 * shared beta-ui "Strata" kit (`@use '../beta-ui/beta-kit'`) with a signature SLATE → CYAN accent. Where
 * the live page is a wide, scroll-x request TABLE, the mobile twin is an immersive scrolling column: a
 * hero with a tiny stat strip (total / errors / p50-ish slowest), a compact filter bar (a
 * {@link BetaSegmentedControl} status family picker + a method picker sheet + a path search), and a
 * scrollable list of condensed LOG CARDS — one per request (time · method badge · path · status · ms ·
 * user). Tapping a card opens a {@link BetaBottomSheet} DETAIL with the full meta + pretty-printed
 * request/response bodies, exactly like the live page's expand row. Pull-to-refresh, skeleton loaders,
 * and elevated empty/error states round it out.
 *
 * DATA PARITY: every row comes straight from the SAME admin-only `/api/logs` endpoint the live page uses
 * — {@link Api.requestLogs} called VERBATIM with the same `{ method, status, q, take }` filter shape (the
 * server already truncates bodies + redacts secrets/auth routes). The status-class + byte/JSON-pretty
 * helpers are mirrored from logs.ts so the two presentations agree. No email is ever shown — only the
 * server-provided display name (email-privacy), same as the live DTO ({@link RequestLogEntry}).
 *
 * ISOLATION: gated by `platform.mobile` on the SAME `/activity` route + the SAME admin permission the live
 * route carries. Imports only the kit + the shared Api/models the live page already uses. No live page is
 * imported or modified. Mobile-first (44px targets, safe-area insets, no 390px overflow); centers on
 * desktop; reduced motion collapses the kit animations via the a11y killswitch.
 */
@Component({
  selector: 'app-activity-mobile',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [ToastController],
  imports: [
    DatePipe, FormsModule, MatIconModule,
    BetaPullRefresh, BetaSegmentedControl, BetaBottomSheet, BetaSkeleton, BetaToaster,
  ],
  template: `
    <!-- ─────────────── PULL-TO-REFRESH OWNS THE SCROLL ─────────────── -->
    <app-bs-pull-refresh class="ac-ptr" [busy]="refreshing()" (refresh)="reload()">
      <div class="ac-scroll" aria-live="polite">

        <!-- ─── IMMERSIVE HEADER: title + a tiny stat strip ─── -->
        <header class="ac-hero">
          <p class="ac-hero__kicker"><mat-icon aria-hidden="true">timeline</mat-icon> Request Log</p>
          <h1 class="ac-hero__title">Activity</h1>
          <p class="ac-hero__sub">Every API request captured by middleware — bodies truncated, secrets redacted.</p>

          @if (!loading() && !errored()) {
            <div class="ac-stats">
              <div class="ac-stat">
                <span class="ac-stat__n mono-num">{{ logs().length }}</span>
                <span class="ac-stat__l">requests</span>
              </div>
              <div class="ac-stat" [class.is-bad]="errorCount() > 0">
                <span class="ac-stat__n mono-num">{{ errorCount() }}</span>
                <span class="ac-stat__l">errors</span>
              </div>
              <div class="ac-stat">
                <span class="ac-stat__n mono-num">{{ slowestMs() }}</span>
                <span class="ac-stat__l">slowest ms</span>
              </div>
            </div>
          }
        </header>

        <!-- ─── COMPACT FILTER BAR ─── -->
        <div class="ac-filters">
          <app-bs-segmented class="ac-statusseg"
            [segments]="statusSegments" [value]="status()" label="Filter by status family"
            (change)="setStatus($event)" />

          <div class="ac-filters__row">
            <button type="button" class="ac-method" (click)="methodSheet.set(true)"
                    [attr.aria-label]="'Method filter: ' + (method() || 'all methods')">
              <mat-icon aria-hidden="true">filter_list</mat-icon>
              <span class="ac-method__txt">{{ method() || 'All methods' }}</span>
              <mat-icon class="ac-method__caret" aria-hidden="true">expand_more</mat-icon>
            </button>

            <label class="ac-search">
              <mat-icon aria-hidden="true">search</mat-icon>
              <input class="ac-search__input mono-num" type="text" inputmode="text"
                     [ngModel]="q()" (ngModelChange)="q.set($event)" (keyup.enter)="reload()"
                     placeholder="/api/usage" autocomplete="off" aria-label="Path contains" />
              @if (q()) {
                <button type="button" class="ac-search__clear" (click)="clearSearch()" aria-label="Clear search">
                  <mat-icon aria-hidden="true">close</mat-icon>
                </button>
              }
            </label>
          </div>
        </div>

        @if (loading()) {
          <!-- skeleton list -->
          <div class="ac-list" aria-hidden="true">
            @for (n of skeletonCells; track n) {
              <app-bs-skeleton height="76px" radius="var(--r-tile)" />
            }
          </div>

        } @else if (errored()) {
          <div class="ac-state">
            <span class="ac-state__orb"><mat-icon aria-hidden="true">cloud_off</mat-icon></span>
            <h2 class="ac-state__title">Couldn't load the activity log</h2>
            <p class="ac-state__body">Something went wrong fetching requests. Give it another go.</p>
            <button type="button" class="ac-state__cta" (click)="reload()">
              <mat-icon aria-hidden="true">refresh</mat-icon> Try again
            </button>
          </div>

        } @else if (logs().length) {
          <div class="ac-list">
            @for (r of logs(); track r.id; let i = $index) {
              <button type="button" class="ac-card ac-reveal" [style.--ri]="i"
                      (click)="openDetail(r)" [attr.aria-label]="cardAria(r)">
                <span class="ac-card__status" [class]="statusClass(r.statusCode)" aria-hidden="true">
                  {{ r.statusCode }}
                </span>
                <span class="ac-card__body">
                  <span class="ac-card__line">
                    <span class="ac-method-badge" [attr.data-m]="r.method">{{ r.method }}</span>
                    <span class="ac-card__path mono-num">{{ r.path }}</span>
                    @if (r.queryString) { <span class="ac-card__qs mono-num">{{ r.queryString }}</span> }
                  </span>
                  <span class="ac-card__meta mono-num">
                    {{ r.whenUtc | date: 'HH:mm:ss' }}
                    · <span [class.is-slow]="r.durationMs >= 500">{{ r.durationMs }} ms</span>
                    · {{ r.userName || 'anon' }}
                  </span>
                </span>
                <mat-icon class="ac-card__go" aria-hidden="true">chevron_right</mat-icon>
              </button>
            }
          </div>

          <p class="ac-foot" aria-hidden="true">Showing the newest {{ logs().length }} requests · tap a row for bodies</p>

        } @else {
          <!-- EMPTY -->
          <div class="ac-empty">
            <span class="ac-empty__orb"><mat-icon aria-hidden="true">inbox</mat-icon></span>
            <h2 class="ac-empty__title">No requests match</h2>
            <p class="ac-empty__body">
              @if (hasActiveFilter()) {
                Nothing matches these filters. Try clearing them.
              } @else {
                No requests logged yet — interact with the app, then refresh.
              }
            </p>
            @if (hasActiveFilter()) {
              <button type="button" class="ac-empty__cta" (click)="clearFilters()">
                <mat-icon aria-hidden="true">filter_alt_off</mat-icon> Clear filters
              </button>
            }
          </div>
        }
      </div>
    </app-bs-pull-refresh>

    <!-- ─────────────── METHOD PICKER SHEET ─────────────── -->
    <app-bs-sheet [(open)]="methodSheet" detent="peek" label="Filter by method">
      <div class="ms">
        <h3 class="ms__title">Method</h3>
        <div class="ms__opts" role="group" aria-label="HTTP method filter">
          <button type="button" class="ms__opt" [class.is-on]="method() === ''" (click)="pickMethod('')">
            <span class="ms__opt-txt">All methods</span>
            @if (method() === '') { <mat-icon aria-hidden="true">check</mat-icon> }
          </button>
          @for (m of methods; track m) {
            <button type="button" class="ms__opt" [class.is-on]="method() === m" (click)="pickMethod(m)">
              <span class="ac-method-badge" [attr.data-m]="m">{{ m }}</span>
              @if (method() === m) { <mat-icon aria-hidden="true">check</mat-icon> }
            </button>
          }
        </div>
      </div>
    </app-bs-sheet>

    <!-- ─────────────── DETAIL BOTTOM SHEET ─────────────── -->
    <app-bs-sheet [(open)]="detailOpen" detent="full" [label]="selected() ? selected()!.method + ' ' + selected()!.path : 'Request detail'">
      @if (selected(); as r) {
        <div class="ad">
          <div class="ad__head">
            <span class="ad__status" [class]="statusClass(r.statusCode)" aria-hidden="true">{{ r.statusCode }}</span>
            <div class="ad__titles">
              <span class="ad__method">
                <span class="ac-method-badge" [attr.data-m]="r.method">{{ r.method }}</span>
              </span>
              <h3 class="ad__path mono-num">{{ r.path }}</h3>
              @if (r.queryString) { <span class="ad__qs mono-num">{{ r.queryString }}</span> }
            </div>
          </div>

          <!-- meta stat strip -->
          <div class="ad__metrics">
            <div class="ad__metric">
              <span class="ad__metric-n mono-num" [class.is-slow]="r.durationMs >= 500">{{ r.durationMs }}</span>
              <span class="ad__metric-l">ms</span>
            </div>
            <div class="ad__metric">
              <span class="ad__metric-n mono-num">{{ fmtBytes(r.requestBytes) }}</span>
              <span class="ad__metric-l">in</span>
            </div>
            <div class="ad__metric">
              <span class="ad__metric-n mono-num">{{ fmtBytes(r.responseBytes) }}</span>
              <span class="ad__metric-l">out</span>
            </div>
          </div>

          <dl class="ad__rows">
            <div class="ad__rowi"><dt>When</dt><dd class="mono-num">{{ r.whenUtc | date: 'MMM d, y HH:mm:ss' }}</dd></div>
            <div class="ad__rowi"><dt>User</dt><dd class="mono-num">{{ r.userName || '— anonymous —' }}</dd></div>
            <div class="ad__rowi"><dt>Client IP</dt><dd class="mono-num">{{ r.clientIp || '—' }}</dd></div>
          </dl>

          <div class="ad__block">
            <span class="ad__block-title"><mat-icon aria-hidden="true">south_west</mat-icon> Request body</span>
            <pre class="ad__body mono-num">{{ pretty(r.requestBody) || '— none —' }}</pre>
          </div>
          <div class="ad__block">
            <span class="ad__block-title"><mat-icon aria-hidden="true">north_east</mat-icon> Response body</span>
            <pre class="ad__body mono-num">{{ pretty(r.responseBody) || '— none —' }}</pre>
          </div>
        </div>
      }
    </app-bs-sheet>

    <app-bs-toaster />
  `,
  styleUrl: './activity-mobile.page.scss',
})
export class ActivityMobilePage {
  private api = inject(Api);
  private toast = inject(ToastController);

  readonly logs = signal<RequestLogEntry[]>([]);
  readonly loading = signal(true);
  readonly errored = signal(false);
  readonly refreshing = signal(false);

  // ---- filters (mirror the live page's filter shape) ----
  readonly method = signal('');
  readonly status = signal('');
  readonly q = signal('');

  readonly methods = ['GET', 'POST', 'PUT', 'DELETE'];

  /** Status-family segments — mirrors the live page's `statuses`, with terse mobile labels. */
  readonly statusSegments: Segment[] = [
    { key: '', label: 'All' },
    { key: '2xx', label: '2xx' },
    { key: '3xx', label: '3xx' },
    { key: '4xx', label: '4xx' },
    { key: '5xx', label: '5xx' },
  ];

  // ---- sheets ----
  readonly methodSheet = signal(false);
  readonly detailOpen = signal(false);
  readonly selected = signal<RequestLogEntry | null>(null);

  readonly skeletonCells = Array.from({ length: 7 }, (_, i) => i);

  /** Count of 4xx/5xx rows in the current page — the "errors" stat. */
  readonly errorCount = computed(() => this.logs().filter((r) => r.statusCode >= 400).length);
  /** The slowest request (ms) in the current page — a friendly tail-latency stat. */
  readonly slowestMs = computed(() =>
    this.logs().reduce((max, r) => Math.max(max, r.durationMs), 0),
  );

  readonly hasActiveFilter = computed(
    () => this.method() !== '' || this.status() !== '' || this.q().trim() !== '',
  );

  constructor() {
    void this.reload();
  }

  // ─────────────── LOAD (reuse the live Api verbatim) ───────────────

  async reload(): Promise<void> {
    const wasLoaded = !this.loading();
    if (wasLoaded) this.refreshing.set(true); else this.loading.set(true);
    this.errored.set(false);
    try {
      const rows = await firstValueFrom(
        this.api.requestLogs({
          method: this.method(),
          status: this.status(),
          q: this.q().trim(),
          take: 300,
        }),
      );
      this.logs.set(rows ?? []);
      // Keep the open detail sheet in sync with the freshly loaded row (if still present).
      const sel = this.selected();
      if (sel) {
        const next = (rows ?? []).find((r) => r.id === sel.id);
        this.selected.set(next ?? sel);
      }
    } catch {
      this.errored.set(true);
    } finally {
      this.loading.set(false);
      if (wasLoaded) {
        this.refreshing.set(false);
        this.toast.show('Activity refreshed', { tone: 'success', durationMs: 1600 });
      }
    }
  }

  // ─────────────── FILTERS ───────────────

  setStatus(key: string): void {
    if (this.status() === key) return;
    this.status.set(key);
    void this.reload();
  }

  pickMethod(m: string): void {
    this.methodSheet.set(false);
    if (this.method() === m) return;
    this.method.set(m);
    void this.reload();
  }

  clearSearch(): void {
    if (!this.q()) return;
    this.q.set('');
    void this.reload();
  }

  clearFilters(): void {
    this.method.set('');
    this.status.set('');
    this.q.set('');
    void this.reload();
  }

  // ─────────────── DETAIL ───────────────

  openDetail(r: RequestLogEntry): void {
    this.selected.set(r);
    this.detailOpen.set(true);
  }

  cardAria(r: RequestLogEntry): string {
    return `${r.method} ${r.path}, status ${r.statusCode}, ${r.durationMs} milliseconds`
      + `${r.userName ? ', by ' + r.userName : ''}. Open detail.`;
  }

  // ─────────────── helpers (mirrored from the live logs.ts) ───────────────

  statusClass(code: number): string {
    if (code >= 500) return 'st-5xx';
    if (code >= 400) return 'st-4xx';
    if (code >= 300) return 'st-3xx';
    return 'st-2xx';
  }

  fmtBytes(n: number | null): string {
    if (n == null) return '—';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  /** Pretty-print a JSON body for display; fall back to the raw string. */
  pretty(body: string | null): string {
    if (!body) return '';
    try {
      return JSON.stringify(JSON.parse(body), null, 2);
    } catch {
      return body;
    }
  }
}
