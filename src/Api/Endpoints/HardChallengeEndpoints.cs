using Ccusage.Api.Auth;
using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
using Ccusage.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;

namespace Ccusage.Api.Endpoints;

/// <summary>
/// 75 Hard v2 (Relaxed ruleset) — a CONFIGURABLE daily-task challenge layered on the food/fitness tracker
/// (<c>/api/challenge</c>). Gated by the SAME tracker permissions, with NO dedicated permission: own use needs
/// <see cref="Permissions.TrackerSelf"/>; a coach/admin read of someone else needs <see cref="Permissions.TrackerViewAll"/>
/// (or the target's contacts-sharing) via the SAME <c>CanViewAsync</c> gate the tracker uses. The AI coach is
/// additionally gated by <see cref="Permissions.TrackerAi"/> but ALWAYS returns 200 (deterministic plain floor).
///
/// <para>V2: the six fixed booleans are replaced by a per-challenge <see cref="HardChallengeTask"/> set — each
/// task has a custom target, points, partial-credit flag, and enable toggle; the user can add custom MANUAL
/// tasks. Auto tasks (diet/water/workout) are recomputed LIVE from the tracker against their OWN custom targets
/// on every read; manual tasks (reading, custom, no-alcohol) persist their day progress. POINTS (incl. partial)
/// are computed by the pure <see cref="HardChallengeScoring"/>. The progress-PHOTO concept is GONE entirely.</para>
///
/// <para>PRIVACY mirrors the tracker: the client never sends an email — it sends <c>?user={userId}</c>, resolved
/// server-side; a non-viewable target is 404 (never leak existence); a viewer never sees confessions (nulled)
/// and never an email on the wire. The leaderboard is userId + display NAME only.</para>
/// </summary>
public static class HardChallengeEndpoints
{
    private const int TotalDays = 75;
    private const int MaxCheatDays = 10;
    private const int MaxTasksPerChallenge = 20;

    // ---- Request DTOs ----
    public sealed record StartChallengeRequest(string? StartDate);

    /// <summary>Upsert the day-level manual flags + per-task manual progress. Every field optional (partial PUT).
    /// <see cref="Tasks"/> carries manual task progress keyed by the stable task <c>key</c>.</summary>
    public sealed record UpsertDayRequest(
        string? Date, bool? NoAlcohol, string? Confession, bool? DietOverride,
        DayTaskProgressRequest[]? Tasks);

    /// <summary>One manual task's progress for a day: a measurable value (e.g. pages) and/or a binary done.</summary>
    public sealed record DayTaskProgressRequest(string Key, decimal? Value, bool? Done);

    public sealed record CheatDaysRequest(string[]? Add, string[]? Remove);

    /// <summary>Create a CUSTOM manual task on the challenge. Auto tasks are not user-creatable (only seeded).</summary>
    public sealed record CreateTaskRequest(
        string? Label, decimal? TargetValue, string? Unit, int? PointValue, bool? PartialCredit);

    /// <summary>Edit an existing task (any field; the auto-source + key are immutable). Used for both the seeded
    /// auto tasks (target/points/enable) and custom tasks (everything except key/source).</summary>
    public sealed record UpdateTaskRequest(
        string? Label, decimal? TargetValue, int? MinMinutes, string? Unit,
        int? PointValue, bool? PartialCredit, bool? Enabled, int? SortOrder);

    // ---- Response DTOs ----
    /// <summary>A task's config (the editable set).</summary>
    public sealed record TaskDto(
        int Id, string Key, string Label, string AutoSource,
        decimal? TargetValue, int? MinMinutes, string Unit,
        int PointValue, bool PartialCredit, bool Enabled, int SortOrder);

    /// <summary>One task's per-day RESULT: its progress fraction (0..1), the raw measured value (for measurable
    /// tasks), the points earned, and whether it is complete.</summary>
    public sealed record DayTaskDto(
        int TaskId, string Key, string Label, string AutoSource,
        decimal? TargetValue, string Unit, decimal? Value,
        double Progress, decimal Points, int PointValue, bool PartialCredit, bool Complete);

    /// <summary>One day in the grid: the per-task results + day-level flags + day points + completeness.
    /// <see cref="Confession"/> is NULLED for a viewer (never the owner's private narration).</summary>
    public sealed record DayDto(
        string Date, int? DayNumber,
        bool? DietOverride, bool NoAlcohol, bool IsCheatDay,
        decimal DayPoints, decimal MaxPoints, bool Complete,
        string? Confession,
        IReadOnlyList<DayTaskDto> Tasks);

    /// <summary>The active challenge with its derived current day, streaks, total points, task set, and day grid.</summary>
    public sealed record ChallengeDto(
        int Id, int UserId, string UserName, bool ReadOnly,
        string StartDate, string Ruleset, string Status,
        int CurrentDay, int TotalDays,
        int CompletedDays, int CurrentStreak, int LongestStreak, int ConfessionsUsed,
        decimal TotalPoints, decimal TodayPoints,
        IReadOnlyList<TaskDto> Tasks,
        IReadOnlyList<DayDto> Days);

    /// <summary>A person whose 75 Hard the caller may view (userId + display name only — NEVER an email).</summary>
    public sealed record SharedPersonDto(int UserId, string Name, string? Picture);

    /// <summary>One leaderboard row (the caller + each sharing mutual contact). userId + NAME only, NEVER email.</summary>
    public sealed record LeaderboardRowDto(
        int UserId, string Name, string? Picture,
        int CurrentDay, int CurrentStreak, decimal TotalPoints, decimal TodayPoints, bool IsSelf);

    /// <summary>The AI coach recap: a tailored encouraging narrative + gentle insights. <see cref="FellBackToPlain"/>
    /// is true when tracker.ai/Gemini was absent and the deterministic plain floor was returned. ALWAYS 200.</summary>
    public sealed record CoachDto(string Narrative, IReadOnlyList<string> Insights, bool FellBackToPlain);

