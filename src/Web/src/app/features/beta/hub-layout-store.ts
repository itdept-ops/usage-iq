import { Injectable, computed, signal } from '@angular/core';

import { BETA_EXPERIMENTS } from './beta-experiments';

/**
 * The factory-default tile order = the {@link BETA_EXPERIMENTS} declaration order. The persisted id is the
 * stable `route` STRING (not an array index), so reordering the source list in code never corrupts a saved
 * layout: unknown/removed routes are dropped on read, and newly-shipped beta pages append at the bottom.
 */
const DEFAULT_ORDER: readonly string[] = BETA_EXPERIMENTS.map(x => x.route);

interface PersistedHubLayout {
  /** The user's tile order (filtered to known routes on read; new defaults appended). */
  order: string[];
  /** Routes the user explicitly turned OFF. Default-on; absence means on. */
  hidden: string[];
}

const STORAGE_KEY = 'beta.hub.layout';

/**
 * Persists the Beta-hub tile ORDER + on/off state to localStorage under `beta.hub.layout`, and owns the
 * "customize" (reorder) mode. Modeled 1:1 on the Atrium {@link AtriumLayoutStore} but keyed by route
 * string instead of a fixed widget-id union, since the hub's tile set is data-driven.
 *
 * NOT `providedIn: 'root'` — the hub page provides it, so the layout lives and dies with the page and
 * never leaks elsewhere. Every storage read/write is wrapped: a private-mode / quota / corrupt-JSON
 * failure silently falls back to the in-memory defaults (a broken storage layer must never blank the hub).
 *
 * GATING IS NOT THIS STORE'S JOB: it tracks order/hidden for ALL known routes; the page applies the
 * per-tile permission gate when it renders. So an ungated route simply never appears, while its slot in
 * the saved order is preserved for if/when the permission is later granted.
 */
@Injectable()
export class HubLayoutStore {
  /** Current tile order (a permutation of the known routes, with new routes appended). */
  readonly order = signal<string[]>(DEFAULT_ORDER.slice());

  /** The set of routes the user turned off. */
  readonly hidden = signal<Set<string>>(new Set<string>());

  /** True while the "customize" UI is active (drag handles + hide + the hidden tray). */
  readonly reordering = signal(false);

  constructor() {
    this.restore();
  }

  /** Is a tile enabled (visible) per the saved layout? Default-on. */
  isOn(route: string): boolean {
    return !this.hidden().has(route);
  }

  /** The ordered, enabled route ids (still subject to the page's permission gate at render). */
  readonly visibleOrder = computed<string[]>(() => {
    const hidden = this.hidden();
    return this.order().filter(r => !hidden.has(r));
  });

  toggleReorder(): void {
    this.reordering.update(v => !v);
  }

  setReorder(on: boolean): void {
    this.reordering.set(on);
  }

  /**
   * Apply a reorder expressed over the currently-SHOWN routes (what the grid renders) back onto the full
   * order, leaving hidden/ungated routes pinned in their absolute slots. `shownRoutes` is the grid's order
   * at drag-start; `prevIndex`/`curIndex` are the drag's from/to within that shown list.
   */
  reorderShown(shownRoutes: readonly string[], prevIndex: number, curIndex: number): void {
    if (prevIndex === curIndex) return;
    if (prevIndex < 0 || curIndex < 0 || prevIndex >= shownRoutes.length || curIndex >= shownRoutes.length) return;
    const newShown = shownRoutes.slice();
    const [moved] = newShown.splice(prevIndex, 1);
    newShown.splice(curIndex, 0, moved);
    const shownSet = new Set(shownRoutes);
    let k = 0;
    // Walk the full order; each "shown" slot takes the next route from the reordered shown list, while
    // non-shown (hidden/ungated) routes stay exactly where they are.
    const rebuilt = this.order().map(r => (shownSet.has(r) ? newShown[k++] : r));
    this.order.set(rebuilt);
    this.persist();
  }

  /** Nudge a shown route one slot earlier/later within the shown sequence (a11y / no-drag fallback). */
  nudge(shownRoutes: readonly string[], route: string, delta: -1 | 1): void {
    const i = shownRoutes.indexOf(route);
    if (i < 0) return;
    this.reorderShown(shownRoutes, i, i + delta);
  }

  /** Turn a tile on/off. Hiding every tile is allowed (the page shows its own re-add affordance). */
  toggle(route: string): void {
    this.hidden.update(prev => {
      const next = new Set(prev);
      if (next.has(route)) next.delete(route); else next.add(route);
      return next;
    });
    this.persist();
  }

  /** Reset to the factory order + all-on, and persist. */
  reset(): void {
    this.order.set(DEFAULT_ORDER.slice());
    this.hidden.set(new Set<string>());
    this.persist();
  }

  /** Best-effort load; any failure leaves the in-memory defaults intact. */
  private restore(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<PersistedHubLayout> | null;
      if (!parsed) return;
      const known = new Set<string>(DEFAULT_ORDER);
      // Keep known routes only, AND de-duplicate (first-seen wins): a hand-edited / double-persisted save
      // with a route twice would otherwise put two tiles with the same `route` into the grid, tripping
      // Angular's `track t.route` (NG0955 duplicate keys → blank page) and desyncing reorderShown().
      const seen = new Set<string>();
      const savedOrder = (parsed.order ?? []).filter(r => known.has(r) && !seen.has(r) && (seen.add(r), true));
      // Append any defaults the save didn't know about, so a newly-shipped page appears (at the bottom)
      // rather than vanishing.
      const merged = [...savedOrder, ...DEFAULT_ORDER.filter(r => !savedOrder.includes(r))];
      this.order.set(merged);
      const hidden = (parsed.hidden ?? []).filter(r => known.has(r));
      this.hidden.set(new Set(hidden));
    } catch {
      // corrupt JSON / blocked storage — keep defaults
    }
  }

  private persist(): void {
    try {
      const payload: PersistedHubLayout = { order: this.order(), hidden: [...this.hidden()] };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // quota / private mode — non-fatal, layout just won't survive a reload
    }
  }
}
