using System.Globalization;
using Ccusage.Api.Auth;
using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
using Ccusage.Api.Dtos;
using Ccusage.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;

namespace Ccusage.Api.Endpoints;

/// <summary>
/// AI-assist endpoints (<c>/api/ai</c>) backed by Google Gemini: estimate food macros, parse meals/photos/
/// labels, suggest goals/workouts/foods, give meal feedback, compute recipe macros, and produce coaching
/// (daily/weekly/weight) plus hydration + natural-language goal parsing. Identity comes from the JWT
/// (<c>.RequireAuthorization()</c>); capability from <see cref="Permissions.TrackerAi"/> (DB-checked) — a
/// dedicated, OFF-by-default permission separate from <see cref="Permissions.TrackerSelf"/> so AI (token
/// spend) must be granted deliberately. Every call is rate-limited (the "ai" policy) because AI costs tokens.
///
/// CONTRACT/SECURITY:
/// <list type="bullet">
///   <item>When Gemini is unconfigured (blank <c>Gemini:ApiKey</c>), every endpoint returns 503 so the
///   frontend can show "AI unavailable, enter manually". The same 503 is returned on a quota/parse failure
///   (the service returns null), so the frontend has ONE consistent degraded path.</item>
///   <item>All user free text AND images are treated strictly as DATA in the model prompt (see
///   <see cref="GeminiService"/>); we only ever parse + CLAMP the model's JSON, never execute/trust it.</item>
///   <item>The coaching / suggestion / insight / hydration / goal endpoints read the CALLER's own profile,
///   day, or weight stats SERVER-SIDE and never trust client-sent stats.</item>
///   <item>The photo features validate the image mime type + decoded size (400 on a bad/oversized image)
///   before any upstream call, and run under a tighter per-user rate cap than the text endpoints.</item>
/// </list>
/// </summary>
public static class AiEndpoints
{
    public const string RateLimitPolicy = "ai";

    /// <summary>Tighter per-user rate limit for the expensive multimodal (photo) routes.</summary>
    public const string PhotoRateLimitPolicy = "ai-photo";

