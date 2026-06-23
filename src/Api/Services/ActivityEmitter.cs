using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Ccusage.Api.Services;

/// <summary>
/// The single code path that turns a SAFE, already-shareable user action into one <see cref="ActivityEvent"/>
/// row on the SHARED activity spine. Wired as a fire-and-forget TAIL call at the end of a few existing write
/// endpoints (mirroring how <c>discord.Enqueue(...)</c> tails the chat fan-out): one added line per call site,
/// never refactoring the surrounding logic.
///
/// SAFETY (mirrors the chat fan-out's "never block/slow/fail the user-facing result"):
/// <list type="bullet">
///   <item>OPT-IN GATE: reads the actor's <see cref="AppUser.ShareActivity"/> once; if false (the default),
///   it NO-OPS, so a private action never becomes an event in the first place.</item>
///   <item>NEVER THROWS into the caller: any failure (DB hiccup, gate read) is swallowed — an emit failure
///   must never fail the underlying log write. Callers invoke it as <c>_ = activity.EmitAsync(...)</c>.</item>
///   <item>NON-SENSITIVE PAYLOAD ONLY: callers pass counts/labels/booleans (duration, day number, streak,
///   an already-snapshotted exercise name) — NEVER raw private content, amounts, coordinates, or health
///   detail. The label is defensively capped here too.</item>
/// </list>
///
/// Inserts ONE row (actor = caller, never per-recipient) — a single-row insert needs no execution-strategy
/// transaction. Because the call sites tail the emit as fire-and-forget (<c>_ = activity.EmitAsync(...)</c>),
/// the emit MUST outlive the request's DI scope; so it opens its OWN short-lived scope + DbContext rather than
/// borrowing the (about-to-be-disposed) request-scoped one. The service itself is registered scoped, but it
/// only depends on the root <see cref="IServiceScopeFactory"/>, so it is effectively scope-agnostic.
/// </summary>
public sealed class ActivityEmitter(IServiceScopeFactory scopeFactory, ILogger<ActivityEmitter> log)
{
    /// <summary>Stable, non-sensitive event kinds. Mirrored as the SPA's render switch.</summary>
    public static class Kinds
    {
        public const string WorkoutLogged = "workout.logged";
        public const string ChallengeDayComplete = "challenge.dayComplete";
        public const string ChallengeStarted = "challenge.started";
        public const string HydrationGoalHit = "hydration.goalHit";
    }

    private const int MaxLabel = 128;

    /// <summary>
    /// Emit ONE activity event for <paramref name="actorEmail"/> of kind <paramref name="kind"/>, carrying an
    /// optional non-sensitive <paramref name="intValue"/> (count) and <paramref name="label"/>. NO-OP when the
    /// actor has not opted to share. NEVER throws to the caller — a failure is logged and swallowed.
    /// </summary>
    public async Task EmitAsync(
        string actorEmail, string kind, int? intValue = null, string? label = null, CancellationToken ct = default)
    {
        try
        {
            var actor = (actorEmail ?? "").Trim().ToLowerInvariant();
            if (actor.Length == 0 || string.IsNullOrWhiteSpace(kind)) return;

            using var scope = scopeFactory.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();

            // OPT-IN gate: only a sharing actor's actions become events. A missing row => not sharing.
            var sharing = await db.Users.AsNoTracking()
                .Where(u => u.Email == actor && u.IsEnabled)
                .Select(u => u.ShareActivity)
                .FirstOrDefaultAsync(ct);
            if (!sharing) return;

            var clean = label?.Trim();
            if (string.IsNullOrEmpty(clean)) clean = null;
            else if (clean.Length > MaxLabel) clean = clean[..MaxLabel];

            db.ActivityEvents.Add(new ActivityEvent
            {
                ActorEmail = actor,
                Kind = kind.Trim(),
                IntValue = intValue,
                Label = clean,
                CreatedUtc = DateTime.UtcNow,
            });
            await db.SaveChangesAsync(ct);

            // TAIL: run the actor's OWN automation rules for this event, reusing this same (still-open) scope.
            // The actor is already confirmed sharing + enabled and the event is persisted. RuleEvaluator is
            // internally defensive (never throws) and self-scoped (acts only on the actor's own channels); the
            // outer try/catch is a second backstop so a rule failure can never fail the user-facing action.
            var evaluator = scope.ServiceProvider.GetRequiredService<RuleEvaluator>();
            await evaluator.EvaluateAsync(actor, kind.Trim(), intValue, clean, ct);
        }
        catch (Exception ex)
        {
            // Fire-and-forget: an emit failure must NEVER fail the user-facing action that tailed this call.
            log.LogWarning(ex, "ActivityEmitter.EmitAsync failed for kind {Kind}; swallowed.", kind);
        }
    }

    /// <summary>
    /// Like <see cref="EmitAsync"/> but emits AT MOST ONCE per (actor, kind, intValue) — used for "crossing"
    /// events (e.g. a 75-Hard day completing) so a repeated write to an already-complete state never re-emits.
    /// Same opt-in gate + never-throws guarantee. <paramref name="intValue"/> is the de-dupe discriminator
    /// (e.g. the day number).
    /// </summary>
    public async Task EmitOnceAsync(
        string actorEmail, string kind, int? intValue = null, string? label = null, CancellationToken ct = default)
    {
        try
        {
            var actor = (actorEmail ?? "").Trim().ToLowerInvariant();
            if (actor.Length == 0 || string.IsNullOrWhiteSpace(kind)) return;
            var trimmedKind = kind.Trim();

            using var scope = scopeFactory.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
            var already = await db.ActivityEvents.AsNoTracking()
                .AnyAsync(e => e.ActorEmail == actor && e.Kind == trimmedKind && e.IntValue == intValue, ct);
            if (already) return;
        }
        catch (Exception ex)
        {
            log.LogWarning(ex, "ActivityEmitter.EmitOnceAsync de-dupe check failed for kind {Kind}; swallowed.", kind);
            return;
        }

        await EmitAsync(actorEmail ?? "", kind, intValue, label, ct);
    }
}
