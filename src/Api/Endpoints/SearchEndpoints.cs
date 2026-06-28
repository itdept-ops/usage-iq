using Ccusage.Api.Auth;
using Ccusage.Api.Data;
using Ccusage.Api.Dtos;
using Ccusage.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Ccusage.Api.Endpoints;

/// <summary>
/// "Search Everything" (<c>GET /api/search</c>): one box that queries every domain the caller can already
/// see and unions the hits server-side. The endpoint requires authentication ONLY
/// (<see cref="Permissions.SearchUse"/> is a page-gate that grants no data) — each domain's sub-query runs
/// ONLY when the caller holds that domain's own permission, and each sub-query replicates its SOURCE
/// endpoint's EXACT visibility rule. Get the scoping wrong and you leak private data, so every domain below
/// is independently re-gated and re-scoped:
///
/// <list type="bullet">
///   <item>OWNER-scoped (UserEmail/OwnerEmail == caller): recipes, automations, bills, tracker foods.</item>
///   <item>HOUSEHOLD-scoped (the caller's household, resolved by membership): family notes, lists, meals, chores.</item>
///   <item>MEMBERSHIP-scoped: chat messages ONLY in channels where the caller is a member.</item>
///   <item>UNION-scoped: people = the caller's contacts ∪ household members, via <see cref="DisplayName.Format"/>
///   (never an email).</item>
/// </list>
///
/// SENSITIVE-FIELD EXCLUSION (defense in depth — do NOT leak health/financial/location detail into a snippet):
/// the cycle health log is EXCLUDED entirely; bills are searched by TITLE only and carry NO amount in the
/// snippet; locations are not a search domain (place names/coords never surface here); and a users/email search
/// domain is deliberately ABSENT (email-privacy). When unsure, a field is excluded.
/// </summary>
public static class SearchEndpoints
{
    /// <summary>The per-email rate-limit policy for the search box (~30 queries/min). Registered in Program.cs.</summary>
    public const string RateLimitPolicy = "search";

    /// <summary>Minimum query length — below this the endpoint returns an empty result set (no DB hit).</summary>
    private const int MinQueryLength = 2;

    /// <summary>Default + max per-domain result cap.</summary>
    private const int DefaultPerDomainLimit = 6;
    private const int MaxPerDomainLimit = 8;

    /// <summary>Hard overall cap across all domains (defensive — many domains × per-domain cap).</summary>
    private const int OverallCap = 60;

    // Score hints: a title/name match outranks a body/snippet match.
    private const int TitleScore = 100;
    private const int BodyScore = 50;