    public static void MapHardChallengeEndpoints(this WebApplication app)
    {
        var g = app.MapGroup("/api/challenge")
            .RequireAuthorization()
            .RequirePermission(Permissions.TrackerSelf);

        // ---- GET / : the active challenge (own, or someone else's read-only when permitted) or null ----
        g.MapGet("/", async (
            int? user, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;

            var (target, isSelf, resolveError) = await ResolveTargetAsync(user, caller, db, ct);
            if (resolveError is { } err) return err;
            if (!isSelf && !await TrackerVisibility.CanViewAsync(db, caller, target, ct))
                return Results.NotFound();

            var challenge = await db.HardChallenges
                .FirstOrDefaultAsync(c => c.UserEmail == target && c.Status == HardChallengeStatus.Active, ct);
            if (challenge is null) return Results.Content("null", "application/json");

            var dto = await BuildChallengeAsync(db, challenge, target, readOnly: !isSelf, persist: isSelf, ct);
            return Results.Ok(dto);
        });

        // ---- POST / : start a challenge (owner; one active at a time) — seeds the DEFAULT task set ----
        g.MapPost("/", async (
            StartChallengeRequest? req, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;

            DateOnly start;
            if (string.IsNullOrWhiteSpace(req?.StartDate))
                start = await TrackerVisibility.DisplayTzTodayAsync(db, ct);
            else if (!TryParseDate(req.StartDate, out start))
                return Results.BadRequest(new { message = "A valid start date (yyyy-MM-dd) is required." });

            var today = await TrackerVisibility.DisplayTzTodayAsync(db, ct);
            if (start < today.AddYears(-1) || start > today.AddYears(1))
                return Results.BadRequest(new { message = "That start date is out of range." });

            if (await db.HardChallenges.AnyAsync(
                    c => c.UserEmail == caller.Email && c.Status == HardChallengeStatus.Active, ct))
                return Results.Conflict(new { message = "You already have an active challenge." });

            var now = DateTime.UtcNow;
            var challenge = new HardChallenge
            {
                UserEmail = caller.Email,
                StartDate = start,
                Ruleset = HardRuleset.Relaxed,
                Status = HardChallengeStatus.Active,
                CreatedUtc = now,
                UpdatedUtc = now,
            };
            db.HardChallenges.Add(challenge);
            try
            {
                await db.SaveChangesAsync(ct); // need the challenge id to seed tasks
                foreach (var t in HardChallengeScoring.DefaultTaskSet(challenge.Id, now))
                    db.HardChallengeTasks.Add(t);
                await db.SaveChangesAsync(ct);
            }
            catch (DbUpdateException ex) when (TrackerVisibility.IsUniqueViolation(ex))
            {
                db.ChangeTracker.Clear();
                return Results.Conflict(new { message = "You already have an active challenge." });
            }

            var dto = await BuildChallengeAsync(db, challenge, caller.Email, readOnly: false, persist: true, ct);
            return Results.Ok(dto);
        });

        // ---- GET /day : one day's per-task breakdown (own, or read-only when permitted) ----
        g.MapGet("/day", async (
            string? date, int? user, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;

            var (target, isSelf, resolveError) = await ResolveTargetAsync(user, caller, db, ct);
            if (resolveError is { } err) return err;
            if (!isSelf && !await TrackerVisibility.CanViewAsync(db, caller, target, ct))
                return Results.NotFound();

            var challenge = await db.HardChallenges.AsNoTracking()
                .FirstOrDefaultAsync(c => c.UserEmail == target && c.Status == HardChallengeStatus.Active, ct);
            if (challenge is null) return Results.NotFound();

            var localDate = TryParseDate(date, out var d)
                ? d : await TrackerVisibility.DisplayTzTodayAsync(db, ct);

            var dto = await BuildDayDtoAsync(db, target, challenge, localDate, readOnly: !isSelf, ct);
            return Results.Ok(dto);
        });

        // ---- PUT /day : upsert the day-level flags + MANUAL per-task progress (owner only) ----
        g.MapPut("/day", async (
            UpsertDayRequest req, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;

            if (!TryParseDate(req?.Date, out var localDate))
                return Results.BadRequest(new { message = "A valid date (yyyy-MM-dd) is required." });

            var challenge = await db.HardChallenges
                .FirstOrDefaultAsync(c => c.UserEmail == caller.Email && c.Status == HardChallengeStatus.Active, ct);
            if (challenge is null) return Results.NotFound();

            var confession = Trunc(req!.Confession?.Trim(), 280);
            if (string.IsNullOrEmpty(confession)) confession = null;

            var now = DateTime.UtcNow;
            var row = await db.HardChallengeDays
                .FirstOrDefaultAsync(x => x.UserEmail == caller.Email && x.LocalDate == localDate, ct);
            var hadConfession = row?.Confession is not null;
            if (row is null)
            {
                row = new HardChallengeDay
                {
                    ChallengeId = challenge.Id,
                    UserEmail = caller.Email,
                    LocalDate = localDate,
                    CreatedUtc = now,
                    UpdatedUtc = now,
                };
                db.HardChallengeDays.Add(row);
            }
            ApplyDayManual(row, req, confession, now);
            try
            {
                await db.SaveChangesAsync(ct);
            }
            catch (DbUpdateException ex) when (TrackerVisibility.IsUniqueViolation(ex))
            {
                db.ChangeTracker.Clear();
                challenge = await db.HardChallenges
                    .FirstAsync(c => c.UserEmail == caller.Email && c.Status == HardChallengeStatus.Active, ct);
                row = await db.HardChallengeDays
                    .FirstAsync(x => x.UserEmail == caller.Email && x.LocalDate == localDate, ct);
                hadConfession = row.Confession is not null;
                ApplyDayManual(row, req, confession, now);
                await db.SaveChangesAsync(ct);
            }

            // Per-task manual progress (only for MANUAL tasks — auto tasks ignore any sent progress).
            if (req.Tasks is { Length: > 0 })
            {
                var taskByKey = await db.HardChallengeTasks.AsNoTracking()
                    .Where(t => t.ChallengeId == challenge.Id)
                    .ToDictionaryAsync(t => t.Key, ct);
                await UpsertTaskProgressAsync(db, caller.Email, challenge.Id, localDate, req.Tasks, taskByKey, now, ct);
            }

            if (!hadConfession && confession is not null)
            {
                challenge.ConfessionsUsed += 1;
                challenge.UpdatedUtc = now;
                await db.SaveChangesAsync(ct);
            }

            var dto = await BuildDayDtoAsync(db, caller.Email, challenge, localDate, readOnly: false, ct);
            return Results.Ok(dto);
        });

        // ---- GET /tasks : the configurable task set (own, or read-only when permitted) ----
        g.MapGet("/tasks", async (
            int? user, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var (target, isSelf, resolveError) = await ResolveTargetAsync(user, caller, db, ct);
            if (resolveError is { } err) return err;
            if (!isSelf && !await TrackerVisibility.CanViewAsync(db, caller, target, ct))
                return Results.NotFound();

            var challenge = await db.HardChallenges.AsNoTracking()
                .FirstOrDefaultAsync(c => c.UserEmail == target && c.Status == HardChallengeStatus.Active, ct);
            if (challenge is null) return Results.NotFound();

            var tasks = await LoadTasksAsync(db, challenge.Id, ct);
            return Results.Ok(tasks.Select(ToTaskDto).ToList());
        });

        // ---- POST /tasks : add a CUSTOM manual task (owner) ----
        g.MapPost("/tasks", async (
            CreateTaskRequest? req, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var challenge = await db.HardChallenges
                .FirstOrDefaultAsync(c => c.UserEmail == caller.Email && c.Status == HardChallengeStatus.Active, ct);
            if (challenge is null) return Results.NotFound();

            var label = Trunc(req?.Label?.Trim(), 120);
            if (string.IsNullOrEmpty(label))
                return Results.BadRequest(new { message = "A task label is required." });

            var existing = await db.HardChallengeTasks
                .Where(t => t.ChallengeId == challenge.Id).ToListAsync(ct);
            if (existing.Count >= MaxTasksPerChallenge)
                return Results.BadRequest(new { message = $"At most {MaxTasksPerChallenge} tasks are allowed." });

            // A fresh stable key: custom-N where N is the next free index.
            var n = 1;
            var keys = existing.Select(t => t.Key).ToHashSet();
            while (keys.Contains($"custom-{n}")) n++;

            var now = DateTime.UtcNow;
            var task = new HardChallengeTask
            {
                ChallengeId = challenge.Id,
                Key = $"custom-{n}",
                Label = label,
                AutoSource = HardTaskAutoSource.None, // custom tasks are always manual
                TargetValue = ClampTarget(req?.TargetValue),
                Unit = Trunc(req?.Unit?.Trim(), 32) ?? "",
                PointValue = ClampPoints(req?.PointValue ?? 10),
                PartialCredit = req?.PartialCredit ?? false,
                Enabled = true,
                SortOrder = existing.Count == 0 ? 0 : existing.Max(t => t.SortOrder) + 1,
                CreatedUtc = now,
                UpdatedUtc = now,
            };
            db.HardChallengeTasks.Add(task);
            await db.SaveChangesAsync(ct);
            return Results.Ok(ToTaskDto(task));
        });

        // ---- PUT /tasks/{id} : edit a task's target/points/enable/etc (owner) ----
        g.MapPut("/tasks/{id:int}", async (
            int id, UpdateTaskRequest? req, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var challenge = await db.HardChallenges
                .FirstOrDefaultAsync(c => c.UserEmail == caller.Email && c.Status == HardChallengeStatus.Active, ct);
            if (challenge is null) return Results.NotFound();

            var task = await db.HardChallengeTasks
                .FirstOrDefaultAsync(t => t.Id == id && t.ChallengeId == challenge.Id, ct);
            if (task is null) return Results.NotFound();

            if (req?.Label is { } lbl)
            {
                var clean = Trunc(lbl.Trim(), 120);
                if (!string.IsNullOrEmpty(clean)) task.Label = clean;
            }
            // The TARGET is only meaningful for measurable tasks; the DIET/no-alcohol binaries keep null.
            if (req?.TargetValue is { } tv && task.AutoSource is not (HardTaskAutoSource.Diet or HardTaskAutoSource.NoAlcohol))
                task.TargetValue = ClampTarget(tv);
            if (req?.MinMinutes is { } mm && task.AutoSource == HardTaskAutoSource.Workout)
                task.MinMinutes = Math.Clamp(mm, 1, 1440);
            if (req?.Unit is { } unit) task.Unit = Trunc(unit.Trim(), 32) ?? "";
            if (req?.PointValue is { } pts) task.PointValue = ClampPoints(pts);
            if (req?.PartialCredit is { } pc) task.PartialCredit = pc;
            if (req?.Enabled is { } en) task.Enabled = en;
            if (req?.SortOrder is { } so) task.SortOrder = Math.Clamp(so, 0, 999);
            task.UpdatedUtc = DateTime.UtcNow;

            await db.SaveChangesAsync(ct);
            return Results.Ok(ToTaskDto(task));
        });

        // ---- DELETE /tasks/{id} : remove a CUSTOM task (owner). Seeded auto tasks can only be disabled. ----
        g.MapDelete("/tasks/{id:int}", async (
            int id, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var challenge = await db.HardChallenges
                .FirstOrDefaultAsync(c => c.UserEmail == caller.Email && c.Status == HardChallengeStatus.Active, ct);
            if (challenge is null) return Results.NotFound();

            var task = await db.HardChallengeTasks
                .FirstOrDefaultAsync(t => t.Id == id && t.ChallengeId == challenge.Id, ct);
            if (task is null) return Results.NotFound();
            if (task.AutoSource != HardTaskAutoSource.None)
                return Results.BadRequest(new { message = "Built-in tasks can be disabled but not deleted." });

            db.HardChallengeTasks.Remove(task); // day-progress rows cascade
            await db.SaveChangesAsync(ct);
            return Results.NoContent();
        });

        // ---- POST /cheat-days : pre-declare / clear FUTURE-only cheat dates within the window (owner) ----
        g.MapPost("/cheat-days", async (
            CheatDaysRequest? req, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;

            var challenge = await db.HardChallenges
                .FirstOrDefaultAsync(c => c.UserEmail == caller.Email && c.Status == HardChallengeStatus.Active, ct);
            if (challenge is null) return Results.NotFound();

            var today = await TrackerVisibility.DisplayTzTodayAsync(db, ct);
            var windowEnd = challenge.StartDate.AddDays(TotalDays - 1);

            var toAdd = ParseDates(req?.Add);
            var toRemove = ParseDates(req?.Remove);

            foreach (var dt in toAdd)
                if (dt <= today || dt < challenge.StartDate || dt > windowEnd)
                    return Results.BadRequest(new { message = "Cheat days must be future dates within the challenge window." });

            var now = DateTime.UtcNow;

            foreach (var dt in toRemove)
            {
                var r = await db.HardChallengeDays
                    .FirstOrDefaultAsync(x => x.UserEmail == caller.Email && x.LocalDate == dt, ct);
                if (r is null) continue;
                r.IsCheatDay = false;
                r.UpdatedUtc = now;
            }
            await db.SaveChangesAsync(ct);

            var existingFuture = await db.HardChallengeDays
                .Where(x => x.UserEmail == caller.Email && x.IsCheatDay && x.LocalDate > today)
                .Select(x => x.LocalDate)
                .ToListAsync(ct);
            var resulting = new HashSet<DateOnly>(existingFuture);
            foreach (var dt in toAdd) resulting.Add(dt);
            if (resulting.Count > MaxCheatDays)
                return Results.BadRequest(new { message = $"At most {MaxCheatDays} cheat days may be declared." });

            foreach (var dt in toAdd)
            {
                var r = await db.HardChallengeDays
                    .FirstOrDefaultAsync(x => x.UserEmail == caller.Email && x.LocalDate == dt, ct);
                if (r is null)
                {
                    r = new HardChallengeDay
                    {
                        ChallengeId = challenge.Id,
                        UserEmail = caller.Email,
                        LocalDate = dt,
                        IsCheatDay = true,
                        CreatedUtc = now,
                        UpdatedUtc = now,
                    };
                    db.HardChallengeDays.Add(r);
                }
                else
                {
                    r.IsCheatDay = true;
                    r.UpdatedUtc = now;
                }
            }
            try
            {
                await db.SaveChangesAsync(ct);
            }
            catch (DbUpdateException ex) when (TrackerVisibility.IsUniqueViolation(ex))
            {
                db.ChangeTracker.Clear();
            }

            var refreshed = await db.HardChallenges.FirstAsync(c => c.Id == challenge.Id, ct);
            var dto = await BuildChallengeAsync(db, refreshed, caller.Email, readOnly: false, persist: true, ct);
            return Results.Ok(dto);
        });

        // ---- GET /shared : people whose 75 Hard the caller may view (userId + name only, NEVER email) ----
        g.MapGet("/shared", async (CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var people = await SharingUsersQuery(db, caller)
                .OrderBy(u => u.Name == "" ? u.Email : u.Name)
                .Select(u => new SharedPersonDto(
                    u.Id, string.IsNullOrEmpty(u.Name) ? "Unknown user" : u.Name, u.Picture))
                .ToListAsync(ct);
            return Results.Ok(people);
        });

        // ---- GET /leaderboard : the caller + each sharing mutual contact, ranked by totalPoints desc ----
        // Reuses the SAME contacts-sharing query as /shared. A person with NO active challenge is omitted.
        // userId + display NAME only — NEVER an email.
        g.MapGet("/leaderboard", async (CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var today = await TrackerVisibility.DisplayTzTodayAsync(db, ct);

            // The set of people to rank: the caller + everyone whose tracker they may view (sharing contacts /
            // viewall). Build a lookup of (email → user) so we can compute each one's challenge stats.
            var others = await SharingUsersQuery(db, caller)
                .Select(u => new { u.Id, u.Email, u.Name, u.Picture })
                .ToListAsync(ct);
            var self = await db.Users.AsNoTracking().Where(u => u.Email == caller.Email)
                .Select(u => new { u.Id, u.Email, u.Name, u.Picture }).FirstAsync(ct);

            var rows = new List<LeaderboardRowDto>();

            async Task AddRowAsync(int id, string email, string? name, string? picture, bool isSelf)
            {
                var challenge = await db.HardChallenges.AsNoTracking()
                    .FirstOrDefaultAsync(c => c.UserEmail == email && c.Status == HardChallengeStatus.Active, ct);
                if (challenge is null) return; // no active challenge ⇒ omitted

                var stats = await ComputeStatsAsync(db, challenge, email, today, ct);
                rows.Add(new LeaderboardRowDto(
                    id,
                    string.IsNullOrEmpty(name) ? "Unknown user" : name!,
                    picture,
                    stats.CurrentDay, stats.CurrentStreak, stats.TotalPoints, stats.TodayPoints, isSelf));
            }

            await AddRowAsync(self.Id, self.Email, self.Name, self.Picture, isSelf: true);
            foreach (var u in others)
                await AddRowAsync(u.Id, u.Email, u.Name, u.Picture, isSelf: false);

            var ranked = rows
                .OrderByDescending(r => r.TotalPoints)
                .ThenByDescending(r => r.CurrentStreak)
                .ThenBy(r => r.Name)
                .ToList();
            return Results.Ok(ranked);
        });

        // ---- GET /coach : a tailored, encouraging NON-medical recap (tracker.ai). ALWAYS 200 with a plain floor ----
        g.MapGet("/coach", async (
            CurrentUserAccessor me, GeminiService gemini, Microsoft.Extensions.Caching.Memory.IMemoryCache cache,
            UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var today = await TrackerVisibility.DisplayTzTodayAsync(db, ct);

            var challenge = await db.HardChallenges.AsNoTracking()
                .FirstOrDefaultAsync(c => c.UserEmail == caller.Email && c.Status == HardChallengeStatus.Active, ct);
            if (challenge is null)
                return Results.Ok(new CoachDto(
                    "Start a 75 Hard challenge to get your daily coaching recap.", Array.Empty<string>(), true));

            var facts = await ComputeCoachFactsAsync(db, challenge, caller.Email, today, ct);
            var plain = PlainCoach(facts);

            // Plain recap is the floor. The warm AI narrative is the optional upgrade ONLY when the caller holds
            // tracker.ai AND Gemini is configured (a tracker.self caller never spends tokens).
            if (!caller.Permissions.Contains(Permissions.TrackerAi) || !gemini.IsConfigured)
                return Results.Ok(new CoachDto(plain, Array.Empty<string>(), true));

            var cacheKey = $"ai:challenge-coach:{caller.Email}:{today:yyyy-MM-dd}";
            if (cache.TryGetValue(cacheKey, out CoachDto? cached) && cached is not null)
                return Results.Ok(cached);

            TrackerRecapResult? ai;
            try { ai = await gemini.HardChallengeCoachAsync(CoachFactsText(facts), ct); }
            catch { ai = null; }

            if (ai is null || string.IsNullOrWhiteSpace(ai.Narrative))
                return Results.Ok(new CoachDto(plain, Array.Empty<string>(), true)); // floor

            var dto = new CoachDto(ai.Narrative, ai.Insights, false);
            cache.Set(cacheKey, dto, TimeSpan.FromHours(6));
            return Results.Ok(dto);
        }).RequireRateLimiting("ai");
    }

