using Ccusage.Api.Auth;
using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
using Ccusage.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;

namespace Ccusage.Api.Endpoints;

/// <summary>
/// Habits engine (<c>/api/habits</c>) — the generalised successor to 75-Hard (<see cref="HardChallengeEndpoints"/>),
/// built NET-NEW on the <see cref="Habit"/>/<see cref="HabitDay"/> tables (the live HardChallenge tables are
/// UNTOUCHED). Gated by <see cref="Permissions.TrackerSelf"/> (NO dedicated permission) and OWNER-SCOPED: a
/// caller only ever reads/writes their OWN habits + days. Unlike 75-Hard there is NO one-active invariant and
/// the window is OPEN-ENDED.
///
/// <para>The day-level points/progress math is DELEGATED to the pure <see cref="HardChallengeScoring"/> (via a
/// Habit→HardChallengeTask shim in <see cref="HabitScoring"/>); the streak is the CADENCE-AWARE fold (the only
/// net-new logic). Crossing a day into complete emits <see cref="ActivityEmitter.Kinds.HabitDayComplete"/>
/// carrying the STREAK only — NEVER the private habit title (mirrors challenge.dayComplete). The leaderboard is
/// userId + display NAME only (never an email), reusing the SAME contacts-sharing query as 75-Hard.</para>
/// </summary>
public static class HabitEndpoints
{
    private const int MaxHabitsPerUser = 50;
    private const int CalendarDays = 120;

    /// <summary>The viewall roster cap for <see cref="SharingUsersQuery"/> — a sane upper bound so the
    /// leaderboard can never enumerate every enabled user (mirrors 75-Hard's cap).</summary>
    private const int MaxLeaderboardPeople = 200;

    // ---- Request DTOs ----
    public sealed record CreateHabitRequest(
        string? Title, int? Cadence, int? DaysOfWeekMask, int? TimesPerPeriod, int? PeriodDays,
        decimal? TargetValue, string? Unit, bool? PartialCredit, int? AutoSource, int? MinMinutes,
        string? Color, string? Icon, string? StartDate, string? EndDate);

    public sealed record UpdateHabitRequest(
        string? Title, int? Cadence, int? DaysOfWeekMask, int? TimesPerPeriod, int? PeriodDays,
        decimal? TargetValue, string? Unit, bool? PartialCredit, int? AutoSource, int? MinMinutes,
        string? Color, string? Icon, string? EndDate, int? Status);

    /// <summary>Upsert one day's progress: a measurable value and/or a binary done and/or a skip flag.</summary>
    public sealed record UpsertDayRequest(string? Date, decimal? Value, bool? Done, bool? Skip);

    // ---- Response DTOs ----
    public sealed record HabitDayDto(string Date, decimal? Value, bool? Done, bool Skip, double Progress, bool Complete);

    /// <summary>A habit card: its config + today's progress + the current/longest streak + completed count.</summary>
    public sealed record HabitDto(
        int Id, string Title, string Cadence, int DaysOfWeekMask, int TimesPerPeriod, int PeriodDays,
        decimal? TargetValue, string Unit, bool PartialCredit, string AutoSource, int? MinMinutes,
        string Color, string Icon, string StartDate, string? EndDate, string Status,
        int CurrentStreak, int LongestStreak, int CompletedCount,
        HabitDayDto Today);

    /// <summary>One leaderboard row (the caller + each sharing mutual contact), ranked by best streak. userId +
    /// NAME only, NEVER email — and NEVER a habit title.</summary>
    public sealed record LeaderboardRowDto(
        int UserId, string Name, string? Picture, int BestStreak, int TotalCompletions, int ActiveHabits, bool IsSelf);

    /// <summary>The AI coach recap (tracker.ai). <see cref="FellBackToPlain"/> is true when tracker.ai/Gemini was
    /// absent. ALWAYS 200.</summary>
    public sealed record CoachDto(string Narrative, IReadOnlyList<string> Insights, bool FellBackToPlain);

