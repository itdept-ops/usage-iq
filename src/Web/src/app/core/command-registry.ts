import { PAGE_REGISTRY, PageDef } from './page-registry';
import { PERM } from './models';

/**
 * One palette command. NAV commands carry the SAME any-of `perm` set as their route guard, so the palette
 * never offers a page the guard would bounce. Commands with no `perm` are auth-only (e.g. Profile, Sign out).
 * `run` is wired by the component to the concrete effect (router navigation, openQuickAdd, logout, …).
 */
export interface CommandDef {
  /** Stable id (also the recent-commands key). */
  id: string;
  label: string;
  group: 'Go to' | 'Actions' | 'Account';
  /** mat-icon ligature name. */
  icon: string;
  /** Extra search terms so e.g. "log water" finds the Tracker command. */
  keywords?: readonly string[];
  /** Any-of permissions that grant access; omit = auth-only. */
  perm?: string | readonly string[];
  /**
   * When true, ALL `perm` entries are required (logical AND) rather than any-of — for routes whose guard
   * STACKS multiple permission guards (e.g. a family subpage's route = family.use AND the inner perm). This
   * keeps the rule "never offer a command the guard would bounce" correct for double-gated routes.
   */
  requireAll?: boolean;
  /**
   * What the command does. For NAV commands this is a route to `navigateByUrl`; for ACTION commands the
   * component maps the `action` id to a shell method (kept declarative so the registry has no Angular deps).
   */
  route?: string;
  /** Named shell action (mapped in the component): 'quickAdd' | 'logout' | 'snap'. */
  action?: 'quickAdd' | 'logout' | 'snap';
}

/**
 * Curated extra search terms for a "Go to" command, keyed by the {@link PAGE_REGISTRY} page id. This is the ONLY
 * per-page thing the palette declares by hand — the route, label, icon, and perms are all derived from the
 * registry (see {@link navCommandsFromRegistry}) so a page can never exist in the registry yet be missing here.
 * Add a page to the registry and it appears in ⌘K automatically; add a row here only to enrich its search terms.
 */
const NAV_KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  dashboard: ['home', 'usage', 'overview'],
  pricing: ['cost', 'price', 'rates'],
  reporter: ['report'],
  fleet: ['machines', 'devices'],
  tracker: ['food', 'water', 'hydration', 'coffee', 'weight', 'exercise', 'log', 'fitness', 'calories', 'macros'],
  meds: ['medication', 'vitals', 'pills', 'blood pressure'],
  challenge: ['challenge'],
  habits: ['habit', 'streak', 'routine'],
  journal: ['diary', 'notes', 'reflect'],
  trophies: ['trophy', 'trophies', 'badges', 'achievements', 'milestones'],
  feed: ['social', 'feed', 'activity'],
  pacts: ['pact', 'commitment', 'accountability'],
  ask: ['ai', 'ask', 'question', 'assistant', 'chat', 'gemini', 'how did my week go'],
  automations: ['rules', 'triggers', 'webhook', 'discord', 'notify'],
  agents: ['agent', 'briefing', 'streak', 'budget', 'staples', 'nudge', 'schedule', 'proactive'],
  inbox: ['agent', 'inbox', 'nudge', 'suggestions'],
  bills: ['bill', 'split', 'receipt', 'expense'],
  grocery: ['grocery', 'shopping', 'list', 'staples'],
  recipes: ['recipe', 'cook', 'meals'],
  'meal-planner': ['meal', 'menu', 'dinner', 'plan'],
  resume: ['resume', 'cv', 'cover letter', 'job'],
  today: ['today', 'day', 'agenda', 'schedule'],
  wrapped: ['wrapped', 'year', 'recap', 'summary'],
  insights: ['insights', 'trends', 'analytics'],
  search: ['find', 'search', 'lookup', 'everything'],
  family: ['hub', 'household'],
  chat: ['message', 'dm'],
  people: ['contacts', 'roster'],
  users: ['admin', 'accounts', 'permissions'],
  activity: ['audit', 'log'],
  settings: ['config', 'sync'],
  'settings-health': ['wearable', 'health', 'sync', 'watch', 'fitbit', 'apple health'],
  'admin-locations': ['map', 'everyone', 'where'],
  'ai-usage': ['tokens', 'gemini', 'ai'],
};

