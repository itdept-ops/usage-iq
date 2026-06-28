using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using Ccusage.Api.Auth;
using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
using Ccusage.Api.Dtos;
using Ccusage.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Ccusage.Api.Endpoints;

/// <summary>
/// Hub Wrapped sharing — the AI narrative for the caller's OWN recap plus a PUBLIC, anonymous, PII-safe link to
/// a frozen "Year in the Hub" snapshot. Mirrors <see cref="ShareEndpoints"/>'s token security
/// (SHA-256-hashed key + AES-GCM-at-rest token + 404-indistinguishable on invalid/expired) but is scoped to a
/// Wrapped PERIOD rather than a usage filter.
///
/// SECURITY INVARIANTS (the whole point of this file):
/// <list type="bullet">
///   <item>PUBLIC-LINK PII — sensitive cards (weight / sleep / finance) are DEFAULT-EXCLUDED at create time
///   (see <see cref="SafeCardKeys"/>) and the public read FILTERS to the baked whitelist SERVER-SIDE, so an
///   excluded card can never reach an anonymous viewer. The owner/window/whitelist are baked from the caller
///   — the holder can NEVER widen them.</item>
///   <item>CACHED NARRATIVE — the narrative is generated ONCE at create time against ONLY the whitelisted
///   cards and frozen; the anonymous path serves that snapshot and makes NO live Gemini call (no
///   unauthenticated token spend / DoS).</item>
///   <item>AI is grounded strictly in the server-derived numbers (it never invents).</item>
///   <item>The owner is exposed as a DISPLAY NAME only (never an email).</item>
/// </list>
/// </summary>
public static class WrappedShareEndpoints
{
    /// <summary>The reuse-share rate-limit policy (shared with usage shares + bill splitter).</summary>
    private const string PublicRateLimitPolicy = "share";

    /// <summary>
    /// The PII-SAFE Wrapped card keys a public link MAY expose. This is the DEFAULT whitelist baked at create
    /// time. Sensitive cards are deliberately ABSENT and can never be added by a holder:
    /// <c>weight-delta</c> (body weight), <c>sleep</c> (sleep hours), <c>bills</c> (finance — Bill Splitter).
    /// (Wrapped has no location card.) Card keys come from <see cref="WrappedEndpoints.BuildCards"/>.
    /// </summary>
    public static readonly IReadOnlySet<string> SafeCardKeys = new HashSet<string>(StringComparer.Ordinal)
    {
        "days-tracked", "workouts", "protein", "calories-out", "steps",
        "hydration", "coffee", "hard", "trophies", "usage",
    };

    /// <summary>The sensitive card keys DEFAULT-EXCLUDED from any public Wrapped link (documentation/asserts).</summary>
    public static readonly IReadOnlySet<string> SensitiveCardKeys = new HashSet<string>(StringComparer.Ordinal)
    {
        "weight-delta", "sleep", "bills",
    };