    public static void MapHabitEndpoints(this WebApplication app)
    {
        var g = app.MapGroup("/api/habits")
            .RequireAuthorization()
            .RequirePermission(Permissions.TrackerSelf);

        // ---- GET / : the caller's active habits + each one's today-progress + streak ----
        g.MapGet("/", async (CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var today = await TrackerVisibility.DisplayTzTodayAsync(db, ct);

            var habits = await db.Habits.AsNoTracking()
                .Where(h => h.UserEmail == caller.Email && h.Status != HabitStatus.Archived)
                .OrderBy(h => h.Status).ThenByDescending(h => h.Id)
                .ToListAsync(ct);

            var dtos = new List<HabitDto>(habits.Count);
            foreach (var h in habits)
                dtos.Add(await BuildHabitDtoAsync(db, h, today, persist: true, ct));
            return Results.Ok(dtos);
        });

        // ---- POST / : create a habit (owner) ----
        g.MapPost("/", async (
            CreateHabitRequest? req, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;

            var title = Trunc(req?.Title?.Trim(), 120);
            if (string.IsNullOrEmpty(title))
                return Results.BadRequest(new { message = "A habit title is required." });

            if (await db.Habits.CountAsync(h => h.UserEmail == caller.Email && h.Status != HabitStatus.Archived, ct)
                >= MaxHabitsPerUser)
                return Results.BadRequest(new { message = $"At most {MaxHabitsPerUser} active habits are allowed." });

            var today = await TrackerVisibility.DisplayTzTodayAsync(db, ct);
            var start = ParseDate(req?.StartDate) ?? today;
            if (DateOutOfRange(start, today))
                return Results.BadRequest(new { message = "That start date is out of range." });
            var end = ParseDate(req?.EndDate);
            if (end is { } e && e < start)
                return Results.BadRequest(new { message = "The end date must be on or after the start." });

            var now = DateTime.UtcNow;
            var habit = new Habit
            {
                UserEmail = caller.Email,
                UserId = caller.Id,
                Title = title,
                StartDate = start,
                EndDate = end,
                Status = HabitStatus.Active,
                CreatedUtc = now,
                UpdatedUtc = now,
            };
            ApplyConfig(habit, req?.Cadence, req?.DaysOfWeekMask, req?.TimesPerPeriod, req?.PeriodDays,
                req?.TargetValue, req?.Unit, req?.PartialCredit, req?.AutoSource, req?.MinMinutes,
                req?.Color, req?.Icon);
            db.Habits.Add(habit);
            await db.SaveChangesAsync(ct);

            return Results.Ok(await BuildHabitDtoAsync(db, habit, today, persist: false, ct));
        });

        // ---- PUT /{id} : edit / pause / archive a habit (owner) ----
        g.MapPut("/{id:int}", async (
            int id, UpdateHabitRequest? req, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var habit = await db.Habits.FirstOrDefaultAsync(h => h.Id == id && h.UserEmail == caller.Email, ct);
            if (habit is null) return Results.NotFound();

            var today = await TrackerVisibility.DisplayTzTodayAsync(db, ct);

            if (req?.Title is { } t)
            {
                var clean = Trunc(t.Trim(), 120);
                if (!string.IsNullOrEmpty(clean)) habit.Title = clean;
            }
            ApplyConfig(habit, req?.Cadence, req?.DaysOfWeekMask, req?.TimesPerPeriod, req?.PeriodDays,
                req?.TargetValue, req?.Unit, req?.PartialCredit, req?.AutoSource, req?.MinMinutes,
                req?.Color, req?.Icon);
            if (req?.EndDate is { } ed)
            {
                var parsed = ParseDate(ed);
                habit.EndDate = parsed is { } pe && pe >= habit.StartDate ? pe : habit.EndDate;
            }
            if (req?.Status is { } s && Enum.IsDefined(typeof(HabitStatus), s)) habit.Status = (HabitStatus)s;
            habit.UpdatedUtc = DateTime.UtcNow;
            await db.SaveChangesAsync(ct);

            return Results.Ok(await BuildHabitDtoAsync(db, habit, today, persist: false, ct));
        });

        // ---- DELETE /{id} : soft-archive a habit (owner) ----
        g.MapDelete("/{id:int}", async (
            int id, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var habit = await db.Habits.FirstOrDefaultAsync(h => h.Id == id && h.UserEmail == caller.Email, ct);
            if (habit is null) return Results.NotFound();

            habit.Status = HabitStatus.Archived;
            habit.UpdatedUtc = DateTime.UtcNow;
            await db.SaveChangesAsync(ct);
            return Results.NoContent();
        });

        // ---- GET /{id}/day?date= : read one day's progress (owner) ----
        g.MapGet("/{id:int}/day", async (
            int id, string? date, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var habit = await db.Habits.AsNoTracking()
                .FirstOrDefaultAsync(h => h.Id == id && h.UserEmail == caller.Email, ct);
            if (habit is null) return Results.NotFound();

            var localDate = ParseDate(date) ?? await TrackerVisibility.DisplayTzTodayAsync(db, ct);
            var row = await db.HabitDays.AsNoTracking()
                .FirstOrDefaultAsync(x => x.HabitId == id && x.LocalDate == localDate, ct);
            var input = await BuildDayInputAsync(db, caller.Email, habit, localDate, ct);
            return Results.Ok(ToDayDto(habit, localDate, row, input));
        });

        // ---- PUT /{id}/day : upsert one day's progress (owner). Emits habit.dayComplete on crossing-complete ----
        g.MapPut("/{id:int}/day", async (
            int id, UpsertDayRequest req, CurrentUserAccessor me, UsageDbContext db,
            ActivityEmitter activity, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var habit = await db.Habits.FirstOrDefaultAsync(h => h.Id == id && h.UserEmail == caller.Email, ct);
            if (habit is null) return Results.NotFound();

            if (ParseDate(req?.Date) is not { } localDate)
                return Results.BadRequest(new { message = "A valid date (yyyy-MM-dd) is required." });
            var today = await TrackerVisibility.DisplayTzTodayAsync(db, ct);
            if (DateOutOfRange(localDate, today))
                return Results.BadRequest(new { message = "That date is out of range." });

            var now = DateTime.UtcNow;
            var row = await db.HabitDays.FirstOrDefaultAsync(x => x.HabitId == id && x.LocalDate == localDate, ct);

            // Was it already complete BEFORE this write (to detect the crossing)?
            var beforeInput = await BuildDayInputAsync(db, caller.Email, habit, localDate, ct);
            var wasComplete = HabitScoring.IsComplete(habit, beforeInput, row?.Value, row?.Done);

            if (row is null)
            {
                row = new HabitDay
                {
                    HabitId = id,
                    UserEmail = caller.Email,
                    LocalDate = localDate,
                    CreatedUtc = now,
                };
                db.HabitDays.Add(row);
            }
            if (req!.Value is not null) row.Value = req.Value is { } v ? Math.Clamp(v, 0m, 1_000_000m) : null;
            if (req.Done is not null) row.Done = req.Done;
            if (req.Skip is not null) row.Skip = req.Skip.Value;
            row.UpdatedUtc = now;
            try
            {
                await db.SaveChangesAsync(ct);
            }
            catch (DbUpdateException ex) when (TrackerVisibility.IsUniqueViolation(ex))
            {
                db.ChangeTracker.Clear();
                row = await db.HabitDays.FirstAsync(x => x.HabitId == id && x.LocalDate == localDate, ct);
                if (req.Value is not null) row.Value = req.Value is { } v ? Math.Clamp(v, 0m, 1_000_000m) : null;
                if (req.Done is not null) row.Done = req.Done;
                if (req.Skip is not null) row.Skip = req.Skip.Value;
                row.UpdatedUtc = now;
                await db.SaveChangesAsync(ct);
            }

            var afterInput = await BuildDayInputAsync(db, caller.Email, habit, localDate, ct);
            var dto = await BuildHabitDtoAsync(db, habit, today, persist: true, ct);

            // Activity feed (fire-and-forget; no-op unless sharing): a habit CROSSED into complete. Emit only on
            // the crossing, de-duped against the SAME (actor, current streak) via EmitOnceAsync. NON-SENSITIVE:
            // the current streak ONLY — NEVER the private habit title.
            var nowComplete = HabitScoring.IsComplete(habit, afterInput, row.Value, row.Done);
            if (nowComplete && !wasComplete)
                _ = activity.EmitOnceAsync(
                    caller.Email, ActivityEmitter.Kinds.HabitDayComplete, intValue: dto.CurrentStreak);

            return Results.Ok(ToDayDto(habit, localDate, row, afterInput));
        });

        // ---- GET /leaderboard : caller + sharing mutual contacts ranked by best streak (id + name only) ----
        g.MapGet("/leaderboard", async (CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var today = await TrackerVisibility.DisplayTzTodayAsync(db, ct);

            var others = (await SharingUsersQuery(db, caller)
                    .Select(u => new { u.Id, u.Email, u.Name, u.DisplayNameMode, u.Nickname, u.Picture })
                    .ToListAsync(ct))
                .Select(u => new { u.Id, u.Email, Name = DisplayName.Format(u.Name, u.DisplayNameMode, u.Nickname), u.Picture })
                .ToList();
            var selfRow = await db.Users.AsNoTracking().Where(u => u.Email == caller.Email)
                .Select(u => new { u.Id, u.Email, u.Name, u.DisplayNameMode, u.Nickname, u.Picture }).FirstAsync(ct);

            // Batch ALL users' stats in a constant handful of queries (one Habits/HabitDays/auto-source read each,
            // filtered by UserEmail IN (...)) rather than a per-user fan-out that would issue ~2-5 sequential
            // queries for each of up to MaxLeaderboardPeople+1 people.
            var emails = new List<string> { selfRow.Email };
            emails.AddRange(others.Select(u => u.Email));
            var statsByEmail = await ComputeUsersStatsAsync(db, emails, today, ct);
            var zero = new UserStats(0, 0, 0);

            var rows = new List<LeaderboardRowDto>();
            void AddRow(int uid, string email, string? name, string? picture, bool isSelf)
            {
                var stats = statsByEmail.TryGetValue(email, out var s) ? s : zero;
                if (stats.ActiveHabits == 0 && !isSelf) return; // omit a contact with no habits
                rows.Add(new LeaderboardRowDto(
                    uid, string.IsNullOrEmpty(name) ? DisplayName.Unknown : name!, picture,
                    stats.BestStreak, stats.TotalCompletions, stats.ActiveHabits, isSelf));
            }

            AddRow(selfRow.Id, selfRow.Email,
                DisplayName.Format(selfRow.Name, selfRow.DisplayNameMode, selfRow.Nickname), selfRow.Picture, isSelf: true);
            foreach (var u in others)
                AddRow(u.Id, u.Email, u.Name, u.Picture, isSelf: false);

            var ranked = rows
                .OrderByDescending(r => r.BestStreak)
                .ThenByDescending(r => r.TotalCompletions)
                .ThenBy(r => r.Name)
                .ToList();
            return Results.Ok(ranked);
        });

        // ---- GET /coach : an encouraging recap (tracker.ai). ALWAYS 200 with a plain floor ----
        g.MapGet("/coach", async (
            CurrentUserAccessor me, GeminiService gemini, IMemoryCache cache,
            UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var today = await TrackerVisibility.DisplayTzTodayAsync(db, ct);

            var habits = await db.Habits.AsNoTracking()
                .Where(h => h.UserEmail == caller.Email && h.Status == HabitStatus.Active)
                .ToListAsync(ct);
            if (habits.Count == 0)
                return Results.Ok(new CoachDto(
                    "Create a habit to get your coaching recap.", Array.Empty<string>(), true));

            // Score every habit from the batched primitives (one days query + one auto-input load), not a
            // per-habit ComputeFullAsync fan-out.
            var perHabit = await ComputeHabitStatsAsync(db, caller.Email, habits, today, ct);
            var facts = habits
                .Select(h => (h.Title, perHabit[h.Id].Streak, perHabit[h.Id].Completed, h.Cadence.ToString()))
                .ToList();
            var plain = PlainCoach(facts);

            if (!caller.Permissions.Contains(Permissions.TrackerAi) || !gemini.IsConfigured)
                return Results.Ok(new CoachDto(plain, Array.Empty<string>(), true));

            var cacheKey = $"ai:habit-coach:{caller.Email}:{today:yyyy-MM-dd}";
            if (cache.TryGetValue(cacheKey, out CoachDto? cached) && cached is not null)
                return Results.Ok(cached);

            TrackerRecapResult? ai;
            try { ai = await gemini.HabitCoachAsync(CoachFactsText(facts), ct); }
            catch { ai = null; }
            if (ai is null || string.IsNullOrWhiteSpace(ai.Narrative))
                return Results.Ok(new CoachDto(plain, Array.Empty<string>(), true));

            var dto = new CoachDto(ai.Narrative, ai.Insights, false);
            cache.Set(cacheKey, dto, TimeSpan.FromHours(6));
            return Results.Ok(dto);
        }).RequireRateLimiting("ai");
    }

