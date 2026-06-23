using Ccusage.Api.Auth;
using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
using Ccusage.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Ccusage.Api.Endpoints;

/// <summary>
/// CRUD for the caller's OWN automation rules (<c>/api/automations</c>) — the management side of the
/// automations engine. STRICTLY owner-scoped: every read/write filters/sets <c>OwnerEmail == caller.Email</c>,
/// so a caller can only ever see/create/edit/delete THEIR OWN rules (another user's rule reads as 404, never
/// revealing its existence). DTOs carry NO email/webhook/secret — only the rule's own safe configuration.
///
/// VIEW/MANAGE gate: <see cref="Permissions.AutomationsUse"/> — a deliberate grant (a rule may carry the
/// owner's OWN Discord webhook). A rule is self-scoped (own events -> own channels), so no broader capability
/// is exposed; the triggers come from tracker/75-Hard actions.
/// </summary>
public static class RulesEndpoints
{
    /// <summary>The wire shape of a rule. No email/webhook/secret — only a <see cref="HasWebhook"/> flag tells
    /// the client whether a per-rule webhook is configured (the URL itself is NEVER returned).</summary>
    public sealed record RuleDto(
        int Id, string Name, string TriggerKind, RuleConditionOp ConditionOp, int? ConditionValue,
        RuleAction Action, string? MessageTemplate, bool Enabled, bool HasWebhook,
        DateTime CreatedUtc, DateTime UpdatedUtc);

    /// <summary>
    /// Create/update body. OwnerEmail is NEVER accepted from the client — it is the caller.
    /// <para><see cref="WebhookUrl"/> follows the same contract as the per-user webhook:
    /// <c>null</c> = leave as-is (on create: no webhook) · <c>""</c> = clear · a value = validate
    /// (SSRF-allowlisted to Discord) + encrypt + store. The plaintext URL is never echoed back.</para>
    /// </summary>
    public sealed record RuleUpsertRequest(
        string? Name, string TriggerKind, RuleConditionOp ConditionOp, int? ConditionValue,
        RuleAction Action, string? MessageTemplate, bool Enabled, string? WebhookUrl = null);

    private static readonly HashSet<string> ValidKinds = new(StringComparer.Ordinal)
    {
        ActivityEmitter.Kinds.WorkoutLogged,
        ActivityEmitter.Kinds.ChallengeDayComplete,
        ActivityEmitter.Kinds.ChallengeStarted,
        ActivityEmitter.Kinds.HydrationGoalHit,
    };

    private const int MaxName = 80;

    public static void MapRulesEndpoints(this WebApplication app)
    {
        var g = app.MapGroup("/api/automations")
            .RequireAuthorization()
            .RequirePermission(Permissions.AutomationsUse);

        // ---- GET /api/automations : the caller's OWN rules, newest-first ----
        g.MapGet("/", async (CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!.Email.ToLowerInvariant();
            var rows = await db.AutomationRules.AsNoTracking()
                .Where(r => r.OwnerEmail == caller)
                .OrderByDescending(r => r.Id)
                .ToListAsync(ct);
            return Results.Ok(rows.Select(ToDto).ToList());
        });

        // ---- POST /api/automations : create a rule owned by the caller ----
        g.MapPost("/", async (
            RuleUpsertRequest req, CurrentUserAccessor me, UsageDbContext db, TokenProtector protector,
            CancellationToken ct) =>
        {
            if (Validate(req) is { } err) return Results.BadRequest(new { message = err });

            var caller = (await me.GetUserAsync(ct))!.Email.ToLowerInvariant();
            var now = DateTime.UtcNow;
            var rule = new AutomationRule
            {
                OwnerEmail = caller, // ALWAYS the caller — never accepted from the body.
                Name = CleanName(req.Name, req.TriggerKind),
                TriggerKind = req.TriggerKind,
                ConditionOp = req.ConditionOp,
                ConditionValue = req.ConditionOp == RuleConditionOp.None ? null : req.ConditionValue,
                Action = req.Action,
                MessageTemplate = RuleEvaluator.Sanitize(req.MessageTemplate),
                Enabled = req.Enabled,
                CreatedUtc = now,
                UpdatedUtc = now,
            };
            // Per-rule webhook: null/"" = none; a value is SSRF-validated to Discord + encrypted (never stored
            // in plaintext, never echoed). An invalid (non-Discord) URL is a 400 — no arbitrary host.
            if (ApplyWebhook(req.WebhookUrl, rule, protector) is { } whErr)
                return Results.BadRequest(new { message = whErr });

            db.AutomationRules.Add(rule);
            await db.SaveChangesAsync(ct);
            return Results.Ok(ToDto(rule));
        });

        // ---- PUT /api/automations/{id} : update — only a row the caller owns (else 404) ----
        g.MapPut("/{id:int}", async (
            int id, RuleUpsertRequest req, CurrentUserAccessor me, UsageDbContext db, TokenProtector protector,
            CancellationToken ct) =>
        {
            if (Validate(req) is { } err) return Results.BadRequest(new { message = err });

            var caller = (await me.GetUserAsync(ct))!.Email.ToLowerInvariant();
            // Owner check is part of the filter: another user's row is simply not found (no existence leak).
            var rule = await db.AutomationRules
                .FirstOrDefaultAsync(r => r.Id == id && r.OwnerEmail == caller, ct);
            if (rule is null) return Results.NotFound();

            rule.Name = CleanName(req.Name, req.TriggerKind);
            rule.TriggerKind = req.TriggerKind;
            rule.ConditionOp = req.ConditionOp;
            rule.ConditionValue = req.ConditionOp == RuleConditionOp.None ? null : req.ConditionValue;
            rule.Action = req.Action;
            rule.MessageTemplate = RuleEvaluator.Sanitize(req.MessageTemplate);
            rule.Enabled = req.Enabled;
            // null = leave the existing webhook · "" = clear · a value = validate (Discord-only) + encrypt.
            if (ApplyWebhook(req.WebhookUrl, rule, protector) is { } whErr)
                return Results.BadRequest(new { message = whErr });
            rule.UpdatedUtc = DateTime.UtcNow;
            await db.SaveChangesAsync(ct);
            return Results.Ok(ToDto(rule));
        });

        // ---- DELETE /api/automations/{id} : delete — only a row the caller owns (else 404) ----
        g.MapDelete("/{id:int}", async (
            int id, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!.Email.ToLowerInvariant();
            var rule = await db.AutomationRules
                .FirstOrDefaultAsync(r => r.Id == id && r.OwnerEmail == caller, ct);
            if (rule is null) return Results.NotFound();

            db.AutomationRules.Remove(rule);
            await db.SaveChangesAsync(ct);
            return Results.NoContent();
        });
    }

