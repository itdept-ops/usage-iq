namespace Ccusage.Api.Auth;

public sealed record PermissionInfo(string Key, string Group, string Label, string Description, bool IsAi = false);

/// <summary>A named, server-defined bundle of permission keys the admin Users page can apply as a STARTING
/// POINT when setting a user's grants. It is NOT a persistent role — there is no DB row and nothing is
/// re-applied later; the page just preselects these keys in the grant matrix for the admin to adjust + save.</summary>
public sealed record PermissionPreset(string Key, string Label, string Description, IReadOnlyList<string> Permissions);

/// <summary>The catalog of permissions users can be granted. Add new capabilities here.</summary>
public static class Permissions
{
    // ---- Dashboard ----
    public const string DashboardView = "dashboard.view";
    public const string DashboardExport = "dashboard.export";
    public const string SyncRun = "sync.run";

    // ---- Calendar ----
    public const string CalendarView = "calendar.view";

    // ---- Pricing ----
    public const string PricingView = "pricing.view";
    public const string PricingManage = "pricing.manage";

    // ---- Settings ----
    public const string SettingsView = "settings.view";
    public const string SettingsManage = "settings.manage";
    public const string SourcesManage = "sources.manage";

    // ---- Reporter ----
    public const string ReporterView = "reporter.view";
    public const string ReporterManage = "reporter.manage";
    public const string ReporterSelf = "reporter.self";
    public const string FleetView = "fleet.view";

    // ---- Notifications ----
    public const string NotificationsView = "notifications.view";
    public const string NotificationsManage = "notifications.manage";

    // ---- Chat ----
    public const string ChatRead = "chat.read";
    public const string ChatSend = "chat.send";
    public const string ChatModerate = "chat.moderate";
    public const string ChatContactsManage = "chat.contacts.manage";

    // ---- Tracker ----
    public const string TrackerSelf = "tracker.self";
    public const string TrackerViewAll = "tracker.viewall";

    // ---- Shares ----
    public const string SharesView = "shares.view";
    public const string SharesManage = "shares.manage";

    // ---- Bills ----
    /// <summary>Bill Splitter (split-the-check): create bills, break a receipt photo down with AI, assign
    /// items to contacts, and share a PUBLIC anonymous claim link. Never default — granted deliberately per
    /// user. The receipt-AI route ALSO requires <see cref="AiVision"/> (the multimodal gate).</summary>
    public const string BillsUse = "bills.use";

    /// <summary>Page-gate for the personal "My Recipes" book (<c>/api/recipes</c>). OWNER-SCOPED private
    /// data: a caller only ever sees/edits their own recipes. A recipe may be opted-in to share read-only
    /// with the owner's mutual chat contacts. Never default — granted deliberately per user, since it gates
    /// private data.</summary>
    public const string RecipesUse = "recipes.use";

    /// <summary>Page-gate for the household Grocery list tool (<c>/api/grocery</c>): the shopping
    /// <see cref="FamilyList"/> ("Groceries"), private to the household and optionally shared to contacts.
    /// Never default — granted deliberately per user, since it gates private household data.</summary>
    public const string GroceryUse = "grocery.use";

    /// <summary>Page-gate for the standalone Meal Planner tool (<c>/api/family/meals</c> + the AI planner
    /// <c>/api/ai/plan-meals</c>): the household weekly meal plan, its grocery + macro interconnect, and the
    /// macro-aware "plan my day/week" AI. Household-scoped private data — solo users auto-get a household,
    /// like the Grocery tool. Never default — granted deliberately per user, since it gates private household
    /// data. The AI planner ALSO requires <see cref="TrackerAi"/> (the token-spending gate, checked there).</summary>
    public const string MealsUse = "meals.use";

    /// <summary>Page-gate for the Resume Builder tool (<c>/api/resume</c>): build, parse, tailor, and
    /// generate cover letters for resumes with AI. OWNER-SCOPED private data — a caller only ever sees/edits
    /// their own resumes + private headshot. A resume may be opted-in to share read-only with the owner's
    /// mutual chat contacts. Never default — granted deliberately per user, since it gates private data.</summary>
    public const string ResumeUse = "resume.use";