    public static void MapWrappedShareEndpoints(this WebApplication app)
    {
        // =====================================================================================
        // GET /api/wrapped/narrative?period= — the caller's OWN recap narrative (authed, AI-gated, FLOORED).
        // Gated by tracker.self (page gate) AND tracker.ai (the token-spending capability, checked in-handler).
        // ALWAYS 200: a tracker.self caller without tracker.ai (or with AI unconfigured/errored) gets the
        // deterministic template floor — never a 503. Rate-limited under the "ai" policy.
        // =====================================================================================
        var narrative = app.MapGroup("/api/wrapped")
            .RequireAuthorization()
            .RequirePermission(Permissions.TrackerSelf)
            .RequireRateLimiting(AiEndpoints.RateLimitPolicy);

        narrative.MapGet("/narrative", async (
            string? period, CurrentUserAccessor me, UsageDbContext db, UsageQueries usage,
            WeeklyRecapComposer recap, GeminiService gemini, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var today = await TrackerVisibility.DisplayTzTodayAsync(db, ct);
            var (norm, from, to) = WrappedEndpoints.ResolveWindow(period, today);

            // Derive the SAME WrappedResponse the recap page uses (never client-sent), then narrate ALL its cards.
            var resp = await WrappedEndpoints.BuildWrappedAsync(db, usage, recap, caller.Email, norm, from, to, ct);
            var (text, insights, fellBack) = await NarrateAsync(gemini, caller, resp, resp.Cards, ct);
            return Results.Ok(new WrappedNarrativeDto { Narrative = text, Insights = insights, FellBackToPlain = fellBack });
        });

        // =====================================================================================
        // Management (authenticated; gated by shares.* — the same perms as usage shares).
        // =====================================================================================
        var shares = app.MapGroup("/api/wrapped/shares").RequireAuthorization();

        // ---- List the caller's OWN Wrapped shares ----
        shares.MapGet("/", async (CurrentUserAccessor me, UsageDbContext db, TokenProtector protector, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var list = await db.WrappedShareLinks.AsNoTracking()
                .Where(s => s.CreatedByEmail == caller.Email)
                .OrderByDescending(s => s.Id).ToListAsync(ct);
            var resolver = await BuildOwnerResolverAsync(db, list.Select(s => s.CreatedByEmail), ct);
            return Results.Ok(list.Select(s => ToDto(s, protector, resolver)));
        }).RequireAnyPermission(Permissions.SharesView, Permissions.SharesManage);

        // ---- Create a share for the CALLER's OWN recap only (owner/window/whitelist/narrative all baked here) ----
        shares.MapPost("/", async (
            CreateWrappedShareRequest req, CurrentUserAccessor me, UsageDbContext db, UsageQueries usage,
            WeeklyRecapComposer recap, GeminiService gemini, TokenProtector protector, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var today = await TrackerVisibility.DisplayTzTodayAsync(db, ct);
            var (norm, from, to) = WrappedEndpoints.ResolveWindow(req.Period, today);

            // Derive the OWNER's recap server-side (OwnerEmail is FORCED to the caller — no widening possible).
            var resp = await WrappedEndpoints.BuildWrappedAsync(db, usage, recap, caller.Email, norm, from, to, ct);

            // Bake the whitelist: the default PII-safe set, optionally narrowed (never widened) by req.CardKeys.
            // A requested key that isn't in the safe set (e.g. a sensitive card) is dropped.
            var whitelist = ResolveWhitelist(req.CardKeys);

            // The cards this link may expose, and the narrative generated against ONLY those (so it can't leak
            // a figure from an excluded sensitive card). The narrative is FROZEN here for the anonymous path.
            var publicCards = resp.Cards.Where(c => whitelist.Contains(c.Key)).ToList();
            var (narrativeText, insights, _) = await NarrateAsync(gemini, caller, resp, publicCards, ct);

            var token = GenerateToken();
            var lbl = req.Label?.Trim();
            var share = new WrappedShareLink
            {
                TokenHash = Hash(token),
                TokenEnc = protector.Protect(token),
                Label = string.IsNullOrEmpty(lbl) ? null : (lbl.Length > 120 ? lbl[..120] : lbl),
                CreatedByEmail = caller.Email,
                OwnerEmail = caller.Email,            // BAKED: the holder can never point this at anyone else.
                Period = norm,
                FromDate = from,
                ToDate = to,
                CardWhitelist = publicCards.Select(c => c.Key).ToArray(),
                NarrativeSnapshot = narrativeText,
                InsightsSnapshot = insights.ToArray(),
                CreatedUtc = DateTime.UtcNow,
                ExpiresUtc = DateTime.UtcNow.AddHours(Math.Clamp(req.ExpiresInHours, 1, 24 * 90)),
            };
            db.WrappedShareLinks.Add(share);
            await db.SaveChangesAsync(ct);

            // The full token is returned exactly once — only its hash is stored.
            return Results.Ok(new WrappedShareCreatedDto
            {
                Id = share.Id, Token = token, Path = $"/w/{token}", ExpiresUtc = share.ExpiresUtc, Label = share.Label,
            });
        }).RequirePermission(Permissions.SharesManage);

        // ---- Update (label / expiry) — caller's OWN share only ----
        shares.MapPut("/{id:int}", async (
            int id, UpdateWrappedShareRequest req, CurrentUserAccessor me, UsageDbContext db,
            TokenProtector protector, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var s = await db.WrappedShareLinks.FirstOrDefaultAsync(x => x.Id == id && x.CreatedByEmail == caller.Email, ct);
            if (s is null) return Results.NotFound();

            s.ExpiresUtc = DateTime.UtcNow.AddHours(Math.Clamp(req.ExpiresInHours, 1, 24 * 90));
            var lbl = req.Label?.Trim();
            s.Label = string.IsNullOrEmpty(lbl) ? null : (lbl.Length > 120 ? lbl[..120] : lbl);
            await db.SaveChangesAsync(ct);
            var resolver = await BuildOwnerResolverAsync(db, new[] { s.CreatedByEmail }, ct);
            return Results.Ok(ToDto(s, protector, resolver));
        }).RequirePermission(Permissions.SharesManage);

        // ---- Delete — caller's OWN share only ----
        shares.MapDelete("/{id:int}", async (int id, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            return await db.WrappedShareLinks.Where(s => s.Id == id && s.CreatedByEmail == caller.Email)
                .ExecuteDeleteAsync(ct) > 0
                ? Results.NoContent() : Results.NotFound();
        }).RequirePermission(Permissions.SharesManage);

        // ---- Per-view detail (who/when) for the caller's OWN share ----
        shares.MapGet("/{id:int}/accesses", async (int id, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var owns = await db.WrappedShareLinks.AsNoTracking()
                .AnyAsync(s => s.Id == id && s.CreatedByEmail == caller.Email, ct);
            if (!owns) return Results.NotFound();
            return Results.Ok(await db.ShareAccesses.AsNoTracking()
                .Where(a => a.WrappedShareLinkId == id)
                .OrderByDescending(a => a.Id).Take(100)
                .Select(a => new ShareAccessDto { WhenUtc = a.WhenUtc, Ip = a.Ip })
                .ToListAsync(ct));
        }).RequireAnyPermission(Permissions.SharesView, Permissions.SharesManage);

        // =====================================================================================
        // PUBLIC, anonymous, rate-limited read of a valid (non-expired) Wrapped link.
        // Rebuilds the recap SERVER-SIDE from the BAKED owner+window (holder can't widen), FILTERS to the baked
        // whitelist, serves the CACHED narrative snapshot (NO live Gemini call), exposes the owner's display
        // NAME only, and is 404-INDISTINGUISHABLE on invalid/expired. Access recording never 500s a valid read.
        // =====================================================================================
        app.MapGet("/api/share/wrapped/{token}", async (
            string token, HttpContext http, UsageDbContext db, UsageQueries usage, WeeklyRecapComposer recap,
            ILoggerFactory lf, CancellationToken ct) =>
        {
            var share = await db.WrappedShareLinks.AsNoTracking().FirstOrDefaultAsync(s => s.TokenHash == Hash(token), ct);
            if (share is null || share.ExpiresUtc <= DateTime.UtcNow)
                return Results.NotFound(); // invalid or expired — indistinguishable to the caller

            // Rebuild the recap from the BAKED owner + window. The holder supplies NOTHING that influences this.
            var resp = await WrappedEndpoints.BuildWrappedAsync(
                db, usage, recap, share.OwnerEmail, share.Period, share.FromDate, share.ToDate, ct);

            // FILTER to the baked whitelist SERVER-SIDE — a sensitive card can never reach the anonymous viewer.
            var whitelist = share.CardWhitelist.ToHashSet(StringComparer.Ordinal);
            var cards = resp.Cards
                .Where(c => whitelist.Contains(c.Key))
                .Select(c => new PublicWrappedCardDto
                {
                    Key = c.Key, Headline = c.Headline, Label = c.Label, Sub = c.Sub, Accent = c.Accent,
                })
                .ToList();

            var dto = new PublicWrappedDto
            {
                Label = share.Label,
                OwnerName = resp.UserName,           // DisplayName.Format — NEVER an email.
                Period = share.Period,
                FromDate = share.FromDate.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
                ToDate = share.ToDate.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
                GeneratedAtUtc = DateTime.UtcNow,
                ExpiresUtc = share.ExpiresUtc,
                Cards = cards,
                Narrative = share.NarrativeSnapshot,  // CACHED snapshot — NO live Gemini call on this path.
                Insights = share.InsightsSnapshot,
            };

            // Best-effort access recording — a concurrent revoke / write error must never 500 a valid read.
            try
            {
                await db.WrappedShareLinks.Where(s => s.Id == share.Id).ExecuteUpdateAsync(u => u
                    .SetProperty(x => x.AccessCount, x => x.AccessCount + 1)
                    .SetProperty(x => x.LastAccessedUtc, _ => DateTime.UtcNow), ct);

                db.ShareAccesses.Add(new ShareAccess
                {
                    WrappedShareLinkId = share.Id,
                    WhenUtc = DateTime.UtcNow,
                    Ip = http.Connection.RemoteIpAddress?.ToString(),
                });
                await db.SaveChangesAsync(ct);
            }
            catch (Exception ex)
            {
                lf.CreateLogger("WrappedShareAccess").LogWarning(ex, "Failed to record Wrapped share access.");
            }

            return Results.Ok(dto);
        }).AllowAnonymous().RequireRateLimiting(PublicRateLimitPolicy);
    }