    // =====================================================================================
    // Shared sharing query (the SAME one /shared + /leaderboard use; mirrors /api/tracker/shared)
    // =====================================================================================
    private static IQueryable<AppUser> SharingUsersQuery(UsageDbContext db, CurrentUserAccessor.CurrentUser caller)
    {
        if (caller.Permissions.Contains(Permissions.TrackerViewAll))
            return db.Users.AsNoTracking().Where(u => u.IsEnabled && u.Email != caller.Email);

        var sharingEmails = db.ChatContacts.AsNoTracking()
            .Where(c => c.ContactEmail == caller.Email)
            .Join(db.TrackerProfiles.AsNoTracking().Where(p => p.ShareWithContacts),
                c => c.OwnerEmail, p => p.UserEmail, (c, p) => p.UserEmail);
        return db.Users.AsNoTracking()
            .Where(u => u.IsEnabled && u.Email != caller.Email && sharingEmails.Contains(u.Email));
    }

    // =====================================================================================
    // Building the challenge + day DTOs (auto scoring recomputed LIVE from the tracker)
    // =====================================================================================

    private static async Task<List<HardChallengeTask>> LoadTasksAsync(UsageDbContext db, int challengeId, CancellationToken ct)
        => await db.HardChallengeTasks.AsNoTracking()
            .Where(t => t.ChallengeId == challengeId)
            .OrderBy(t => t.SortOrder).ThenBy(t => t.Id)
            .ToListAsync(ct);