    // =====================================================================================
    // Shared sharing query (the SAME one 75-Hard's /shared + /leaderboard use)
    // =====================================================================================
    private static IQueryable<AppUser> SharingUsersQuery(UsageDbContext db, CurrentUserAccessor.CurrentUser caller)
    {
        if (caller.Permissions.Contains(Permissions.TrackerViewAll))
            // A contact roster is naturally bounded by the sharing graph; only the viewall path needs a cap
            // so the leaderboard can never fan out to every enabled user (mirrors 75-Hard's SharingUsersQuery).
            return db.Users.AsNoTracking()
                .Where(u => u.IsEnabled && u.Email != caller.Email)
                .OrderBy(u => u.Email)
                .Take(MaxLeaderboardPeople);
        return ContactGraph.SharingUsers(db, caller.Email);
    }

    // =====================================================================================
    // Building the habit DTO + the cadence-aware streak (delegates day math to HardChallengeScoring)
    // =====================================================================================

    private static async Task<HabitDto> BuildHabitDtoAsync(
        UsageDbContext db, Habit habit, DateOnly today, bool persist, CancellationToken ct)
    {
        var (streak, longest, completed, todayInput, todayRow) =
            await ComputeFullAsync(db, habit, today, ct);

        if (persist && (habit.CurrentStreak != streak || habit.LongestStreak != longest
                        || habit.CompletedCount != completed))
        {
            var tracked = await db.Habits.FirstOrDefaultAsync(h => h.Id == habit.Id, ct);
            if (tracked is not null)
            {
                tracked.CurrentStreak = streak;
                tracked.LongestStreak = longest;
                tracked.CompletedCount = completed;
                tracked.UpdatedUtc = DateTime.UtcNow;
                await db.SaveChangesAsync(ct);
            }
            habit.CurrentStreak = streak;
            habit.LongestStreak = longest;
            habit.CompletedCount = completed;
        }

        return new HabitDto(
            habit.Id, habit.Title, habit.Cadence.ToString(), habit.DaysOfWeekMask,
            habit.TimesPerPeriod, habit.PeriodDays, habit.TargetValue, habit.Unit, habit.PartialCredit,
            habit.AutoSource.ToString(), habit.MinMinutes, habit.Color, habit.Icon,
            habit.StartDate.ToString("yyyy-MM-dd"), habit.EndDate?.ToString("yyyy-MM-dd"),
            habit.Status.ToString(), streak, longest, completed,
            ToDayDto(habit, today, todayRow, todayInput));
    }