    public static void MapAiEndpoints(this WebApplication app)
    {
        var g = app.MapGroup("/api/ai")
            .RequireAuthorization()
            .RequirePermission(Permissions.TrackerAi)
            .RequireRateLimiting(RateLimitPolicy);

        // ============================ Food / nutrition ============================

        // ---- Estimate macros for a free-text food description ----
        g.MapPost("/estimate-macros", async (
            EstimateMacrosRequest body, GeminiService gemini, CancellationToken ct) =>
        {
            if (!gemini.IsConfigured) return Unconfigured();
            var result = await gemini.EstimateMacrosAsync(body?.Description, body?.Quantity, ct);
            return result is null ? Unavailable() : Results.Ok(result);
        });

        // ---- Parse a multi-item meal from free text ("Big Mac, fries, Coke") ----
        g.MapPost("/parse-meal", async (
            ParseMealRequest body, GeminiService gemini, CancellationToken ct) =>
        {
            if (!gemini.IsConfigured) return Unconfigured();
            var result = await gemini.ParseMealAsync(body?.Text, ct);
            return result is null ? Unavailable() : Results.Ok(result);
        });

        // ---- MULTIMODAL: identify foods + macros from a meal photo (tighter rate cap) ----
        g.MapPost("/photo-meal", async (
            ImageRequest body, GeminiService gemini, CancellationToken ct) =>
        {
            // Validate the image FIRST so a bad/oversized upload is a clear 400 regardless of config.
            if (!TryValidateImage(body, out var base64, out var mime, out var bad)) return bad;
            if (!gemini.IsConfigured) return Unconfigured();
            var result = await gemini.PhotoMealAsync(base64, mime, ct);
            return result is null ? Unavailable() : Results.Ok(result);
        }).RequireRateLimiting(PhotoRateLimitPolicy);

        // ---- MULTIMODAL: read a nutrition label from a photo (tighter rate cap) ----
        g.MapPost("/read-label", async (
            ImageRequest body, GeminiService gemini, CancellationToken ct) =>
        {
            // Validate the image FIRST so a bad/oversized upload is a clear 400 regardless of config.
            if (!TryValidateImage(body, out var base64, out var mime, out var bad)) return bad;
            if (!gemini.IsConfigured) return Unconfigured();
            var result = await gemini.ReadLabelAsync(base64, mime, ct);
            return result is null ? Unavailable() : Results.Ok(result);
        }).RequireRateLimiting(PhotoRateLimitPolicy);

        // ---- Quick feedback (verdict + swaps) on a free-text meal ----
        g.MapPost("/meal-feedback", async (
            MealFeedbackRequest body, GeminiService gemini, CancellationToken ct) =>
        {
            if (!gemini.IsConfigured) return Unconfigured();
            var result = await gemini.MealFeedbackAsync(body?.Description, ct);
            return result is null ? Unavailable() : Results.Ok(result);
        });

        // ---- Per-serving macros for a free-text recipe ----
        g.MapPost("/recipe-macros", async (
            RecipeMacrosRequest body, GeminiService gemini, CancellationToken ct) =>
        {
            if (!gemini.IsConfigured) return Unconfigured();
            var result = await gemini.RecipeMacrosAsync(body?.Recipe, body?.Servings ?? 1, ct);
            return result is null ? Unavailable() : Results.Ok(result);
        });

        // ---- Suggest foods from the caller's OWN remaining calories/macros today (read server-side) ----
        g.MapPost("/suggest-foods", async (
            SuggestFoodsRequest _, CurrentUserAccessor me, GeminiService gemini, UsageDbContext db,
            CancellationToken ct) =>
        {
            if (!gemini.IsConfigured) return Unconfigured();
            var caller = (await me.GetUserAsync(ct))!;
            var (remCal, remP, remC, remF) = await RemainingTodayAsync(db, caller.Email, ct);
            var result = await gemini.SuggestFoodsAsync(remCal, remP, remC, remF, ct);
            return result is null ? Unavailable() : Results.Ok(result);
        });

        // ============================ Exercise / workouts ============================

        // ---- Estimate calories burned for a free-text exercise ----
        g.MapPost("/estimate-exercise", async (
            EstimateExerciseRequest body, GeminiService gemini, CancellationToken ct) =>
        {
            if (!gemini.IsConfigured) return Unconfigured();
            var result = await gemini.EstimateExerciseCaloriesAsync(body?.Name, body?.DurationMin ?? 0, ct);
            return result is null ? Unavailable() : Results.Ok(result);
        });

        // ---- Parse a natural-language exercise log; calories use the caller's OWN body weight ----
        g.MapPost("/parse-exercise", async (
            ParseExerciseRequest body, CurrentUserAccessor me, GeminiService gemini, UsageDbContext db,
            CancellationToken ct) =>
        {
            if (!gemini.IsConfigured) return Unconfigured();
            var caller = (await me.GetUserAsync(ct))!;
            var weight = await db.TrackerProfiles.AsNoTracking()
                .Where(p => p.UserEmail == caller.Email)
                .Select(p => p.WeightKg)
                .FirstOrDefaultAsync(ct);
            var result = await gemini.ParseExerciseAsync(body?.Text, weight, ct);
            return result is null ? Unavailable() : Results.Ok(result);
        });

        // ---- Suggest a workout for a focus area + duration + optional equipment ----
        g.MapPost("/suggest-workout", async (
            SuggestWorkoutRequest body, GeminiService gemini, CancellationToken ct) =>
        {
            if (!gemini.IsConfigured) return Unconfigured();
            var result = await gemini.SuggestWorkoutAsync(body?.Focus, body?.Minutes ?? 0, body?.Equipment, ct);
            return result is null ? Unavailable() : Results.Ok(result);
        });

        // ============================ Goal / profile ============================

        // ---- Suggest a daily goal from the caller's OWN profile (read server-side) ----
        g.MapPost("/suggest-goal", async (
            SuggestGoalRequest _, CurrentUserAccessor me, GeminiService gemini, UsageDbContext db,
            CancellationToken ct) =>
        {
            if (!gemini.IsConfigured) return Unconfigured();

            var caller = (await me.GetUserAsync(ct))!;
            var profile = await db.TrackerProfiles.AsNoTracking()
                .FirstOrDefaultAsync(p => p.UserEmail == caller.Email, ct)
                ?? new TrackerProfile { UserEmail = caller.Email };

            var result = await gemini.SuggestGoalAsync(profile, ct);
            return result is null ? Unavailable() : Results.Ok(result);
        });

        // ---- Turn a free-text goal into a structured plan ("lose 10 lbs in 3 months") ----
        g.MapPost("/natural-goal", async (
            NaturalGoalRequest body, GeminiService gemini, CancellationToken ct) =>
        {
            if (!gemini.IsConfigured) return Unconfigured();
            var result = await gemini.NaturalGoalAsync(body?.Text, ct);
            return result is null ? Unavailable() : Results.Ok(result);
        });

        // ============================ Coaching (GET, cached) ============================

        // ---- Daily coach from the caller's OWN day (cached ~6h per user+local-date) ----
        g.MapGet("/daily-coach", async (
            CurrentUserAccessor me, GeminiService gemini, UsageDbContext db, CancellationToken ct) =>
        {
            if (!gemini.IsConfigured) return Unconfigured();
            var caller = (await me.GetUserAsync(ct))!;
            var today = await TodayAsync(db, ct);
            var summary = await BuildDaySummaryAsync(db, caller.Email, today, ct);
            var result = await gemini.DailyCoachAsync(caller.Email, today.ToString("yyyy-MM-dd"), summary, ct);
            return result is null ? Unavailable() : Results.Ok(result);
        });

        // ---- Weekly review from the caller's OWN last 7 days (cached ~6h per user+ISO-week) ----
        g.MapGet("/weekly-review", async (
            CurrentUserAccessor me, GeminiService gemini, UsageDbContext db, CancellationToken ct) =>
        {
            if (!gemini.IsConfigured) return Unconfigured();
            var caller = (await me.GetUserAsync(ct))!;
            var today = await TodayAsync(db, ct);
            var (isoWeek, summary) = await BuildWeekSummaryAsync(db, caller.Email, today, ct);
            var result = await gemini.WeeklyReviewAsync(caller.Email, isoWeek, summary, ct);
            return result is null ? Unavailable() : Results.Ok(result);
        });

        // ---- Weight insight from the caller's OWN weight stats (cached ~6h per user+local-date) ----
        g.MapGet("/weight-insight", async (
            CurrentUserAccessor me, GeminiService gemini, UsageDbContext db, CancellationToken ct) =>
        {
            if (!gemini.IsConfigured) return Unconfigured();
            var caller = (await me.GetUserAsync(ct))!;
            var today = await TodayAsync(db, ct);
            var summary = await BuildWeightSummaryAsync(db, caller.Email, today, ct);
            var result = await gemini.WeightInsightAsync(caller.Email, today.ToString("yyyy-MM-dd"), summary, ct);
            return result is null ? Unavailable() : Results.Ok(result);
        });

        // ============================ Hydration ============================

        // ---- Suggest a hydration target from the caller's OWN profile (read server-side) ----
        g.MapPost("/hydration-suggest", async (
            HydrationSuggestRequest _, CurrentUserAccessor me, GeminiService gemini, UsageDbContext db,
            CancellationToken ct) =>
        {
            if (!gemini.IsConfigured) return Unconfigured();
            var caller = (await me.GetUserAsync(ct))!;
            var profile = await db.TrackerProfiles.AsNoTracking()
                .FirstOrDefaultAsync(p => p.UserEmail == caller.Email, ct)
                ?? new TrackerProfile { UserEmail = caller.Email };
            var result = await gemini.HydrationSuggestAsync(profile, ct);
            return result is null ? Unavailable() : Results.Ok(result);
        });

        // ---- Parse free-text drinks into discrete amounts ("2 coffees and a big water") ----
        g.MapPost("/parse-hydration", async (
            ParseHydrationRequest body, GeminiService gemini, CancellationToken ct) =>
        {
            if (!gemini.IsConfigured) return Unconfigured();
            var result = await gemini.ParseHydrationAsync(body?.Text, ct);
            return result is null ? Unavailable() : Results.Ok(result);
        });

        // ============================ AI Day Builder ============================

        // ---- Reconstruct a COMPLETE day from a brain-dump + optional photos; multi-turn refine ----
        // Runs under the tighter ai-photo (5/min) cap whether or not images are attached (it's the most
        // token-heavy multi-item call). NOTHING is persisted; the whole-day write is the separate /commit.
        g.MapPost("/build-day", async (
            BuildDayRequest body, CurrentUserAccessor me, GeminiService gemini, UsageDbContext db,
            CancellationToken ct) =>
        {
            // Structural abuse caps (400 before any upstream work).
            var images = body?.Images ?? new List<ImageRequest>();
            var answers = body?.Answers ?? new List<ClarifyAnswer>();
            if (images.Count > 4)
                return Results.BadRequest(new { message = "At most 4 photos." });
            if (answers.Count > 20)
                return Results.BadRequest(new { message = "Too many answers." });

            // Validate EACH image first (mime/size/base64) so a bad upload is a clear 400 regardless of config.
            var validImages = new List<(string base64, string mime)>();
            foreach (var img in images)
            {
                if (!TryValidateImage(img, out var b64, out var mime, out var bad)) return bad;
                validImages.Add((b64, mime));
            }

            var hasText = !string.IsNullOrWhiteSpace(body?.Text);
            if (!hasText && validImages.Count == 0 && body?.PriorDraft is null)
                return Results.BadRequest(new { message = "Describe your day or attach a photo." });

            if (!gemini.IsConfigured) return Unconfigured();

            // The caller's OWN body weight (read server-side) sharpens exercise calorie estimates.
            var caller = (await me.GetUserAsync(ct))!;
            var weight = await db.TrackerProfiles.AsNoTracking()
                .Where(p => p.UserEmail == caller.Email)
                .Select(p => p.WeightKg)
                .FirstOrDefaultAsync(ct);

            var result = await gemini.BuildDayAsync(
                body?.Text, body?.Date, body?.LocalTimeOfDay, validImages,
                body?.PriorDraft, answers, weight, ct);
            if (result is null) return Unavailable();

            var priorRound = body?.PriorDraft is not null;
            return Results.Ok(new BuildDayResponse
            {
                BuildId = Guid.NewGuid().ToString("N"),
                Draft = result.Draft,
                Questions = result.Questions,
                Round = priorRound ? 2 : 1,
                Notes = null,
            });
        }).RequireRateLimiting(PhotoRateLimitPolicy);

        // ---- A celebratory end-of-day recap of the caller's LOGGED day (read server-side, cached 6h) ----
        g.MapPost("/day-summary", async (
            DaySummaryRequest body, CurrentUserAccessor me, GeminiService gemini, UsageDbContext db,
            CancellationToken ct) =>
        {
            if (!gemini.IsConfigured) return Unconfigured();
            var caller = (await me.GetUserAsync(ct))!;
            var localDate = await ResolveDateAsync(db, body?.Date, ct);
            var (summary, anythingLogged) = await BuildLoggedDaySummaryAsync(db, caller.Email, localDate, ct);

            // Empty-day rule: don't call Gemini (and don't 503) — return a friendly empty state.
            if (!anythingLogged)
                return Results.Ok(new DaySummaryResponse
                {
                    Headline = "Nothing logged yet today.",
                    Highlights = new List<string>(),
                    Tomorrow = null,
                });

            var result = await gemini.DaySummaryAsync(caller.Email, localDate.ToString("yyyy-MM-dd"), summary, ct);
            return result is null ? Unavailable() : Results.Ok(result);
        });

        // ---- A warm, read-only weekly recap of the caller's OWN last 7 local days (cached 6h, ALWAYS 200) ----
        // Unlike the other AI routes, this one is gated by tracker.self (NOT tracker.ai) and ALWAYS returns 200:
        // its deterministic plain floor needs no AI, so a tracker.self user always gets the recap (the warm AI
        // narration is the optional upgrade when tracker.ai-level AI is configured). When Gemini is
        // unconfigured/errors the GUARANTEED plain floor is returned with fellBackToPlain=true (NEVER a 503). It
        // NARRATES ONLY the server-computed weekly numbers; it writes NOTHING. Mapped OUTSIDE the tracker.ai
        // group so the floor is reachable with tracker.self alone; still rate-limited (the AI policy).
        var recap = app.MapGroup("/api/ai")
            .RequireAuthorization()
            .RequirePermission(Permissions.TrackerSelf)
            .RequireRateLimiting(RateLimitPolicy);

        recap.MapGet("/tracker-recap", async (
            CurrentUserAccessor me, GeminiService gemini, IMemoryCache cache, UsageDbContext db,
            CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var today = await TodayAsync(db, ct);
            var weekStart = today.AddDays(-6);
            var facts = await ComputeWeekRecapFactsAsync(db, caller.Email, today, ct);

            var plain = PlainTrackerRecap(facts);

            // Plain recap is the floor. Prefer the warm AI narrative when configured (cached per user+week).
            if (!gemini.IsConfigured)
                return Results.Ok(new TrackerRecapDto(plain, Array.Empty<string>(), true));

            var cacheKey = $"ai:tracker-recap:{caller.Email}:{weekStart:yyyy-MM-dd}";
            if (cache.TryGetValue(cacheKey, out TrackerRecapDto? cached) && cached is not null)
                return Results.Ok(cached);

            TrackerRecapResult? ai;
            try
            {
                ai = await gemini.TrackerRecapAsync(TrackerRecapFacts(facts), ct);
            }
            catch
            {
                ai = null;
            }

            if (ai is null || string.IsNullOrWhiteSpace(ai.Narrative))
                return Results.Ok(new TrackerRecapDto(plain, Array.Empty<string>(), true)); // floor

            var dto = new TrackerRecapDto(ai.Narrative, ai.Insights, false);
            cache.Set(cacheKey, dto, TimeSpan.FromHours(6));
            return Results.Ok(dto);
        });
    }