    // ---- Family ----
    public const string FamilyUse = "family.use";
    public const string FamilyFinance = "family.finance";
    /// <summary>Cycle tracker (PRIVATE health data). Never default — an admin grants it deliberately to the
    /// person who tracks; the LOG is private to its owner and the family overlay is a further per-user opt-in.</summary>
    public const string CycleTrack = "cycle.track";
    /// <summary>A CHILD capability (chore marketplace): claim pool chores, submit their own claimed/assigned
    /// chores, and view their OWN allowance balance + ledger. Never default — granted deliberately to a child
    /// (the "child" preset). On its own it grants nothing else: every family endpoint a child can reach is
    /// rescoped server-side to the child's own data (never another member's, never any email).</summary>
    public const string ChoreClaim = "chore.claim";
    /// <summary>A PARENT capability (chore marketplace): approve/reject submitted chores and record allowance
    /// payouts/spends/adjustments + view all household children's balances. Never default — granted to an
    /// owner/adult, never to a child.</summary>
    public const string AllowanceManage = "allowance.manage";
    /// <summary>Identity Map (PRIVATE, owner-scoped): define the ROLES you play, log TIME against them, and see
    /// your time split as a radial web. Optionally imports from your OWN connected Google Calendar with
    /// deterministic keyword→role rules. Never default — the data is personal, granted deliberately per user;
    /// every endpoint is owner-scoped (you only ever see your own roles/time).</summary>
    public const string IdentityMap = "identity.map";

    // ---- Location (GPS feature; never default) ----
    public const string LocationSelf = "location.self";
    public const string LocationShare = "location.share";
    /// <summary>Admin oversight: view ALL users' location history + the live map. Admin-gated, never default.</summary>
    public const string LocationViewAll = "location.view-all";

    // ---- AI (group "AI", IsAi=true; NONE are defaultable — every user starts AI-off) ----
    public const string TrackerAi = "tracker.ai";
    public const string FamilyAi = "family.ai";
    public const string FamilyAiAssistant = "family.ai.assistant";
    public const string FinanceAi = "finance.ai";
    public const string ChatAi = "chat.ai";
    public const string AiVision = "ai.vision";
    /// <summary>"Ask that Acts": gates ONLY the propose step of the action-taking Ask box (the token spend) —
    /// the AI answers over the caller's own snapshot AND proposes confirm-chip actions to approve. Mirrors the
    /// <see cref="FamilyAiAssistant"/> precedent (an action-proposing AI capability) and the way
    /// <see cref="TrackerAi"/> gates answering: the WRITE each action maps to stays gated by its own existing
    /// permission (family.use/grocery.use/meals.use/tracker.self), checked at map time. IsAi=true, never
    /// defaultable — granted deliberately, every account starts AI-off.</summary>
    public const string AiAct = "ai.act";

    // ---- Automations ----
    /// <summary>Page-gate for the Automations builder + the <c>/api/automations</c> CRUD. A rule can carry the
    /// owner's OWN Discord webhook (SSRF-allowlisted + encrypted at rest), so the capability is granted
    /// deliberately — never default. Auto-included in the administrator preset (preset = the full catalog).
    /// Not a *.view (a page gate, like <see cref="TrackerSelf"/>).</summary>
    public const string AutomationsUse = "automations.use";

    // ---- Platform (the mobile-app gate) ----
    /// <summary>The MOBILE PLATFORM gate: use the mobile app — the Strata mobile-first UI of every page on a phone
    /// (kept under the "beta" framing for now). A platform-level capability, not a feature *.view; auto-included in
    /// the administrator preset (the full catalog). Never default — every account starts on the desktop UI and
    /// only gets the mobile app when granted. (Renamed from the legacy <c>beta.access</c> + absorbs the old
    /// <c>tracker.beta</c>.)</summary>
    public const string PlatformMobile = "platform.mobile";

    // ---- Administration ----
    public const string UsersView = "users.view";
    public const string UsersManage = "users.manage";
    public const string ActivityView = "activity.view";
    public const string AiUsageView = "ai.usage.view";

    /// <summary>The six AI permission keys (group "AI"). NONE are defaultable.</summary>
    public static readonly string[] AiKeys =
    {
        TrackerAi, FamilyAi, FamilyAiAssistant, FinanceAi, ChatAi, AiVision, AiAct,
    };

    /// <summary>The Location permission keys (GPS feature). NONE are defaultable.</summary>
    public static readonly string[] LocationKeys = { LocationSelf, LocationShare, LocationViewAll };