    /// <summary>
    /// Load the habit's recent day rows + the per-day auto inputs, score each day with the delegated
    /// <see cref="HabitScoring"/>, and fold the CADENCE-AWARE streak. Returns the streak/longest/completed plus
    /// today's input + row (so the caller can render today's tile without a second round-trip).
    /// </summary>
    private static async Task<(int Streak, int Longest, int Completed,
        HardChallengeScoring.HardDayInput TodayInput, HabitDay? TodayRow)> ComputeFullAsync(
        UsageDbContext db, Habit habit, DateOnly today, CancellationToken ct)
    {
        var windowStart = MaxDate(habit.StartDate, today.AddDays(-(CalendarDays - 1)));
        var rows = await db.HabitDays.AsNoTracking()
            .Where(x => x.HabitId == habit.Id && x.LocalDate >= windowStart && x.LocalDate <= today)
            .ToListAsync(ct);
        var rowByDate = rows.ToDictionary(r => r.LocalDate);

        var inputs = await LoadAutoInputsAsync(db, habit, windowStart, today, ct);

        var facts = new List<HabitScoring.DayFact>();
        var completed = 0;
        for (var d = windowStart; d <= today; d = d.AddDays(1))
        {
            rowByDate.TryGetValue(d, out var row);
            var input = inputs.TryGetValue(d, out var i) ? i : EmptyInput;
            var complete = HabitScoring.IsComplete(habit, input, row?.Value, row?.Done);
            if (complete) completed++;
            facts.Add(new HabitScoring.DayFact(d, complete, row?.Skip ?? false));
        }

        var streak = HabitScoring.CadenceStreak(habit, facts, today);
        rowByDate.TryGetValue(today, out var todayRow);
        var todayInput = inputs.TryGetValue(today, out var ti) ? ti : EmptyInput;
        return (streak.CurrentStreak, streak.LongestStreak, completed, todayInput, todayRow);
    }