    private static async Task<ChallengeDto> BuildChallengeAsync(
        UsageDbContext db, HardChallenge challenge, string email, bool readOnly, bool persist, CancellationToken ct)
    {
        var today = await TrackerVisibility.DisplayTzTodayAsync(db, ct);
        var currentDay = CurrentDay(challenge.StartDate, today);
        var windowEnd = challenge.StartDate.AddDays(TotalDays - 1);

        var tasks = await LoadTasksAsync(db, challenge.Id, ct);
        var rows = await db.HardChallengeDays.AsNoTracking()
            .Where(x => x.UserEmail == email && x.LocalDate >= challenge.StartDate && x.LocalDate <= windowEnd)
            .OrderBy(x => x.LocalDate)
            .ToListAsync(ct);
        var rowByDate = rows.ToDictionary(r => r.LocalDate);

        var profile = await db.TrackerProfiles.AsNoTracking()
            .FirstOrDefaultAsync(p => p.UserEmail == email, ct);
        var facts = await LoadTrackerFactsAsync(db, email, challenge.StartDate, windowEnd, ct);
        var manual = await LoadManualProgressAsync(db, email, challenge.StartDate, windowEnd, ct);

        var days = new List<DayDto>(TotalDays);
        var streakDays = new List<HardChallengeScoring.StreakDay>();
        var completedDays = 0;
        decimal totalPoints = 0m, todayPoints = 0m;

        for (var i = 0; i < TotalDays; i++)
        {
            var date = challenge.StartDate.AddDays(i);
            rowByDate.TryGetValue(date, out var row);
            var (dayDto, score) = BuildDayInMemory(date, i + 1, row, tasks, profile, facts, manual, readOnly);

            if (score.Complete) completedDays++;
            totalPoints += score.DayPoints;
            if (date == today) todayPoints = score.DayPoints;

            if (date <= today)
                streakDays.Add(new HardChallengeScoring.StreakDay(
                    score.Complete, row?.IsCheatDay ?? false, row?.Confession is not null));

            days.Add(dayDto);
        }

        var streak = HardChallengeScoring.RelaxedStreak(streakDays);
        var day75 = days.Count == TotalDays && days[TotalDays - 1].Complete;
        var status = challenge.Status;
        if (day75 && status == HardChallengeStatus.Active) status = HardChallengeStatus.Completed;

        if (persist)
        {
            var tracked = await db.HardChallenges.FirstOrDefaultAsync(c => c.Id == challenge.Id, ct);
            if (tracked is not null)
            {
                var dirty = tracked.CompletedDays != completedDays
                    || tracked.CurrentStreak != streak.CurrentStreak
                    || tracked.LongestStreak != streak.LongestStreak
                    || tracked.Status != status;
                if (dirty)
                {
                    tracked.CompletedDays = completedDays;
                    tracked.CurrentStreak = streak.CurrentStreak;
                    tracked.LongestStreak = streak.LongestStreak;
                    tracked.Status = status;
                    tracked.UpdatedUtc = DateTime.UtcNow;
                    await db.SaveChangesAsync(ct);
                }
            }
        }

        var owner = await db.Users.AsNoTracking()
            .Where(u => u.Email == email)
            .Select(u => new { u.Id, u.Name })
            .FirstOrDefaultAsync(ct);

        return new ChallengeDto(
            challenge.Id,
            owner?.Id ?? 0,
            owner is null || string.IsNullOrEmpty(owner.Name) ? "Unknown user" : owner.Name,
            readOnly,
            challenge.StartDate.ToString("yyyy-MM-dd"),
            challenge.Ruleset.ToString(),
            status.ToString(),
            currentDay,
            TotalDays,
            completedDays,
            streak.CurrentStreak,
            streak.LongestStreak,
            challenge.ConfessionsUsed,
            totalPoints,
            todayPoints,
            tasks.Select(ToTaskDto).ToList(),
            days);
    }

