using Ccusage.Api.Auth;
using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
using Microsoft.EntityFrameworkCore;

namespace Ccusage.Api.Services;

/// <summary>
/// Builds the Family Hub "Today" snapshot for a household: a warm greeting, the local date, today's
/// reminders (by time, in the household timezone), active timers, list summaries (open/done counts +
/// the first few open items), pinned notes, and an optional weather card. People and items are exposed
/// by AppUser id + display name ONLY — an email is never read into a DTO (email-privacy).
///
/// All "today" math is done in the household's <see cref="Household.TimeZone"/> (IANA id) over UTC
/// storage: a reminder counts as "today" when its <c>DueUtc</c>, converted to local time, falls on the
/// household-local date. Weather degrades gracefully (null when unconfigured) and never blocks the build.
/// The same aggregate also feeds the daily briefing's text.
/// </summary>
public sealed class FamilyTodayService(UsageDbContext db, WeatherService weather)
{
    // ---- DTOs (people/items by userId + name; never email) ----

    public sealed record TodayReminderDto(
        long Id, string Text, DateTime DueUtc, string LocalTime, string Recurrence,
        int TargetUserId, string TargetName);

    public sealed record TodayTimerDto(
        long Id, string Label, DateTime EndsUtc, int StartedByUserId, string StartedByName);

    public sealed record TodayListDto(
        long Id, string Name, string Kind, int OpenCount, int DoneCount,
        IReadOnlyList<string> FirstFewOpenItems);

    public sealed record TodayNoteDto(long Id, string Title);

    public sealed record TodayDto(
        string Greeting, string DateLocal,
        IReadOnlyList<TodayReminderDto> Reminders,
        IReadOnlyList<TodayTimerDto> Timers,
        IReadOnlyList<TodayListDto> Lists,
        IReadOnlyList<TodayNoteDto> PinnedNotes,
        WeatherDto? Weather);

    /// <summary>How many open items to preview per list in the Today card / briefing.</summary>
    private const int PreviewItems = 4;

    /// <summary>
    /// Build the Today snapshot for <paramref name="household"/> as seen by <paramref name="caller"/>.
    /// <paramref name="nowUtc"/> defaults to <see cref="DateTime.UtcNow"/> (tests pass a fixed clock).
    /// </summary>
    public async Task<TodayDto> BuildAsync(
        Household household, CurrentUserAccessor.CurrentUser caller, DateTime? nowUtc = null, CancellationToken ct = default)
    {
        var tz = ResolveTimeZone(household.TimeZone);
        var now = nowUtc ?? DateTime.UtcNow;
        var localNow = TimeZoneInfo.ConvertTimeFromUtc(DateTime.SpecifyKind(now, DateTimeKind.Utc), tz);
        var localDate = DateOnly.FromDateTime(localNow);

        var reminders = await TodayRemindersAsync(household.Id, tz, localDate, ct);
        var timers = await ActiveTimersAsync(household.Id, now, ct);
        var lists = await ListSummariesAsync(household.Id, ct);
        var pinnedNotes = await PinnedNotesAsync(household.Id, ct);
        // Weather is best-effort: null (card hides) when unconfigured / location missing / any failure.
        var w = await weather.GetCurrentAsync(household.WeatherLocation, ct);

        return new TodayDto(
            Greeting: GreetingFor(localNow, caller),
            DateLocal: localDate.ToString("o"),
            Reminders: reminders,
            Timers: timers,
            Lists: lists,
            PinnedNotes: pinnedNotes,
            Weather: w);
    }

    // ---- Today's reminders (DueUtc lands on the household-local date), ordered by local time ----

    private async Task<List<TodayReminderDto>> TodayRemindersAsync(
        int householdId, TimeZoneInfo tz, DateOnly localDate, CancellationToken ct)
    {
        // The local-day window is [localMidnight, nextLocalMidnight) converted back to UTC. Active
        // reminders only (a fired one-shot is no longer "today's").
        var localMidnight = localDate.ToDateTime(TimeOnly.MinValue);
        var startUtc = TimeZoneInfo.ConvertTimeToUtc(DateTime.SpecifyKind(localMidnight, DateTimeKind.Unspecified), tz);
        var endUtc = TimeZoneInfo.ConvertTimeToUtc(
            DateTime.SpecifyKind(localMidnight.AddDays(1), DateTimeKind.Unspecified), tz);

        var rows = await db.FamilyReminders.AsNoTracking()
            .Where(r => r.HouseholdId == householdId && r.Active && r.DueUtc >= startUtc && r.DueUtc < endUtc)
            .OrderBy(r => r.DueUtc)
            .ToListAsync(ct);
        if (rows.Count == 0) return new();

        var names = await NamesAsync(rows.Select(r => r.TargetUserId), ct);
        return rows.Select(r =>
        {
            var local = TimeZoneInfo.ConvertTimeFromUtc(
                DateTime.SpecifyKind(r.DueUtc, DateTimeKind.Utc), tz);
            return new TodayReminderDto(
                r.Id, r.Text, r.DueUtc, local.ToString("h:mm tt"), r.Recurrence,
                r.TargetUserId, Name(names, r.TargetUserId));
        }).ToList();
    }