    private readonly record struct UserStats(int BestStreak, int TotalCompletions, int ActiveHabits);

    /// <summary>
    /// Batch every leaderboard user's <see cref="UserStats"/> in a CONSTANT handful of queries — keyed by email —
    /// instead of the per-user fan-out that issued ~2-5 sequential queries for each of up to
    /// <see cref="MaxLeaderboardPeople"/>+1 people. Reads ONE Habits query (UserEmail IN (...)), ONE HabitDays
    /// query for all of those habits' ids in the window, and ONE query per auto-source table (UserEmail IN (...)),
    /// then groups everything in memory and scores each habit via the same <see cref="ScoreHabit"/> primitive.
    /// Emails with no active habits are simply absent from the result.
    /// </summary>
    private static async Task<Dictionary<string, UserStats>> ComputeUsersStatsAsync(
        UsageDbContext db, IReadOnlyCollection<string> emails, DateOnly today, CancellationToken ct)
    {
        var result = new Dictionary<string, UserStats>();
        var distinctEmails = emails.Distinct().ToList();
        if (distinctEmails.Count == 0) return result;

        var windowStart = today.AddDays(-(CalendarDays - 1));

        // ONE Habits read for all users.
        var habits = await db.Habits.AsNoTracking()
            .Where(h => distinctEmails.Contains(h.UserEmail) && h.Status == HabitStatus.Active)
            .ToListAsync(ct);
        if (habits.Count == 0) return result;
        var habitsByEmail = habits.GroupBy(h => h.UserEmail).ToDictionary(g => g.Key, g => g.ToList());
        var habitIds = habits.Select(h => h.Id).ToList();

        // ONE HabitDays read for all of those habits.
        var days = await db.HabitDays.AsNoTracking()
            .Where(x => habitIds.Contains(x.HabitId) && x.LocalDate >= windowStart && x.LocalDate <= today)
            .ToListAsync(ct);
        var daysByHabit = days.GroupBy(d => d.HabitId)
            .ToDictionary(g => g.Key, g => g.ToDictionary(d => d.LocalDate));

        // ONE read per auto-source table across all users, projected to a per-email cache.
        var autoByEmail = await LoadUsersAutoInputsAsync(db, distinctEmails, habits, windowStart, today, ct);

        var emptyCache = new UserAutoInputs(
            new Dictionary<DateOnly, int>(), new Dictionary<DateOnly, List<int>>(), new Dictionary<DateOnly, int>());
        var emptyDays = new Dictionary<DateOnly, HabitDay>();
        foreach (var (email, userHabits) in habitsByEmail)
        {
            var cache = autoByEmail.TryGetValue(email, out var c) ? c : emptyCache;
            int best = 0, total = 0;
            foreach (var h in userHabits)
            {
                var rowByDate = daysByHabit.TryGetValue(h.Id, out var m) ? m : emptyDays;
                var (streak, completed) = ScoreHabit(h, rowByDate, cache, today);
                best = Math.Max(best, streak);
                total += completed;
            }
            result[email] = new UserStats(best, total, userHabits.Count);
        }
        return result;
    }

    /// <summary>
    /// Score a batch of one user's active habits to their per-habit (streak, completed) — keyed by HabitId — using
    /// a CONSTANT handful of queries regardless of habit count: all habits' days in ONE HabitId IN (...) window
    /// query + the user's auto-source tracker data loaded ONCE, then score each habit purely in memory via
    /// <see cref="ScoreHabit"/>. This is the batched counterpart to the per-habit <see cref="ComputeFullAsync"/>
    /// fan-out, used by /coach (the cross-user leaderboard batches the same way via
    /// <see cref="ComputeUsersStatsAsync"/>).
    /// </summary>
    private static async Task<Dictionary<int, (int Streak, int Completed)>> ComputeHabitStatsAsync(
        UsageDbContext db, string email, IReadOnlyCollection<Habit> habits, DateOnly today, CancellationToken ct)
    {
        var result = new Dictionary<int, (int Streak, int Completed)>(habits.Count);
        if (habits.Count == 0) return result;

        var windowStart = today.AddDays(-(CalendarDays - 1));
        var habitIds = habits.Select(h => h.Id).ToList();
        var days = await db.HabitDays.AsNoTracking()
            .Where(x => habitIds.Contains(x.HabitId) && x.LocalDate >= windowStart && x.LocalDate <= today)
            .ToListAsync(ct);
        var daysByHabit = days.GroupBy(d => d.HabitId)
            .ToDictionary(g => g.Key, g => g.ToDictionary(d => d.LocalDate));

        var cache = await LoadUserAutoInputsAsync(db, email, habits, windowStart, today, ct);

        var empty = new Dictionary<DateOnly, HabitDay>();
        foreach (var h in habits)
        {
            var rowByDate = daysByHabit.TryGetValue(h.Id, out var m) ? m : empty;
            result[h.Id] = ScoreHabit(h, rowByDate, cache, today);
        }
        return result;
    }

    // =====================================================================================
    // Auto-source inputs (water/workout recomputed live from the tracker; None habits ignore these)
    // =====================================================================================

    private static readonly HardChallengeScoring.HardDayInput EmptyInput =
        new(0, 0, 0, 0, null, null, null, null, 0, Array.Empty<int>(), null, true, null);