    public static readonly IReadOnlyList<PermissionInfo> Catalog = new[]
    {
        // ---- Usage ----
        new PermissionInfo(DashboardView, "Usage", "View dashboard", "View the dashboard and core usage data."),
        new PermissionInfo(DashboardExport, "Usage", "Export records", "Export usage records to CSV."),
        new PermissionInfo(SyncRun, "Usage", "Run sync", "Trigger a manual incremental sync."),
        new PermissionInfo(CalendarView, "Usage", "View calendar", "View the calendar heatmap, stats, and session drill-down."),
        new PermissionInfo(PricingView, "Usage", "View pricing", "View the model pricing table."),
        new PermissionInfo(PricingManage, "Usage", "Manage pricing", "Edit or add model pricing and recompute costs."),
        new PermissionInfo(ReporterView, "Usage", "View reporter", "View ingest keys and reporter docs."),
        new PermissionInfo(ReporterManage, "Usage", "Manage reporter", "Create and revoke ingest keys."),
        new PermissionInfo(ReporterSelf, "Usage", "Manage own reporter keys", "Create and revoke your own ingest keys to report your own usage."),
        new PermissionInfo(FleetView, "Usage", "View fleet", "View the fleet leaderboard (per-machine and per-user usage attribution)."),
        new PermissionInfo(SharesView, "Usage", "View shares", "View share links and access logs."),
        new PermissionInfo(SharesManage, "Usage", "Manage shares", "Create, edit, and revoke share links."),
        new PermissionInfo(NotificationsView, "Usage", "View notifications", "View the Discord/notification config."),
        new PermissionInfo(NotificationsManage, "Usage", "Manage notifications", "Edit notifications and send a test."),

        // ---- Fitness ----
        new PermissionInfo(TrackerSelf, "Fitness", "Track food & fitness", "Log and view your own food intake and exercises."),
        new PermissionInfo(TrackerViewAll, "Fitness", "View all trackers", "View every user’s food & fitness log (coach/admin)."),

        // ---- Tools ----
        new PermissionInfo(BillsUse, "Tools", "Use Bill Splitter", "Create bills, break a receipt photo down with AI, assign items to your contacts, and share a public claim link so people can claim what they owe."),
        new PermissionInfo(RecipesUse, "Tools", "Use My Recipes", "Save, edit, and organize your own recipes, and optionally share a recipe read-only with your mutual contacts."),
        new PermissionInfo(GroceryUse, "Tools", "Use Grocery list", "Keep a household grocery list: add, check off, and clear items, and pull missing ingredients straight from a recipe."),
        new PermissionInfo(MealsUse, "Tools", "Use Meal Planner", "Plan your weekly meals, get a macro-aware AI plan for the day or week from your recipes, recent foods, and groceries, and pull ingredients straight onto your grocery list."),
        new PermissionInfo(ResumeUse, "Tools", "Use Resume Builder", "Build, parse, tailor, and generate cover letters for resumes with AI — your private resumes + headshot."),

        // ---- Family ----
        new PermissionInfo(FamilyUse, "Family", "Use Family Hub", "Access the Family Hub: see your household, its members, and shared family data."),
        new PermissionInfo(FamilyFinance, "Family", "Manage family finances", "View and manage the household's shared finances (budgets, bills, balances)."),
        new PermissionInfo(CycleTrack, "Family", "Track cycle", "Log and view your own private cycle calendar (informational, non-medical), and choose whether to overlay only predicted phases on the family calendar."),
        new PermissionInfo(ChoreClaim, "Family", "Claim chores (child)", "A child capability: claim chores from the family chore marketplace, submit your own chores for approval, and view your own allowance balance and history (only your own — never another member's)."),
        new PermissionInfo(AllowanceManage, "Family", "Manage allowance", "A parent capability: approve or reject submitted chores, record cash payouts, spends, and adjustments, and view every household child's allowance balance."),
        new PermissionInfo(IdentityMap, "Family", "Identity Map", "Log time against the roles you play (parent, coder, athlete…) and see your time split as a radial web. Optionally import from your connected calendar — only your own data, never anyone else's."),

        // ---- Social ----
        new PermissionInfo(ChatRead, "Social", "View chat", "See channels and direct messages you belong to and read their messages."),
        new PermissionInfo(ChatSend, "Social", "Send messages", "Post messages, create channels, and start direct messages."),
        new PermissionInfo(ChatModerate, "Social", "Moderate chat", "Edit or delete other people’s messages, and archive or delete channels."),
        new PermissionInfo(ChatContactsManage, "Social", "Manage contacts", "Add or remove the people in any user’s chat contacts (their circle)."),

        // ---- Location (GPS feature; never default) ----
        new PermissionInfo(LocationSelf, "Location", "Track own location", "Record and view your own location and location history."),
        new PermissionInfo(LocationShare, "Location", "Share location", "Share your live location with your household and contacts."),
        new PermissionInfo(LocationViewAll, "Location", "View all locations", "Admin oversight: view every user’s location history and the live location map."),

        // ---- Tools (continued) ----
        new PermissionInfo(AutomationsUse, "Tools", "Use Automations", "Create rules that react to your own activity and notify you in-app or to your own Discord webhook."),

        // ---- Platform (the mobile-app gate) ----
        new PermissionInfo(PlatformMobile, "Platform", "Mobile app (beta)", "Use the mobile app — the mobile-first UI of every page on a phone. Off by default; the desktop UI needs no grant."),

        // ---- Administration ----
        new PermissionInfo(UsersView, "Admin", "View users", "View the user list, permission catalog, and audit log."),
        new PermissionInfo(UsersManage, "Admin", "Manage users", "Create, edit, and delete users, set permissions, and edit the access policy."),
        new PermissionInfo(ActivityView, "Admin", "View activity", "View request logs on the Activity page."),
        new PermissionInfo(AiUsageView, "Admin", "View AI usage", "View the AI usage log: per-call feature, outcome, and token counts (never prompt or response content)."),
        new PermissionInfo(SettingsView, "Admin", "View settings", "View settings and ingestion sources."),
        new PermissionInfo(SettingsManage, "Admin", "Manage settings", "Edit timezone and the auto-sync timer."),
        new PermissionInfo(SourcesManage, "Admin", "Manage sources", "Edit ingestion sources."),

        // ---- AI (IsAi=true; none defaultable — every user starts AI-off) ----
        new PermissionInfo(TrackerAi, "AI", "Tracker AI", "Use text AI in the tracker: estimate macros/calories, parse meals & exercises from text, build a day, and get coaching narratives.", IsAi: true),
        new PermissionInfo(FamilyAi, "AI", "Family AI", "Use text AI across the Family Hub: reminders & timers from text, the morning briefing, list quick-add, note draft/ask/transform/summarize, meal planning, chore suggestions, calendar scheduling, and poll options.", IsAi: true),
        new PermissionInfo(FamilyAiAssistant, "AI", "Family Assistant", "Use the action-taking Family Assistant chat box that answers over your household and proposes actions to confirm.", IsAi: true),
        new PermissionInfo(FinanceAi, "AI", "Finance AI", "Use finance AI: the “where the money went” monthly explainer and the money-coach recurring-charge insights.", IsAi: true),
        new PermissionInfo(ChatAi, "AI", "Chat AI", "Use chat AI: catch-me-up summaries, smart replies, and the compose assistant.", IsAi: true),
        new PermissionInfo(AiVision, "AI", "Vision AI", "Use multimodal image/PDF AI: meal-photo and nutrition-label reading, and extracting events from a schedule image or PDF.", IsAi: true),
        new PermissionInfo(AiAct, "AI", "Ask that Acts", "Let the Ask box propose actions to confirm alongside its answer (add a calendar event, grocery item, meal, tracker log, or family note/reminder/timer). Each action still needs the matching feature permission to run; nothing is written until you approve a chip.", IsAi: true),
    };