    // =====================================================================================
    // Narration — grounds the AI strictly in the derived Wrapped cards, with a deterministic floor.
    // =====================================================================================

    /// <summary>
    /// Narrate the supplied (already PII-filtered) <paramref name="cards"/> for <paramref name="owner"/>'s recap.
    /// Prefers the warm AI narrative ONLY when the owner holds <see cref="Permissions.TrackerAi"/> AND Gemini is
    /// configured; otherwise (or on AI failure) returns the deterministic <see cref="PlainNarrative"/> floor with
    /// fellBack=true. The AI is fed ONLY the supplied cards' headlines/labels (never a figure from an excluded
    /// card). NEVER throws / NEVER 503s.
    /// </summary>
    private static async Task<(string Narrative, IReadOnlyList<string> Insights, bool FellBack)> NarrateAsync(
        GeminiService gemini, CurrentUserAccessor.CurrentUser owner, WrappedEndpoints.WrappedResponse resp,
        IReadOnlyList<WrappedEndpoints.WrappedCard> cards, CancellationToken ct)
    {
        var plain = PlainNarrative(resp, cards);

        if (!owner.Permissions.Contains(Permissions.TrackerAi) || !gemini.IsConfigured)
            return (plain, Array.Empty<string>(), true);

        TrackerRecapResult? ai;
        try { ai = await gemini.WrappedNarrativeAsync(WrappedFacts(resp, cards), ct); }
        catch { ai = null; }

        if (ai is null || string.IsNullOrWhiteSpace(ai.Narrative))
            return (plain, Array.Empty<string>(), true);
        return (ai.Narrative, ai.Insights, false);
    }