    // ===================================================================================
    // Tracker weekly recap — server-side aggregation of the caller's OWN last 7 local days
    // ===================================================================================

    /// <summary>
    /// The tracker weekly-recap DTO: a warm 2–4 sentence <see cref="Narrative"/> of the caller's last 7 days
    /// plus 0–4 gentle <see cref="Insights"/>, both NARRATED from the same server-side tracker queries the
    /// recap aggregates (the model invents nothing). <see cref="FellBackToPlain"/> is true when Gemini was
    /// unconfigured/errored and the deterministic plain floor was returned instead. This endpoint ALWAYS
    /// returns 200 — the plain text is the floor — never a 503/500, and it writes NOTHING.
    /// </summary>
    public sealed record TrackerRecapDto(
        string Narrative, IReadOnlyList<string> Insights, bool FellBackToPlain);

    /// <summary>The server-computed facts for the caller's last 7 LOCAL days, aggregated from the SAME tracker
    /// queries the day/weight reads use. Nothing here comes from the client. <see cref="DaysLogged"/> counts
    /// days with ANY food/exercise/hydration/weight/activity row; the averages are over the 7-day window.</summary>
    private sealed record WeekRecapFacts(
        string WeekStart, string WeekEnd, int DaysLogged,
        int AvgCaloriesIn, int? CalorieGoal,
        double AvgProteinG, double AvgCarbsG, double AvgFatG,
        int? ProteinGoalG, int? CarbGoalG, int? FatGoalG,
        int ProteinGoalMetDays, int CarbGoalMetDays, int FatGoalMetDays,
        int AvgSteps, int AvgActiveCalories, int AvgHydrationMl,
        double? WeightStartKg, double? WeightEndKg, double? WeightDeltaKg);

