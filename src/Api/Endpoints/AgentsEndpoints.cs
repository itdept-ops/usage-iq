using Ccusage.Api.Auth;
using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
using Ccusage.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Ccusage.Api.Endpoints;

/// <summary>
/// Self-scoped CRUD + actions for the caller's OWN proactive scheduled agents (<c>/api/agents</c>). STRICTLY
/// owner-scoped: every read/write keys on <c>UserEmail == caller.Email</c>, so a caller only ever sees/edits
/// THEIR OWN agent prefs. Gated by <see cref="Permissions.AgentsUse"/> (a deliberate grant). The AI narrative
/// a kind may use stays gated on the EXISTING AI keys (family.ai / finance.ai), checked inside the composer —
/// never on this page gate.
///
/// <list type="bullet">
///   <item>GET <c>/api/agents</c> — the caller's prefs for every kind, upserting a disabled default row per
///   kind on first read (mirrors notification preferences).</item>
///   <item>PUT <c>/api/agents/{kind}</c> — upsert enabled / deliver-hour / quiet-hours / timezone (validated).</item>
///   <item>POST <c>/api/agents/{kind}/preview</c> — render the deterministic floor NOW, ignoring
///   quiet-hours/idempotency: <c>{ text, link, fellBackToPlain }</c>.</item>
///   <item>POST <c>/api/agents/{kind}/test</c> — deliver a real one-off nudge via the bell (+ opt-in push).</item>
/// </list>
/// </summary>
public static class AgentsEndpoints
{
    /// <summary>The wire shape of one agent preference row.</summary>
    public sealed record AgentDto(
        string Kind, bool Enabled, int DeliverHourLocal,
        int? QuietStartLocalHour, int? QuietEndLocalHour, string TimeZone);

    /// <summary>Create/update body. The kind comes from the route; the email is ALWAYS the caller.</summary>
    public sealed record AgentInput(
        bool Enabled, int DeliverHourLocal,
        int? QuietStartLocalHour, int? QuietEndLocalHour, string? TimeZone);

    /// <summary>The result of a preview render: the would-be nudge text + whether it fell back to the plain floor.</summary>
    public sealed record PreviewDto(string Text, string Link, bool FellBackToPlain);

    public static void MapAgentsEndpoints(this WebApplication app)
    {
        var g = app.MapGroup("/api/agents")
            .RequireAuthorization()
            .RequirePermission(Permissions.AgentsUse);

        // ---- GET /api/agents : the caller's prefs for every kind (upserting defaults on first read) ----
        g.MapGet("/", async (CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var email = (await me.GetUserAsync(ct))!.Email.ToLowerInvariant();
            var existing = await db.ScheduledAgents
                .Where(a => a.UserEmail == email)
                .ToDictionaryAsync(a => a.Kind, ct);

            var now = DateTime.UtcNow;
            var created = false;
            foreach (var kind in AllKinds)
            {
                if (existing.ContainsKey(kind)) continue;
                var row = DefaultFor(email, kind, now);
                db.ScheduledAgents.Add(row);
                existing[kind] = row;
                created = true;
            }
            if (created)
            {
                try { await db.SaveChangesAsync(ct); }
                catch (DbUpdateException) { db.ChangeTracker.Clear(); } // concurrent first-read seeded it; reload below
            }

            var rows = await db.ScheduledAgents.AsNoTracking()
                .Where(a => a.UserEmail == email)
                .ToListAsync(ct);
            return Results.Ok(AllKinds
                .Select(k => rows.FirstOrDefault(r => r.Kind == k) ?? DefaultFor(email, k, now))
                .Select(ToDto)
                .ToList());
        });

        // ---- PUT /api/agents/{kind} : upsert the caller's pref for one kind ----
        g.MapPut("/{kind}", async (
            string kind, AgentInput req, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            if (!TryParseKind(kind, out var parsed)) return Results.NotFound();
            if (Validate(req) is { } err) return Results.BadRequest(new { message = err });

            var email = (await me.GetUserAsync(ct))!.Email.ToLowerInvariant();
            var now = DateTime.UtcNow;
            var row = await db.ScheduledAgents
                .FirstOrDefaultAsync(a => a.UserEmail == email && a.Kind == parsed, ct);
            if (row is null)
            {
                row = DefaultFor(email, parsed, now);
                db.ScheduledAgents.Add(row);
            }

            row.Enabled = req.Enabled;
            row.DeliverHourLocal = req.DeliverHourLocal;
            row.QuietStartLocalHour = req.QuietStartLocalHour;
            row.QuietEndLocalHour = req.QuietEndLocalHour;
            row.TimeZone = NormalizeTimeZone(req.TimeZone);
            row.UpdatedUtc = now;
            await db.SaveChangesAsync(ct);
            return Results.Ok(ToDto(row));
        });

        // ---- POST /api/agents/{kind}/preview : render the deterministic floor NOW (ignores quiet/idempotency) ----
        g.MapPost("/{kind}/preview", async (
            string kind, CurrentUserAccessor me, UsageDbContext db, AgentComposer composer, CancellationToken ct) =>
        {
            if (!TryParseKind(kind, out var parsed)) return Results.NotFound();
            var caller = (await me.GetUserAsync(ct))!;
            var email = caller.Email.ToLowerInvariant();

            // Use the caller's saved row for timezone/hour context if present, else a default (preview ignores
            // the deliver-hour/quiet-hours/idempotency — it just renders what the nudge WOULD say right now).
            var row = await db.ScheduledAgents.AsNoTracking()
                .FirstOrDefaultAsync(a => a.UserEmail == email && a.Kind == parsed, ct)
                ?? DefaultFor(email, parsed, DateTime.UtcNow);

            var nudge = await composer.ComposeAsync(db, row, DateTime.UtcNow, ct);
            return nudge is null
                ? Results.Ok(new PreviewDto(NothingToSay(parsed), LinkFor(parsed), true))
                : Results.Ok(new PreviewDto(nudge.Text, nudge.Link, nudge.FellBackToPlain));
        });

        // ---- POST /api/agents/{kind}/test : deliver a real one-off nudge to the caller's bell ----
        g.MapPost("/{kind}/test", async (
            string kind, CurrentUserAccessor me, UsageDbContext db, AgentComposer composer,
            ChatNotificationService notifier, CancellationToken ct) =>
        {
            if (!TryParseKind(kind, out var parsed)) return Results.NotFound();
            var email = (await me.GetUserAsync(ct))!.Email.ToLowerInvariant();

            var row = await db.ScheduledAgents.AsNoTracking()
                .FirstOrDefaultAsync(a => a.UserEmail == email && a.Kind == parsed, ct)
                ?? DefaultFor(email, parsed, DateTime.UtcNow);

            var nudge = await composer.ComposeAsync(db, row, DateTime.UtcNow, ct);
            if (nudge is null)
                return Results.Ok(new { delivered = false, message = NothingToSay(parsed) });

            // A test is an explicit user action — deliver it like a real one-off (bell + opt-in push). The
            // idempotency stamps are deliberately NOT touched (a test must never suppress the real scheduled run).
            await notifier.NotifySystem(new[] { email }, NotificationType.AgentNudge, nudge.Text, nudge.Link, ct);
            return Results.Ok(new { delivered = true, text = nudge.Text });
        });
    }