    private static async Task<DayDto> BuildDayDtoAsync(
        UsageDbContext db, string email, HardChallenge challenge, DateOnly date, bool readOnly, CancellationToken ct)
    {
        var tasks = await LoadTasksAsync(db, challenge.Id, ct);
        var profile = await db.TrackerProfiles.AsNoTracking()
            .FirstOrDefaultAsync(p => p.UserEmail == email, ct);
        var facts = await LoadTrackerFactsAsync(db, email, date, date, ct);
        var manual = await LoadManualProgressAsync(db, email, date, date, ct);
        var row = await db.HardChallengeDays.AsNoTracking()
            .FirstOrDefaultAsync(x => x.UserEmail == email && x.LocalDate == date, ct);

        var dayNumber = WithinWindow(challenge.StartDate, date)
            ? (int?)CurrentDay(challenge.StartDate, date) : null;
        var (dto, _) = BuildDayInMemory(date, dayNumber, row, tasks, profile, facts, manual, readOnly);
        return dto;
    }

    /// <summary>The tracker facts for one day, used to recompute its auto scoring.</summary>
    private readonly record struct DayFacts(
        int CaloriesIn, double ProteinG, double CarbG, double FatG, int HydrationMl, List<int> WorkoutDurationsMin);

    /// <summary>
    /// Load the per-day tracker facts for [from, to]. caloriesIn/macros = day food sums; hydration = day drink
    /// volume sum; workout durations = the day's exercise durations (the scorer counts those &gt;= each task's
    /// MinMinutes against that task's target). Mirrors the tracker day roll-up.
    /// </summary>
    private static async Task<Dictionary<DateOnly, DayFacts>> LoadTrackerFactsAsync(
        UsageDbContext db, string email, DateOnly from, DateOnly to, CancellationToken ct)
    {
        var foods = await db.FoodEntries.AsNoTracking()
            .Where(f => f.UserEmail == email && f.LocalDate >= from && f.LocalDate <= to)
            .GroupBy(f => f.LocalDate)
            .Select(grp => new
            {
                Date = grp.Key,
                Calories = grp.Sum(f => f.Calories),
                Protein = grp.Sum(f => f.ProteinG),
                Carb = grp.Sum(f => f.CarbG),
                Fat = grp.Sum(f => f.FatG),
            })
            .ToListAsync(ct);

        // All exercise durations that day (the scorer applies each workout task's own MinMinutes threshold).
        var workouts = await db.ExerciseEntries.AsNoTracking()
            .Where(x => x.UserEmail == email && x.LocalDate >= from && x.LocalDate <= to && x.DurationMin != null)
            .Select(x => new { x.LocalDate, Dur = x.DurationMin!.Value })
            .ToListAsync(ct);

        var hydration = await db.HydrationEntries.AsNoTracking()
            .Where(h => h.UserEmail == email && h.LocalDate >= from && h.LocalDate <= to)
            .GroupBy(h => h.LocalDate)
            .Select(grp => new { Date = grp.Key, Ml = grp.Sum(h => h.AmountMl) })
            .ToListAsync(ct);

        var map = new Dictionary<DateOnly, DayFacts>();
        DayFacts Get(DateOnly d) => map.TryGetValue(d, out var f) ? f : new DayFacts(0, 0, 0, 0, 0, new List<int>());
        foreach (var f in foods)
            map[f.Date] = Get(f.Date) with
            {
                CaloriesIn = f.Calories,
                ProteinG = Math.Round(f.Protein, 1),
                CarbG = Math.Round(f.Carb, 1),
                FatG = Math.Round(f.Fat, 1),
            };
        foreach (var w in workouts.GroupBy(w => w.LocalDate))
            map[w.Key] = Get(w.Key) with { WorkoutDurationsMin = w.Select(x => x.Dur).ToList() };
        foreach (var h in hydration)
            map[h.Date] = Get(h.Date) with { HydrationMl = h.Ml };
        return map;
    }

