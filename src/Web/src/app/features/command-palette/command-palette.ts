import {
  Component,
  ElementRef,
  HostListener,
  computed,
  effect,
  inject,
  signal,
  viewChild,
  ChangeDetectionStrategy,
} from '@angular/core';
import { Router } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';

import { firstValueFrom } from 'rxjs';

import { AuthService } from '../../core/auth';
import { Api } from '../../core/api';
import { CommandPaletteService } from '../../core/command-palette';
import { COMMAND_DEFS, CommandDef, scoreCommand } from '../../core/command-registry';
import { PERM, SearchResultItem } from '../../core/models';
import { metaFor } from '../../core/search-meta';

/** A command resolved for display: the def plus its computed fuzzy score for the active query. */
interface ScoredCommand extends CommandDef {
  score: number;
}

/** One "Search your life" row in the palette (a /api/search hit + its resolved icon). */
interface SearchRow {
  item: SearchResultItem;
  icon: string;
  domainLabel: string;
}

const SEARCH_DEBOUNCE_MS = 250;
const SEARCH_MIN_QUERY = 2;

/** A rendered section: a group header + its (flat-indexed) rows, used to draw the grouped list. */
interface CommandGroup {
  name: CommandDef['group'];
  items: ScoredCommand[];
}

const RECENTS_KEY = 'usage_iq_palette_recents';
const RECENTS_MAX = 6;
const GROUP_ORDER: readonly CommandDef['group'][] = ['Actions', 'Go to', 'Account'];

/**
 * Global command palette overlay. A centered modal with a fuzzy-filtered, grouped, fully keyboard-driven
 * command list. It is permission-aware: every command is filtered by the SAME any-of permission its route
 * guard uses (via {@link AuthService.hasAnyPermission}), so a user only ever sees commands for pages they
 * can actually open. Opened/closed via {@link CommandPaletteService} (the shell binds ⌘K / Ctrl-K / "/").
 *
 * Self-contained: renders nothing unless `palette.open()` AND the caller is authenticated, so it's inert on
 * the public/bare chrome even though it's mounted once in the shell. Hand-rolled overlay (fixed, z-index
 * above the toolbar) with its own focus trap + restore + Escape, mirroring the drawer's contract.
 */
@Component({
  selector: 'app-command-palette',
  imports: [MatIconModule],
  templateUrl: './command-palette.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './command-palette.scss',
})
export class CommandPalette {
  private readonly auth = inject(AuthService);
  private readonly api = inject(Api);
  private readonly palette = inject(CommandPaletteService);
  private readonly router = inject(Router);
  private readonly host = inject(ElementRef<HTMLElement>);

  private readonly searchInput = viewChild<ElementRef<HTMLInputElement>>('search');

  /** Whether the overlay should render at all (open AND signed in — inert on bare/public chrome). */
  readonly visible = computed(() => this.palette.open() && this.auth.isAuthenticated());

  readonly query = signal('');
  /** Flat index of the highlighted row across all groups (keyboard selection). */
  readonly activeIndex = signal(0);
  /** Recent command ids (most-recent first), persisted to localStorage. */
  private readonly recents = signal<string[]>(this.restoreRecents());

  /** The element focus should return to when the palette closes (the trigger that opened it). */
  private returnFocusEl: HTMLElement | null = null;

  /** Commands the current session may actually run (same any-of perm check the guards use). Reactive to /me. */
  private readonly allowed = computed<CommandDef[]>(() => {
    this.auth.permissions(); // re-run when permissions change live
    return COMMAND_DEFS.filter((c) => {
      if (!c.perm) return this.auth.isAuthenticated();
      const keys = Array.isArray(c.perm) ? c.perm : [c.perm];
      // requireAll = the route stacks multiple guards (AND); otherwise any-of (the guard passes on any one).
      return c.requireAll
        ? keys.every((k) => this.auth.hasPermission(k))
        : this.auth.hasAnyPermission(...keys);
    });
  });

  /** Fuzzy-scored + grouped results for the active query (empty query → everything, recents floated up). */
  readonly groups = computed<CommandGroup[]>(() => {
    const q = this.query().trim();
    const recent = this.recents();
    const scored: ScoredCommand[] = this.allowed()
      .map((c) => ({ ...c, score: scoreCommand(q, c.label, c.keywords) }))
      .filter((c) => c.score > 0);

    // Within a group: by score desc; on a tie, recents first, then label. Empty query keeps catalog order
    // but still floats recents to the top of their group so the palette opens to "what you do often".
    const rank = (c: ScoredCommand) => {
      const r = recent.indexOf(c.id);
      return r === -1 ? Number.MAX_SAFE_INTEGER : r;
    };
    const out: CommandGroup[] = [];
    for (const name of GROUP_ORDER) {
      const items = scored
        .filter((c) => c.group === name)
        .sort((a, b) => b.score - a.score || rank(a) - rank(b) || a.label.localeCompare(b.label));
      if (items.length) out.push({ name, items });
    }
    return out;
  });