    /// <summary>
    /// Build the per-day <see cref="HardChallengeScoring.HardDayInput"/> for a habit's auto source. For a None
    /// (manual) habit there is nothing to load — the empty input is returned for every day (manual value/done is
    /// what the scorer reads). For Water/Workout we load the day hydration / exercise durations + activity in the
    /// window so the scorer recomputes progress against the habit's own target. Diet/no-alcohol are not offered
    /// as habit auto sources (a habit is a single user-defined task), so only Water/Workout are loaded.
    /// </summary>
    private static async Task<Dictionary<DateOnly, HardChallengeScoring.HardDayInput>> LoadAutoInputsAsync(
        UsageDbContext db, Habit habit, DateOnly from, DateOnly to, CancellationToken ct)
    {
        var map = new Dictionary<DateOnly, HardChallengeScoring.HardDayInput>();
        if (habit.AutoSource == HardTaskAutoSource.None) return map; // manual: nothing to load

        if (habit.AutoSource == HardTaskAutoSource.Water)
        {
            var hydration = await db.HydrationEntries.AsNoTracking()
                .Where(h => h.UserEmail == habit.UserEmail && h.LocalDate >= from && h.LocalDate <= to)
                .GroupBy(h => h.LocalDate)
                .Select(grp => new { Date = grp.Key, Ml = grp.Sum(h => h.AmountMl) })
                .ToListAsync(ct);
            foreach (var h in hydration)
                map[h.Date] = EmptyInput with { HydrationMl = h.Ml };
        }
        else if (habit.AutoSource == HardTaskAutoSource.Workout)
        {
            var workouts = await db.ExerciseEntries.AsNoTracking()
                .Where(x => x.UserEmail == habit.UserEmail && x.LocalDate >= from && x.LocalDate <= to && x.DurationMin != null)
                .Select(x => new { x.LocalDate, Dur = x.DurationMin!.Value })
                .ToListAsync(ct);
            var activity = await db.DailyActivities.AsNoTracking()
                .Where(a => a.UserEmail == habit.UserEmail && a.LocalDate >= from && a.LocalDate <= to && a.ActiveCalories != null)
                .Select(a => new { a.LocalDate, a.ActiveCalories })
                .ToListAsync(ct);
            foreach (var grp in workouts.GroupBy(w => w.LocalDate))
                map[grp.Key] = EmptyInput with { WorkoutDurationsMin = grp.Select(x => x.Dur).ToList() };
            foreach (var a in activity)
                map[a.LocalDate] = (map.TryGetValue(a.LocalDate, out var existing) ? existing : EmptyInput)
                    with { ActiveCalories = a.ActiveCalories };
        }
        return map;
    }

    private static async Task<HardChallengeScoring.HardDayInput> BuildDayInputAsync(
        UsageDbContext db, string email, Habit habit, DateOnly date, CancellationToken ct)
    {
        var map = await LoadAutoInputsAsync(db, habit, date, date, ct);
        return map.TryGetValue(date, out var i) ? i : EmptyInput;
    }

    /// <summary>
    /// A user's raw auto-source tracker data for a window, loaded ONCE (independent of habit count). The
    /// Water/Workout inputs depend only on <c>UserEmail</c> + the date window — not the habit — so many habits of
    /// the same source can share a single load. Only the sources the user actually uses are queried.
    /// </summary>
    private readonly record struct UserAutoInputs(
        IReadOnlyDictionary<DateOnly, int> HydrationMl,
        IReadOnlyDictionary<DateOnly, List<int>> WorkoutDurationsMin,
        IReadOnlyDictionary<DateOnly, int> ActiveCalories);

    /// <summary>
    /// Batch-load a user's auto-source tracker data for the window in at most one query per needed source,
    /// replacing the per-habit fan-out in <see cref="LoadAutoInputsAsync"/> for callers scoring many habits.
    /// </summary>
    private static async Task<UserAutoInputs> LoadUserAutoInputsAsync(
        UsageDbContext db, string email, IReadOnlyCollection<Habit> habits,
        DateOnly from, DateOnly to, CancellationToken ct)
    {
        var needWater = habits.Any(h => h.AutoSource == HardTaskAutoSource.Water);
        var needWorkout = habits.Any(h => h.AutoSource == HardTaskAutoSource.Workout);

        var hydration = new Dictionary<DateOnly, int>();
        var workouts = new Dictionary<DateOnly, List<int>>();
        var calories = new Dictionary<DateOnly, int>();

        if (needWater)
        {
            var rows = await db.HydrationEntries.AsNoTracking()
                .Where(h => h.UserEmail == email && h.LocalDate >= from && h.LocalDate <= to)
                .GroupBy(h => h.LocalDate)
                .Select(grp => new { Date = grp.Key, Ml = grp.Sum(h => h.AmountMl) })
                .ToListAsync(ct);
            foreach (var h in rows) hydration[h.Date] = h.Ml;
        }
        if (needWorkout)
        {
            var ex = await db.ExerciseEntries.AsNoTracking()
                .Where(x => x.UserEmail == email && x.LocalDate >= from && x.LocalDate <= to && x.DurationMin != null)
                .Select(x => new { x.LocalDate, Dur = x.DurationMin!.Value })
                .ToListAsync(ct);
            foreach (var grp in ex.GroupBy(x => x.LocalDate))
                workouts[grp.Key] = grp.Select(x => x.Dur).ToList();

            var act = await db.DailyActivities.AsNoTracking()
                .Where(a => a.UserEmail == email && a.LocalDate >= from && a.LocalDate <= to && a.ActiveCalories != null)
                .Select(a => new { a.LocalDate, a.ActiveCalories })
                .ToListAsync(ct);
            foreach (var a in act) calories[a.LocalDate] = a.ActiveCalories!.Value;
        }
        return new UserAutoInputs(hydration, workouts, calories);
    }