    /// <summary>Load the manual per-task progress for [from, to] as a (date → (taskId → manual)) lookup.</summary>
    private static async Task<Dictionary<DateOnly, Dictionary<int, HardChallengeScoring.DayManual>>> LoadManualProgressAsync(
        UsageDbContext db, string email, DateOnly from, DateOnly to, CancellationToken ct)
    {
        var rows = await db.HardChallengeDayTasks.AsNoTracking()
            .Where(x => x.UserEmail == email && x.LocalDate >= from && x.LocalDate <= to)
            .Select(x => new { x.LocalDate, x.TaskId, x.Value, x.Done })
            .ToListAsync(ct);

        var map = new Dictionary<DateOnly, Dictionary<int, HardChallengeScoring.DayManual>>();
        foreach (var r in rows)
        {
            if (!map.TryGetValue(r.LocalDate, out var inner))
                map[r.LocalDate] = inner = new Dictionary<int, HardChallengeScoring.DayManual>();
            inner[r.TaskId] = new HardChallengeScoring.DayManual(r.Value, r.Done);
        }
        return map;
    }

    /// <summary>Build one day's DTO + score in memory from the loaded facts/manual progress/task set.</summary>
    private static (DayDto Dto, HardChallengeScoring.HardDayScore Score) BuildDayInMemory(
        DateOnly date, int? dayNumber, HardChallengeDay? row,
        IReadOnlyList<HardChallengeTask> tasks, TrackerProfile? profile,
        Dictionary<DateOnly, DayFacts> facts,
        Dictionary<DateOnly, Dictionary<int, HardChallengeScoring.DayManual>> manualByDate,
        bool readOnly)
    {
        var f = facts.TryGetValue(date, out var v) ? v : new DayFacts(0, 0, 0, 0, 0, new List<int>());
        var input = new HardChallengeScoring.HardDayInput(
            f.CaloriesIn, f.ProteinG, f.CarbG, f.FatG,
            profile?.DailyCalorieGoal, profile?.ProteinGoalG, profile?.CarbGoalG, profile?.FatGoalG,
            f.HydrationMl, f.WorkoutDurationsMin ?? new List<int>(),
            row?.DietOverride, row?.NoAlcohol ?? true);

        var manual = manualByDate.TryGetValue(date, out var m) ? m : new Dictionary<int, HardChallengeScoring.DayManual>();
        var score = HardChallengeScoring.ScoreDay(tasks, input, manual);

        var scoreByTask = score.Tasks.ToDictionary(t => t.TaskId);
        var taskDtos = new List<DayTaskDto>(tasks.Count);
        foreach (var t in tasks)
        {
            if (!t.Enabled) continue;
            scoreByTask.TryGetValue(t.Id, out var ts);
            // The raw measured VALUE for the row (auto: from tracker; manual: stored), for display.
            decimal? value = t.AutoSource switch
            {
                HardTaskAutoSource.Water => f.HydrationMl,
                HardTaskAutoSource.Workout => (f.WorkoutDurationsMin ?? new List<int>()).Count(d => d >= (t.MinMinutes ?? HardChallengeScoring.WorkoutMinMinutes)),
                HardTaskAutoSource.None => manual.TryGetValue(t.Id, out var dm) ? dm.Value : null,
                _ => null,
            };
            taskDtos.Add(new DayTaskDto(
                t.Id, t.Key, t.Label, t.AutoSource.ToString(),
                t.TargetValue, t.Unit, value,
                ts.Progress, ts.Points, t.PointValue, t.PartialCredit, ts.Complete));
        }

        var dto = new DayDto(
            date.ToString("yyyy-MM-dd"),
            dayNumber,
            row?.DietOverride,
            row?.NoAlcohol ?? true,
            row?.IsCheatDay ?? false,
            score.DayPoints,
            score.MaxPoints,
            score.Complete,
            readOnly ? null : row?.Confession,
            taskDtos);
        return (dto, score);
    }

