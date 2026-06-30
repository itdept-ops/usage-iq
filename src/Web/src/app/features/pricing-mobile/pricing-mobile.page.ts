import {
  ChangeDetectionStrategy, Component, computed, inject, signal,
} from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { MatIconModule } from '@angular/material/icon';

import { Api } from '../../core/api';
import { AuthService } from '../../core/auth';
import { Pricing as PricingRow, PERM } from '../../core/models';
import {
  BetaPullRefresh, BetaSkeleton, BetaToaster, ToastController,
} from '../beta-ui';

/** One editable rate field's static copy — drives the per-card grid of number inputs. */
interface RateField {
  readonly key: 'inputPerMTok' | 'outputPerMTok' | 'cacheWrite5mPerMTok'
    | 'cacheWrite1hPerMTok' | 'cacheReadPerMTok';
  readonly label: string;
  readonly icon: string;
}

/**
 * Model Pricing — the MOBILE twin of the live `/pricing` page, rebuilt on the shared beta-ui "Strata"
 * kit (`@use '../beta-ui/beta-kit'`) with a signature AMBER → CYAN accent (a "rates / config" hue). It is
 * an immersive scrolling column: an accent-bloom header with a tiny stat strip (model count + how many
 * are placeholders), then one glassy editable CARD per model — a display-name field plus a 5-up grid of
 * "per 1M tokens" rate inputs (input / output / cache-write-5m / cache-write-1h / cache-read) — each card
 * carrying its OWN per-row Save. A sticky bottom action bar (above the tab bar) commits a global Recompute.
 *
 * DATA PARITY: rows come from the SAME {@link Api.pricing} (GET /api/pricing) the live page uses; per-card
 * saves go through {@link Api.updatePricing} (PUT /api/pricing/:id) VERBATIM, and the Recompute action calls
 * {@link Api.recompute} (POST /api/pricing/recompute) — re-pricing existing usage rows. Rates are sanitized
 * client-side exactly like the live page (NaN/negative → 0) so a stray '-5' can't corrupt the recompute, and
 * the server stays the source of truth. Editing is gated by the SAME `pricing.manage` permission: without it
 * the cards are read-only (no Save) and the Recompute bar is hidden.
 *
 * ISOLATION: gated by `platform.mobile` on the SAME `/pricing` route. Imports only the kit + the shared
 * Api/auth/models the live page already uses; no live page is imported or modified. Mobile-first 44px+
 * targets, skeleton loaders, and elevated empty/error states; the harness mocks the API so it renders
 * cleanly with ZERO rows.
 */