    /// <summary>The model-facing facts: ONLY the supplied cards' headline+label+sub lines. No email, no figure
    /// from an excluded card (the caller passes the already-filtered set).</summary>
    private static string WrappedFacts(WrappedEndpoints.WrappedResponse resp, IReadOnlyList<WrappedEndpoints.WrappedCard> cards)
    {
        var sb = new StringBuilder();
        sb.Append("Period: ").Append(resp.Period)
          .Append(" (").Append(resp.FromDate).Append(" to ").Append(resp.ToDate).Append(").\n");
        foreach (var c in cards)
        {
            sb.Append("- ").Append(c.Label).Append(": ").Append(c.Headline);
            if (!string.IsNullOrWhiteSpace(c.Sub)) sb.Append(" (").Append(c.Sub).Append(')');
            sb.Append('\n');
        }
        return sb.ToString();
    }

    /// <summary>The GUARANTEED deterministic floor: a warm one-liner over the supplied cards. NEVER 503s.</summary>
    private static string PlainNarrative(WrappedEndpoints.WrappedResponse resp, IReadOnlyList<WrappedEndpoints.WrappedCard> cards)
    {
        var label = resp.Period switch { "year" => "this year", "all" => "all time", _ => "this period" };
        if (cards.Count == 0)
            return $"Your Hub recap for {label} is just getting started — log a few things and watch the story grow.";
        var bits = cards.Take(3).Select(c => $"{c.Headline} {c.Label.ToLowerInvariant()}");
        return $"What a run {label}: " + string.Join(", ", bits) + ". Nicely done.";
    }