    // ---- Active (not-yet-done) timers, soonest-ending first ----

    private async Task<List<TodayTimerDto>> ActiveTimersAsync(int householdId, DateTime now, CancellationToken ct)
    {
        var rows = await db.FamilyTimers.AsNoTracking()
            .Where(t => t.HouseholdId == householdId && !t.Done)
            .OrderBy(t => t.EndsUtc)
            .ToListAsync(ct);
        if (rows.Count == 0) return new();

        var names = await NamesAsync(rows.Select(t => t.StartedByUserId), ct);
        return rows.Select(t => new TodayTimerDto(
            t.Id, t.Label, t.EndsUtc, t.StartedByUserId, Name(names, t.StartedByUserId))).ToList();
    }

    // ---- List summaries: open/done counts + the first few open items ----

    private async Task<List<TodayListDto>> ListSummariesAsync(int householdId, CancellationToken ct)
    {
        var lists = await db.FamilyLists.AsNoTracking()
            .Where(l => l.HouseholdId == householdId)
            .OrderBy(l => l.Name)
            .Select(l => new { l.Id, l.Name, l.Kind })
            .ToListAsync(ct);
        if (lists.Count == 0) return new();

        var ids = lists.Select(l => l.Id).ToArray();
        var items = await db.FamilyListItems.AsNoTracking()
            .Where(i => ids.Contains(i.ListId))
            .Select(i => new { i.ListId, i.Text, i.Done, i.SortOrder, i.Id })
            .ToListAsync(ct);

        var byList = items.GroupBy(i => i.ListId).ToDictionary(g => g.Key, g => g.ToList());

        return lists.Select(l =>
        {
            var its = byList.GetValueOrDefault(l.Id) ?? new();
            var open = its.Where(i => !i.Done).OrderBy(i => i.SortOrder).ThenBy(i => i.Id).ToList();
            return new TodayListDto(
                l.Id, l.Name, l.Kind,
                OpenCount: open.Count,
                DoneCount: its.Count - open.Count,
                FirstFewOpenItems: open.Take(PreviewItems).Select(i => i.Text).ToList());
        }).ToList();
    }

    // ---- Pinned notes (id + title only) ----

    private async Task<List<TodayNoteDto>> PinnedNotesAsync(int householdId, CancellationToken ct) =>
        await db.FamilyNotes.AsNoTracking()
            .Where(n => n.HouseholdId == householdId && n.Pinned)
            .OrderByDescending(n => n.UpdatedUtc)
            .Select(n => new TodayNoteDto(n.Id, n.Title))
            .ToListAsync(ct);

    // ---- Helpers ----

    /// <summary>A warm, time-of-day greeting addressed to the caller by first name (never email).</summary>
    private static string GreetingFor(DateTime localNow, CurrentUserAccessor.CurrentUser caller)
    {
        var part = localNow.Hour switch
        {
            >= 5 and < 12 => "Good morning",
            >= 12 and < 17 => "Good afternoon",
            >= 17 and < 22 => "Good evening",
            _ => "Hello",
        };
        var first = (caller.Name ?? "").Trim();
        if (first.Length > 0)
        {
            var space = first.IndexOf(' ');
            if (space > 0) first = first[..space];
            return $"{part}, {first}!";
        }
        return $"{part}!";
    }

    /// <summary>Resolve a set of userIds to display names (email is never read). Missing → "Unknown user".</summary>
    private async Task<Dictionary<int, string>> NamesAsync(IEnumerable<int> userIds, CancellationToken ct)
    {
        var ids = userIds.Distinct().ToList();
        if (ids.Count == 0) return new();
        return await db.Users.AsNoTracking()
            .Where(u => ids.Contains(u.Id))
            .ToDictionaryAsync(
                u => u.Id,
                u => string.IsNullOrEmpty(u.Name) ? "Unknown user" : u.Name, ct);
    }

    private static string Name(Dictionary<int, string> names, int userId) =>
        names.TryGetValue(userId, out var n) ? n : "Unknown user";

    /// <summary>Resolve an IANA id to a <see cref="TimeZoneInfo"/>, falling back to UTC on anything odd.</summary>
    public static TimeZoneInfo ResolveTimeZone(string? id)
    {
        if (string.IsNullOrWhiteSpace(id)) return TimeZoneInfo.Utc;
        try { return TimeZoneInfo.FindSystemTimeZoneById(id); }
        catch { return TimeZoneInfo.Utc; }
    }
}