    public static readonly string[] All = Catalog.Select(p => p.Key).ToArray();

    /// <summary>The <c>*.view</c> page-view gate keys — every page-level viewing capability.</summary>
    public static readonly string[] Views =
    {
        DashboardView, CalendarView, PricingView, SettingsView,
        ReporterView, FleetView, NotificationsView, ChatRead, TrackerSelf, SharesView, UsersView, ActivityView,
        AiUsageView,
    };

    public static bool IsValid(string key) => All.Contains(key);

    /// <summary>Whether <paramref name="key"/> is one of the six AI (token-spending) permissions.</summary>
    public static bool IsAi(string key) => AiKeys.Contains(key);

    /// <summary>
    /// Server-defined preset templates the admin Users page can apply as a STARTING POINT for a user's
    /// grants (not persistent roles — applying one just preselects its keys in the grant matrix). Every key
    /// listed here is a real catalog key (asserted in tests). "Administrator" is the full catalog.
    /// </summary>
    public static readonly IReadOnlyList<PermissionPreset> Presets = new[]
    {
        new PermissionPreset("administrator", "Administrator",
            "Everything — every permission in the catalog, including all AI.",
            All),

        new PermissionPreset("family-member", "Family Member",
            "A full household member (like a spouse): Family Hub + finances, chat, own tracker, calendar, dashboard, and all AI.",
            new[]
            {
                FamilyUse, FamilyFinance,
                // A full member is a PARENT — they manage the chore marketplace + allowance.
                AllowanceManage,
                // A full member maps their own time/roles (private, owner-scoped).
                IdentityMap,
                ChatRead, ChatSend,
                TrackerSelf,
                CalendarView, DashboardView,
                // AI (the full member gets the lot)
                TrackerAi, FamilyAi, FamilyAiAssistant, FinanceAi, ChatAi, AiVision,
            }),

        new PermissionPreset("child", "Child",
            "A kid with their own login: the chore marketplace + their own allowance, and nothing else. " +
            "They belong to the household (family.use) but every family endpoint they reach is rescoped to " +
            "their OWN chores + balance — never another member's data, never any finances, AI, or admin.",
            new[]
            {
                // The MINIMAL family.use so the household-scoped /api/family group admits them and they can be
                // a household member, PLUS the child capability. Deliberately OMITS family.finance, cycle.track,
                // allowance.manage, all AI keys, all admin/usage keys, tracker, chat, and location.
                FamilyUse, ChoreClaim,
            }),

        new PermissionPreset("friend-tracker", "Friend (Tracker)",
            "A friend who only logs their own food & fitness, and can read chat.",
            new[] { TrackerSelf, ChatRead }),

        new PermissionPreset("viewer", "Viewer",
            "Read-only usage: the dashboard, their own reporter keys, and share links.",
            new[] { DashboardView, ReporterSelf, SharesView }),
    };