@Component({
  selector: 'app-pricing-mobile',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [ToastController],
  imports: [
    MatIconModule,
    BetaPullRefresh, BetaSkeleton, BetaToaster,
  ],
  template: `
    <app-bs-pull-refresh class="pr-ptr" [busy]="refreshing()" (refresh)="reload()">
      <div class="pr-scroll" aria-live="polite">

        <!-- ─── IMMERSIVE HEADER: title + a tiny stat strip ─── -->
        <header class="pr-hero">
          <p class="pr-hero__kicker">
            <mat-icon aria-hidden="true">payments</mat-icon> Rate config
          </p>
          <h1 class="pr-hero__title">Model pricing</h1>
          <p class="pr-hero__sub">Edit <strong>USD per 1M token</strong> rates; Recompute re-prices existing usage rows.</p>

          @if (!loading() && !loadError()) {
            <div class="pr-stats">
              <div class="pr-stat">
                <span class="pr-stat__n mono-num">{{ rows().length }}</span>
                <span class="pr-stat__l">{{ rows().length === 1 ? 'model' : 'models' }}</span>
              </div>
              <div class="pr-stat">
                <span class="pr-stat__n mono-num">{{ placeholderCount() }}</span>
                <span class="pr-stat__l">placeholder{{ placeholderCount() === 1 ? '' : 's' }}</span>
              </div>
              @if (!canManage()) {
                <div class="pr-stat pr-stat--ro">
                  <mat-icon aria-hidden="true">lock</mat-icon>
                  <span class="pr-stat__l">read-only</span>
                </div>
              }
            </div>
          }
        </header>

        @if (loading()) {
          <!-- skeleton cards -->
          @for (s of [1,2,3]; track s) {
            <div class="pr-card" aria-hidden="true">
              <app-bs-skeleton width="58%" height="18px" radius="var(--r-pill)" />
              <app-bs-skeleton height="48px" radius="var(--r-pill)" />
              <div class="pr-skel-grid">
                <app-bs-skeleton height="56px" radius="var(--r-card)" />
                <app-bs-skeleton height="56px" radius="var(--r-card)" />
                <app-bs-skeleton height="56px" radius="var(--r-card)" />
                <app-bs-skeleton height="56px" radius="var(--r-card)" />
              </div>
            </div>
          }

        } @else if (loadError()) {
          <div class="pr-state">
            <span class="pr-state__orb"><mat-icon aria-hidden="true">error_outline</mat-icon></span>
            <h2 class="pr-state__title">Couldn't load pricing</h2>
            <p class="pr-state__body">We couldn't reach the rate config. Give it another go.</p>
            <button type="button" class="pr-state__cta" (click)="reload()">
              <mat-icon aria-hidden="true">refresh</mat-icon> Try again
            </button>
          </div>

        } @else if (rows().length === 0) {
          <div class="pr-state">
            <span class="pr-state__orb pr-state__orb--calm"><mat-icon aria-hidden="true">price_change</mat-icon></span>
            <h2 class="pr-state__title">No pricing rows yet</h2>
            <p class="pr-state__body">Model rates will appear here once they've been configured.</p>
          </div>

        } @else {
          @for (row of rows(); track row.id) {
            <section class="pr-card" [class.is-placeholder]="row.isPlaceholder">
              <div class="pr-card__accent" aria-hidden="true"></div>

              <!-- card head: the model pattern + placeholder badge -->
              <div class="pr-card__head">
                <div class="pr-card__title">
                  <span class="pr-card__dot" aria-hidden="true"></span>
                  <code class="pr-pattern mono-num">{{ row.modelPattern }}</code>
                </div>
                @if (row.isPlaceholder) { <span class="pr-badge">placeholder</span> }
              </div>

              <!-- display name -->
              <label class="pr-field">
                <span class="pr-field__label">Display name</span>
                <input class="pr-field__input" type="text" inputmode="text"
                       autocomplete="off" maxlength="120"
                       [disabled]="!canManage()"
                       [value]="row.displayName ?? ''"
                       (input)="onName(row, $event)"
                       placeholder="e.g. Claude Opus 4.8"
                       [attr.aria-label]="'Display name for ' + row.modelPattern" />
              </label>

              <!-- rate grid: per 1M tokens -->
              <div class="pr-rates-label">Rates · per 1M tokens (USD)</div>
              <div class="pr-rates">
                @for (f of rateFields; track f.key) {
                  <label class="pr-rate">
                    <span class="pr-rate__label">
                      <mat-icon aria-hidden="true">{{ f.icon }}</mat-icon> {{ f.label }}
                    </span>
                    <span class="pr-rate__inputwrap">
                      <span class="pr-rate__pre" aria-hidden="true">$</span>
                      <input class="pr-rate__input mono-num" type="number"
                             inputmode="decimal" min="0" step="0.01"
                             [disabled]="!canManage()"
                             [value]="row[f.key]"
                             (input)="onRate(row, f.key, $event)"
                             [attr.aria-label]="f.label + ' rate per million tokens for ' + row.modelPattern" />
                      <span class="pr-rate__suf" aria-hidden="true">/M</span>
                    </span>
                  </label>
                }
              </div>

              <!-- per-card save (gated) -->
              @if (canManage()) {
                <button type="button" class="pr-save"
                        [disabled]="savingId() === row.id"
                        (click)="save(row)">
                  @if (savingId() === row.id) {
                    <mat-icon class="pr-spin" aria-hidden="true">progress_activity</mat-icon> Saving…
                  } @else {
                    <mat-icon aria-hidden="true">save</mat-icon> Save {{ row.modelPattern }}
                  }
                </button>
              }
            </section>
          }

          <p class="pr-foot" aria-hidden="true">
            Lookup is exact → longest-prefix → <code>*</code>. The server stays the source of truth.
          </p>

          @if (canManage()) {
            <!-- spacer so content clears the sticky action bar -->
            <div class="pr-actionbar-spacer" aria-hidden="true"></div>
          }
        }
      </div>
    </app-bs-pull-refresh>

    <!-- ─── STICKY RECOMPUTE BAR — docked above the tab bar (gated) ─── -->
    @if (canManage() && !loading() && !loadError()) {
      <div class="pr-actionbar">
        <span class="pr-actionbar__hint">Re-price existing usage rows from the saved rates.</span>
        <button type="button" class="pr-actionbar__btn"
                [disabled]="recomputing()" (click)="recompute()">
          @if (recomputing()) {
            <mat-icon class="pr-spin" aria-hidden="true">progress_activity</mat-icon> Recomputing…
          } @else {
            <mat-icon aria-hidden="true">calculate</mat-icon> Recompute
          }
        </button>
      </div>
    }

    <app-bs-toaster />
  `,
  styleUrl: './pricing-mobile.page.scss',
})
export class PricingMobilePage {
  private api = inject(Api);
  private toast = inject(ToastController);
  readonly auth = inject(AuthService);