/** The canonical absolute route for a registry page (`/` for the home page, `/` + path otherwise). */
function routeOf(p: PageDef): string {
  return p.path === '' ? '/' : '/' + p.path;
}

/**
 * Derive the "Go to" commands from {@link PAGE_REGISTRY} — one per page that carries `nav` metadata, gated by the
 * SAME perm/anyPerm its own route guard uses (so the palette never offers a page the guard would bounce). This is
 * what stops the drift the review flagged: every navigable, permissioned page is reachable via ⌘K by construction,
 * and a new registry page needs no edit here (only an optional {@link NAV_KEYWORDS} row to enrich its search terms).
 */
function navCommandsFromRegistry(): CommandDef[] {
  return PAGE_REGISTRY.filter((p) => p.nav).map((p): CommandDef => {
    const keywords = NAV_KEYWORDS[p.id];
    return {
      id: 'nav-' + p.id,
      label: p.nav!.label,
      group: 'Go to',
      icon: p.nav!.icon,
      route: routeOf(p),
      // Registry `perm` (single, AND) → any-of over one key; `anyPerm` → any-of; neither → auth-only (no perm).
      ...(p.perm ? { perm: p.perm } : p.anyPerm ? { perm: p.anyPerm } : {}),
      ...(keywords ? { keywords } : {}),
    };
  });
}

/**
 * The command catalog. The "Go to" navigation commands are DERIVED from {@link PAGE_REGISTRY} (see
 * {@link navCommandsFromRegistry}) so they can never drift from the app's real, permissioned pages. Only the
 * entries the registry can't express are hand-written: the beta-preview routes + the family subpages (which are
 * `Route` children, not top-level `PageDef`s), the deep `/locations` page (no nav entry), plus all ACTION and
 * ACCOUNT commands. Add a normal page to the registry and it appears in ⌘K automatically.
 */