    private static async Task<WeekRecapFacts> ComputeWeekRecapFactsAsync(
        UsageDbContext db, string email, DateOnly today, CancellationToken ct)
    {
        var from = today.AddDays(-6);
        var profile = await db.TrackerProfiles.AsNoTracking()
            .FirstOrDefaultAsync(p => p.UserEmail == email, ct);

        var foods = await db.FoodEntries.AsNoTracking()
            .Where(f => f.UserEmail == email && f.LocalDate >= from && f.LocalDate <= today)
            .Select(f => new { f.LocalDate, f.Calories, f.ProteinG, f.CarbG, f.FatG })
            .ToListAsync(ct);
        var exercises = await db.ExerciseEntries.AsNoTracking()
            .Where(x => x.UserEmail == email && x.LocalDate >= from && x.LocalDate <= today)
            .Select(x => new { x.LocalDate, x.CaloriesBurned })
            .ToListAsync(ct);
        var hydration = await db.HydrationEntries.AsNoTracking()
            .Where(h => h.UserEmail == email && h.LocalDate >= from && h.LocalDate <= today)
            .Select(h => new { h.LocalDate, h.AmountMl })
            .ToListAsync(ct);
        var activities = await db.DailyActivities.AsNoTracking()
            .Where(a => a.UserEmail == email && a.LocalDate >= from && a.LocalDate <= today)
            .Select(a => new { a.LocalDate, a.Steps, a.ActiveCalories })
            .ToListAsync(ct);
        var weights = await db.WeightEntries.AsNoTracking()
            .Where(w => w.UserEmail == email && w.LocalDate >= from && w.LocalDate <= today)
            .OrderBy(w => w.LocalDate).ThenBy(w => w.Slot).ThenBy(w => w.Id)
            .Select(w => new { w.LocalDate, w.WeightKg })
            .ToListAsync(ct);

        // Goals (null when unset — the floor/model handles "no goal" gracefully).
        var calGoal = profile?.DailyCalorieGoal;
        var proteinGoal = profile?.ProteinGoalG;
        var carbGoal = profile?.CarbGoalG;
        var fatGoal = profile?.FatGoalG;

        // Per-day macro/calorie roll-ups (only days that have food entries contribute to the averages).
        var foodDays = foods.GroupBy(f => f.LocalDate).Select(grp => new
        {
            Date = grp.Key,
            Cal = grp.Sum(f => f.Calories),
            Protein = grp.Sum(f => f.ProteinG),
            Carbs = grp.Sum(f => f.CarbG),
            Fat = grp.Sum(f => f.FatG),
        }).ToList();

        int AvgOver(IEnumerable<int> vals)
        {
            var list = vals.ToList();
            return list.Count == 0 ? 0 : (int)Math.Round(list.Average(), MidpointRounding.AwayFromZero);
        }
        double AvgOverD(IEnumerable<double> vals)
        {
            var list = vals.ToList();
            return list.Count == 0 ? 0 : Math.Round(list.Average(), 1);
        }

        var avgCal = AvgOver(foodDays.Select(d => d.Cal));
        var avgProtein = AvgOverD(foodDays.Select(d => d.Protein));
        var avgCarbs = AvgOverD(foodDays.Select(d => d.Carbs));
        var avgFat = AvgOverD(foodDays.Select(d => d.Fat));

        // How many of the logged-food days met each macro goal (only meaningful when a goal is set).
        var proteinMet = proteinGoal is int pg && pg > 0 ? foodDays.Count(d => d.Protein >= pg) : 0;
        var carbMet = carbGoal is int cg && cg > 0 ? foodDays.Count(d => d.Carbs >= cg) : 0;
        var fatMet = fatGoal is int fg && fg > 0 ? foodDays.Count(d => d.Fat >= fg) : 0;

        // Steps / active calories: average over the days that recorded each (not the whole window).
        var avgSteps = AvgOver(activities.Where(a => a.Steps is not null).Select(a => a.Steps!.Value));
        var avgActiveCal = AvgOver(activities.Where(a => a.ActiveCalories is not null)
            .Select(a => a.ActiveCalories!.Value));

        // Hydration: average over days that logged any fluid.
        var hydrationByDay = hydration.GroupBy(h => h.LocalDate).Select(grp => grp.Sum(h => h.AmountMl)).ToList();
        var avgHydration = AvgOver(hydrationByDay);

        // Weight trend: first vs last reading in the window (start→end delta).
        double? weightStart = weights.Count > 0 ? weights[0].WeightKg : null;
        double? weightEnd = weights.Count > 0 ? weights[^1].WeightKg : null;
        double? weightDelta = weightStart is { } ws && weightEnd is { } we ? Math.Round(we - ws, 2) : null;

        // Days logged = days with ANY tracked data of any kind.
        var loggedDates = new HashSet<DateOnly>();
        foreach (var f in foods) loggedDates.Add(f.LocalDate);
        foreach (var x in exercises) loggedDates.Add(x.LocalDate);
        foreach (var h in hydration) loggedDates.Add(h.LocalDate);
        foreach (var a in activities)
            if (a.Steps is not null || a.ActiveCalories is not null) loggedDates.Add(a.LocalDate);
        foreach (var w in weights) loggedDates.Add(w.LocalDate);

        return new WeekRecapFacts(
            WeekStart: from.ToString("yyyy-MM-dd"),
            WeekEnd: today.ToString("yyyy-MM-dd"),
            DaysLogged: loggedDates.Count,
            AvgCaloriesIn: avgCal,
            CalorieGoal: calGoal,
            AvgProteinG: avgProtein, AvgCarbsG: avgCarbs, AvgFatG: avgFat,
            ProteinGoalG: proteinGoal, CarbGoalG: carbGoal, FatGoalG: fatGoal,
            ProteinGoalMetDays: proteinMet, CarbGoalMetDays: carbMet, FatGoalMetDays: fatMet,
            AvgSteps: avgSteps, AvgActiveCalories: avgActiveCal, AvgHydrationMl: avgHydration,
            WeightStartKg: weightStart, WeightEndKg: weightEnd, WeightDeltaKg: weightDelta);
    }

