using System.Text;
using Ccusage.Api.Auth;
using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
using Ccusage.Api.Endpoints;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;

namespace Ccusage.Api.Services;

/// <summary>
/// Composes and delivers the Family Hub daily morning briefing for a household. The briefing is built
/// from the same <see cref="FamilyTodayService"/> aggregate the Today view uses, and is delivered TWO
/// ways:
/// <list type="number">
///   <item>ALWAYS — a <see cref="NotificationType.FamilyBriefing"/> inbox notification to EVERY household
///   member's bell, via <see cref="ChatNotificationService.NotifyFamily"/> (the guaranteed path).</item>
///   <item>ALSO (best-effort) — a <see cref="ChatMessage"/> posted into the household's private "Family"
///   chat channel, ensured once and remembered as <see cref="Household.FamilyChannelId"/>, authored by the
///   household owner and fanned out via the existing <see cref="ChatNotificationService.FanOutMessageAsync"/>
///   path. If chat isn't usable, the bell delivery still happened.</item>
/// </list>
/// "Once per local day" is guarded by <see cref="Household.LastBriefingLocalDate"/>: a second run on the
/// same household-local date is a no-op. All times come from the household's IANA timezone over UTC storage.
/// </summary>
public sealed class FamilyBriefingService(
    UsageDbContext db,
    FamilyTodayService today,
    ChatNotificationService notifier,
    GeminiService gemini,
    IMemoryCache cache,
    ILogger<FamilyBriefingService> logger)
{
    /// <summary>The per-household/local-date TTL for the AI narrative so the Today card's briefing call (and
    /// the morning job) don't re-spend tokens on every load within a local day.</summary>
    private static readonly TimeSpan NarrativeCacheTtl = TimeSpan.FromHours(12);

    /// <summary>
    /// Maybe run the briefing for <paramref name="household"/> as of <paramref name="nowUtc"/>: deliver it
    /// exactly once when briefings are enabled, the household-local time has reached
    /// <see cref="Household.BriefingHourLocal"/>, and one hasn't already gone out today-local. Returns true
    /// if a briefing was delivered this call, false if it was skipped (disabled / too early / already sent).
    /// Never throws on the chat side — the bell delivery is guaranteed, the chat post is best-effort.
    /// </summary>
    public async Task<bool> RunIfDueAsync(Household household, DateTime nowUtc, CancellationToken ct = default)
    {
        if (!household.BriefingEnabled) return false;

        var tz = FamilyTodayService.ResolveTimeZone(household.TimeZone);
        var localNow = TimeZoneInfo.ConvertTimeFromUtc(DateTime.SpecifyKind(nowUtc, DateTimeKind.Utc), tz);
        var localDate = DateOnly.FromDateTime(localNow);

        // Too early in the day, or already delivered for this local date.
        if (localNow.Hour < household.BriefingHourLocal) return false;
        if (household.LastBriefingLocalDate == localDate) return false;

        await DeliverAsync(household, nowUtc, ct);
        return true;
    }

    /// <summary>
    /// Compose + deliver the briefing for <paramref name="household"/> unconditionally (tests call this with
    /// the local time at the briefing hour). Stamps <see cref="Household.LastBriefingLocalDate"/> FIRST so a
    /// crash/retry can't double-deliver, pushes the bell notification to every member, then (best-effort)
    /// ensures the Family chat channel and posts the briefing into it.
    /// </summary>
    public async Task DeliverAsync(Household household, DateTime nowUtc, CancellationToken ct = default)
    {
        var tz = FamilyTodayService.ResolveTimeZone(household.TimeZone);
        var localNow = TimeZoneInfo.ConvertTimeFromUtc(DateTime.SpecifyKind(nowUtc, DateTimeKind.Utc), tz);
        var localDate = DateOnly.FromDateTime(localNow);

        // The owner is the briefing's "voice" (greeting + chat author). Resolve owner id + the member ids.
        var members = await db.HouseholdMembers.AsNoTracking()
            .Where(m => m.HouseholdId == household.Id)
            .Select(m => new { m.UserId, m.Role })
            .ToListAsync(ct);
        var ownerId = members.FirstOrDefault(m => m.Role == "owner")?.UserId
            ?? members.Select(m => (int?)m.UserId).FirstOrDefault()
            ?? household.CreatedByUserId;
        var ownerUser = await ResolveCallerAsync(ownerId, ct);

        // Build the aggregate from the same source the Today view uses. The deterministic Compose() is the
        // GUARANTEED text; we PREFER a warmer AI narrative when Gemini is available (cached per local day),
        // but a null/error there silently keeps the composed text — the briefing must never fail on AI.
        var snapshot = await today.BuildAsync(household, ownerUser, nowUtc, ct);
        var (text, _) = await NarrativeOrComposeAsync(household, snapshot, nowUtc, ct);

        // Stamp the guard FIRST (idempotency): a retry after a mid-delivery crash won't re-send.
        household.LastBriefingLocalDate = localDate;
        await db.Households.Where(h => h.Id == household.Id)
            .ExecuteUpdateAsync(s => s.SetProperty(h => h.LastBriefingLocalDate, localDate), ct);

        // (1) GUARANTEED: every member's bell.
        var memberIds = members.Select(m => m.UserId).ToList();
        await notifier.NotifyFamily(memberIds, NotificationType.FamilyBriefing, text, "/family/today", ct);

        // (2) BEST-EFFORT: post into the household's Family chat channel.
        try
        {
            await PostToFamilyChannelAsync(household, ownerUser, text, ct);
        }
        catch (Exception ex)
        {
            // The bell delivery already happened; a chat hiccup must never fail the briefing.
            logger.LogWarning("Family briefing chat post failed for household {Id}: {Reason}", household.Id, ex.Message);
        }
    }

    // ---- AI narrative (with the deterministic Compose() as the GUARANTEED fallback) ----

    /// <summary>The AI-narrative result for the Today card's briefing endpoint: the text + whether it fell
    /// back to the plain deterministic <c>Compose()</c> (true when Gemini was unconfigured/errored).</summary>
    public sealed record BriefingText(string Narrative, bool FellBackToPlain);

    /// <summary>
    /// Build the briefing text the Today card shows for <paramref name="household"/> as of
    /// <paramref name="nowUtc"/>: the warm AI narrative when Gemini is available, else the GUARANTEED
    /// deterministic <c>Compose()</c> text (<c>FellBackToPlain=true</c>). NEVER throws / 503s — an AI hiccup
    /// silently degrades to the composed line. CACHED per (household, local-date) so repeated Today loads
    /// don't re-spend tokens. The aggregate is built here from the same source the Today view uses.
    /// </summary>
    public async Task<BriefingText> BriefingTextForAsync(
        Household household, CurrentUserAccessor.CurrentUser caller, DateTime nowUtc, CancellationToken ct = default)
    {
        var snapshot = await today.BuildAsync(household, caller, nowUtc, ct);
        var (text, fellBack) = await NarrativeOrComposeAsync(household, snapshot, nowUtc, ct);
        return new BriefingText(text, fellBack);
    }

    /// <summary>
    /// Resolve the briefing text for a household + snapshot: try the cached AI narrative, falling back to the
    /// deterministic <c>Compose()</c> on null/error/unconfigured (returning <c>fellBackToPlain=true</c>). The
    /// AI narrative is cached per (household, household-local date). Compose() is ALWAYS the floor — this
    /// method never throws and never returns empty.
    /// </summary>
    private async Task<(string Text, bool FellBackToPlain)> NarrativeOrComposeAsync(
        Household household, FamilyTodayService.TodayDto snapshot, DateTime nowUtc, CancellationToken ct)
    {
        var plain = Compose(snapshot);
        if (!gemini.IsConfigured) return (plain, true);

        var tz = FamilyTodayService.ResolveTimeZone(household.TimeZone);
        var localDate = DateOnly.FromDateTime(
            TimeZoneInfo.ConvertTimeFromUtc(DateTime.SpecifyKind(nowUtc, DateTimeKind.Utc), tz));
        var cacheKey = $"family:briefing-narrative:{household.Id}:{localDate:yyyy-MM-dd}";
        if (cache.TryGetValue(cacheKey, out string? cached) && !string.IsNullOrWhiteSpace(cached))
            return (cached!, false);

        try
        {
            var narrative = await gemini.BriefingNarrativeAsync(BriefingSummary(snapshot), tz, ct);
            if (string.IsNullOrWhiteSpace(narrative)) return (plain, true);
            var capped = narrative.Length > 1000 ? narrative[..1000] : narrative;
            cache.Set(cacheKey, capped, NarrativeCacheTtl);
            return (capped, false);
        }
        catch (Exception ex)
        {
            // The AI path must never fail the briefing — fall back to the guaranteed composed line.
            logger.LogWarning("Family briefing AI narrative failed for household {Id}: {Reason}",
                household.Id, ex.Message);
            return (plain, true);
        }
    }

    /// <summary>
    /// Flatten the Today aggregate into a compact, deterministic facts summary the model NARRATES (it invents
    /// nothing — every number/name comes from the server). Mirrors what <c>Compose()</c> surfaces: greeting,
    /// today's reminders (with local times), the busiest list, running timers, pinned notes, weather, and
    /// today's events. Empty categories are omitted.
    /// </summary>
    private static string BriefingSummary(FamilyTodayService.TodayDto t)
    {
        var sb = new StringBuilder();
        sb.Append("GREETING: ").Append(t.Greeting).Append('\n');
        sb.Append("DATE: ").Append(t.DateLocal).Append('\n');

        if (t.Reminders.Count > 0)
        {
            sb.Append("REMINDERS (").Append(t.Reminders.Count).Append("):\n");
            foreach (var r in t.Reminders.Take(10))
                sb.Append("- ").Append(r.Text).Append(" at ").Append(r.LocalTime).Append('\n');
        }

        var openLists = t.Lists.Where(l => l.OpenCount > 0).OrderByDescending(l => l.OpenCount).ToList();
        if (openLists.Count > 0)
        {
            sb.Append("LISTS:\n");
            foreach (var l in openLists.Take(5))
                sb.Append("- ").Append(l.Name).Append(" (").Append(l.Kind).Append("): ")
                  .Append(l.OpenCount).Append(" open\n");
        }

        if (t.Timers.Count > 0)
        {
            sb.Append("TIMERS (").Append(t.Timers.Count).Append("):\n");
            foreach (var tm in t.Timers.Take(10))
                sb.Append("- ").Append(tm.Label).Append('\n');
        }

        if (t.PinnedNotes.Count > 0)
        {
            sb.Append("PINNED NOTES (").Append(t.PinnedNotes.Count).Append("):\n");
            foreach (var n in t.PinnedNotes.Take(10))
                sb.Append("- ").Append(n.Title).Append('\n');
        }

        if (t.Weather is { } w)
            sb.Append("WEATHER: ").Append(Math.Round(w.TempF)).Append("F, ").Append(w.Description)
              .Append(" in ").Append(w.Location).Append('\n');

        if (t.Events.Count > 0)
        {
            sb.Append("EVENTS (").Append(t.Events.Count).Append("):\n");
            foreach (var e in t.Events.Take(10))
                sb.Append("- ").Append(e.Title).Append(" at ").Append(e.LocalTime).Append('\n');
        }

        return sb.ToString();
    }

    /// <summary>
    /// Public entry point reused by the F6b event heads-up tick: ensure the household's Family channel and
    /// post <paramref name="text"/> into it authored by the household OWNER (resolved here). Best-effort and
    /// never throws on the chat side — returns silently when no channel/owner email can be resolved.
    /// </summary>
    public async Task PostToFamilyChannelAsync(Household household, string text, CancellationToken ct = default)
    {
        var members = await db.HouseholdMembers.AsNoTracking()
            .Where(m => m.HouseholdId == household.Id)
            .Select(m => new { m.UserId, m.Role })
            .ToListAsync(ct);
        var ownerId = members.FirstOrDefault(m => m.Role == "owner")?.UserId
            ?? members.Select(m => (int?)m.UserId).FirstOrDefault()
            ?? household.CreatedByUserId;
        var owner = await ResolveCallerAsync(ownerId, ct);
        await PostToFamilyChannelAsync(household, owner, text, ct);
    }

    /// <summary>
    /// Ensure the household's private "Family" chat channel exists (members = the household members, by
    /// resolved email), remember its id on the household, then post the briefing authored by the owner and
    /// fan it out via the existing chat path so it lands in the channel timeline + unread badges.
    /// </summary>
    private async Task PostToFamilyChannelAsync(
        Household household, CurrentUserAccessor.CurrentUser owner, string text, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(owner.Email)) return; // owner has no resolvable email — skip chat, bell stands

        var channel = await EnsureFamilyChannelAsync(household, ct);
        if (channel is null) return;

        var msg = new ChatMessage
        {
            ChannelId = channel.Id,
            SenderEmail = owner.Email,
            Body = text.Length > 4000 ? text[..4000] : text,
            CreatedUtc = DateTime.UtcNow,
        };
        db.ChatMessages.Add(msg);
        await db.SaveChangesAsync(ct);

        var sender = new ChatNotificationService.SenderIdentity(
            owner.Id, string.IsNullOrEmpty(owner.Name) ? "Unknown user" : owner.Name, null);
        // No mentions; the fan-out broadcasts to the channel group + writes per-member unread.
        await notifier.FanOutMessageAsync(channel, msg, sender, Array.Empty<int>(), ct);
    }

    /// <summary>
    /// Get-or-create the household's private "Family" channel: a named, private <see cref="ChatChannel"/>
    /// whose members are the household members (resolved id → enabled email). Created once and remembered as
    /// <see cref="Household.FamilyChannelId"/>; subsequent runs reuse it (and re-create it only if the stored
    /// id no longer resolves). Returns the channel with its members loaded, or null if no member email could
    /// be resolved.
    /// </summary>
    private async Task<ChatChannel?> EnsureFamilyChannelAsync(Household household, CancellationToken ct)
    {
        if (household.FamilyChannelId is { } existingId)
        {
            var existing = await db.ChatChannels.Include(c => c.Members)
                .FirstOrDefaultAsync(c => c.Id == existingId, ct);
            if (existing is not null) return existing;
            // Stored id is stale (channel deleted) — fall through and re-create.
        }

        // Resolve every household member's enabled email (the chat world keys by email; never on the wire).
        var memberIds = await db.HouseholdMembers.AsNoTracking()
            .Where(m => m.HouseholdId == household.Id)
            .Select(m => m.UserId)
            .ToListAsync(ct);
        var emailById = await ChatNotificationService.ResolveEmailsByIdAsync(db, memberIds, ct);
        var emails = emailById.Values.Select(e => e.ToLowerInvariant())
            .Distinct(StringComparer.Ordinal).ToList();
        if (emails.Count == 0) return null;

        var ownerEmail = (await ResolveEmailAsync(household.CreatedByUserId, ct)) ?? emails[0];

        var now = DateTime.UtcNow;
        var channel = new ChatChannel
        {
            Kind = ChannelKind.Channel,
            Name = "Family",
            IsPrivate = true,
            CreatedByEmail = ownerEmail,
            CreatedUtc = now,
            Members = emails.Select(e => new ChatChannelMember { UserEmail = e, JoinedUtc = now }).ToList(),
        };
        db.ChatChannels.Add(channel);
        await db.SaveChangesAsync(ct);

        // Remember the channel on the household so we ensure-once.
        household.FamilyChannelId = channel.Id;
        await db.Households.Where(h => h.Id == household.Id)
            .ExecuteUpdateAsync(s => s.SetProperty(h => h.FamilyChannelId, channel.Id), ct);

        return channel;
    }

    /// <summary>
    /// Compose a friendly briefing line from the Today aggregate, e.g.
    /// "Good morning! Today: 2 reminders, Groceries has 5 items to grab, 1 timer running, and 1 pinned note."
    /// Always opens with the snapshot's greeting; lists the most useful bits, gracefully omitting empties.
    /// </summary>
    public static string Compose(FamilyTodayService.TodayDto t)
    {
        var parts = new List<string>();

        if (t.Reminders.Count > 0)
            parts.Add($"{t.Reminders.Count} {Plural(t.Reminders.Count, "reminder", "reminders")}");

        // Call out the busiest list by name ("Groceries has 5 items to grab").
        var busiest = t.Lists.Where(l => l.OpenCount > 0).OrderByDescending(l => l.OpenCount).FirstOrDefault();
        if (busiest is not null)
        {
            var verb = string.Equals(busiest.Kind, "shopping", StringComparison.OrdinalIgnoreCase)
                ? "to grab" : "to do";
            parts.Add($"{busiest.Name} has {busiest.OpenCount} {Plural(busiest.OpenCount, "item", "items")} {verb}");
        }

        if (t.Timers.Count > 0)
            parts.Add($"{t.Timers.Count} {Plural(t.Timers.Count, "timer", "timers")} running");

        if (t.PinnedNotes.Count > 0)
            parts.Add($"{t.PinnedNotes.Count} pinned {Plural(t.PinnedNotes.Count, "note", "notes")}");

        if (t.Weather is { } w)
            parts.Add($"it's {Math.Round(w.TempF)}°F and {w.Description} in {w.Location}");

        var body = parts.Count == 0
            ? "nothing on the calendar — enjoy the day!"
            : JoinNaturally(parts);

        var line = $"{t.Greeting} Today: {body}";
        return line.Length > 512 ? line[..512] : line;
    }

    private static string Plural(int n, string one, string many) => n == 1 ? one : many;

    /// <summary>Join clauses with commas and a closing "and" ("a, b, and c"; "a and b"; "a").</summary>
    private static string JoinNaturally(IReadOnlyList<string> parts)
    {
        if (parts.Count == 1) return parts[0] + ".";
        if (parts.Count == 2) return $"{parts[0]} and {parts[1]}.";
        return string.Join(", ", parts.Take(parts.Count - 1)) + $", and {parts[^1]}.";
    }

    /// <summary>Resolve a userId to the minimal <see cref="CurrentUserAccessor.CurrentUser"/> the aggregate needs.</summary>
    private async Task<CurrentUserAccessor.CurrentUser> ResolveCallerAsync(int userId, CancellationToken ct)
    {
        var u = await db.Users.AsNoTracking()
            .Where(x => x.Id == userId)
            .Select(x => new { x.Id, x.Email, x.Name })
            .FirstOrDefaultAsync(ct);
        return u is null
            ? new CurrentUserAccessor.CurrentUser(userId, "", "", true, new HashSet<string>())
            : new CurrentUserAccessor.CurrentUser(u.Id, u.Email, u.Name, true, new HashSet<string>());
    }

    private async Task<string?> ResolveEmailAsync(int userId, CancellationToken ct) =>
        await db.Users.AsNoTracking()
            .Where(u => u.Id == userId)
            .Select(u => u.Email)
            .FirstOrDefaultAsync(ct);
}