    private static readonly ScheduledAgentKind[] AllKinds = Enum.GetValues<ScheduledAgentKind>();

    /// <summary>The wire name of a kind (camelCase-ish; matches the enum member, lower-cased).</summary>
    private static string KindName(ScheduledAgentKind k) => k switch
    {
        ScheduledAgentKind.MorningBriefing => "morningBriefing",
        ScheduledAgentKind.StreakRescue => "streakRescue",
        ScheduledAgentKind.BudgetAlert => "budgetAlert",
        ScheduledAgentKind.LowStaples => "lowStaples",
        _ => k.ToString(),
    };

    private static bool TryParseKind(string raw, out ScheduledAgentKind kind)
    {
        foreach (var k in AllKinds)
        {
            if (string.Equals(KindName(k), raw, StringComparison.OrdinalIgnoreCase))
            {
                kind = k;
                return true;
            }
        }
        kind = default;
        return false;
    }

    private static ScheduledAgent DefaultFor(string email, ScheduledAgentKind kind, DateTime now) => new()
    {
        UserEmail = email,
        Kind = kind,
        Enabled = false,
        DeliverHourLocal = DefaultHour(kind),
        TimeZone = "America/New_York",
        CreatedUtc = now,
        UpdatedUtc = now,
    };

    /// <summary>A sensible default deliver hour per kind (morning briefing at 7am; streak rescue late at 8pm;
    /// budget alert mid-morning; low staples late afternoon).</summary>
    private static int DefaultHour(ScheduledAgentKind kind) => kind switch
    {
        ScheduledAgentKind.MorningBriefing => 7,
        ScheduledAgentKind.StreakRescue => 20,
        ScheduledAgentKind.BudgetAlert => 9,
        ScheduledAgentKind.LowStaples => 17,
        _ => 9,
    };

    private static string LinkFor(ScheduledAgentKind kind) => kind switch
    {
        ScheduledAgentKind.MorningBriefing => "/family/today",
        ScheduledAgentKind.StreakRescue => "/challenge",
        ScheduledAgentKind.BudgetAlert => "/family/finance",
        ScheduledAgentKind.LowStaples => "/grocery",
        _ => "/",
    };

    /// <summary>The friendly "nothing to nudge about right now" preview line per kind.</summary>
    private static string NothingToSay(ScheduledAgentKind kind) => kind switch
    {
        ScheduledAgentKind.MorningBriefing => "No household briefing yet — join or set up your Family Hub first.",
        ScheduledAgentKind.StreakRescue => "Nothing to rescue — today's tasks are done (or no active challenge).",
        ScheduledAgentKind.BudgetAlert => "No spending recorded this month yet.",
        ScheduledAgentKind.LowStaples => "Your shopping list is all stocked up.",
        _ => "Nothing to share right now.",
    };

    /// <summary>Validate an upsert body: hour 0–23 and, when a quiet window is set, BOTH bounds present + 0–23.</summary>
    private static string? Validate(AgentInput req)
    {
        if (req.DeliverHourLocal is < 0 or > 23) return "Deliver hour must be between 0 and 23.";
        var hasStart = req.QuietStartLocalHour is not null;
        var hasEnd = req.QuietEndLocalHour is not null;
        if (hasStart != hasEnd) return "Set both quiet-hours bounds, or neither.";
        if (req.QuietStartLocalHour is < 0 or > 23) return "Quiet-hours start must be between 0 and 23.";
        if (req.QuietEndLocalHour is < 0 or > 23) return "Quiet-hours end must be between 0 and 23.";
        return null;
    }

    private static string NormalizeTimeZone(string? tz)
    {
        var id = (tz ?? "").Trim();
        if (id.Length == 0) return "America/New_York";
        try { _ = TimeZoneInfo.FindSystemTimeZoneById(id); return id; }
        catch { return "America/New_York"; } // unknown id → safe default (never throws on save)
    }

    private static AgentDto ToDto(ScheduledAgent a) => new(
        KindName(a.Kind), a.Enabled, a.DeliverHourLocal,
        a.QuietStartLocalHour, a.QuietEndLocalHour, a.TimeZone);
}