    /// <summary>
    /// Whether a permission may appear in the open-sign-up default set. Excludes <see cref="UsersManage"/>
    /// so auto-provisioning can never mint an administrator: granting admin must always be an explicit,
    /// per-user action on the Users page, never something every new Google account inherits by default.
    /// Also excludes <see cref="ChatModerate"/> for the same reason — chat-moderation is a privileged
    /// capability that must be granted deliberately, never inherited by every new account. Likewise
    /// excludes <see cref="ChatContactsManage"/>: curating other people's contacts is an admin
    /// capability that must be granted deliberately, never inherited by every new account. Likewise
    /// excludes <see cref="TrackerViewAll"/>: reading every user's food &amp; fitness log is a
    /// coach/admin capability that must be granted deliberately, never inherited by default.
    /// Likewise excludes the Family keys (<see cref="FamilyUse"/>, <see cref="FamilyFinance"/> and
    /// <see cref="CycleTrack"/>): the Family Hub holds private household data and shared finances, and the
    /// cycle tracker is PRIVATE health data, so access must be granted deliberately per user and never
    /// inherited by every new account.
    /// Likewise excludes <see cref="AiUsageView"/>: the AI usage log is admin oversight of who spends
    /// tokens, so it must be granted deliberately, never inherited by every new account.
    /// Likewise excludes the chore-marketplace keys (<see cref="ChoreClaim"/>, <see cref="AllowanceManage"/>):
    /// a child capability and a parent allowance-management capability respectively, both granted deliberately
    /// (via the "child"/"family-member" presets) so open sign-up can never auto-mint a child or an allowance
    /// manager. Likewise excludes <see cref="IdentityMap"/>: the Identity Map holds private, personal
    /// time/role data, so it must be granted deliberately per user, never inherited by every new account.
    /// Likewise excludes <see cref="BillsUse"/>: the Bill Splitter mints PUBLIC anonymous claim links and
    /// reads receipt photos through vision AI, so it must be granted deliberately per user, never inherited
    /// by every new account.
    /// Likewise excludes <see cref="AutomationsUse"/>: an automation rule can carry the owner's OWN Discord
    /// webhook (SSRF-allowlisted + encrypted), so the capability is a deliberate grant, never inherited by
    /// every new account.
    /// Likewise excludes <see cref="RecipesUse"/>, <see cref="GroceryUse"/>, <see cref="MealsUse"/> and
    /// <see cref="ResumeUse"/>: all gate private, owner/household-scoped data (a personal recipe book, the
    /// household grocery list, the household meal plan, and a personal resume + headshot), so they must be
    /// granted deliberately per user, never inherited by every new account.
    /// Finally excludes ALL AI keys (<see cref="AiKeys"/>) and ALL Location keys (<see cref="LocationKeys"/>):
    /// AI capabilities spend tokens and the Location feature reveals where a user is, so both must be
    /// granted deliberately per user — every new account starts with AI off and location off.
    /// </summary>
    public static bool IsDefaultable(string key) =>
        IsValid(key) && key != UsersManage && key != ChatModerate && key != ChatContactsManage
        && key != TrackerViewAll && key != FamilyUse && key != FamilyFinance && key != CycleTrack
        && key != ChoreClaim && key != AllowanceManage && key != IdentityMap
        && key != AiUsageView && key != BillsUse && key != PlatformMobile && key != AutomationsUse
        && key != RecipesUse && key != GroceryUse && key != MealsUse && key != ResumeUse
        && !AiKeys.Contains(key) && !LocationKeys.Contains(key);
}
