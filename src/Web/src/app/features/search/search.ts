import {
  Component, ChangeDetectionStrategy, computed, inject, signal, effect,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { firstValueFrom } from 'rxjs';

import { Api } from '../../core/api';
import { SearchResultItem } from '../../core/models';
import { SEARCH_DOMAINS, SearchDomainMeta, metaFor } from '../../core/search-meta';
import { BetaEmptyState, BetaErrorState } from '../beta-ui';

/** A rendered section: a domain's meta + its hits, in backend score order. */
interface ResultGroup {
  meta: SearchDomainMeta;
  items: SearchResultItem[];
}

const MIN_QUERY = 2;
const DEBOUNCE_MS = 250;

/**
 * "Search Everything" — the gated /search Tool (permissionGuard(search.use)). One box that queries every
 * domain the caller can see via {@link Api.search}; the server unions + permission-scopes the hits and the
 * page renders them grouped by domain with filter chips, each row deep-linking into its existing page.
 *
 * Search is keyword-first and entirely server-scoped — this page never holds privileged data; it only ever
 * renders what /api/search returned (already re-gated per domain server-side; people via display name + id,
 * never an email; sensitive fields excluded/redacted upstream). The query seeds from `?q=` (so the ⌘K
 * palette + nav can deep-link a search), is debounced, and requires ≥2 chars. Themed with --tech-* tokens.
 */
@Component({
  selector: 'app-search',
  imports: [FormsModule, MatIconModule, BetaEmptyState, BetaErrorState],
  templateUrl: './search.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './search.scss',
})
export class Search {
  private api = inject(Api);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  /** The order/labels/icons of every searchable domain (drives the chips + section order). */
  readonly domains = SEARCH_DOMAINS;

  /** The live query (bound to the input). */
  readonly query = signal('');
  /** The query the currently-shown results are for (so we know when the box is "ahead" of results). */
  private readonly ranQuery = signal('');

  /** The active domain filter token, or null = all domains. */
  readonly activeDomain = signal<string | null>(null);

  readonly results = signal<SearchResultItem[]>([]);
  readonly countsByDomain = signal<Record<string, number>>({});
  readonly truncated = signal(false);

  readonly loading = signal(false);
  readonly errored = signal(false);

  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  /** Monotonic token so a stale (slower) response can't overwrite a newer one. */
  private runSeq = 0;

  /** True once the user has typed enough to have searched (vs. the pristine intro state). */
  readonly searched = computed(() => this.ranQuery().length >= MIN_QUERY);
  readonly tooShort = computed(() => {
    const q = this.query().trim();
    return q.length > 0 && q.length < MIN_QUERY;
  });

  /** The results to show, after the active-domain filter. */
  private readonly filtered = computed<SearchResultItem[]>(() => {
    const dom = this.activeDomain();
    const all = this.results();
    return dom ? all.filter((r) => r.domain === dom) : all;
  });

  readonly totalCount = computed(() => this.results().length);

  /** Results grouped by domain in the canonical {@link SEARCH_DOMAINS} order. */
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
    // Any domain not in the canonical list (forward-compat) appended after.
    for (const [key, items] of byDomain) {
      if (!SEARCH_DOMAINS.some((d) => d.key === key)) out.push({ meta: metaFor(key), items });
    }
    return out;
  });

  /** The chips to render: every domain that returned at least one hit, with its count. */
  readonly chips = computed<{ meta: SearchDomainMeta; count: number }[]>(() => {
    const counts = this.countsByDomain();
    return SEARCH_DOMAINS
      .filter((d) => (counts[d.key] ?? 0) > 0)
      .map((d) => ({ meta: d, count: counts[d.key] }));
  });

  constructor() {
    // Seed the query from ?q= on entry (so ⌘K / a deep link can pre-fill a search).
    const seed = (this.route.snapshot.queryParamMap.get('q') ?? '').trim();
    if (seed) {
      this.query.set(seed);
      void this.run(seed);
    }

    // Mirror the (debounced) live query into the URL's ?q= so a search is shareable/back-nav friendly,
    // without pushing history on every keystroke.
    effect(() => {
      const q = this.ranQuery();
      void this.router.navigate([], {
        relativeTo: this.route,
        queryParams: q ? { q } : {},
        replaceUrl: true,
      });
    });
  }

  /** Input handler: update the box + (re)arm the debounce. */
  onInput(value: string): void {
    this.query.set(value);
    const q = value.trim();
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (q.length < MIN_QUERY) {
      // Clear results the moment the box drops below the threshold (no stale hits lingering).
      this.results.set([]);
      this.countsByDomain.set({});
      this.ranQuery.set('');
      this.loading.set(false);
      return;
    }
    this.loading.set(true);
    this.debounceTimer = setTimeout(() => void this.run(q), DEBOUNCE_MS);
  }

  /** Run a search now (Enter bypasses the debounce). */
  submit(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    const q = this.query().trim();
    if (q.length >= MIN_QUERY) void this.run(q);
  }

  private async run(q: string): Promise<void> {
    const seq = ++this.runSeq;
    this.loading.set(true);
    this.errored.set(false);
    try {
      const res = await firstValueFrom(this.api.search(q));
      if (seq !== this.runSeq) return; // a newer search superseded this one
      this.results.set(res.results);
      this.countsByDomain.set(res.countsByDomain);
      this.truncated.set(res.truncated);
      this.ranQuery.set(q);
      // Drop a stale active filter if that domain returned nothing this time.
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

  /** Navigate to a result's deep link (the existing page that owns it). */
  open(item: SearchResultItem): void {
    void this.router.navigateByUrl(item.deepLink);
  }

  /** A short relative-ish label for a result's timestamp (or '' when none). */
  whenLabel(iso: string | null): string {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
}