export const COMMAND_DEFS: readonly CommandDef[] = [
  // ---- Go to (navigation) — derived from PAGE_REGISTRY (route/label/perms/icon), keywords from NAV_KEYWORDS ----
  ...navCommandsFromRegistry(),

  // ---- Go to — routes PAGE_REGISTRY can't express (same perm as their own guard) ----
  // Beta-preview surfaces live in app.routes.ts (not the page registry); gated by platform.mobile.
  { id: 'nav-tracker-beta', label: 'Tracker Beta', group: 'Go to', icon: 'science', route: '/tracker-beta', perm: [PERM.platformMobile], keywords: ['strata'] },
  { id: 'nav-beta', label: 'Beta', group: 'Go to', icon: 'science', route: '/beta', perm: [PERM.platformMobile], keywords: ['experimental'] },
  // /locations is a registry page but carries no nav entry, so it isn't derived above.
  { id: 'nav-locations', label: 'My locations', group: 'Go to', icon: 'place', route: '/locations', perm: [PERM.locationSelf], keywords: ['gps', 'map', 'where'] },
  // Family subpages — Route children, not PageDefs; all need family.use; the four with an extra perm require BOTH (requireAll), matching their stacked route guards.
  { id: 'nav-family-lists', label: 'Family · Lists', group: 'Go to', icon: 'checklist', route: '/family/lists', perm: [PERM.familyUse], keywords: ['grocery', 'shopping', 'todo'] },
  { id: 'nav-family-meals', label: 'Family · Meals', group: 'Go to', icon: 'restaurant', route: '/family/meals', perm: [PERM.familyUse], keywords: ['dinner', 'recipe', 'menu'] },
  { id: 'nav-family-chores', label: 'Family · Chores', group: 'Go to', icon: 'cleaning_services', route: '/family/chores', perm: [PERM.familyUse], keywords: ['tasks', 'allowance'] },
  { id: 'nav-family-calendar', label: 'Family · Calendar', group: 'Go to', icon: 'event', route: '/family/calendar', perm: [PERM.familyUse] },
  { id: 'nav-family-notes', label: 'Family · Notes', group: 'Go to', icon: 'sticky_note_2', route: '/family/notes', perm: [PERM.familyUse] },
  { id: 'nav-family-reminders', label: 'Family · Reminders', group: 'Go to', icon: 'notifications', route: '/family/reminders', perm: [PERM.familyUse] },
  { id: 'nav-family-finance', label: 'Family · Finance', group: 'Go to', icon: 'savings', route: '/family/finance', perm: [PERM.familyUse, PERM.familyFinance], requireAll: true, keywords: ['budget', 'money'] },
  { id: 'nav-family-cycle', label: 'Family · Cycle', group: 'Go to', icon: 'cycle', route: '/family/cycle', perm: [PERM.familyUse, PERM.cycleTrack], requireAll: true },
  { id: 'nav-family-identity', label: 'Family · Identity map', group: 'Go to', icon: 'donut_small', route: '/family/identity', perm: [PERM.familyUse, PERM.identityMap], requireAll: true, keywords: ['roles', 'time'] },
  { id: 'nav-family-allowance', label: 'Family · Allowance', group: 'Go to', icon: 'payments', route: '/family/allowance', perm: [PERM.familyUse, PERM.allowanceManage], requireAll: true, keywords: ['kids', 'money'] },

  // ---- Actions (one-call paths the scout confirmed safe from the shell) ----
  { id: 'act-quick-add', label: 'Quick add (list / reminder / note)', group: 'Actions', icon: 'bolt', action: 'quickAdd', perm: [PERM.familyUse], keywords: ['new', 'capture', 'add', 'q'] },
  { id: 'act-snap', label: 'Snap a photo (route it anywhere)', group: 'Actions', icon: 'photo_camera', action: 'snap', perm: [PERM.aiVision], keywords: ['snap', 'photo', 'camera', 'receipt', 'label', 'meal', 'pantry', 'schedule', 'note', 'scan', 'capture'] },
  { id: 'act-log-food', label: 'Log food', group: 'Actions', icon: 'restaurant', route: '/tracker', perm: [PERM.trackerSelf], keywords: ['eat', 'meal', 'calories', 'macros'] },
  { id: 'act-log-water', label: 'Log water / hydration', group: 'Actions', icon: 'water_drop', route: '/tracker', perm: [PERM.trackerSelf], keywords: ['drink', 'fluid', 'hydration'] },
  { id: 'act-log-coffee', label: 'Log coffee', group: 'Actions', icon: 'local_cafe', route: '/tracker', perm: [PERM.trackerSelf], keywords: ['caffeine', 'espresso'] },
  { id: 'act-new-bill', label: 'New bill / split a receipt', group: 'Actions', icon: 'receipt_long', route: '/bills', perm: [PERM.billsUse], keywords: ['split', 'expense', 'receipt'] },

  // ---- Account (auth-only, no perm) ----
  { id: 'acct-profile', label: 'How others see me (profile)', group: 'Account', icon: 'badge', route: '/profile', keywords: ['profile', 'presence', 'nickname', 'appear offline'] },
  { id: 'acct-logout', label: 'Sign out', group: 'Account', icon: 'logout', action: 'logout', keywords: ['log out', 'exit'] },
];

/**
 * Tiny subsequence fuzzy scorer (no dependency). Returns a positive score when every char of `query` appears
 * in `text` in order, with bonuses for consecutive runs, word-boundary hits, and a leading prefix match;
 * returns 0 (no match) otherwise. Case-insensitive. Empty query is handled by the caller (lists everything).
 */
export function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 1;

  let score = 0;
  let qi = 0;
  let prevMatch = -2;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) continue;
    let bonus = 1;
    if (ti === prevMatch + 1) bonus += 4;                          // consecutive run
    if (ti === 0) bonus += 6;                                       // prefix
    else if (/[\s/·.\-]/.test(t[ti - 1])) bonus += 3;               // word boundary
    score += bonus;
    prevMatch = ti;
    qi++;
  }
  return qi === q.length ? score : 0;
}

/**
 * Best fuzzy score of `query` over a command's label + keywords (keywords score slightly lower so a label
 * hit always wins a tie). 0 means the command should be filtered out for that query.
 */
export function scoreCommand(query: string, label: string, keywords?: readonly string[]): number {
  if (!query) return 1;
  let best = fuzzyScore(query, label);
  for (const k of keywords ?? []) {
    best = Math.max(best, fuzzyScore(query, k) * 0.85);
  }
  return best;
}