    private static TaskDto ToTaskDto(HardChallengeTask t) => new(
        t.Id, t.Key, t.Label, t.AutoSource.ToString(),
        t.TargetValue, t.MinMinutes, t.Unit, t.PointValue, t.PartialCredit, t.Enabled, t.SortOrder);

    // =====================================================================================
    // Leaderboard + coach stats (lightweight; reuse the in-memory scorer)
    // =====================================================================================

    private readonly record struct ChallengeStats(int CurrentDay, int CurrentStreak, decimal TotalPoints, decimal TodayPoints);

    private static async Task<ChallengeStats> ComputeStatsAsync(
        UsageDbContext db, HardChallenge challenge, string email, DateOnly today, CancellationToken ct)
    {
        var windowEnd = challenge.StartDate.AddDays(TotalDays - 1);
        var tasks = await LoadTasksAsync(db, challenge.Id, ct);
        var rows = await db.HardChallengeDays.AsNoTracking()
            .Where(x => x.UserEmail == email && x.LocalDate >= challenge.StartDate && x.LocalDate <= windowEnd)
            .ToListAsync(ct);
        var rowByDate = rows.ToDictionary(r => r.LocalDate);
        var profile = await db.TrackerProfiles.AsNoTracking().FirstOrDefaultAsync(p => p.UserEmail == email, ct);
        var facts = await LoadTrackerFactsAsync(db, email, challenge.StartDate, windowEnd, ct);
        var manual = await LoadManualProgressAsync(db, email, challenge.StartDate, windowEnd, ct);

        decimal total = 0m, todayPoints = 0m;
        var streakDays = new List<HardChallengeScoring.StreakDay>();
        for (var i = 0; i < TotalDays; i++)
        {
            var date = challenge.StartDate.AddDays(i);
            rowByDate.TryGetValue(date, out var row);
            var (_, score) = BuildDayInMemory(date, i + 1, row, tasks, profile, facts, manual, readOnly: true);
            total += score.DayPoints;
            if (date == today) todayPoints = score.DayPoints;
            if (date <= today)
                streakDays.Add(new HardChallengeScoring.StreakDay(
                    score.Complete, row?.IsCheatDay ?? false, row?.Confession is not null));
        }
        var streak = HardChallengeScoring.RelaxedStreak(streakDays);
        return new ChallengeStats(CurrentDay(challenge.StartDate, today), streak.CurrentStreak, total, todayPoints);
    }

    /// <summary>The server-computed facts the coach narrates (nothing comes from the client).</summary>
    private sealed record CoachFacts(
        int CurrentDay, int CurrentStreak, int LongestStreak, int CompletedDays,
        decimal TotalPoints, decimal MaxPointsToDate, int AvgPercent,
        IReadOnlyList<(string Label, int AvgPercent)> PerTask);

    private static async Task<CoachFacts> ComputeCoachFactsAsync(
        UsageDbContext db, HardChallenge challenge, string email, DateOnly today, CancellationToken ct)
    {
        var windowEnd = challenge.StartDate.AddDays(TotalDays - 1);
        var tasks = await LoadTasksAsync(db, challenge.Id, ct);
        var enabled = tasks.Where(t => t.Enabled).ToList();
        var rows = await db.HardChallengeDays.AsNoTracking()
            .Where(x => x.UserEmail == email && x.LocalDate >= challenge.StartDate && x.LocalDate <= windowEnd)
            .ToListAsync(ct);
        var rowByDate = rows.ToDictionary(r => r.LocalDate);
        var profile = await db.TrackerProfiles.AsNoTracking().FirstOrDefaultAsync(p => p.UserEmail == email, ct);
        var facts = await LoadTrackerFactsAsync(db, email, challenge.StartDate, windowEnd, ct);
        var manual = await LoadManualProgressAsync(db, email, challenge.StartDate, windowEnd, ct);

        decimal total = 0m, maxToDate = 0m;
        var completedDays = 0;
        var streakDays = new List<HardChallengeScoring.StreakDay>();
        var perTaskProgressSum = new Dictionary<int, double>();
        var elapsed = 0;

        for (var i = 0; i < TotalDays; i++)
        {
            var date = challenge.StartDate.AddDays(i);
            if (date > today) break; // only days that have happened
            elapsed++;
            rowByDate.TryGetValue(date, out var row);
            var (dto, score) = BuildDayInMemory(date, i + 1, row, tasks, profile, facts, manual, readOnly: true);
            total += score.DayPoints;
            maxToDate += score.MaxPoints;
            if (score.Complete) completedDays++;
            streakDays.Add(new HardChallengeScoring.StreakDay(
                score.Complete, row?.IsCheatDay ?? false, row?.Confession is not null));
            foreach (var ts in score.Tasks)
                perTaskProgressSum[ts.TaskId] = perTaskProgressSum.GetValueOrDefault(ts.TaskId) + ts.Progress;
        }

        var streak = HardChallengeScoring.RelaxedStreak(streakDays);
        var avgPercent = maxToDate > 0 ? (int)Math.Round((double)(total / maxToDate) * 100) : 0;
        var perTask = enabled
            .Select(t => (t.Label, AvgPercent: elapsed > 0
                ? (int)Math.Round(perTaskProgressSum.GetValueOrDefault(t.Id) / elapsed * 100) : 0))
            .ToList();

        return new CoachFacts(
            CurrentDay(challenge.StartDate, today), streak.CurrentStreak, streak.LongestStreak, completedDays,
            total, maxToDate, avgPercent, perTask);
    }

