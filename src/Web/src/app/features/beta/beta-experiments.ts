/**
 * The single source of truth for the Beta section's experimental pages. Both the Beta hub
 * ({@link BetaHubPage}) grid AND the top-nav / mobile-drawer "Beta" dropdown iterate this list, so the
 * nav and the hub can never drift. Add a future beta page by appending ONE entry here (title, blurb,
 * route, icon, and an optional `perm` gate).
 *
 * Every entry additionally requires `beta.access` — that is the gate on the Beta dropdown trigger and
 * the route guard, so it is NOT repeated per entry. A `perm`, when set, is an ADDITIONAL feature gate
 * (e.g. `bills.use`, `family.use`) layered on top of `beta.access`.
 */
export interface BetaExperiment {
  readonly title: string;
  readonly blurb: string;
  readonly route: string;
  readonly icon: string;
  /** Optional ADDITIONAL permission gate (on top of beta.access) — the entry only renders if held. */
  readonly perm?: string;
}

export const BETA_EXPERIMENTS: readonly BetaExperiment[] = [
  {
    title: 'Strata',
    blurb: 'Mobile-first clean-sheet fitness tracker (Strata)',
    route: '/tracker-beta',
    icon: 'fitness_center',
    perm: 'tracker.beta',
  },
  {
    title: 'Bills',
    blurb: 'Snap a receipt, split it, share a claim link — mobile-first',
    route: '/beta/bills',
    icon: 'receipt_long',
    perm: 'bills.use',
  },
  {
    title: 'Home',
    blurb: 'Your cross-domain glance surface — rings, events, who\'s online',
    route: '/beta/home',
    icon: 'space_dashboard',
    // No `perm` → visible to anyone who holds beta.access. The page's own widgets self-gate on their
    // domain perms, and the route guard re-checks beta.access on direct nav.
  },
  {
    title: 'Dashboard',
    blurb: 'Your token + cost analytics, glanceable on mobile',
    route: '/beta/dashboard',
    icon: 'insights',
    // No `perm` → the route guard re-checks beta.access; same data as the live dashboard.
  },
  {
    title: 'Family',
    blurb: 'Your household at a glance — mobile-first',
    route: '/beta/family',
    icon: 'cottage',
    // Gated on `family.use` (the feature); the route additionally STACKS beta.access + family.use, so a
    // direct nav re-checks both. Mirrors the live family glance — never surfaces cycle/finance data.
    perm: 'family.use',
  },
  {
    title: 'Wrapped',
    blurb: 'Your Hub, the highlight reel',
    route: '/beta/wrapped',
    icon: 'auto_awesome',
    // No `perm` → the route guard re-checks beta.access; the page itself is gated server-side by
    // tracker.self (the /api/wrapped endpoint), and only ever shows the caller's OWN data.
  },
  {
    title: 'Settings',
    blurb: 'Your quick toggles, mobile-first',
    route: '/beta/settings',
    icon: 'tune',
    // No `perm` → the route guard re-checks beta.access; the page mirrors the live Settings hub's quick
    // toggles and reuses the same per-user Api methods (each toggle still self-gates by its own perm).
  },
  {
    title: 'Messenger',
    blurb: 'Your channels and DMs — fast, native-feel chat with bubbles, reactions & live typing',
    route: '/beta/chat',
    icon: 'chat_bubble',
    // Gated on `chat.read` (the feature); the route additionally STACKS beta.access + chat.read, so a
    // direct nav re-checks both. Mirrors the live /chat over the same realtime data.
    perm: 'chat.read',
  },
  {
    title: 'Ask my life',
    blurb: 'Chat with an AI grounded in your own numbers',
    route: '/beta/ask',
    icon: 'auto_awesome',
    // Gated on `tracker.ai` (the OFF-by-default text-AI perm, same as the live /ask page + POST /api/ai/ask);
    // the route additionally STACKS beta.access + tracker.ai, so a direct nav re-checks both.
    perm: 'tracker.ai',
  },
  {
    title: 'Meals',
    blurb: 'Plan your week, swipe your days, fill the cart — mobile-first',
    route: '/beta/meals',
    icon: 'restaurant_menu',
    // Gated on `meals.use` (the feature); the route additionally STACKS beta.access + meals.use, so a
    // direct nav re-checks both. Mirrors the live /meal-planner over the same household meal/grocery data.
    perm: 'meals.use',
  },
];