  readonly loading = signal(true);
  readonly loadError = signal(false);
  readonly refreshing = signal(false);
  readonly savingId = signal<number | null>(null);
  readonly recomputing = signal(false);

  readonly rows = signal<PricingRow[]>([]);

  /** Whether the caller may edit + recompute (mirrors the live page's PERM.pricingManage gate). */
  readonly canManage = computed(() => this.auth.hasPermission(PERM.pricingManage));

  readonly placeholderCount = computed(() => this.rows().filter(r => r.isPlaceholder).length);

  /** The 5 editable per-1M-token rate fields, in the same order as the live page. */
  readonly rateFields: readonly RateField[] = [
    { key: 'inputPerMTok', label: 'Input', icon: 'login' },
    { key: 'outputPerMTok', label: 'Output', icon: 'logout' },
    { key: 'cacheWrite5mPerMTok', label: 'Cache write 5m', icon: 'bolt' },
    { key: 'cacheWrite1hPerMTok', label: 'Cache write 1h', icon: 'schedule' },
    { key: 'cacheReadPerMTok', label: 'Cache read', icon: 'cached' },
  ];

  constructor() {
    this.reload();
  }

  // ─────────────── LOAD ───────────────

  async reload(): Promise<void> {
    const wasLoaded = this.rows().length > 0 || !this.loading();
    if (wasLoaded && !this.loading()) this.refreshing.set(true); else this.loading.set(true);
    this.loadError.set(false);
    try {
      const r = await firstValueFrom(this.api.pricing());
      this.rows.set(r);
    } catch {
      this.loadError.set(true);
    } finally {
      this.loading.set(false);
      this.refreshing.set(false);
    }
  }

  // ─────────────── EDITS (mutate the row in place; @for tracks by id) ───────────────

  onName(row: PricingRow, e: Event): void {
    row.displayName = (e.target as HTMLInputElement).value;
  }

  onRate(row: PricingRow, key: RateField['key'], e: Event): void {
    // Keep the raw numeric value; final NaN/negative coercion happens in save() (matches live).
    row[key] = (e.target as HTMLInputElement).valueAsNumber;
  }

  /** Coerce NaN/negative rates to 0 so a stray '-5' can't persist and corrupt cost recompute (live parity). */
  private sanitizeRates(row: PricingRow): void {
    for (const f of this.rateFields) {
      const n = Number(row[f.key]);
      row[f.key] = Number.isFinite(n) && n > 0 ? n : 0;
    }
  }

  // ─────────────── SAVE (per card) ───────────────

  save(row: PricingRow): void {
    if (this.savingId() !== null) return;
    this.sanitizeRates(row);
    this.savingId.set(row.id);
    this.api.updatePricing(row.id, row).subscribe({
      next: (saved) => {
        // Reflect the server's truth back into the row (e.g. coerced rates).
        this.rows.update(list => list.map(r => (r.id === saved.id ? saved : r)));
        this.savingId.set(null);
        this.toast.show(`Saved ${saved.modelPattern}`, { tone: 'success', durationMs: 2400 });
      },
      error: () => {
        this.savingId.set(null);
        this.toast.show('Save failed — try again.', { tone: 'warn' });
      },
    });
  }

  // ─────────────── RECOMPUTE (global) ───────────────

  recompute(): void {
    if (this.recomputing()) return;
    this.recomputing.set(true);
    this.api.recompute().subscribe({
      next: (r) => {
        this.recomputing.set(false);
        this.toast.show(
          `Recomputed ${r.rowsUpdated.toLocaleString()} rows across ${r.modelsUpdated} models.`,
          { tone: 'success', durationMs: 5000 },
        );
      },
      error: () => {
        this.recomputing.set(false);
        this.toast.show('Recompute failed — try again.', { tone: 'warn' });
      },
    });
  }
}