    /// <summary>The GUARANTEED deterministic plain-text coach floor (no AI). Encouraging, non-medical.</summary>
    private static string PlainCoach(CoachFacts f)
    {
        var sb = new System.Text.StringBuilder();
        sb.Append($"Day {f.CurrentDay} of 75 — you're averaging {f.AvgPercent}% of your daily points");
        if (f.CurrentStreak > 0) sb.Append($" on a {f.CurrentStreak}-day streak");
        sb.Append($". {f.CompletedDays} full day{(f.CompletedDays == 1 ? "" : "s")} complete so far.");
        var weakest = f.PerTask.Where(t => t.AvgPercent < 100).OrderBy(t => t.AvgPercent).FirstOrDefault();
        if (weakest.Label is not null && weakest.AvgPercent < 100)
            sb.Append($" Your biggest opportunity is \"{weakest.Label}\" at {weakest.AvgPercent}% — keep at it.");
        else
            sb.Append(" Every task is on track — outstanding consistency.");
        return sb.ToString();
    }

    /// <summary>The compact facts string handed to the AI (it NARRATES these — it invents nothing).</summary>
    private static string CoachFactsText(CoachFacts f)
    {
        var lines = new List<string>
        {
            $"current_day: {f.CurrentDay} of 75",
            $"current_streak_days: {f.CurrentStreak}",
            $"longest_streak_days: {f.LongestStreak}",
            $"full_days_complete: {f.CompletedDays}",
            $"total_points: {f.TotalPoints:0.#}",
            $"max_points_to_date: {f.MaxPointsToDate:0.#}",
            $"average_percent_of_daily_points: {f.AvgPercent}",
        };
        foreach (var (label, pct) in f.PerTask)
            lines.Add($"task \"{label}\": {pct}% average completion");
        return string.Join("\n", lines);
    }

    // =====================================================================================
    // Small helpers
    // =====================================================================================

    private static void ApplyDayManual(HardChallengeDay row, UpsertDayRequest req, string? confession, DateTime now)
    {
        if (req.NoAlcohol is { } na) row.NoAlcohol = na;
        if (req.DietOverride is { } d) row.DietOverride = d;
        if (confession is not null) row.Confession = confession;
        row.UpdatedUtc = now;
    }

    /// <summary>Upsert the per-task MANUAL progress rows for a day (auto tasks are ignored — they recompute live).</summary>
    private static async Task UpsertTaskProgressAsync(
        UsageDbContext db, string email, int challengeId, DateOnly localDate,
        DayTaskProgressRequest[] requested, IReadOnlyDictionary<string, HardChallengeTask> taskByKey,
        DateTime now, CancellationToken ct)
    {
        foreach (var p in requested)
        {
            if (string.IsNullOrWhiteSpace(p.Key) || !taskByKey.TryGetValue(p.Key, out var task)) continue;
            if (task.AutoSource != HardTaskAutoSource.None) continue; // auto tasks: progress is computed, never stored

            var existing = await db.HardChallengeDayTasks
                .FirstOrDefaultAsync(x => x.UserEmail == email && x.LocalDate == localDate && x.TaskId == task.Id, ct);
            var value = p.Value is { } v ? Math.Clamp(v, 0m, 1_000_000m) : (decimal?)null;
            if (existing is null)
            {
                db.HardChallengeDayTasks.Add(new HardChallengeDayTask
                {
                    ChallengeId = challengeId,
                    TaskId = task.Id,
                    UserEmail = email,
                    LocalDate = localDate,
                    Value = value,
                    Done = p.Done,
                    CreatedUtc = now,
                    UpdatedUtc = now,
                });
            }
            else
            {
                if (p.Value is not null) existing.Value = value;
                if (p.Done is not null) existing.Done = p.Done;
                existing.UpdatedUtc = now;
            }
        }
        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException ex) when (TrackerVisibility.IsUniqueViolation(ex))
        {
            db.ChangeTracker.Clear(); // a concurrent insert raced one row; the next read recomputes anyway
        }
    }

    private static decimal? ClampTarget(decimal? t) => t is { } v && v > 0 ? Math.Clamp(v, 0.01m, 1_000_000m) : null;
    private static int ClampPoints(int p) => Math.Clamp(p, 0, HardChallengeScoring.MaxTaskPoints);

    private static int CurrentDay(DateOnly start, DateOnly date) =>
        Math.Clamp((date.DayNumber - start.DayNumber) + 1, 1, TotalDays);

    private static bool WithinWindow(DateOnly start, DateOnly date) =>
        date >= start && date <= start.AddDays(TotalDays - 1);

    private static async Task<(string Target, bool IsSelf, IResult? Error)> ResolveTargetAsync(
        int? user, CurrentUserAccessor.CurrentUser caller, UsageDbContext db, CancellationToken ct)
    {
        if (user is not int targetId)
            return (caller.Email, true, null);
        if (targetId <= 0)
            return ("", false, Results.BadRequest(new { message = "`user` must be a positive user id." }));

        var targetEmail = await db.Users.AsNoTracking()
            .Where(u => u.Id == targetId).Select(u => u.Email).FirstOrDefaultAsync(ct);
        if (string.IsNullOrEmpty(targetEmail))
            return ("", false, Results.NotFound());

        var isSelf = string.Equals(targetEmail, caller.Email, StringComparison.OrdinalIgnoreCase);
        return (targetEmail, isSelf, null);
    }

    private static List<DateOnly> ParseDates(string[]? raw)
    {
        var list = new List<DateOnly>();
        if (raw is null) return list;
        foreach (var s in raw)
            if (TryParseDate(s, out var d) && !list.Contains(d)) list.Add(d);
        return list;
    }

    private static bool TryParseDate(string? date, out DateOnly result) =>
        DateOnly.TryParseExact((date ?? "").Trim(), "yyyy-MM-dd",
            System.Globalization.CultureInfo.InvariantCulture,
            System.Globalization.DateTimeStyles.None, out result);

    private static string? Trunc(string? s, int max) =>
        s is null ? null : (s.Length > max ? s[..max] : s);
}