    /// <summary>Pre-format the server-computed week <paramref name="f"/> numbers as a tight DATA block the model
    /// NARRATES (it never recomputes). Goals that are unset read as "(unset)". Nothing here comes from the
    /// client beyond the implicit "today".</summary>
    private static string TrackerRecapFacts(WeekRecapFacts f)
    {
        var sb = new System.Text.StringBuilder();
        sb.Append("week: ").Append(f.WeekStart).Append(" to ").Append(f.WeekEnd).Append('\n');
        sb.Append("days_logged: ").Append(f.DaysLogged).Append(" of 7\n");
        sb.Append("avg_calories_per_day: ").Append(f.AvgCaloriesIn)
          .Append(" (goal ").Append(f.CalorieGoal?.ToString() ?? "unset").Append(")\n");
        sb.Append("avg_protein_g: ").Append(f.AvgProteinG)
          .Append(" (goal ").Append(f.ProteinGoalG?.ToString() ?? "unset").Append(")");
        if (f.ProteinGoalG is int) sb.Append(" met ").Append(f.ProteinGoalMetDays).Append(" of 7 days");
        sb.Append('\n');
        sb.Append("avg_carbs_g: ").Append(f.AvgCarbsG)
          .Append(" (goal ").Append(f.CarbGoalG?.ToString() ?? "unset").Append(")");
        if (f.CarbGoalG is int) sb.Append(" met ").Append(f.CarbGoalMetDays).Append(" of 7 days");
        sb.Append('\n');
        sb.Append("avg_fat_g: ").Append(f.AvgFatG)
          .Append(" (goal ").Append(f.FatGoalG?.ToString() ?? "unset").Append(")");
        if (f.FatGoalG is int) sb.Append(" met ").Append(f.FatGoalMetDays).Append(" of 7 days");
        sb.Append('\n');
        sb.Append("avg_steps: ").Append(f.AvgSteps).Append('\n');
        sb.Append("avg_active_calories: ").Append(f.AvgActiveCalories).Append('\n');
        sb.Append("avg_hydration_ml: ").Append(f.AvgHydrationMl).Append('\n');
        if (f.WeightDeltaKg is { } d && f.WeightStartKg is { } ws && f.WeightEndKg is { } we)
            sb.Append("weight_kg: start ").Append(ws).Append(" end ").Append(we)
              .Append(" delta ").Append(d).Append('\n');
        else
            sb.Append("weight_kg: (no readings this week)\n");
        return sb.ToString();
    }