    /// <summary>Returns an error message if the body is invalid, else null. Enforces the fixed safe enums +
    /// a known trigger kind + a sane condition value.</summary>
    private static string? Validate(RuleUpsertRequest req)
    {
        if (string.IsNullOrWhiteSpace(req.TriggerKind) || !ValidKinds.Contains(req.TriggerKind))
            return "Unknown trigger.";
        if (!Enum.IsDefined(req.ConditionOp)) return "Invalid condition.";
        if (!Enum.IsDefined(req.Action)) return "Invalid action.";
        if (req.ConditionOp != RuleConditionOp.None && req.ConditionValue is null)
            return "A condition value is required for this condition.";
        return null;
    }

    /// <summary>
    /// Applies the webhook contract to <paramref name="rule"/>: <c>null</c> = leave as-is, <c>""</c>/whitespace
    /// = clear, a value = SSRF-validate to a Discord host then AES-GCM encrypt (never stored in plaintext, never
    /// returned). Returns an error message on an invalid (non-Discord) URL, else null. NEVER logs the URL.
    /// </summary>
    private static string? ApplyWebhook(string? webhookUrl, AutomationRule rule, TokenProtector protector)
    {
        if (webhookUrl is null) return null; // leave as-is.
        var url = webhookUrl.Trim();
        if (url.Length == 0)
        {
            rule.WebhookEnc = null; // explicit clear.
            return null;
        }
        if (!DiscordWebhookValidator.IsValid(url))
            return "Enter a valid Discord webhook URL (https://discord.com/api/webhooks/…).";
        rule.WebhookEnc = protector.Protect(url); // encrypt at rest; the plaintext never leaves this method.
        return null;
    }

    private static string CleanName(string? name, string triggerKind)
    {
        var n = (name ?? "").Trim();
        if (n.Length == 0) n = DefaultName(triggerKind);
        return n.Length > MaxName ? n[..MaxName] : n;
    }

    private static string DefaultName(string kind) => kind switch
    {
        ActivityEmitter.Kinds.WorkoutLogged => "When I log a workout",
        ActivityEmitter.Kinds.ChallengeDayComplete => "When I complete a 75-Hard day",
        ActivityEmitter.Kinds.ChallengeStarted => "When I start 75-Hard",
        ActivityEmitter.Kinds.HydrationGoalHit => "When I hit my water goal",
        _ => "Automation",
    };

    private static RuleDto ToDto(AutomationRule r) => new(
        r.Id, r.Name, r.TriggerKind, r.ConditionOp, r.ConditionValue, r.Action,
        r.MessageTemplate, r.Enabled, r.WebhookEnc is { Length: > 0 }, r.CreatedUtc, r.UpdatedUtc);
}
