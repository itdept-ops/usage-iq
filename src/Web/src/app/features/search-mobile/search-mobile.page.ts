import {
  ChangeDetectionStrategy, Component, computed, inject, signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { firstValueFrom } from 'rxjs';

import { Api } from '../../core/api';
import { SearchResultItem } from '../../core/models';
import { SEARCH_DOMAINS, SearchDomainMeta, metaFor } from '../../core/search-meta';
import { BetaSkeleton } from '../beta-ui';

/** A rendered section: a domain's meta + its hits. */
interface ResultGroup {
  meta: SearchDomainMeta;
  items: SearchResultItem[];
}

const MIN_QUERY = 2;
const DEBOUNCE_MS = 250;

/**
 * "Search" — the mobile-first twin of the live /search Tool, rebuilt on the shared beta-ui "Strata" kit
 * (`@use '../beta-ui/beta-kit'`). One signature accent — INDIGO → VIOLET — re-skins the whole screen via
 * the per-page accent contract.
 *
 * One box across every domain the caller can see via {@link Api.search}: a big sticky search field, a
 * horizontally-scrolling row of filter chips (with per-domain counts), and results grouped by domain — each
 * row a 44px+ tap target that deep-links into the page that owns it. Keyword-first + debounced (≥2 chars).
 * The query seeds from `?q=` so a deep link / the ⌘K palette can pre-fill it.
 *
 * DATA PARITY: the SAME /api/search the live page uses; this page holds no privileged data — it only renders
 * what the server returned (already permission-scoped per domain; people via display name + id, never email;
 * sensitive fields excluded/redacted upstream). ISOLATION: gated by `platform.mobile` + the SAME search.use
 * the live route carries; consumes only the kit + the shared Api/models. No live page is imported/modified.
 * Degrades gracefully — a skeleton while loading, an intro state, an empty state, a retry-able error state
 * (the screenshot harness mocks the API → empty data renders cleanly).
 */
@Component({
  selector: 'app-search-mobile',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './search-mobile.page.scss',
  imports: [FormsModule, MatIconModule, BetaSkeleton],
  template: `
    <div class="sm-scroll" aria-live="polite">

      <!-- ─── STICKY SEARCH HEADER ─── -->
      <header class="sm-head">
        <div class="sm-head__bloom" aria-hidden="true"></div>
        <h1 class="sm-head__title">Search</h1>
        <form class="sm-box" (submit)="submit(); $event.preventDefault()" role="search">
          <mat-icon class="sm-box__ic" aria-hidden="true">search</mat-icon>
          <input class="sm-box__input" type="search" name="q" [value]="query()"
                 (input)="onInput($any($event.target).value)"
                 placeholder="Search your life…" autocomplete="off" autocapitalize="off"
                 autocorrect="off" spellcheck="false" aria-label="Search everything" />
          @if (loading()) { <span class="sm-box__spin" aria-label="Searching"></span> }
          @else if (query()) {
            <button type="button" class="sm-box__clear" (click)="clear()" aria-label="Clear search">
              <mat-icon aria-hidden="true">close</mat-icon>
            </button>
          }
        </form>

        <!-- ─── FILTER CHIPS (horizontal scroll) ─── -->
        @if (searched() && chips().length) {
          <div class="sm-chips" role="group" aria-label="Filter by type">
            <button type="button" class="sm-chip" [class.is-on]="activeDomain() === null"
                    (click)="setDomain(null)">All <span class="sm-chip__n">{{ totalCount() }}</span></button>
            @for (c of chips(); track c.meta.key) {
              <button type="button" class="sm-chip" [class.is-on]="activeDomain() === c.meta.key"
                      (click)="setDomain(c.meta.key)">
                <mat-icon aria-hidden="true">{{ c.meta.icon }}</mat-icon>
                {{ c.meta.label }} <span class="sm-chip__n">{{ c.count }}</span>
              </button>
            }
          </div>
        }
      </header>

      <!-- ─── BODY ─── -->
      @if (loading() && !searched()) {
        <div class="sm-list" aria-hidden="true">
          @for (n of skeletonRows; track n) { <app-bs-skeleton height="62px" radius="var(--r-tile)" /> }
        </div>

      } @else if (errored()) {
        <div class="sm-state">
          <span class="sm-state__orb"><mat-icon aria-hidden="true">error_outline</mat-icon></span>
          <h2 class="sm-state__title">Something went wrong</h2>
          <p class="sm-state__body">We couldn't run that search. Give it another go.</p>
          <button type="button" class="sm-state__cta" (click)="submit()">
            <mat-icon aria-hidden="true">refresh</mat-icon> Try again
          </button>
        </div>

      } @else if (tooShort()) {
        <div class="sm-state">
          <span class="sm-state__orb"><mat-icon aria-hidden="true">keyboard</mat-icon></span>
          <p class="sm-state__body">Keep typing — at least 2 characters.</p>
        </div>

      } @else if (!searched()) {
        <div class="sm-state sm-state--intro">
          <span class="sm-state__orb"><mat-icon aria-hidden="true">travel_explore</mat-icon></span>
          <h2 class="sm-state__title">Search everything you can see</h2>
          <p class="sm-state__body">
            Recipes, meals, notes, lists, chores, messages, people, bills — all in one box. Health, exact
            amounts and locations are never shown here.
          </p>
          <div class="sm-domains" aria-hidden="true">
            @for (d of domains; track d.key) {
              <span class="sm-domain"><mat-icon>{{ d.icon }}</mat-icon> {{ d.label }}</span>
            }
          </div>
        </div>

      } @else if (totalCount() === 0) {
        <div class="sm-state">
          <span class="sm-state__orb"><mat-icon aria-hidden="true">search_off</mat-icon></span>
          <h2 class="sm-state__title">No matches</h2>
          <p class="sm-state__body">Nothing you can see matches “{{ query() }}”. Try a different word.</p>
        </div>

      } @else {
        @for (g of groups(); track g.meta.key) {
          <section class="sm-group">
            <div class="sm-group__head">
              <mat-icon class="sm-group__ic" aria-hidden="true">{{ g.meta.icon }}</mat-icon>
              <h2 class="sm-group__title">{{ g.meta.label }}</h2>
              <span class="sm-group__n">{{ g.items.length }}</span>
            </div>
            <div class="sm-list">
              @for (r of g.items; track r.domain + r.id) {
                <button type="button" class="sm-row" (click)="open(r)">
                  <mat-icon class="sm-row__ic" aria-hidden="true">{{ g.meta.icon }}</mat-icon>
                  <span class="sm-row__main">
                    <span class="sm-row__title">{{ r.title }}</span>
                    @if (r.snippet) { <span class="sm-row__snippet">{{ r.snippet }}</span> }
                    @if (r.subtitle) { <span class="sm-row__subtitle">{{ r.subtitle }}</span> }
                  </span>
                  <mat-icon class="sm-row__go" aria-hidden="true">chevron_right</mat-icon>
                </button>
              }
            </div>
          </section>
        }
        @if (truncated()) {
          <p class="sm-more"><mat-icon aria-hidden="true">more_horiz</mat-icon> Refine your search to see more.</p>
        }
      }
    </div>
  `,
})
export class SearchMobilePage {
  private api = inject(Api);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  readonly domains = SEARCH_DOMAINS;
  readonly skeletonRows = Array.from({ length: 6 }, (_, i) => i);

  readonly query = signal('');
  private readonly ranQuery = signal('');
  readonly activeDomain = signal<string | null>(null);

  readonly results = signal<SearchResultItem[]>([]);
  readonly countsByDomain = signal<Record<string, number>>({});
  readonly truncated = signal(false);
  readonly loading = signal(false);
  readonly errored = signal(false);

  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private runSeq = 0;

  readonly searched = computed(() => this.ranQuery().length >= MIN_QUERY);
  readonly tooShort = computed(() => {
    const q = this.query().trim();
    return q.length > 0 && q.length < MIN_QUERY;
  });

  private readonly filtered = computed<SearchResultItem[]>(() => {
    const dom = this.activeDomain();
    const all = this.results();
    return dom ? all.filter((r) => r.domain === dom) : all;
  });

  readonly totalCount = computed(() => this.results().length);

  readonly groups = computed<ResultGroup[]>(() => {
    const byDomain = new Map<string, SearchResultItem[]>();
    for (const r of this.filtered()) {
      (byDomain.get(r.domain) ?? byDomain.set(r.domain, []).get(r.domain)!).push(r);
    }
    const out: ResultGroup[] = [];
    for (const meta of SEARCH_DOMAINS) {
      const items = byDomain.get(meta.key);
      if (items?.length) out.push({ meta, items });
    }
    for (const [key, items] of byDomain) {
      if (!SEARCH_DOMAINS.some((d) => d.key === key)) out.push({ meta: metaFor(key), items });
    }
    return out;
  });

  readonly chips = computed<{ meta: SearchDomainMeta; count: number }[]>(() => {
    const counts = this.countsByDomain();
    return SEARCH_DOMAINS
      .filter((d) => (counts[d.key] ?? 0) > 0)
      .map((d) => ({ meta: d, count: counts[d.key] }));
  });

  constructor() {
    const seed = (this.route.snapshot.queryParamMap.get('q') ?? '').trim();
    if (seed) {
      this.query.set(seed);
      void this.run(seed);
    }
  }

  onInput(value: string): void {
    this.query.set(value);
    const q = value.trim();
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (q.length < MIN_QUERY) {
      this.results.set([]);
      this.countsByDomain.set({});
      this.ranQuery.set('');
      this.loading.set(false);
      return;
    }
    this.loading.set(true);
    this.debounceTimer = setTimeout(() => void this.run(q), DEBOUNCE_MS);
  }

  submit(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    const q = this.query().trim();
    if (q.length >= MIN_QUERY) void this.run(q);
  }

  clear(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.query.set('');
    this.ranQuery.set('');
    this.results.set([]);
    this.countsByDomain.set({});
    this.activeDomain.set(null);
    this.loading.set(false);
  }

  private async run(q: string): Promise<void> {
    const seq = ++this.runSeq;
    this.loading.set(true);
    this.errored.set(false);
    try {
      const res = await firstValueFrom(this.api.search(q));
      if (seq !== this.runSeq) return;
      this.results.set(res.results);
      this.countsByDomain.set(res.countsByDomain);
      this.truncated.set(res.truncated);
      this.ranQuery.set(q);
      if (this.activeDomain() && !(res.countsByDomain[this.activeDomain()!] > 0)) {
        this.activeDomain.set(null);
      }
    } catch {
      if (seq !== this.runSeq) return;
      this.errored.set(true);
      this.results.set([]);
      this.countsByDomain.set({});
    } finally {
      if (seq === this.runSeq) this.loading.set(false);
    }
  }

  setDomain(key: string | null): void {
    this.activeDomain.set(this.activeDomain() === key ? null : key);
  }

  open(item: SearchResultItem): void {
    void this.router.navigateByUrl(item.deepLink);
  }
}