    /// <summary>The GUARANTEED deterministic plain floor: a one-liner stating days logged, avg calories vs goal,
    /// and the weight delta. Used when Gemini is unconfigured/errors — it NEVER 503s.</summary>
    private static string PlainTrackerRecap(WeekRecapFacts f)
    {
        var s = $"You logged {f.DaysLogged} of 7 days";
        if (f.DaysLogged > 0)
        {
            s += $"; averaged {f.AvgCaloriesIn} kcal/day";
            if (f.CalorieGoal is int g && g > 0) s += $" vs a {g} goal";
        }
        if (f.WeightDeltaKg is { } d)
        {
            var dir = d < 0 ? "down" : d > 0 ? "up" : "steady";
            s += d == 0
                ? "; weight held steady"
                : $"; weight {dir} {Math.Abs(d).ToString("0.#", CultureInfo.InvariantCulture)} kg";
        }
        return s + ".";
    }

    /// <summary>Parse the client's yyyy-MM-dd date, or fall back to "today" in the display timezone.</summary>
    private static async Task<DateOnly> ResolveDateAsync(UsageDbContext db, string? date, CancellationToken ct)
    {
        if (DateOnly.TryParseExact((date ?? "").Trim(), "yyyy-MM-dd",
                CultureInfo.InvariantCulture, DateTimeStyles.None, out var parsed))
            return parsed;
        return await TodayAsync(db, ct);
    }

    /// <summary>
    /// A richer, model-friendly summary of the caller's LOGGED day for the end-of-day recap: the goal /
    /// calorie / macro / foods / exercises summary, PLUS the hydration total, latest weight, and watch
    /// steps/distance/active-calories. Returns the summary text and whether ANYTHING was logged at all
    /// (so the handler can short-circuit an empty day without calling Gemini).
    /// </summary>
    private static async Task<(string summary, bool anythingLogged)> BuildLoggedDaySummaryAsync(
        UsageDbContext db, string email, DateOnly date, CancellationToken ct)
    {
        var baseSummary = await BuildDaySummaryAsync(db, email, date, ct);

        var foodCount = await db.FoodEntries.AsNoTracking()
            .CountAsync(f => f.UserEmail == email && f.LocalDate == date, ct);
        var exerciseCount = await db.ExerciseEntries.AsNoTracking()
            .CountAsync(x => x.UserEmail == email && x.LocalDate == date, ct);
        var hydrationMl = await db.HydrationEntries.AsNoTracking()
            .Where(h => h.UserEmail == email && h.LocalDate == date)
            .SumAsync(h => (int?)h.AmountMl, ct) ?? 0;
        var latestWeight = await db.WeightEntries.AsNoTracking()
            .Where(w => w.UserEmail == email && w.LocalDate == date)
            .OrderByDescending(w => w.Slot).ThenByDescending(w => w.Id)
            .Select(w => (double?)w.WeightKg)
            .FirstOrDefaultAsync(ct);
        var activity = await db.DailyActivities.AsNoTracking()
            .FirstOrDefaultAsync(a => a.UserEmail == email && a.LocalDate == date, ct);

        var sb = new System.Text.StringBuilder(baseSummary);
        sb.Append("hydration_ml: ").Append(hydrationMl).Append('\n');
        if (latestWeight is { } lw) sb.Append("weight_kg: ").Append(lw).Append('\n');
        if (activity is not null)
        {
            if (activity.Steps is { } st) sb.Append("steps: ").Append(st).Append('\n');
            if (activity.DistanceMeters is { } dm) sb.Append("distance_m: ").Append(dm).Append('\n');
            if (activity.ActiveCalories is { } ac) sb.Append("active_calories: ").Append(ac).Append('\n');
        }

        var anythingLogged = foodCount > 0 || exerciseCount > 0 || hydrationMl > 0
            || latestWeight is not null
            || (activity is not null && (activity.Steps is not null || activity.DistanceMeters is not null
                || activity.ActiveCalories is not null));
        return (sb.ToString(), anythingLogged);
    }

    // ===================================================================================
    // Server-side data reads (the caller's OWN profile / day / week / weight)
    // ===================================================================================

    /// <summary>
    /// The caller's REMAINING calories + macros for today: their goal minus what's logged (calories also add
    /// back the day's exercise burn, mirroring the day roll-up). Missing goals fall back to a sane default so
    /// suggestions still make sense. Never trusts client-sent stats.
    /// </summary>
    private static async Task<(int cal, double protein, double carbs, double fat)> RemainingTodayAsync(
        UsageDbContext db, string email, CancellationToken ct)
    {
        var today = await TodayAsync(db, ct);
        var profile = await db.TrackerProfiles.AsNoTracking()
            .FirstOrDefaultAsync(p => p.UserEmail == email, ct);

        var foods = await db.FoodEntries.AsNoTracking()
            .Where(f => f.UserEmail == email && f.LocalDate == today)
            .Select(f => new { f.Calories, f.ProteinG, f.CarbG, f.FatG })
            .ToListAsync(ct);
        var burned = await db.ExerciseEntries.AsNoTracking()
            .Where(x => x.UserEmail == email && x.LocalDate == today)
            .SumAsync(x => (int?)x.CaloriesBurned, ct) ?? 0;

        var calIn = foods.Sum(f => f.Calories);
        var protein = foods.Sum(f => f.ProteinG);
        var carbs = foods.Sum(f => f.CarbG);
        var fat = foods.Sum(f => f.FatG);

        var calGoal = profile?.DailyCalorieGoal ?? 2000;
        var remCal = Math.Max(0, calGoal - calIn + burned);
        var remP = Math.Max(0, (profile?.ProteinGoalG ?? 0) - protein);
        var remC = Math.Max(0, (profile?.CarbGoalG ?? 0) - carbs);
        var remF = Math.Max(0, (profile?.FatGoalG ?? 0) - fat);
        return (remCal, Math.Round(remP, 1), Math.Round(remC, 1), Math.Round(remF, 1));
    }