  /** The command rows flattened (the command portion of the keyboard cursor range). */
  private readonly flatCommands = computed<ScoredCommand[]>(() => this.groups().flatMap((g) => g.items));

  // ---- "Search your life" — a debounced /api/search section below the command matches ----

  /** Whether the caller may search at all (the `search.use` page-gate); search is hidden otherwise. */
  private readonly canSearch = computed(() => {
    this.auth.permissions();
    return this.auth.hasPermission(PERM.searchUse);
  });

  /** The /api/search hits for the active (debounced) query. Cleared on close / short query. */
  private readonly searchHits = signal<SearchResultItem[]>([]);
  /** True while a /api/search request is in flight. */
  readonly searchLoading = signal(false);
  /** The query the current `searchHits` are for (so a stale response can be ignored). */
  private readonly searchRanQuery = signal('');
  /** Monotonic token so a slower /api/search response can't overwrite a newer one. */
  private searchSeq = 0;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  /** The search rows to render (resolved icon + domain label per hit). */
  readonly searchRows = computed<SearchRow[]>(() =>
    this.searchHits().map((item) => {
      const meta = metaFor(item.domain);
      return { item, icon: meta.icon, domainLabel: meta.label };
    }),
  );

  /** Whether the "Search your life" section should render (can search + a long-enough query). */
  readonly showSearch = computed(
    () => this.canSearch() && this.query().trim().length >= SEARCH_MIN_QUERY,
  );

  /**
   * The full keyboard-navigable list: command rows first, then the search rows. The cursor (`activeIndex`)
   * indexes into THIS, so ↑/↓ flows from the last command straight into the search results and Enter runs
   * whichever kind the cursor is on.
   */
  readonly flat = computed<(ScoredCommand | SearchRow)[]>(() => {
    const cmds = this.flatCommands();
    return this.showSearch() ? [...cmds, ...this.searchRows()] : cmds;
  });

  /** The flat index at which the search rows begin (= command count), for template index mapping. */
  readonly searchOffset = computed(() => this.flatCommands().length);

  /** Type guard the template uses to tell a search row from a command row. */
  isSearchRow(row: ScoredCommand | SearchRow): row is SearchRow {
    return (row as SearchRow).item !== undefined;
  }

  /** The flat index of the first row of each group, so the template can map a row to its global index. */
  readonly groupOffsets = computed<number[]>(() => {
    const offs: number[] = [];
    let acc = 0;
    for (const g of this.groups()) {
      offs.push(acc);
      acc += g.items.length;
    }
    return offs;
  });

  readonly hasResults = computed(() => this.flat().length > 0);

  constructor() {
    // On open: reset query/cursor + clear any prior search, remember the focus origin, and move focus
    // into the search field. On close, also clear the search results so they don't flash on re-open.
    effect(() => {
      if (this.visible()) {
        this.query.set('');
        this.activeIndex.set(0);
        this.resetSearch();
        this.returnFocusEl = document.activeElement as HTMLElement | null;
        requestAnimationFrame(() => this.searchInput()?.nativeElement.focus());
      } else {
        this.resetSearch();
      }
    });
    // Keep the cursor in range whenever the result set shrinks (typing narrows the list).
    effect(() => {
      const n = this.flat().length;
      if (this.activeIndex() >= n) this.activeIndex.set(Math.max(0, n - 1));
    });
    // Lock background scroll while open so wheel/touch doesn't bleed through the scrim (esp. on mobile).
    effect(() => {
      document.body.style.overflow = this.visible() ? 'hidden' : '';
    });
  }

  onQueryInput(value: string): void {
    this.query.set(value);
    this.activeIndex.set(0);
    this.scheduleSearch(value);
  }

  /** (Re)arm the debounced /api/search for the current query (no-op when the caller can't search). */
  private scheduleSearch(value: string): void {
    if (this.searchTimer) clearTimeout(this.searchTimer);
    const q = value.trim();
    if (!this.canSearch() || q.length < SEARCH_MIN_QUERY) {
      this.searchHits.set([]);
      this.searchRanQuery.set('');
      this.searchLoading.set(false);
      return;
    }
    this.searchLoading.set(true);
    this.searchTimer = setTimeout(() => void this.runSearch(q), SEARCH_DEBOUNCE_MS);
  }