    public static void MapSearchEndpoints(this WebApplication app)
    {
        // .RequireAuthorization() ONLY — no single data permission. search.use gates the PAGE, but it grants
        // no data, so the endpoint doesn't require it: every result is re-gated by its own domain perm below.
        app.MapGet("/api/search", async (
                string? q, string? domains, int? limit,
                CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
            {
                var caller = (await me.GetUserAsync(ct))!; // RequireAuthorization guarantees identity
                var query = (q ?? "").Trim();

                if (query.Length < MinQueryLength)
                    return Results.Ok(new SearchResponse(query, Array.Empty<SearchResultItem>(),
                        new Dictionary<string, int>(), Truncated: false));

                var perDomain = Math.Clamp(limit ?? DefaultPerDomainLimit, 1, MaxPerDomainLimit);
                var wanted = ParseDomains(domains); // null => all domains
                bool Want(string d) => wanted is null || wanted.Contains(d);
                var like = $"%{EscapeLike(query)}%";

                var results = new List<SearchResultItem>();
                var truncatedAny = false;

                // Helper: a domain ran and returned exactly its cap ⇒ more may exist.
                void Note(int returned) { if (returned >= perDomain) truncatedAny = true; }

                // ===== OWNER-scoped domains (OwnerEmail/UserEmail == caller) =====

                // --- Recipes (recipes.use): a caller only ever sees their OWN recipes (Recipe.OwnerEmail). ---
                if (Want(Domains.Recipe) && caller.Permissions.Contains(Permissions.RecipesUse))
                {
                    var rows = await db.Recipes.AsNoTracking()
                        .Where(r => r.OwnerEmail == caller.Email
                            && (EF.Functions.ILike(r.Title, like) || EF.Functions.ILike(r.Notes, like)))
                        .OrderByDescending(r => r.UpdatedUtc)
                        .Take(perDomain)
                        .Select(r => new { r.Id, r.Title, r.Notes, r.UpdatedUtc })
                        .ToListAsync(ct);
                    foreach (var r in rows)
                        results.Add(new SearchResultItem("recipe", r.Id.ToString(), Blank(r.Title, "Untitled recipe"),
                            Excerpt(r.Notes, query), null, $"/recipes?focus={r.Id}", Domains.Recipe,
                            TitleMatch(r.Title, query) ? TitleScore : BodyScore, r.UpdatedUtc));
                    Note(rows.Count);
                }

                // --- Automations (automations.use): a rule belongs to EXACTLY one owner (AutomationRule.OwnerEmail).
                //     Name only — never the encrypted webhook (it isn't even selected). ---
                if (Want(Domains.Automation) && caller.Permissions.Contains(Permissions.AutomationsUse))
                {
                    var rows = await db.AutomationRules.AsNoTracking()
                        .Where(a => a.OwnerEmail == caller.Email && EF.Functions.ILike(a.Name, like))
                        .OrderByDescending(a => a.UpdatedUtc)
                        .Take(perDomain)
                        .Select(a => new { a.Id, a.Name, a.TriggerKind, a.Enabled, a.UpdatedUtc })
                        .ToListAsync(ct);
                    foreach (var a in rows)
                        results.Add(new SearchResultItem("automation", a.Id.ToString(), Blank(a.Name, "Automation"),
                            null, a.Enabled ? a.TriggerKind : $"{a.TriggerKind} (off)", "/automations", Domains.Automation,
                            TitleScore, a.UpdatedUtc));
                    Note(rows.Count);
                }

                // --- Bills (bills.use): owner-scoped (Bill.OwnerEmail). TITLE ONLY; the snippet REDACTS amounts
                //     (no tax/tip/item totals ever surface in search) — sensitive-field exclusion. ---
                if (Want(Domains.Bill) && caller.Permissions.Contains(Permissions.BillsUse))
                {
                    var rows = await db.Bills.AsNoTracking()
                        .Where(bl => bl.OwnerEmail == caller.Email && EF.Functions.ILike(bl.Title, like))
                        .OrderByDescending(bl => bl.CreatedUtc)
                        .Take(perDomain)
                        .Select(bl => new { bl.Id, bl.Title, bl.Status, bl.CreatedUtc })
                        .ToListAsync(ct);
                    foreach (var bl in rows)
                        results.Add(new SearchResultItem("bill", bl.Id.ToString(), Blank(bl.Title, "Bill"),
                            null, bl.Status, $"/bills?focus={bl.Id}", Domains.Bill, TitleScore, bl.CreatedUtc));
                    Note(rows.Count);
                }

                // --- Tracker foods (tracker.self): owner-scoped logged foods (FoodEntry.UserEmail). Deep-links to
                //     the day. Search Description + Brand. ---
                if (Want(Domains.Food) && caller.Permissions.Contains(Permissions.TrackerSelf))
                {
                    var rows = await db.FoodEntries.AsNoTracking()
                        .Where(f => f.UserEmail == caller.Email
                            && (EF.Functions.ILike(f.Description, like)
                                || (f.Brand != null && EF.Functions.ILike(f.Brand, like))))
                        .OrderByDescending(f => f.LocalDate).ThenByDescending(f => f.Id)
                        .Take(perDomain)
                        .Select(f => new { f.Id, f.Description, f.Brand, f.LocalDate })
                        .ToListAsync(ct);
                    foreach (var f in rows)
                        results.Add(new SearchResultItem("food", f.Id.ToString(), Blank(f.Description, "Food"),
                            string.IsNullOrWhiteSpace(f.Brand) ? null : f.Brand, f.LocalDate.ToString("yyyy-MM-dd"),
                            $"/tracker?date={f.LocalDate:yyyy-MM-dd}", Domains.Food, TitleScore,
                            f.LocalDate.ToDateTime(TimeOnly.MinValue)));
                    Note(rows.Count);
                }

                // ===== HOUSEHOLD-scoped domains (the caller's household, resolved by membership) =====
                // Resolve the caller's household EXACTLY as PeopleEndpoints/CurrentHouseholdAccessor do — by the
                // caller's own membership row. A household is private: only the caller's own id is ever read, so
                // results can only ever come from the caller's household. Read-only (never auto-creates).
                int? householdId = null;
                var needsHousehold =
                    (Want(Domains.FamilyNote) || Want(Domains.FamilyList) || Want(Domains.FamilyChore)
                        || Want(Domains.FamilyMeal))
                    && (caller.Permissions.Contains(Permissions.FamilyUse)
                        || caller.Permissions.Contains(Permissions.MealsUse));
                if (needsHousehold)
                    householdId = await db.HouseholdMembers.AsNoTracking()
                        .Where(m => m.UserId == caller.Id)
                        .Select(m => (int?)m.HouseholdId)
                        .FirstOrDefaultAsync(ct);

                if (householdId is int hid)
                {
                    // --- Family notes (family.use): private to the household (FamilyNote.HouseholdId). Title + Body. ---
                    if (Want(Domains.FamilyNote) && caller.Permissions.Contains(Permissions.FamilyUse))
                    {
                        var rows = await db.FamilyNotes.AsNoTracking()
                            .Where(n => n.HouseholdId == hid
                                && (EF.Functions.ILike(n.Title, like) || EF.Functions.ILike(n.Body, like)))
                            .OrderByDescending(n => n.UpdatedUtc)
                            .Take(perDomain)
                            .Select(n => new { n.Id, n.Title, n.Body, n.UpdatedUtc })
                            .ToListAsync(ct);
                        foreach (var n in rows)
                            results.Add(new SearchResultItem("note", n.Id.ToString(), Blank(n.Title, "Note"),
                                Excerpt(n.Body, query), null, $"/family/notes#note-{n.Id}", Domains.FamilyNote,
                                TitleMatch(n.Title, query) ? TitleScore : BodyScore, n.UpdatedUtc));
                        Note(rows.Count);
                    }

                    // --- Family lists (family.use): private to the household (FamilyList.HouseholdId). Name. ---
                    if (Want(Domains.FamilyList) && caller.Permissions.Contains(Permissions.FamilyUse))
                    {
                        var rows = await db.FamilyLists.AsNoTracking()
                            .Where(l => l.HouseholdId == hid && EF.Functions.ILike(l.Name, like))
                            .OrderByDescending(l => l.UpdatedUtc)
                            .Take(perDomain)
                            .Select(l => new { l.Id, l.Name, l.Kind, l.UpdatedUtc })
                            .ToListAsync(ct);
                        foreach (var l in rows)
                            results.Add(new SearchResultItem("list", l.Id.ToString(), Blank(l.Name, "List"),
                                null, l.Kind, $"/family/lists#list-{l.Id}", Domains.FamilyList, TitleScore, l.UpdatedUtc));
                        Note(rows.Count);
                    }

                    // --- Family chores (family.use): the household's board (FamilyChore.HouseholdId). Title. ---
                    if (Want(Domains.FamilyChore) && caller.Permissions.Contains(Permissions.FamilyUse))
                    {
                        var rows = await db.FamilyChores.AsNoTracking()
                            .Where(c => c.HouseholdId == hid && EF.Functions.ILike(c.Title, like))
                            .OrderByDescending(c => c.CreatedUtc)
                            .Take(perDomain)
                            .Select(c => new { c.Id, c.Title, c.Status, c.CreatedUtc })
                            .ToListAsync(ct);
                        foreach (var c in rows)
                            results.Add(new SearchResultItem("chore", c.Id.ToString(), Blank(c.Title, "Chore"),
                                null, c.Status, "/family/chores", Domains.FamilyChore, TitleScore, c.CreatedUtc));
                        Note(rows.Count);
                    }

                    // --- Family meals (meals.use): the household's weekly plan (FamilyMeal.HouseholdId). Title +
                    //     Ingredients. Deep-links to the planned date. ---
                    if (Want(Domains.FamilyMeal) && caller.Permissions.Contains(Permissions.MealsUse))
                    {
                        var rows = await db.FamilyMeals.AsNoTracking()
                            .Where(m => m.HouseholdId == hid
                                && (EF.Functions.ILike(m.Title, like) || EF.Functions.ILike(m.Ingredients, like)))
                            .OrderByDescending(m => m.LocalDate)
                            .Take(perDomain)
                            .Select(m => new { m.Id, m.Title, m.Ingredients, m.Slot, m.LocalDate })
                            .ToListAsync(ct);
                        foreach (var m in rows)
                            results.Add(new SearchResultItem("meal", m.Id.ToString(), Blank(m.Title, "Meal"),
                                Excerpt(m.Ingredients, query), m.Slot, $"/family/meals?date={m.LocalDate:yyyy-MM-dd}",
                                Domains.FamilyMeal, TitleMatch(m.Title, query) ? TitleScore : BodyScore,
                                m.LocalDate.ToDateTime(TimeOnly.MinValue)));
                        Note(rows.Count);
                    }
                }

                // ===== MEMBERSHIP-scoped: chat messages (chat.read) =====
                // ONLY messages in channels where the caller is a ChatChannelMember — copies ChatEndpoints'
                // membership scoping (a non-member can never read a channel's messages, nor learn it exists).
                // Soft-deleted messages are excluded. The deep-link opens the channel; the channel display name
                // (a NAMED channel's name, or "Direct message" for a DM) is the subtitle — never an email.
                if (Want(Domains.Chat) && caller.Permissions.Contains(Permissions.ChatRead))
                {
                    var rows = await db.ChatMessages.AsNoTracking()
                        .Where(msg => msg.DeletedUtc == null
                            && EF.Functions.ILike(msg.Body, like)
                            // MEMBERSHIP gate: the message's channel must have the caller as a member.
                            && db.ChatChannelMembers.Any(cm => cm.ChannelId == msg.ChannelId && cm.UserEmail == caller.Email))
                        .OrderByDescending(msg => msg.Id)
                        .Take(perDomain)
                        .Select(msg => new
                        {
                            msg.Id, msg.ChannelId, msg.Body, msg.CreatedUtc,
                            ChannelName = db.ChatChannels.Where(c => c.Id == msg.ChannelId).Select(c => c.Name).FirstOrDefault(),
                            IsDirect = db.ChatChannels.Any(c => c.Id == msg.ChannelId && c.Kind == Ccusage.Api.Data.Entities.ChannelKind.Direct),
                        })
                        .ToListAsync(ct);
                    foreach (var msg in rows)
                    {
                        var subtitle = msg.IsDirect ? "Direct message"
                            : (string.IsNullOrWhiteSpace(msg.ChannelName) ? "Channel" : msg.ChannelName);
                        results.Add(new SearchResultItem("chat", msg.Id.ToString(),
                            Excerpt(msg.Body, query) ?? "Message", null, subtitle,
                            $"/chat?c={msg.ChannelId}&m={msg.Id}", Domains.Chat, BodyScore, msg.CreatedUtc));
                    }
                    Note(rows.Count);
                }

                // ===== UNION-scoped: people (chat.read OR family.use) =====
                // The caller's contacts ∪ their household members, de-duplicated over the AppUser spine and
                // surfaced via DisplayName.Format (+ the AppUser id) — NEVER an email. Each source is included
                // only when the caller holds its permission (contacts ⟸ chat.read, household ⟸ family.use),
                // mirroring PeopleEndpoints. The NAME match is applied AFTER formatting so the wire-facing name
                // is what's matched (not a hidden full name) — consistent with what the caller already sees.
                var hasChat = caller.Permissions.Contains(Permissions.ChatRead);
                var hasFamily = caller.Permissions.Contains(Permissions.FamilyUse);
                if (Want(Domains.Person) && (hasChat || hasFamily))
                {
                    var personIds = new HashSet<int>();

                    if (hasChat)
                    {
                        var contactIds = await db.ChatContacts.AsNoTracking()
                            .Where(cc => cc.OwnerEmail == caller.Email)
                            .Join(db.Users.AsNoTracking(), cc => cc.ContactEmail, u => u.Email, (cc, u) => u)
                            .Where(u => u.IsEnabled)
                            .Select(u => u.Id)
                            .ToListAsync(ct);
                        foreach (var id in contactIds) personIds.Add(id);
                    }

                    if (hasFamily && householdId is null)
                        // Household wasn't resolved above (no household domain wanted / no meals perm path) —
                        // resolve it now for the people union, the same membership way.
                        householdId = await db.HouseholdMembers.AsNoTracking()
                            .Where(m => m.UserId == caller.Id)
                            .Select(m => (int?)m.HouseholdId)
                            .FirstOrDefaultAsync(ct);

                    if (hasFamily && householdId is int phid)
                    {
                        var memberIds = await db.HouseholdMembers.AsNoTracking()
                            .Where(m => m.HouseholdId == phid)
                            .Select(m => m.UserId)
                            .ToListAsync(ct);
                        foreach (var id in memberIds) personIds.Add(id);
                    }

                    if (personIds.Count > 0)
                    {
                        var ids = personIds.ToArray();
                        var users = await db.Users.AsNoTracking()
                            .Where(u => ids.Contains(u.Id))
                            .Select(u => new { u.Id, u.Name, u.DisplayNameMode, u.Nickname })
                            .ToListAsync(ct);

                        var matched = users
                            .Select(u => new { u.Id, Name = DisplayName.Format(u.Name, u.DisplayNameMode, u.Nickname) })
                            .Where(u => u.Name.Contains(query, StringComparison.OrdinalIgnoreCase))
                            .OrderBy(u => u.Name, StringComparer.OrdinalIgnoreCase)
                            .Take(perDomain)
                            .ToList();
                        foreach (var u in matched)
                            results.Add(new SearchResultItem("person", u.Id.ToString(), u.Name,
                                null, null, "/people", Domains.Person, TitleScore, null));
                        Note(matched.Count);
                    }
                }

                // ===== Assemble: order by score then recency, overall cap, per-domain counts =====
                var ordered = results
                    .OrderByDescending(r => r.ScoreHint)
                    .ThenByDescending(r => r.WhenUtc ?? DateTime.MinValue)
                    .Take(OverallCap)
                    .ToList();

                var counts = ordered
                    .GroupBy(r => r.Domain)
                    .ToDictionary(g => g.Key, g => g.Count());

                return Results.Ok(new SearchResponse(query, ordered, counts, truncatedAny));
            })
            .RequireAuthorization()
            .RequireRateLimiting(RateLimitPolicy);
    }

    /// <summary>The stable domain bucket tokens (also the <c>domains</c> filter values).</summary>
    public static class Domains
    {
        public const string Recipe = "recipes";
        public const string Automation = "automations";
        public const string Bill = "bills";
        public const string Food = "foods";
        public const string FamilyNote = "family-notes";
        public const string FamilyList = "family-lists";
        public const string FamilyChore = "family-chores";
        public const string FamilyMeal = "family-meals";
        public const string Chat = "chat";
        public const string Person = "people";
    }

    /// <summary>Parse the optional comma-separated <c>domains</c> filter into a set, or null for "all domains".
    /// Unknown tokens are ignored; an empty/whitespace value means all.</summary>
    private static HashSet<string>? ParseDomains(string? domains)
    {
        if (string.IsNullOrWhiteSpace(domains)) return null;
        var set = domains.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(d => d.ToLowerInvariant())
            .ToHashSet(StringComparer.Ordinal);
        return set.Count == 0 ? null : set;
    }

    /// <summary>Escape the LIKE wildcards in user input so a literal '%' or '_' can't widen the match.</summary>
    private static string EscapeLike(string s) =>
        s.Replace("\\", "\\\\").Replace("%", "\\%").Replace("_", "\\_");

    private static string Blank(string? s, string fallback) =>
        string.IsNullOrWhiteSpace(s) ? fallback : s.Trim();

    /// <summary>True when the query appears in the (case-insensitive) title — used to score a title hit higher.</summary>
    private static bool TitleMatch(string? title, string query) =>
        !string.IsNullOrEmpty(title) && title.Contains(query, StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// A short, single-line excerpt of a body around the first case-insensitive match of the query, with
    /// whitespace collapsed and capped — so a snippet never dumps a whole note/message and stays readable.
    /// Returns null for an empty body.
    /// </summary>
    private static string? Excerpt(string? body, string query)
    {
        if (string.IsNullOrWhiteSpace(body)) return null;
        var flat = System.Text.RegularExpressions.Regex.Replace(body, @"\s+", " ").Trim();
        if (flat.Length == 0) return null;

        const int radius = 60;
        const int max = 140;
        var idx = flat.IndexOf(query, StringComparison.OrdinalIgnoreCase);
        if (idx < 0)
            return flat.Length <= max ? flat : flat[..max].TrimEnd() + "…";

        var start = Math.Max(0, idx - radius);
        var end = Math.Min(flat.Length, idx + query.Length + radius);
        var slice = flat[start..end];
        if (start > 0) slice = "…" + slice;
        if (end < flat.Length) slice += "…";
        return slice.Length <= max ? slice : slice[..max].TrimEnd() + "…";
    }
}
