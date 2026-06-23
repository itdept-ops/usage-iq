using System.Text.RegularExpressions;
using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
using Microsoft.EntityFrameworkCore;

namespace Ccusage.Api.Services;

/// <summary>
/// Evaluates an actor's OWN automation rules against a just-persisted activity event and runs each matching
/// action against ONLY that actor's own channels. Invoked as a fire-and-forget TAIL of
/// <see cref="ActivityEmitter.EmitAsync"/> (after the event row is saved, while the actor is already known to be a
/// sharing, enabled user), reusing the emitter's already-open DI scope.
///
/// SAFETY (mirrors the emitter's never-block/never-fail discipline):
/// <list type="bullet">
///   <item>SELF-SCOPED ONLY: loads rules WHERE OwnerEmail == actor, and every action's only recipient is that
///   same owner. Cross-user delivery is structurally impossible — there is no path that takes another email.</item>
///   <item>NEVER THROWS into the caller: the whole body is wrapped in try/catch and swallowed; an evaluation or
///   action failure must never fail the underlying activity emit (which itself must never fail the user action).</item>
///   <item>NO SECRET/EMAIL LEAK: actions reuse the existing senders (<see cref="DiscordForwarder"/> resolves +
///   decrypts the owner's own webhook in-memory; <see cref="ChatNotificationService"/> writes a self-notification).
///   No webhook URL, secret, or email is ever logged or returned. Logs carry the rule id + kind only.</item>
///   <item>FIXED SAFE ACTIONS: the action is a closed enum; the message is a capped, sanitized template
///   (@everyone/@here stripped) — never a user-supplied URL or endpoint.</item>
/// </list>
/// </summary>
public sealed class RuleEvaluator(
    UsageDbContext db, ChatNotificationService chat, DiscordForwarder discord, ILogger<RuleEvaluator> log)
{
    private const int MaxMessage = 200;

    /// <summary>
    /// Run the actor's enabled rules for <paramref name="kind"/>. <paramref name="actor"/> is already trimmed +
    /// lower-cased and confirmed to be a sharing, enabled user by the caller. Never throws.
    /// </summary>
    public async Task EvaluateAsync(
        string actor, string kind, int? intValue, string? label, CancellationToken ct = default)
    {
        try
        {
            if (string.IsNullOrEmpty(actor) || string.IsNullOrEmpty(kind)) return;

            // Hot read keyed on the (OwnerEmail, TriggerKind) index: ONLY this actor's own rules.
            var rules = await db.AutomationRules.AsNoTracking()
                .Where(r => r.OwnerEmail == actor && r.TriggerKind == kind && r.Enabled)
                .ToListAsync(ct);
            if (rules.Count == 0) return;

            foreach (var rule in rules)
            {
                if (!ConditionMet(rule.ConditionOp, rule.ConditionValue, intValue)) continue;

                var msg = RenderTemplate(rule.MessageTemplate, kind, intValue, label);

                // Each branch's only recipient is the rule's OWN owner (== actor). No cross-user path exists.
                switch (rule.Action)
                {
                    case RuleAction.InAppNotify:
                        await chat.NotifySystem(new[] { actor }, NotificationType.SystemAutomation, msg, link: null, ct);
                        break;
                    case RuleAction.DiscordDm:
                        // Enqueue a self-forward. If the rule carries its OWN webhook, the forwarder decrypts +
                        // validates + posts THERE (its own opt-in); otherwise it falls back to the owner's
                        // per-user webhook (gated on SurfaceDiscord). Decrypt + rate-limit + never-throw all
                        // happen inside the forwarder. The encrypted blob (never plaintext) rides the channel.
                        discord.Enqueue(new DiscordForwardItem(
                            actor, "systemAutomation", "Usage IQ", msg, null, rule.WebhookEnc));
                        break;
                    case RuleAction.NotifyAndDiscord:
                        if (rule.WebhookEnc is { Length: > 0 })
                        {
                            // The rule has its OWN webhook: persist the in-app row WITHOUT NotifySystem's per-user
                            // Discord mirror (suppressed), then post the Discord half explicitly to the rule's
                            // webhook — so we never double-post (per-user mirror + rule webhook).
                            await chat.NotifySystem(new[] { actor }, NotificationType.SystemAutomation, msg,
                                link: null, ct, suppressDiscordMirror: true);
                            discord.Enqueue(new DiscordForwardItem(
                                actor, "systemAutomation", "Usage IQ", msg, null, rule.WebhookEnc));
                        }
                        else
                        {
                            // No rule webhook: NotifySystem persists the in-app row AND mirrors to the owner's
                            // per-user Discord when SurfaceDiscord is on (the existing #104 behavior).
                            await chat.NotifySystem(new[] { actor }, NotificationType.SystemAutomation, msg, link: null, ct);
                        }
                        break;
                }
            }
        }
        catch (Exception ex)
        {
            // Fire-and-forget: a rule failure must NEVER bubble into the emit caller (and thence the user action).
            log.LogWarning(ex, "RuleEvaluator.EvaluateAsync failed for kind {Kind}; swallowed.", kind);
        }
    }

    /// <summary>True when the rule's optional numeric condition holds. None => always; numeric ops require a
    /// non-null event IntValue (kinds with no numeric payload never match a numeric op).</summary>
    public static bool ConditionMet(RuleConditionOp op, int? threshold, int? eventValue)
    {
        if (op == RuleConditionOp.None) return true;
        if (eventValue is not { } v || threshold is not { } t) return false;
        return op switch
        {
            RuleConditionOp.Gte => v >= t,
            RuleConditionOp.Lte => v <= t,
            RuleConditionOp.Eq => v == t,
            _ => false,
        };
    }

    /// <summary>Build the message: the owner's sanitized template (with <c>{value}</c> substituted), or a
    /// default per-kind sentence. Never contains @everyone/@here.</summary>
    public static string RenderTemplate(string? template, string kind, int? intValue, string? label)
    {
        var clean = Sanitize(template);
        if (string.IsNullOrEmpty(clean)) return DefaultMessage(kind, intValue, label);

        var rendered = clean.Replace("{value}", intValue?.ToString() ?? "", StringComparison.Ordinal);
        // Sanitize again post-substitution (defense in depth) and cap.
        rendered = Sanitize(rendered) ?? "";
        if (rendered.Length == 0) return DefaultMessage(kind, intValue, label);
        return rendered.Length > MaxMessage ? rendered[..MaxMessage] : rendered;
    }

    private static string DefaultMessage(string kind, int? intValue, string? label) => kind switch
    {
        ActivityEmitter.Kinds.WorkoutLogged =>
            intValue is { } m && m > 0
                ? (string.IsNullOrWhiteSpace(label) ? $"You logged a {m}-minute workout." : $"You logged a {m}-minute {label!.Trim()}.")
                : "You logged a workout.",
        ActivityEmitter.Kinds.ChallengeDayComplete =>
            intValue is { } d ? $"You completed 75-Hard day {d}." : "You completed a 75-Hard day.",
        ActivityEmitter.Kinds.ChallengeStarted => "You started the 75-Hard challenge.",
        ActivityEmitter.Kinds.HydrationGoalHit => "You hit your water goal.",
        _ => "An automation rule fired.",
    };

    private static readonly Regex MassMention =
        new(@"@(everyone|here)", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    /// <summary>Trim, strip @everyone/@here mass-mention tokens, collapse to null when empty, and cap length.</summary>
    public static string? Sanitize(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;
        // Loop to a fixed point so a reconstructing input (e.g. "@every@everyoneone") can't survive one pass.
        var s = raw;
        string prev;
        do { prev = s; s = MassMention.Replace(s, ""); } while (s != prev);
        s = s.Trim();
        if (s.Length == 0) return null;
        return s.Length > MaxMessage ? s[..MaxMessage] : s;
    }
}