    /// <summary>A compact, model-friendly summary of the caller's day so far (goal, intake, burn, foods).</summary>
    private static async Task<string> BuildDaySummaryAsync(
        UsageDbContext db, string email, DateOnly date, CancellationToken ct)
    {
        var profile = await db.TrackerProfiles.AsNoTracking()
            .FirstOrDefaultAsync(p => p.UserEmail == email, ct);
        var foods = await db.FoodEntries.AsNoTracking()
            .Where(f => f.UserEmail == email && f.LocalDate == date)
            .OrderBy(f => f.Meal).ThenBy(f => f.Id)
            .Select(f => new { f.Meal, f.Description, f.Calories, f.ProteinG, f.CarbG, f.FatG })
            .ToListAsync(ct);
        var exercises = await db.ExerciseEntries.AsNoTracking()
            .Where(x => x.UserEmail == email && x.LocalDate == date)
            .OrderBy(x => x.Id)
            .Select(x => new { x.Name, x.DurationMin, x.CaloriesBurned })
            .ToListAsync(ct);

        var calIn = foods.Sum(f => f.Calories);
        var burned = exercises.Sum(x => x.CaloriesBurned);
        var sb = new System.Text.StringBuilder();
        sb.Append("goal_direction: ").Append(profile?.Goal.ToString() ?? "Maintain").Append('\n');
        sb.Append("calorie_goal: ").Append(profile?.DailyCalorieGoal?.ToString() ?? "unset").Append('\n');
        sb.Append("calories_in: ").Append(calIn).Append('\n');
        sb.Append("calories_burned: ").Append(burned).Append('\n');
        sb.Append("protein_g: ").Append(Math.Round(foods.Sum(f => f.ProteinG), 1)).Append('\n');
        sb.Append("carbs_g: ").Append(Math.Round(foods.Sum(f => f.CarbG), 1)).Append('\n');
        sb.Append("fat_g: ").Append(Math.Round(foods.Sum(f => f.FatG), 1)).Append('\n');
        sb.Append("foods:\n");
        foreach (var f in foods.Take(40))
            sb.Append("- ").Append(f.Meal).Append(": ").Append(Snip(f.Description, 60))
              .Append(" (").Append(f.Calories).Append(" kcal)\n");
        sb.Append("exercises:\n");
        foreach (var x in exercises.Take(40))
            sb.Append("- ").Append(Snip(x.Name, 60)).Append(" (").Append(x.CaloriesBurned).Append(" kcal)\n");
        return sb.ToString();
    }

    /// <summary>The ISO-week key + a per-day calorie/macro summary of the caller's last 7 days.</summary>
    private static async Task<(string isoWeek, string summary)> BuildWeekSummaryAsync(
        UsageDbContext db, string email, DateOnly today, CancellationToken ct)
    {
        var from = today.AddDays(-6);
        var profile = await db.TrackerProfiles.AsNoTracking()
            .FirstOrDefaultAsync(p => p.UserEmail == email, ct);

        var foods = await db.FoodEntries.AsNoTracking()
            .Where(f => f.UserEmail == email && f.LocalDate >= from && f.LocalDate <= today)
            .Select(f => new { f.LocalDate, f.Calories, f.ProteinG })
            .ToListAsync(ct);
        var exercises = await db.ExerciseEntries.AsNoTracking()
            .Where(x => x.UserEmail == email && x.LocalDate >= from && x.LocalDate <= today)
            .Select(x => new { x.LocalDate, x.CaloriesBurned })
            .ToListAsync(ct);

        var sb = new System.Text.StringBuilder();
        sb.Append("goal_direction: ").Append(profile?.Goal.ToString() ?? "Maintain").Append('\n');
        sb.Append("calorie_goal: ").Append(profile?.DailyCalorieGoal?.ToString() ?? "unset").Append('\n');
        sb.Append("days:\n");
        for (var d = from; d <= today; d = d.AddDays(1))
        {
            var calIn = foods.Where(f => f.LocalDate == d).Sum(f => f.Calories);
            var protein = foods.Where(f => f.LocalDate == d).Sum(f => f.ProteinG);
            var burned = exercises.Where(x => x.LocalDate == d).Sum(x => x.CaloriesBurned);
            sb.Append("- ").Append(d.ToString("yyyy-MM-dd")).Append(": in=").Append(calIn)
              .Append(" burned=").Append(burned).Append(" protein_g=").Append(Math.Round(protein, 1)).Append('\n');
        }

        var iso = ISOWeek.GetYear(today.ToDateTime(TimeOnly.MinValue));
        var week = ISOWeek.GetWeekOfYear(today.ToDateTime(TimeOnly.MinValue));
        return ($"{iso}-W{week:00}", sb.ToString());
    }