    // =====================================================================================
    // Whitelist + token + owner-resolution helpers (mirror ShareEndpoints).
    // =====================================================================================

    /// <summary>Resolve the baked whitelist: the default PII-safe set, optionally NARROWED (never widened) to a
    /// requested subset. Any requested key not in <see cref="SafeCardKeys"/> (e.g. a sensitive card) is dropped.</summary>
    private static HashSet<string> ResolveWhitelist(string[]? requested)
    {
        if (requested is null or { Length: 0 })
            return SafeCardKeys.ToHashSet(StringComparer.Ordinal);
        return requested.Where(k => SafeCardKeys.Contains(k)).ToHashSet(StringComparer.Ordinal);
    }

    private static string GenerateToken() =>
        Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)).Replace('+', '-').Replace('/', '_').TrimEnd('=');

    private static string Hash(string token) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token)));

    private static WrappedShareDto ToDto(WrappedShareLink s, TokenProtector protector,
        IReadOnlyDictionary<string, (int Id, string Name)> owners)
    {
        var token = protector.Unprotect(s.TokenEnc);
        var (id, name) = ResolveOwner(s.CreatedByEmail, owners);
        return new()
        {
            Id = s.Id, Label = s.Label,
            Path = token is null ? null : $"/w/{token}",
            CreatedByUserId = id, CreatedByName = name,
            Period = s.Period,
            CreatedUtc = s.CreatedUtc, ExpiresUtc = s.ExpiresUtc, Expired = s.ExpiresUtc <= DateTime.UtcNow,
            AccessCount = s.AccessCount, LastAccessedUtc = s.LastAccessedUtc,
            Cards = s.CardWhitelist, Scope = Describe(s),
        };
    }

    private static string Describe(WrappedShareLink s)
    {
        var window = s.Period switch
        {
            "year" => $"{s.FromDate:MMM d, yyyy}–{s.ToDate:MMM d, yyyy}",
            "all" => "all time",
            _ => $"{s.FromDate:MMM d}–{s.ToDate:MMM d}",
        };
        return $"{window} · {s.CardWhitelist.Length} card{(s.CardWhitelist.Length == 1 ? "" : "s")}";
    }

    /// <summary>Resolve creator emails to {AppUser.Id, display name}. The raw email is NEVER exposed.</summary>
    private static async Task<IReadOnlyDictionary<string, (int Id, string Name)>> BuildOwnerResolverAsync(
        UsageDbContext db, IEnumerable<string> emails, CancellationToken ct)
    {
        var lower = emails.Where(e => !string.IsNullOrEmpty(e)).Select(e => e.ToLowerInvariant()).Distinct().ToList();
        if (lower.Count == 0)
            return new Dictionary<string, (int, string)>(StringComparer.OrdinalIgnoreCase);
        return (await db.Users.AsNoTracking()
                .Where(u => lower.Contains(u.Email))
                .Select(u => new { u.Id, u.Email, u.Name, u.DisplayNameMode, u.Nickname }).ToListAsync(ct))
            .GroupBy(u => u.Email, StringComparer.OrdinalIgnoreCase)
            .ToDictionary(
                g => g.Key,
                g => (g.First().Id, DisplayName.Format(g.First().Name, g.First().DisplayNameMode, g.First().Nickname)),
                StringComparer.OrdinalIgnoreCase);
    }

    private static (int? Id, string Name) ResolveOwner(
        string email, IReadOnlyDictionary<string, (int Id, string Name)> owners)
    {
        if (!string.IsNullOrEmpty(email) && owners.TryGetValue(email, out var u))
            return (u.Id, string.IsNullOrEmpty(u.Name) ? "Unknown user" : u.Name);
        return (null, "Unknown user");
    }
}