    /// <summary>
    /// The cross-user counterpart of <see cref="LoadUserAutoInputsAsync"/>: batch-load MANY users' auto-source
    /// tracker data for the window keyed by email, in at most one query per needed source (UserEmail IN (...)).
    /// Only the sources some habit in the batch actually uses are queried. Users with no rows are absent.
    /// </summary>
    private static async Task<Dictionary<string, UserAutoInputs>> LoadUsersAutoInputsAsync(
        UsageDbContext db, IReadOnlyCollection<string> emails, IReadOnlyCollection<Habit> habits,
        DateOnly from, DateOnly to, CancellationToken ct)
    {
        var needWater = habits.Any(h => h.AutoSource == HardTaskAutoSource.Water);
        var needWorkout = habits.Any(h => h.AutoSource == HardTaskAutoSource.Workout);

        var hydration = new Dictionary<string, Dictionary<DateOnly, int>>();
        var workouts = new Dictionary<string, Dictionary<DateOnly, List<int>>>();
        var calories = new Dictionary<string, Dictionary<DateOnly, int>>();

        if (needWater)
        {
            var rows = await db.HydrationEntries.AsNoTracking()
                .Where(h => emails.Contains(h.UserEmail) && h.LocalDate >= from && h.LocalDate <= to)
                .GroupBy(h => new { h.UserEmail, h.LocalDate })
                .Select(grp => new { grp.Key.UserEmail, grp.Key.LocalDate, Ml = grp.Sum(h => h.AmountMl) })
                .ToListAsync(ct);
            foreach (var r in rows)
                (hydration.TryGetValue(r.UserEmail, out var m) ? m : hydration[r.UserEmail] = new())[r.LocalDate] = r.Ml;
        }
        if (needWorkout)
        {
            var ex = await db.ExerciseEntries.AsNoTracking()
                .Where(x => emails.Contains(x.UserEmail) && x.LocalDate >= from && x.LocalDate <= to && x.DurationMin != null)
                .Select(x => new { x.UserEmail, x.LocalDate, Dur = x.DurationMin!.Value })
                .ToListAsync(ct);
            foreach (var grp in ex.GroupBy(x => new { x.UserEmail, x.LocalDate }))
                (workouts.TryGetValue(grp.Key.UserEmail, out var m) ? m : workouts[grp.Key.UserEmail] = new())[grp.Key.LocalDate]
                    = grp.Select(x => x.Dur).ToList();

            var act = await db.DailyActivities.AsNoTracking()
                .Where(a => emails.Contains(a.UserEmail) && a.LocalDate >= from && a.LocalDate <= to && a.ActiveCalories != null)
                .Select(a => new { a.UserEmail, a.LocalDate, a.ActiveCalories })
                .ToListAsync(ct);
            foreach (var a in act)
                (calories.TryGetValue(a.UserEmail, out var m) ? m : calories[a.UserEmail] = new())[a.LocalDate]
                    = a.ActiveCalories!.Value;
        }

        var result = new Dictionary<string, UserAutoInputs>();
        foreach (var email in emails.Distinct())
        {
            var h = hydration.TryGetValue(email, out var hm) ? hm : new Dictionary<DateOnly, int>();
            var w = workouts.TryGetValue(email, out var wm) ? wm : new Dictionary<DateOnly, List<int>>();
            var c = calories.TryGetValue(email, out var cm) ? cm : new Dictionary<DateOnly, int>();
            result[email] = new UserAutoInputs(h, w, c);
        }
        return result;
    }

    /// <summary>The per-day <see cref="HardChallengeScoring.HardDayInput"/> for a specific habit's day, projected
    /// PURELY (no DB) from the pre-loaded <see cref="UserAutoInputs"/>. Mirrors <see cref="LoadAutoInputsAsync"/>.</summary>
    private static HardChallengeScoring.HardDayInput ProjectAutoInput(
        Habit habit, UserAutoInputs cache, DateOnly date)
    {
        if (habit.AutoSource == HardTaskAutoSource.Water)
            return cache.HydrationMl.TryGetValue(date, out var ml)
                ? EmptyInput with { HydrationMl = ml } : EmptyInput;
        if (habit.AutoSource == HardTaskAutoSource.Workout)
        {
            var input = EmptyInput;
            if (cache.WorkoutDurationsMin.TryGetValue(date, out var durs))
                input = input with { WorkoutDurationsMin = durs };
            if (cache.ActiveCalories.TryGetValue(date, out var cal))
                input = input with { ActiveCalories = cal };
            return input;
        }
        return EmptyInput; // None (manual)
    }