  /** Run a /api/search now; a monotonic token drops stale (slower) responses. */
  private async runSearch(q: string): Promise<void> {
    const seq = ++this.searchSeq;
    this.searchLoading.set(true);
    try {
      const res = await firstValueFrom(this.api.search(q));
      if (seq !== this.searchSeq) return;
      this.searchHits.set(res.results);
      this.searchRanQuery.set(q);
    } catch {
      if (seq !== this.searchSeq) return;
      this.searchHits.set([]);
    } finally {
      if (seq === this.searchSeq) this.searchLoading.set(false);
    }
  }

  /** Clear all "Search your life" state (on open/close + when the query drops below the threshold). */
  private resetSearch(): void {
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = null;
    this.searchSeq++;
    this.searchHits.set([]);
    this.searchRanQuery.set('');
    this.searchLoading.set(false);
  }

  /** Map a (group, local) cell to its global flat index — used for hover highlight + click run. */
  globalIndex(groupIndex: number, localIndex: number): number {
    return this.groupOffsets()[groupIndex] + localIndex;
  }

  close(): void {
    this.palette.hide();
    const el = this.returnFocusEl;
    this.returnFocusEl = null;
    // Restore focus to whatever opened the palette (trigger button / page element).
    if (el && document.contains(el)) requestAnimationFrame(() => el.focus());
  }

  /** Run the row at the given flat index (Enter or click): a search hit deep-links; a command dispatches. */
  runAt(index: number): void {
    const row = this.flat()[index];
    if (!row) return;
    this.close();
    if (this.isSearchRow(row)) {
      const link = row.item.deepLink;
      queueMicrotask(() => void this.router.navigateByUrl(link));
      return;
    }
    this.remember(row.id);
    // Defer the side-effect a tick so close()/focus-restore settle before navigation/dialog open.
    queueMicrotask(() => this.dispatch(row));
  }

  private dispatch(cmd: CommandDef): void {
    if (cmd.action === 'logout') {
      this.logoutHandler();
      return;
    }
    if (cmd.action === 'quickAdd') {
      this.quickAddHandler();
      return;
    }
    if (cmd.action === 'snap') {
      this.snapHandler();
      return;
    }
    if (cmd.route) void this.router.navigateByUrl(cmd.route);
  }

  /**
   * The two shell actions (Quick-Add + Sign out) live on the App shell. Rather than couple the palette to
   * `App`, the shell assigns these thin callbacks once at mount via the public setters below. If a host
   * never wires them, the command simply no-ops (it's still permission-gated to even appear).
   */
  private quickAddHandler: () => void = () => {};
  private logoutHandler: () => void = () => {};
  private snapHandler: () => void = () => {};
  setQuickAddHandler(fn: () => void): void {
    this.quickAddHandler = fn;
  }
  setLogoutHandler(fn: () => void): void {
    this.logoutHandler = fn;
  }
  setSnapHandler(fn: () => void): void {
    this.snapHandler = fn;
  }

  // ---- keyboard ----

  @HostListener('document:keydown', ['$event'])
  onKeydown(e: KeyboardEvent): void {
    if (!this.visible()) return;

    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        this.close();
        return;
      case 'ArrowDown':
        e.preventDefault();
        this.move(1);
        return;
      case 'ArrowUp':
        e.preventDefault();
        this.move(-1);
        return;
      case 'Enter':
        e.preventDefault();
        this.runAt(this.activeIndex());
        return;
      case 'Tab': {
        // Trap focus inside the panel (only the search input is tabbable, so just keep it focused).
        e.preventDefault();
        this.searchInput()?.nativeElement.focus();
        return;
      }
    }
  }

  /** Move the cursor by delta with wrap-around, scrolling the active row into view. */
  private move(delta: number): void {
    const n = this.flat().length;
    if (n === 0) return;
    const next = (this.activeIndex() + delta + n) % n;
    this.activeIndex.set(next);
    requestAnimationFrame(() => {
      const el = (this.host.nativeElement as HTMLElement).querySelector<HTMLElement>(
        `.cmdp__row[data-index="${next}"]`,
      );
      el?.scrollIntoView({ block: 'nearest' });
    });
  }

  /** Scrim click closes; clicks inside the panel are swallowed by the panel's own stopPropagation. */
  onScrimClick(): void {
    this.close();
  }

  private remember(id: string): void {
    const next = [id, ...this.recents().filter((r) => r !== id)].slice(0, RECENTS_MAX);
    this.recents.set(next);
    try {
      localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  }

  private restoreRecents(): string[] {
    try {
      const raw = localStorage.getItem(RECENTS_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }
}
