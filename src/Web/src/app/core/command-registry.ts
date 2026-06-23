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
  /** Named shell action (mapped in the component): 'quickAdd' | 'logout' | 'profile'. */
  action?: 'quickAdd' | 'logout';
}

/**
 * The static command catalog. NAV entries are a SUPERSET of the shell's `homeOptionDefs` (same route + any-of
 * perms, with icons mirrored from the nav menus) PLUS the reachable routes that map omits — Profile,
 * admin Locations, AI usage, and the family subpages — each gated by the SAME perm its own guard uses.
 * Edit THIS list to add/remove a command; the component filters it by `auth.hasAnyPermission(...perm)`.
 */
export const COMMAND_DEFS: readonly CommandDef[] = [
  // ---- Go to (navigation) — mirrors homeOptionDefs route/label/perms + icons from the nav ----
  { id: 'nav-dashboard', label: 'Dashboard', group: 'Go to', icon: 'dashboard', route: '/', perm: [PERM.dashboardView], keywords: ['home', 'usage', 'overview'] },
  { id: 'nav-calendar', label: 'Calendar', group: 'Go to', icon: 'calendar_month', route: '/calendar', perm: [PERM.calendarView] },
  { id: 'nav-pricing', label: 'Pricing', group: 'Go to', icon: 'payments', route: '/pricing', perm: [PERM.pricingView], keywords: ['cost', 'price', 'rates'] },
  { id: 'nav-reporter', label: 'Reporter', group: 'Go to', icon: 'summarize', route: '/reporter', perm: [PERM.reporterView, PERM.reporterManage, PERM.reporterSelf], keywords: ['report'] },
  { id: 'nav-fleet', label: 'Fleet', group: 'Go to', icon: 'dns', route: '/fleet', perm: [PERM.fleetView, PERM.reporterManage], keywords: ['machines', 'devices'] },
  { id: 'nav-tracker', label: 'Tracker', group: 'Go to', icon: 'monitoring', route: '/tracker', perm: [PERM.trackerSelf], keywords: ['food', 'water', 'hydration', 'coffee', 'weight', 'exercise', 'log', 'fitness', 'calories', 'macros'] },
  { id: 'nav-ask', label: 'Ask my life', group: 'Go to', icon: 'auto_awesome', route: '/ask', perm: [PERM.trackerAi], keywords: ['ai', 'ask', 'question', 'assistant', 'chat', 'gemini', 'how did my week go'] },
  { id: 'nav-tracker-beta', label: 'Tracker Beta', group: 'Go to', icon: 'science', route: '/tracker-beta', perm: [PERM.trackerBeta], keywords: ['strata'] },
  { id: 'nav-challenge', label: '75 Hard', group: 'Go to', icon: 'fitness_center', route: '/challenge', perm: [PERM.trackerSelf], keywords: ['challenge'] },
  { id: 'nav-trophies', label: 'Trophies', group: 'Go to', icon: 'emoji_events', route: '/trophies', perm: [PERM.trackerSelf], keywords: ['trophy', 'trophies', 'badges', 'achievements', 'milestones'] },
  { id: 'nav-feed', label: 'Activity feed', group: 'Go to', icon: 'dynamic_feed', route: '/feed', perm: [PERM.trackerSelf], keywords: ['social', 'feed'] },
  { id: 'nav-automations', label: 'Automations', group: 'Go to', icon: 'bolt', route: '/automations', perm: [PERM.automationsUse], keywords: ['rules', 'triggers', 'webhook', 'discord', 'notify'] },
  { id: 'nav-bills', label: 'Bill Splitter', group: 'Go to', icon: 'receipt_long', route: '/bills', perm: [PERM.billsUse], keywords: ['bill', 'split', 'receipt', 'expense'] },
  { id: 'nav-beta', label: 'Beta', group: 'Go to', icon: 'science', route: '/beta', perm: [PERM.betaAccess], keywords: ['experimental'] },
  { id: 'nav-family', label: 'Family', group: 'Go to', icon: 'cottage', route: '/family', perm: [PERM.familyUse], keywords: ['hub', 'household'] },
  { id: 'nav-chat', label: 'Chat', group: 'Go to', icon: 'forum', route: '/chat', perm: [PERM.chatRead], keywords: ['message', 'dm'] },
  { id: 'nav-people', label: 'People', group: 'Go to', icon: 'groups', route: '/people', perm: [PERM.chatRead, PERM.familyUse], keywords: ['contacts', 'roster'] },
  { id: 'nav-locations', label: 'My locations', group: 'Go to', icon: 'place', route: '/locations', perm: [PERM.locationSelf], keywords: ['gps', 'map', 'where'] },
  { id: 'nav-users', label: 'Users', group: 'Go to', icon: 'group', route: '/users', perm: [PERM.usersView], keywords: ['admin', 'accounts', 'permissions'] },
  { id: 'nav-activity', label: 'Activity', group: 'Go to', icon: 'receipt_long', route: '/activity', perm: [PERM.activityView], keywords: ['audit', 'log'] },
  { id: 'nav-settings', label: 'Settings', group: 'Go to', icon: 'tune', route: '/settings', perm: [PERM.settingsView], keywords: ['config', 'sync'] },

  // ---- Go to — reachable routes the homeOptionDefs map omits (same perm as their own guard) ----
  { id: 'nav-admin-locations', label: 'Locations (admin)', group: 'Go to', icon: 'map', route: '/admin/locations', perm: [PERM.locationViewAll], keywords: ['map', 'everyone', 'where'] },
  { id: 'nav-ai-usage', label: 'AI usage', group: 'Go to', icon: 'smart_toy', route: '/ai-usage', perm: [PERM.aiUsageView], keywords: ['tokens', 'gemini', 'ai'] },
  // Family subpages — all need family.use; the four with an extra perm require BOTH (requireAll), matching their stacked route guards.
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