    /// <summary>Score one habit's streak/completed over the window PURELY from pre-loaded day rows + auto inputs
    /// (no DB) — the batched, in-memory counterpart of <see cref="ComputeFullAsync"/>.</summary>
    private static (int Streak, int Completed) ScoreHabit(
        Habit habit, IReadOnlyDictionary<DateOnly, HabitDay> rowByDate, UserAutoInputs cache, DateOnly today)
    {
        var windowStart = MaxDate(habit.StartDate, today.AddDays(-(CalendarDays - 1)));
        var facts = new List<HabitScoring.DayFact>();
        var completed = 0;
        for (var d = windowStart; d <= today; d = d.AddDays(1))
        {
            rowByDate.TryGetValue(d, out var row);
            var input = ProjectAutoInput(habit, cache, d);
            var complete = HabitScoring.IsComplete(habit, input, row?.Value, row?.Done);
            if (complete) completed++;
            facts.Add(new HabitScoring.DayFact(d, complete, row?.Skip ?? false));
        }
        var streak = HabitScoring.CadenceStreak(habit, facts, today);
        return (streak.CurrentStreak, completed);
    }

    // =====================================================================================
    // Coach (deterministic plain floor + the optional AI narration)
    // =====================================================================================

    private static string PlainCoach(IReadOnlyList<(string Title, int Streak, int Completed, string Cadence)> facts)
    {
        var best = facts.OrderByDescending(f => f.Streak).First();
        var sb = new System.Text.StringBuilder();
        sb.Append($"You're tracking {facts.Count} habit{(facts.Count == 1 ? "" : "s")}");
        if (best.Streak > 0) sb.Append($", with a best streak of {best.Streak} on \"{best.Title}\"");
        sb.Append('.');
        var gap = facts.Where(f => f.Streak == 0).OrderBy(f => f.Title).FirstOrDefault();
        if (gap.Title is not null)
            sb.Append($" \"{gap.Title}\" could use some momentum — start a streak today.");
        else
            sb.Append(" Every habit is on a run — keep it going.");
        return sb.ToString();
    }

    private static string CoachFactsText(IReadOnlyList<(string Title, int Streak, int Completed, string Cadence)> facts)
    {
        var lines = new List<string> { $"habit_count: {facts.Count}" };
        foreach (var (title, streak, completed, cadence) in facts)
            lines.Add($"habit \"{title}\" ({cadence}): current_streak {streak}, completed {completed}");
        return string.Join("\n", lines);
    }

    // =====================================================================================
    // Small helpers
    // =====================================================================================

    private static void ApplyConfig(
        Habit habit, int? cadence, int? daysMask, int? timesPerPeriod, int? periodDays,
        decimal? target, string? unit, bool? partial, int? autoSource, int? minMinutes, string? color, string? icon)
    {
        if (cadence is { } c && Enum.IsDefined(typeof(HabitCadence), c)) habit.Cadence = (HabitCadence)c;
        if (daysMask is { } m) habit.DaysOfWeekMask = m & 0x7F;
        if (timesPerPeriod is { } tp) habit.TimesPerPeriod = Math.Clamp(tp, 1, 100);
        if (periodDays is { } pd) habit.PeriodDays = Math.Clamp(pd, 1, 366);
        if (target is { } tv) habit.TargetValue = tv > 0 ? Math.Clamp(tv, 0.01m, 1_000_000m) : null;
        if (unit is { } u) habit.Unit = Trunc(u.Trim(), 32) ?? "";
        if (partial is { } p) habit.PartialCredit = p;
        // Only None/Water/Workout are valid habit auto sources (Diet/NoAlcohol are 75-Hard-specific).
        if (autoSource is { } a && a is (int)HardTaskAutoSource.None or (int)HardTaskAutoSource.Water or (int)HardTaskAutoSource.Workout)
            habit.AutoSource = (HardTaskAutoSource)a;
        if (minMinutes is { } mm) habit.MinMinutes = Math.Clamp(mm, 1, 1440);
        if (color is { } col) habit.Color = Trunc(col.Trim(), 32) ?? "";
        if (icon is { } ic) habit.Icon = Trunc(ic.Trim(), 32) ?? "";
    }

    private static HabitDayDto ToDayDto(
        Habit habit, DateOnly date, HabitDay? row, HardChallengeScoring.HardDayInput input)
    {
        var progress = HabitScoring.DayProgress(habit, input, row?.Value, row?.Done);
        // For an auto habit, surface the live tracker value; for a manual one, the stored value.
        decimal? value = habit.AutoSource switch
        {
            HardTaskAutoSource.Water => input.HydrationMl,
            HardTaskAutoSource.Workout => HardChallengeScoring.WorkoutBreakdownFor(HabitScoring.ToTask(habit), input).Count,
            _ => row?.Value,
        };
        return new HabitDayDto(
            date.ToString("yyyy-MM-dd"), value, row?.Done, row?.Skip ?? false, progress, progress >= 1.0);
    }

    private static DateOnly MaxDate(DateOnly a, DateOnly b) => a > b ? a : b;

    private static bool DateOutOfRange(DateOnly date, DateOnly today) =>
        date < today.AddYears(-5) || date > today.AddYears(1);

    private static DateOnly? ParseDate(string? s) =>
        DateOnly.TryParseExact((s ?? "").Trim(), "yyyy-MM-dd",
            System.Globalization.CultureInfo.InvariantCulture,
            System.Globalization.DateTimeStyles.None, out var d) ? d : null;

    private static string? Trunc(string? s, int max) =>
        s is null ? null : (s.Length > max ? s[..max] : s);
}