    /// <summary>
    /// A summary of the caller's own weight stats: per-slot averages + latest, the morning→evening delta,
    /// and a simple first-vs-last trend over the last 90 days. Mirrors the tracker's private weight stats.
    /// </summary>
    private static async Task<string> BuildWeightSummaryAsync(
        UsageDbContext db, string email, DateOnly today, CancellationToken ct)
    {
        var from = today.AddDays(-89);
        var rows = await db.WeightEntries.AsNoTracking()
            .Where(w => w.UserEmail == email && w.LocalDate >= from && w.LocalDate <= today)
            .OrderBy(w => w.LocalDate).ThenBy(w => w.Slot).ThenBy(w => w.Id)
            .Select(w => new { w.LocalDate, w.Slot, w.WeightKg })
            .ToListAsync(ct);

        var sb = new System.Text.StringBuilder();
        if (rows.Count == 0)
        {
            sb.Append("no_readings: true\n");
            return sb.ToString();
        }

        foreach (var grp in rows.GroupBy(w => w.Slot).OrderBy(grp => grp.Key))
            sb.Append("slot_").Append(grp.Key).Append("_avg_kg: ").Append(Math.Round(grp.Average(w => w.WeightKg), 2))
              .Append(" latest_kg: ").Append(grp.Last().WeightKg).Append(" count: ").Append(grp.Count()).Append('\n');

        double? AvgFor(WeightSlot s)
        {
            var v = rows.Where(w => w.Slot == s).Select(w => w.WeightKg).ToList();
            return v.Count == 0 ? null : v.Average();
        }
        var morning = AvgFor(WeightSlot.Morning);
        var evening = AvgFor(WeightSlot.Evening);
        if (morning is { } m && evening is { } e)
            sb.Append("morning_evening_delta_kg: ").Append(Math.Round(e - m, 2)).Append('\n');

        sb.Append("first_kg: ").Append(rows[0].WeightKg).Append(" last_kg: ").Append(rows[^1].WeightKg).Append('\n');
        sb.Append("change_kg: ").Append(Math.Round(rows[^1].WeightKg - rows[0].WeightKg, 2)).Append('\n');
        return sb.ToString();
    }

    /// <summary>"Today" in the app's display timezone (UTC fallback on a bad/blank id), mirroring TrackerEndpoints.</summary>
    private static async Task<DateOnly> TodayAsync(UsageDbContext db, CancellationToken ct)
    {
        var id = (await db.AppConfigs.AsNoTracking().FirstOrDefaultAsync(ct))?.DisplayTimeZone;
        TimeZoneInfo tz;
        if (string.IsNullOrWhiteSpace(id)) tz = TimeZoneInfo.Utc;
        else { try { tz = TimeZoneInfo.FindSystemTimeZoneById(id); } catch { tz = TimeZoneInfo.Utc; } }
        return DateOnly.FromDateTime(TimeZoneInfo.ConvertTimeFromUtc(DateTime.UtcNow, tz));
    }

    private static string Snip(string? s, int max)
    {
        var t = (s ?? "").Trim();
        return t.Length > max ? t[..max] : t;
    }

    // ===================================================================================
    // Image validation (multimodal routes)
    // ===================================================================================

    /// <summary>
    /// Validate a multimodal image request: the mime type must be one of the allowed image types, the
    /// base64 must be present and decode cleanly, and the decoded payload must be under
    /// <see cref="GeminiService.MaxImageBytes"/>. On failure, <paramref name="bad"/> is a 400 result.
    /// </summary>
    private static bool TryValidateImage(
        ImageRequest? body, out string base64, out string mimeType, out IResult bad)
    {
        base64 = "";
        mimeType = "";
        bad = Results.BadRequest(new { message = "A valid image (jpeg/png/webp) under 5 MB is required." });

        var mime = (body?.MimeType ?? "").Trim();
        var data = (body?.ImageBase64 ?? "").Trim();
        if (mime.Length == 0 || data.Length == 0) return false;
        if (!GeminiService.AllowedImageMimeTypes.Contains(mime)) return false;

        // Strip an optional data-URL prefix ("data:image/png;base64,...") before decoding.
        var comma = data.IndexOf(',');
        if (data.StartsWith("data:", StringComparison.OrdinalIgnoreCase) && comma >= 0)
            data = data[(comma + 1)..];

        // Reject before decode if the base64 length alone already exceeds the cap (4/3 expansion); base64
        // encodes 3 bytes per 4 chars, so decoded bytes ≈ len*3/4 — cheaply bounds an oversized payload.
        if ((long)data.Length / 4 * 3 > GeminiService.MaxImageBytes) return false;

        byte[] decoded;
        try { decoded = Convert.FromBase64String(data); }
        catch (FormatException) { return false; }
        if (decoded.Length == 0 || decoded.Length > GeminiService.MaxImageBytes) return false;

        base64 = data;
        mimeType = mime;
        return true;
    }

    // ===================================================================================
    // 503 helpers
    // ===================================================================================

    /// <summary>503 when no API key is configured (the test host + an un-keyed deploy hit this).</summary>
    private static IResult Unconfigured() => Results.Problem(
        title: "AI assistance is not configured.",
        detail: "AI assistance is not configured.",
        statusCode: StatusCodes.Status503ServiceUnavailable);

    /// <summary>503 when the model is configured but the call failed (quota/parse) — same degraded path.</summary>
    private static IResult Unavailable() => Results.Problem(
        title: "AI estimate unavailable, enter manually.",
        detail: "AI estimate unavailable, enter manually.",
        statusCode: StatusCodes.Status503ServiceUnavailable);
}
