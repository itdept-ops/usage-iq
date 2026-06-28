/**
 * Presentation metadata for "Search Everything" domains — the single source of truth the desktop /search
 * page, its mobile twin, and the ⌘K palette's results section all key off, so a domain's label/icon/order
 * never drift between surfaces. The DOMAIN TOKENS mirror the backend `SearchEndpoints.Domains` constants
 * exactly; results carry a `domain` string that maps here (an unknown domain falls back to {@link FALLBACK_META}).
 */

/** One domain's display metadata. */
export interface SearchDomainMeta {
  /** The stable domain bucket token (matches the backend + the `domains` filter value). */
  readonly key: string;
  /** Plural human label for the section header / filter chip. */
  readonly label: string;
  /** Material Symbols ligature for the section + each row. */
  readonly icon: string;
}

/**
 * The domains in display order. Mirrors the backend `SearchEndpoints.Domains` tokens; ordering here drives
 * both the filter-chip order and the grouped-section order on the page.
 */
export const SEARCH_DOMAINS: readonly SearchDomainMeta[] = [
  { key: 'recipes', label: 'Recipes', icon: 'menu_book' },
  { key: 'family-meals', label: 'Meals', icon: 'restaurant' },
  { key: 'family-notes', label: 'Notes', icon: 'sticky_note_2' },
  { key: 'family-lists', label: 'Lists', icon: 'checklist' },
  { key: 'family-chores', label: 'Chores', icon: 'cleaning_services' },
  { key: 'chat', label: 'Messages', icon: 'forum' },
  { key: 'people', label: 'People', icon: 'groups' },
  { key: 'bills', label: 'Bills', icon: 'receipt_long' },
  { key: 'automations', label: 'Automations', icon: 'bolt' },
  { key: 'foods', label: 'Food log', icon: 'lunch_dining' },
];

/** O(1) lookup token → meta. */
export const SEARCH_DOMAIN_OF: Readonly<Record<string, SearchDomainMeta>> = Object.fromEntries(
  SEARCH_DOMAINS.map((d) => [d.key, d]),
);

/** Used when a result's domain isn't in the table (forward-compat — a new backend domain still renders). */
export const FALLBACK_META: SearchDomainMeta = { key: '', label: 'Other', icon: 'search' };

/** Meta for a domain token, never null (falls back to {@link FALLBACK_META}). */
export function metaFor(domain: string): SearchDomainMeta {
  return SEARCH_DOMAIN_OF[domain] ?? { ...FALLBACK_META, key: domain, label: domain || 'Other' };
}
