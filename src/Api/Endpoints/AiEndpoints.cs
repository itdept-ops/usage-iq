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

        // ---- ADD-FOOD PARSE: free-text OR meal-photo -> reviewable, per-item food list (PARSE-ONLY) ----
        // The single entry point behind the add-food dialog's "Describe/Speak" and "Photo" modes. A TEXT
        // body runs on tracker.ai alone (the group gate); the moment an IMAGE is attached the call becomes
        // multimodal -> the SEPARATE, OFF-by-default ai.vision capability is ALSO required (checked here, not
        // on the route, because the route gate can't see the body). The image is validated FIRST (clear 400
        // on bad mime/oversize), then digested IN-MEMORY and NEVER stored (mirrors the receipt/meal rule).
        // Identity is the JWT caller; text/image are treated strictly as DATA (injection-guarded in the
        // service). It WRITES NOTHING — the frontend posts each confirmed item to POST /api/tracker/food.
        // Like /ask + /voice-parse it NEVER 503s: AI off / unconfigured / unparseable floors to
        // 200 { aiUsed:false, items:[] } so the dialog falls back to manual entry. Macros/quantity are CLAMPED.
        g.MapPost("/parse-meal", async (
            ParseMealRequest body, CurrentUserAccessor me, GeminiService gemini, CancellationToken ct) =>
        {
            // An IMAGE makes the call multimodal -> validate it (400 on bad/oversize) and gate it on ai.vision
            // (403 without it, the route gate can't see the body). A text-only call skips both.
            (string base64, string mime)? image = null;
            if (!string.IsNullOrWhiteSpace(body?.ImageBase64))
            {
                if (!TryValidateImage(
                        new ImageRequest { ImageBase64 = body!.ImageBase64, MimeType = body.MimeType },
                        out var b64, out var mime, out var bad))
                    return bad;

                var caller0 = (await me.GetUserAsync(ct))!;
                if (!caller0.Permissions.Contains(Permissions.AiVision))
                    return Results.Json(
                        new { message = $"You don't have permission: {Permissions.AiVision}" },
                        statusCode: StatusCodes.Status403Forbidden);

                image = (b64, mime);
            }

            // Friendly always-200 floor when AI is off/unconfigured (NEVER a 503 from the add-food parse).
            if (!gemini.IsConfigured) return Results.Ok(new ParseMealResultDto());

            IReadOnlyList<ParsedFoodItemDto>? items;
            try { items = await gemini.ParseMealItemsAsync(body?.Text, image, ct); }
            catch { items = null; }

            // Unavailable / unparseable / nothing usable -> the same friendly floor (200), not a 503.
            if (items is null) return Results.Ok(new ParseMealResultDto());
            return Results.Ok(new ParseMealResultDto { AiUsed = true, Items = items });
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
        }).RequirePermission(Permissions.AiVision).RequireRateLimiting(PhotoRateLimitPolicy);

        // ---- MULTIMODAL: read a nutrition label from a photo (tighter rate cap) ----
        g.MapPost("/read-label", async (
            ImageRequest body, GeminiService gemini, CancellationToken ct) =>
        {
            // Validate the image FIRST so a bad/oversized upload is a clear 400 regardless of config.
            if (!TryValidateImage(body, out var base64, out var mime, out var bad)) return bad;
            if (!gemini.IsConfigured) return Unconfigured();
            var result = await gemini.ReadLabelAsync(base64, mime, ct);
            return result is null ? Unavailable() : Results.Ok(result);
        }).RequirePermission(Permissions.AiVision).RequireRateLimiting(PhotoRateLimitPolicy);

        // ---- MULTIMODAL: list the on-hand FOOD ingredients visible in a pantry/fridge photo (tighter rate cap) ----
        // Feeds the meal planner's "what's in your pantry?" chips: the model returns PLAIN generic ingredient names
        // (no quantities/brands/packaging), which the user reviews/edits then threads into /plan-meals as a strong
        // preference. Same ai.vision gate + same image validation (jpeg/png/webp, <=5 MB) + same in-memory-only,
        // never-stored handling as /photo-meal / /read-label; AI-usage is logged at the GeminiService chokepoint.
        // UNLIKE those two it NEVER 503s (per the planner contract): AI off / unconfigured / unreadable floors to
        // 200 { ingredients: [], aiUsed: false }. The ONLY non-200 is a bad/oversized image (400), like /parse-meal.
        g.MapPost("/scan-pantry", async (
            ImageRequest body, GeminiService gemini, CancellationToken ct) =>
        {
            // Validate the image FIRST so a bad/oversized upload is a clear 400 regardless of config.
            if (!TryValidateImage(body, out var base64, out var mime, out var bad)) return bad;

            // Friendly always-200 floor when AI is off/unconfigured (NEVER a 503 from the pantry scan).
            if (!gemini.IsConfigured) return Results.Ok(new ScanPantryResponse());

            IReadOnlyList<string>? list;
            try { list = await gemini.ScanPantryAsync(base64, mime, ct); }
            catch { list = null; }

            // Unavailable / unreadable -> the same friendly floor (200), not a 503. An EMPTY-but-non-null list
            // still counts as a successful AI read (aiUsed:true, ingredients:[]).
            if (list is null) return Results.Ok(new ScanPantryResponse());
            return Results.Ok(new ScanPantryResponse { AiUsed = true, Ingredients = list });
        }).RequirePermission(Permissions.AiVision).RequireRateLimiting(PhotoRateLimitPolicy);

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

        // ---- "What should I eat?": macro-aware options from the caller's OWN context (read server-side) ----
        // Reads the caller's remaining macros + goal, today's foods, recent foods, the household's on-hand
        // groceries, and planned meals — NO identity from the body. Unlike the rest of /api/ai, this NEVER 503s:
        // when Gemini is off/unavailable it returns 200 with a friendly NON-AI fallback (aiUsed:false) built from
        // planned meals + groceries, so the dialog degrades gracefully (per the frontend contract).
        g.MapPost("/what-to-eat", async (
            WhatToEatRequest body, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            GeminiService gemini, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var ctx = await BuildEatContextAsync(db, households, caller, body, ct);

            if (gemini.IsConfigured)
            {
                var result = await gemini.WhatToEatAsync(
                    ctx.Snapshot, body?.Craving, body?.Constraints,
                    ctx.RemCal, ctx.RemP, ctx.RemC, ctx.RemF, ct);
                if (result is { Options.Count: > 0 })
                    return Results.Ok(new WhatToEatDto { AiUsed = true, Options = ToEatOptionDtos(result.Options, ctx.GroceryByName) });
            }

            // Gemini off, unavailable, or returned nothing usable -> friendly deterministic fallback (200).
            return Results.Ok(new WhatToEatDto { AiUsed = false, Options = FallbackOptions(ctx) });
        });

        // ---- "Plan my day / week": a macro-aware multi-day plan from the caller's OWN context (read server-side) --
        // The robust extension of /what-to-eat: instead of one slot's options it builds a per-DAY plan across N
        // days, filling the requested slots, each meal fitting the caller's daily remaining macro budget. CONTEXT
        // comes from the SAME server-side build (remaining macros + recent foods + the caller's saved recipes +
        // on-hand groceries + planned meals) — NO identity from the body. Like /what-to-eat it NEVER 503s: when
        // Gemini is off/unavailable it floors to 200 with a deterministic NON-AI plan (aiUsed:false) built from the
        // caller's recipes/recent foods/groceries. Writes NOTHING — the user reviews then commits via the
        // add-to-plan endpoint below. Each ingredient is DETERMINISTICALLY labelled against the grocery list.
        g.MapPost("/plan-meals", async (
            PlanMealsRequest body, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            GeminiService gemini, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            // Reuse the what-to-eat context build (remaining macros + recent foods + recipes + groceries + meals).
            var ctx = await BuildEatContextAsync(db, households, caller,
                new WhatToEatRequest { Constraints = body?.Constraints }, ct);

            // Resolve the planned dates (anchor + N days) and the slots to fill — both clamped, caller-supplied only.
            var anchor = ParseLocalDate(body?.WeekStart) ?? await TodayAsync(db, ct);
            var dayCount = Math.Clamp(body?.Days ?? 1, 1, MaxPlanDays);
            var dates = Enumerable.Range(0, dayCount).Select(i => anchor.AddDays(i)).ToList();
            var slots = NormalizePlanSlots(body?.Slots);
            // Optional on-hand pantry list (e.g. from /scan-pantry, then edited): trimmed/lowered/deduped + clamped,
            // then threaded as a STRONG preference into the planner prompt. Treated strictly as DATA; null when empty.
            var onHand = NormalizeOnHand(body?.IngredientsOnHand);

            if (gemini.IsConfigured)
            {
                var result = await gemini.PlanMealsAsync(
                    ctx.Snapshot, body?.Constraints, dates, slots,
                    ctx.RemCal, ctx.RemP, ctx.RemC, ctx.RemF, onHand, ct);
                if (result is { Days.Count: > 0 })
                    return Results.Ok(new PlanMealsDto
                    {
                        AiUsed = true,
                        Days = result.Days.Select(d => new PlanMealDayDto
                        {
                            LocalDate = d.LocalDate.ToString("yyyy-MM-dd"),
                            Slots = d.Slots.Select(s => new PlanMealSlotDto
                            {
                                Slot = s.Slot,
                                Title = s.Title,
                                Why = s.Why,
                                Macros = s.Macros,
                                Ingredients = s.Ingredients
                                    .Select(i => LabelIngredient(i.Name, i.Quantity, ctx.GroceryByName)).ToList(),
                            }).ToList(),
                        }).ToList(),
                    });
            }

            // Gemini off/unavailable/empty -> deterministic NON-AI plan (200), one option per requested day.
            return Results.Ok(new PlanMealsDto { AiUsed = false, Days = FallbackPlan(ctx, dates, slots) });
        });

        // ---- "Add to plan": COMMIT the reviewed AI plan into the household meal planner (FamilyMeals) ----
        // The single WRITE in the planner flow: the frontend posts the meals the user accepted (date+slot+title,
        // optional ingredients/macros) and we create them through the SAME shared meal-create path as POST
        // /api/family/meals (single-sourced clamps/normalisation — no duplicate meal model). Household-scoped via
        // GetOrCreate (solo users auto-get a household, mirroring the grocery tool); the count is clamped. Gated by
        // the group's tracker.ai PLUS meals.use (the planner tool gate, checked here since the route group is /ai).
        g.MapPost("/plan-meals/to-plan", async (
            PlanMealsToPlanRequest body, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            if (!caller.Permissions.Contains(Permissions.MealsUse))
                return Results.Json(
                    new { message = $"You don't have permission: {Permissions.MealsUse}" },
                    statusCode: StatusCodes.Status403Forbidden);

            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;

            var toCreate = (body?.Meals ?? Array.Empty<PlanMealToWriteDto>())
                .Select(m => new FamilyMealsChoresEndpoints.MealToCreate(
                    m.LocalDate, m.Slot, m.Title, m.Ingredients,
                    m.Servings, m.Calories, m.ProteinG, m.CarbG, m.FatG, m.MacroSource))
                .ToList();

            var added = await FamilyMealsChoresEndpoints.CreateMealsAsync(
                db, household.Id, caller.Id, toCreate, ct);
            return Results.Ok(new PlanMealsToPlanResultDto { Added = added });
        });

        // ---- Estimate the kind + macros for a free-text supplement ("whey, 1 scoop") ----
        // Most supplements/vitamins/meds estimate to all-zeros; protein powders carry real macros. The
        // frontend falls back to manual entry on the 503 (Gemini off / quota / parse failure).
        g.MapPost("/supplement-macros", async (
            SupplementMacrosRequest body, GeminiService gemini, CancellationToken ct) =>
        {
            if (!gemini.IsConfigured) return Unconfigured();
            var result = await gemini.SupplementMacrosAsync(body?.Name, body?.Dose, ct);
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

            // The caller's OWN body weight (read server-side) sharpens exercise calorie estimates.
            var caller = (await me.GetUserAsync(ct))!;

            // PERMISSION SPLIT: a text-only build runs on tracker.ai alone (the group gate). The moment any
            // image is attached the call becomes multimodal (vision), which is a SEPARATE, OFF-by-default
            // capability — so the image-bearing path ADDITIONALLY requires ai.vision (403 without it). This is
            // checked here (not on the route) because the route gate can't see whether images were sent.
            if (validImages.Count > 0 && !caller.Permissions.Contains(Permissions.AiVision))
                return Results.Json(
                    new { message = $"You don't have permission: {Permissions.AiVision}" },
                    statusCode: StatusCodes.Status403Forbidden);

            if (!gemini.IsConfigured) return Unconfigured();

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

        // ---- VOICE CAPTURE: PARSE-ONLY a spoken note into confirmable, loggable intents (ALWAYS 200) ----
        // The transcript (on-device STT, preferred) OR an inline audio clip is sent to Gemini, processed
        // strictly IN-MEMORY, and parsed into 0..N intents — each mapped onto an EXISTING owner-scoped write
        // endpoint's DTO. This endpoint WRITES NOTHING: the frontend posts each confirmed intent to that
        // existing endpoint (so voice rides the existing tracker.self / family.use gates + clamps and can
        // never bypass a gate or write cross-user). The transcript/audio is NEVER persisted or logged (only
        // the AI-usage token-count row is recorded). Like /ask + /what-to-eat it NEVER 503s: AI off /
        // unconfigured / error floors to 200 { aiUsed:false, intents:[], message:"...type instead." }.
        // The transcript/audio is the CALLER's own and is treated strictly as DATA (injection-guarded).
        g.MapPost("/voice-parse", async (
            VoiceParseRequest body, CurrentUserAccessor me, GeminiService gemini, UsageDbContext db,
            CancellationToken ct) =>
        {
            // The text path runs on tracker.ai (the group gate). An inline AUDIO clip makes the call
            // multimodal, which is the SEPARATE, OFF-by-default ai.vision capability — so validate + gate it
            // here (the route gate can't see the body). A bad/oversized/missing-mime clip is a clear 400.
            (string base64, string mime)? audio = null;
            var hasAudioField = !string.IsNullOrWhiteSpace(body?.AudioBase64);
            if (hasAudioField)
            {
                if (!TryValidateAudio(body, out var b64, out var amime, out var bad)) return bad;

                var caller0 = (await me.GetUserAsync(ct))!;
                if (!caller0.Permissions.Contains(Permissions.AiVision))
                    return Results.Json(
                        new { message = $"You don't have permission: {Permissions.AiVision}" },
                        statusCode: StatusCodes.Status403Forbidden);

                audio = (b64, amime);
            }

            // Need a transcript or an audio clip to parse.
            var hasTranscript = !string.IsNullOrWhiteSpace(body?.Transcript);
            if (!hasTranscript && audio is null)
                return Results.BadRequest(new { message = "Speak or type something to log." });

            // Friendly always-200 floor when AI is off/unconfigured (NEVER a 503/500 from the mic).
            if (!gemini.IsConfigured) return Results.Ok(VoiceFloor());

            var caller = (await me.GetUserAsync(ct))!;
            var localToday = await ResolveDateAsync(db, body?.Date, ct);
            var weight = await db.TrackerProfiles.AsNoTracking()
                .Where(p => p.UserEmail == caller.Email)
                .Select(p => p.WeightKg)
                .FirstOrDefaultAsync(ct);

            GeminiService.VoiceParseResult? result;
            try
            {
                result = await gemini.VoiceParseAsync(
                    body?.Transcript, audio, localToday.ToString("yyyy-MM-dd"), weight, ct);
            }
            catch
            {
                result = null;
            }

            // AI unavailable/errored -> same friendly floor (200), not a 503.
            if (result is null) return Results.Ok(VoiceFloor());

            return Results.Ok(new VoiceParseResponse
            {
                Transcript = result.Transcript,
                AiUsed = true,
                Intents = result.Intents.Select(i => new VoiceIntentDto
                {
                    Domain = i.Domain,
                    Summary = i.Summary,
                    Endpoint = VoiceEndpointFor(i.Domain),
                    Payload = i.Payload,
                }).Where(i => i.Endpoint.Length > 0).ToList(),
            });
        });

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

        // ---- "ASK MY LIFE": a grounded, cross-domain Q&A over the CALLER's OWN data (ALWAYS 200) ----
        // Reads ONLY the caller's own numbers, and ONLY from the domains the caller has permission for, into a
        // compact DATA snapshot assembled server-side; Gemini answers strictly from it (or says it lacks the
        // data). Answer-only — proposes/writes NOTHING. Like /what-to-eat it NEVER 503s: when AI is off /
        // unconfigured / errors it floors to a deterministic plain summary of the same snapshot (aiUsed:false),
        // so a tracker.ai user always gets an answer. Identity comes from the JWT — NEVER the body (only the
        // question is read from the body, and it is treated strictly as DATA). NO email / secret / other-user /
        // other-household-private data ever enters the snapshot (each domain is perm-gated below).
        g.MapPost("/ask", async (
            AskRequest body, CurrentUserAccessor me, GeminiService gemini, UsageDbContext db,
            CurrentHouseholdAccessor households, FamilyTodayService familyToday, UsageQueries usage,
            CancellationToken ct) =>
        {
            var question = Snip(body?.Question, 1000);
            if (question.Length == 0)
                return Results.BadRequest(new { message = "Ask a question about your tracked data." });

            var caller = (await me.GetUserAsync(ct))!;
            var (snapshot, domains) = await BuildAskSnapshotAsync(
                db, households, familyToday, usage, caller, ct);

            // Prefer the grounded AI answer; fall back to a deterministic plain summary so this never 503s.
            AskMyLifeResult? ai = null;
            if (gemini.IsConfigured)
            {
                try { ai = await gemini.AskMyLifeAsync(snapshot, question, ct); }
                catch { ai = null; }
            }

            if (ai is null || string.IsNullOrWhiteSpace(ai.Answer))
                return Results.Ok(new AskResponse(PlainAskFloor(domains), false, domains));

            return Results.Ok(new AskResponse(ai.Answer, true, domains));
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

            // Plain recap is the floor. Prefer the warm AI narrative ONLY when the caller holds the AI perm
            // (tracker.ai is the gated, token-spending capability) AND Gemini is configured. A tracker.self
            // caller without tracker.ai always gets the deterministic floor (never spends tokens).
            if (!caller.Permissions.Contains(Permissions.TrackerAi) || !gemini.IsConfigured)
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
    // "Ask my life" — cross-domain, caller-scoped, perm-filtered snapshot aggregator
    // ===================================================================================

    /// <summary>The request body for POST /api/ai/ask: ONLY a free-text question (treated as DATA). Identity is
    /// NEVER taken from the body — it comes from the JWT via the CurrentUserAccessor.</summary>
    public sealed record AskRequest(string? Question);

    /// <summary>The POST /api/ai/ask response: the grounded <see cref="Answer"/>, whether the AI produced it
    /// (<see cref="AiUsed"/> false ⇒ the deterministic plain floor was returned), and which DOMAINS the snapshot
    /// included (so the UI can hint what's covered). Carries NO email / secret / other-user data.</summary>
    public sealed record AskResponse(string Answer, bool AiUsed, IReadOnlyList<string> Domains);

    /// <summary>
    /// Assemble the CALLER's cross-domain DATA snapshot for "Ask my life" from ONLY the domains the caller has
    /// permission for. Every read is keyed by the resolved <paramref name="caller"/> (email for the tracker/
    /// sleep/75-Hard reads; household membership for family-today) — NOTHING comes from the request body. The
    /// snapshot is labeled DATA blocks (the model narrates, never recomputes) and NEVER contains an email, a
    /// secret (webhook/token/key), another user's data, or another household member's private data:
    /// <list type="bullet">
    ///   <item>tracker today + 7-day recap + sleep — always (the caller's own; gated by tracker.self, which the
    ///   tracker.ai group caller effectively holds; still checked);</item>
    ///   <item>75-Hard — only when the caller has an ACTIVE challenge (else absent);</item>
    ///   <item>bills — only with <see cref="Permissions.BillsUse"/>; reports the caller's OWN bills only
    ///   (counts + the caller-owned totals/unclaimed), never another person's bucket/name;</item>
    ///   <item>family-today — only with <see cref="Permissions.FamilyUse"/>; counts + titles by display name,
    ///   never an email or another member's private data;</item>
    ///   <item>token usage — only with <see cref="Permissions.DashboardView"/>; month-to-date cost + tokens.</item>
    /// </list>
    /// Returns the snapshot text plus the list of included domain labels (for the response / the plain floor).
    /// </summary>
    private static async Task<(string snapshot, IReadOnlyList<string> domains)> BuildAskSnapshotAsync(
        UsageDbContext db, CurrentHouseholdAccessor households, FamilyTodayService familyToday,
        UsageQueries usage, CurrentUserAccessor.CurrentUser caller, CancellationToken ct)
    {
        var today = await TodayAsync(db, ct);
        var sb = new System.Text.StringBuilder();
        var domains = new List<string>();

        // ---- Tracker (the caller's own; gated by tracker.self) ----
        if (caller.Permissions.Contains(Permissions.TrackerSelf))
        {
            var (todaySummary, _) = await BuildLoggedDaySummaryAsync(db, caller.Email, today, ct);
            sb.Append("TRACKER_TODAY (").Append(today.ToString("yyyy-MM-dd")).Append("):\n");
            sb.Append(Indent(todaySummary));

            var facts = await ComputeWeekRecapFactsAsync(db, caller.Email, today, ct);
            sb.Append("TRACKER_WEEK:\n").Append(Indent(TrackerRecapFacts(facts)));
            domains.Add("tracker");

            // ---- Sleep (OWNER-ONLY; this is the caller's own data, so tracker.self is sufficient) ----
            var sleep = await BuildSleepSummaryAsync(db, caller.Email, today, ct);
            if (sleep is not null)
            {
                sb.Append("SLEEP:\n").Append(Indent(sleep));
                domains.Add("sleep");
            }

            // ---- 75-Hard (only when an active challenge exists) ----
            var hard = await HardChallengeEndpoints.ComputeWeeklyRecapStatsAsync(
                db, caller.Email, today.AddDays(-6), today, today, ct);
            if (hard is not null)
            {
                sb.Append("HARD_75:\n")
                  .Append("  current_streak: ").Append(hard.CurrentStreak).Append('\n')
                  .Append("  total_points: ").Append(hard.TotalPoints.ToString("0.#", CultureInfo.InvariantCulture)).Append('\n')
                  .Append("  week_points: ").Append(hard.WeekPoints.ToString("0.#", CultureInfo.InvariantCulture)).Append('\n')
                  .Append("  full_days_complete_this_week: ").Append(hard.WeekCompletedDays).Append('\n');
                domains.Add("hard75");
            }
        }

        // ---- Bills (caller-OWNED only; bills.use) ----
        if (caller.Permissions.Contains(Permissions.BillsUse))
        {
            var bills = await db.Bills.AsNoTracking()
                .Where(b => b.OwnerEmail == caller.Email)
                .Select(b => new
                {
                    b.Status, b.TaxAmount, b.TipAmount,
                    ItemsTotal = b.Items.Sum(i => (decimal?)i.Amount) ?? 0m,
                    Unclaimed = b.Items.Where(i => i.AssignedToUserId == null && i.ClaimedByUserId == null
                        && (i.ClaimedByName == null || i.ClaimedByName == "")).Sum(i => (decimal?)i.Amount) ?? 0m,
                })
                .ToListAsync(ct);
            var open = bills.Count(b => b.Status != "settled");
            var settled = bills.Count(b => b.Status == "settled");
            var grandTotal = bills.Sum(b => b.ItemsTotal + (b.TaxAmount ?? 0m) + (b.TipAmount ?? 0m));
            var unclaimed = bills.Sum(b => b.Unclaimed);
            sb.Append("BILLS (your own):\n")
              .Append("  open_bills: ").Append(open).Append('\n')
              .Append("  settled_bills: ").Append(settled).Append('\n')
              .Append("  your_bills_total_usd: ").Append(grandTotal.ToString("0.00", CultureInfo.InvariantCulture)).Append('\n')
              .Append("  unclaimed_usd: ").Append(unclaimed.ToString("0.00", CultureInfo.InvariantCulture)).Append('\n');
            domains.Add("bills");
        }

        // ---- Family today (family.use; counts + titles by display name, never email/private data) ----
        if (caller.Permissions.Contains(Permissions.FamilyUse))
        {
            var household = await households.GetForCallerAsync(caller, ct);
            if (household is not null)
            {
                var t = await familyToday.BuildAsync(household, caller, null, ct);
                sb.Append("FAMILY_TODAY:\n");
                sb.Append("  events: ").Append(t.Events.Count).Append('\n');
                foreach (var e in t.Events.Take(10))
                    sb.Append("  - ").Append(string.IsNullOrEmpty(e.LocalTime) ? "" : e.LocalTime + " ")
                      .Append(Snip(e.Title, 80)).Append('\n');
                sb.Append("  reminders_today: ").Append(t.Reminders.Count).Append('\n');
                sb.Append("  active_timers: ").Append(t.Timers.Count).Append('\n');
                if (t.Lists.Count > 0)
                {
                    sb.Append("  open_lists:\n");
                    foreach (var l in t.Lists.Take(12))
                        sb.Append("  - ").Append(Snip(l.Name, 60)).Append(" (").Append(l.OpenCount).Append(" open)\n");
                }
                sb.Append("  pinned_notes: ").Append(t.PinnedNotes.Count).Append('\n');
                domains.Add("family");
            }
        }

        // ---- Token usage (dashboard.view; month-to-date cost + tokens — org-level usage the caller may view) ----
        if (caller.Permissions.Contains(Permissions.DashboardView))
        {
            var monthStart = new DateOnly(today.Year, today.Month, 1);
            var filter = new UsageFilterQuery(monthStart, today, null, null, null, null);
            var summary = await usage.SummaryAsync(filter, "month", ct);
            sb.Append("USAGE_THIS_MONTH:\n")
              .Append("  total_cost_usd: ").Append(summary.Total.CostUsd.ToString("0.00", CultureInfo.InvariantCulture)).Append('\n')
              .Append("  total_tokens: ").Append(summary.Total.TotalTokens).Append('\n');
            domains.Add("usage");
        }

        return (sb.ToString(), domains);
    }

    /// <summary>Indent a multi-line DATA block two spaces so nested sections read clearly in the snapshot.</summary>
    private static string Indent(string block)
    {
        var sb = new System.Text.StringBuilder();
        foreach (var line in block.Split('\n'))
        {
            if (line.Length == 0) continue;
            sb.Append("  ").Append(line).Append('\n');
        }
        return sb.ToString();
    }

    /// <summary>
    /// The caller's OWN sleep summary for "Ask my life": last-night hours/quality + the rolling 7-day averages,
    /// mirroring the owner-only read in TrackerEndpoints (caller-only; NEVER another user's). Returns null when
    /// the caller has logged no sleep in the window (the section is then simply absent from the snapshot).
    /// </summary>
    private static async Task<string?> BuildSleepSummaryAsync(
        UsageDbContext db, string email, DateOnly date, CancellationToken ct)
    {
        var windowFrom = date.AddDays(-6);
        var window = await db.SleepEntries.AsNoTracking()
            .Where(s => s.UserEmail == email && s.LocalDate >= windowFrom && s.LocalDate <= date)
            .Select(s => new { s.LocalDate, s.Hours, s.Quality })
            .ToListAsync(ct);
        if (window.Count == 0) return null;

        var sb = new System.Text.StringBuilder();
        var lastNight = window.Where(s => s.LocalDate == date).ToList();
        if (lastNight.Count > 0)
        {
            sb.Append("last_night_hours: ")
              .Append(Math.Round(lastNight.Average(s => (double)s.Hours), 1)).Append('\n');
            sb.Append("last_night_quality: ")
              .Append(Math.Round(lastNight.Average(s => (double)s.Quality), 1)).Append('\n');
        }
        sb.Append("avg_hours_7d: ").Append(Math.Round(window.Average(s => (double)s.Hours), 1)).Append('\n');
        sb.Append("avg_quality_7d: ").Append(Math.Round(window.Average(s => (double)s.Quality), 1)).Append('\n');
        return sb.ToString();
    }

    /// <summary>The GUARANTEED deterministic floor for "Ask my life" when AI is off/unconfigured/errors: it does
    /// NOT answer the free-text question (no AI to ground it) but honestly states which of the caller's domains
    /// have data ready, so the endpoint NEVER 503s. NEVER leaks anything (it only names the included domains).</summary>
    private static string PlainAskFloor(IReadOnlyList<string> domains)
    {
        if (domains.Count == 0)
            return "AI is off and I don't see any tracked data to summarize yet. Log some food, sleep, or other "
                 + "activity and I'll be able to answer questions about it.";
        var labels = domains.Select(d => d switch
        {
            "tracker" => "your food & fitness tracker",
            "sleep" => "your sleep",
            "hard75" => "your 75-Hard challenge",
            "bills" => "your bills",
            "family" => "your family hub",
            "usage" => "your token usage",
            _ => d,
        }).ToList();
        return "AI answering is off right now, but I have your latest data ready for "
             + string.Join(", ", labels)
             + ". Turn on tracker AI to ask questions in plain language.";
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

    /// <summary>
    /// The caller-scoped context for "What should I eat?": the REMAINING macro budget plus a compact, model-
    /// friendly snapshot of the caller's OWN day (goal + what's logged), recent eaten foods, the household's
    /// on-hand groceries, and the next week's planned meals — plus the optional typed craving/constraint.
    ///
    /// SCOPING INVARIANT: the ONLY identity used is the resolved <paramref name="caller"/> — email-keyed for the
    /// tracker reads (foods/profile), household-membership-keyed for the family reads (groceries/meals). NOTHING
    /// is taken from the request body except the free-text craving/constraints. Emails NEVER enter the snapshot
    /// (names are not even read here). The household is read-only (GetForCaller, never auto-create on this read).
    /// </summary>
    private static async Task<EatContext> BuildEatContextAsync(
        UsageDbContext db, CurrentHouseholdAccessor households,
        CurrentUserAccessor.CurrentUser caller, WhatToEatRequest? body, CancellationToken ct)
    {
        var today = await TodayAsync(db, ct);
        var (remCal, remP, remC, remF) = await RemainingTodayAsync(db, caller.Email, ct);

        var sb = new System.Text.StringBuilder();
        sb.Append(await BuildDaySummaryAsync(db, caller.Email, today, ct));

        // Recent eaten foods (names only) — caller's own history, deduped by description+brand.
        var recentRows = await db.FoodEntries.AsNoTracking()
            .Where(f => f.UserEmail == caller.Email)
            .OrderByDescending(f => f.CreatedUtc)
            .Select(f => new { f.Description, f.Brand })
            .Take(120)
            .ToListAsync(ct);
        var recent = new List<string>();
        var seenRecent = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var r in recentRows)
        {
            var name = Snip(r.Description, 60);
            if (name.Length == 0) continue;
            var key = name + "|" + (r.Brand ?? "");
            if (!seenRecent.Add(key)) continue;
            recent.Add(name);
            if (recent.Count >= 30) break;
        }
        if (recent.Count > 0)
        {
            sb.Append("recent_foods:\n");
            foreach (var n in recent) sb.Append("- ").Append(n).Append('\n');
        }

        // The caller's OWN saved recipes (owner-scoped by email; titles only, deduped) — a strong source the
        // planner can reuse. NEVER another user's recipes; no email enters the snapshot.
        var recipeTitles = await db.Recipes.AsNoTracking()
            .Where(r => r.OwnerEmail == caller.Email)
            .OrderByDescending(r => r.UpdatedUtc)
            .Select(r => r.Title)
            .Take(40)
            .ToListAsync(ct);
        var recipes = recipeTitles
            .Select(t => Snip(t, 80)).Where(t => t.Length > 0)
            .Distinct(StringComparer.OrdinalIgnoreCase).Take(30).ToList();
        if (recipes.Count > 0)
        {
            sb.Append("my_recipes:\n");
            foreach (var n in recipes) sb.Append("- ").Append(n).Append('\n');
        }

        // Household-scoped reads (groceries on the list + planned meals). Read-only: absent household => empty.
        // The grocery list is the SOURCE OF TRUTH the endpoint cross-references each AI ingredient against
        // (deterministically, below) — it is NOT fed to the model as "pantry"/"on-hand" to infer from anymore.
        var onHand = new List<string>();
        var groceryByName = new Dictionary<string, int>(StringComparer.Ordinal);
        var household = await households.GetForCallerAsync(caller, ct);
        if (household is not null)
        {
            var groceryItems = await db.FamilyLists.AsNoTracking()
                .Where(l => l.HouseholdId == household.Id && l.Kind == "shopping"
                    && l.Name.ToLower() == "groceries")
                .SelectMany(l => l.Items.Where(i => !i.Done).Select(i => i.Text))
                .Take(200)
                .ToListAsync(ct);
            foreach (var t in groceryItems)
            {
                var s = Snip(t, 80);
                if (s.Length == 0) continue;
                onHand.Add(s);
                // Normalized base-name -> listed quantity ("Milk x3" -> 3), summing duplicates. Reuses the grocery
                // tool's "xN" parse + the SAME case/space-insensitive de-dupe normalization.
                var (baseName, qty) = GroceryEndpoints.SplitQuantity(s);
                var key = FamilyMealsChoresEndpoints.Normalize(baseName);
                if (key.Length == 0) continue;
                groceryByName[key] = groceryByName.GetValueOrDefault(key) + (qty ?? 1);
            }
            if (onHand.Count > 0)
            {
                sb.Append("grocery_list:\n");
                foreach (var s in onHand) sb.Append("- ").Append(s).Append('\n');
            }

            var meals = await db.FamilyMeals.AsNoTracking()
                .Where(m => m.HouseholdId == household.Id && m.LocalDate >= today && m.LocalDate < today.AddDays(7))
                .OrderBy(m => m.LocalDate).ThenBy(m => m.Id)
                .Select(m => new { m.LocalDate, m.Slot, m.Title })
                .Take(40)
                .ToListAsync(ct);
            if (meals.Count > 0)
            {
                sb.Append("planned_meals:\n");
                foreach (var m in meals)
                    sb.Append("- ").Append(m.LocalDate.ToString("yyyy-MM-dd")).Append(' ').Append(m.Slot)
                      .Append(": ").Append(Snip(m.Title, 80)).Append('\n');
            }
        }

        var craving = Snip(body?.Craving, 400);
        var constraints = Snip(body?.Constraints, 400);

        return new EatContext(sb.ToString(), remCal, remP, remC, remF, onHand, groceryByName,
            await PlannedMealTitlesAsync(db, household, today, ct), recent, recipes, craving, constraints);
    }

    /// <summary>The next week's planned meal titles for the caller's household (deterministic-fallback source).</summary>
    private static async Task<IReadOnlyList<string>> PlannedMealTitlesAsync(
        UsageDbContext db, Household? household, DateOnly today, CancellationToken ct)
    {
        if (household is null) return Array.Empty<string>();
        var titles = await db.FamilyMeals.AsNoTracking()
            .Where(m => m.HouseholdId == household.Id && m.LocalDate >= today && m.LocalDate < today.AddDays(7))
            .OrderBy(m => m.LocalDate).ThenBy(m => m.Id)
            .Select(m => m.Title)
            .Take(40)
            .ToListAsync(ct);
        return titles.Select(t => Snip(t, 80)).Where(t => t.Length > 0).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
    }

    /// <summary>
    /// The friendly NON-AI fallback used when Gemini is off/unavailable: a small deterministic option list built
    /// from the caller's next planned meals (and, failing that, on-hand groceries). Macros are zero (we have no
    /// AI estimate); each option carries a plain "from your plan" rationale so the dialog labels it honestly.
    /// </summary>
    private static IReadOnlyList<EatOptionDto> FallbackOptions(EatContext ctx)
    {
        var options = new List<EatOptionDto>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        void Add(string title, string why, IReadOnlyList<string>? ingredientNames = null)
        {
            if (options.Count >= MaxFallbackOptions) return;
            var t = title?.Trim();
            if (string.IsNullOrEmpty(t) || !seen.Add(t)) return; // skip blanks + de-dupe across all sources
            // The deterministic floor has no recipe; any seed names ARE the grocery items, so label them onList.
            var ingredients = (ingredientNames ?? Array.Empty<string>())
                .Select(n => LabelIngredient(n, "", ctx.GroceryByName)).ToList();
            options.Add(new EatOptionDto
            {
                Title = t,
                Why = why,
                Macros = new MacroSet(), // deterministic floor — no AI, so no estimated macros
                Ingredients = ingredients,
                Steps = Array.Empty<string>(),
            });
        }

        // 1) The caller's planned meals (most intentful).
        foreach (var title in ctx.PlannedMeals)
            Add(title, "From your planned meals.");

        // 2) Recently eaten foods the caller already likes (caller-scoped history; names only).
        foreach (var title in ctx.RecentFoods)
            Add(title, "Something you've had recently.");

        // 3) Failing all else, a single "use what's on hand" idea seeded with the grocery-list items.
        if (options.Count == 0 && ctx.OnHand.Count > 0)
            Add("Make something with what you have", "Built from items on your grocery list.",
                ctx.OnHand.Take(MaxFallbackHave).ToList());

        return options;
    }

    /// <summary>The default + allowed meal slots for the day/week planner (mirrors the FamilyMeal slot vocab).</summary>
    private static readonly string[] PlanSlotVocab = { "breakfast", "lunch", "dinner", "snack" };
    private static readonly string[] DefaultPlanSlots = { "breakfast", "lunch", "dinner" };

    /// <summary>Normalise the caller-supplied slots to the known vocabulary (dedup, order-preserving); an empty/
    /// all-invalid set falls back to breakfast/lunch/dinner. NEVER trusts unknown slot strings into the prompt.</summary>
    private static IReadOnlyList<string> NormalizePlanSlots(IReadOnlyList<string>? slots)
    {
        if (slots is null || slots.Count == 0) return DefaultPlanSlots;
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var outp = new List<string>();
        foreach (var raw in slots)
        {
            var s = (raw ?? "").Trim().ToLowerInvariant();
            if (PlanSlotVocab.Contains(s) && seen.Add(s)) outp.Add(s);
        }
        return outp.Count > 0 ? outp : DefaultPlanSlots;
    }

    /// <summary>Max on-hand pantry ingredients the planner accepts (mirrors GeminiService.MaxPantryItems).</summary>
    private const int MaxOnHandItems = 40;
    /// <summary>Max length of one on-hand ingredient name (mirrors GeminiService.MaxPantryItemLen).</summary>
    private const int MaxOnHandItemLen = 40;

    /// <summary>
    /// Normalize the optional on-hand pantry list threaded into /plan-meals: trim, lowercase, drop empties, dedupe
    /// (case-insensitive), clamp each entry to <see cref="MaxOnHandItemLen"/> chars and the list to
    /// <see cref="MaxOnHandItems"/> items — the SAME cleaning <see cref="GeminiService.ScanPantryAsync"/> applies to
    /// its own output, so a scan→edit→plan round-trip stays consistent. Null/empty → null (unchanged planner behaviour).
    /// </summary>
    private static IReadOnlyList<string>? NormalizeOnHand(IReadOnlyList<string>? items)
    {
        if (items is null || items.Count == 0) return null;
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var outp = new List<string>();
        foreach (var raw in items)
        {
            if (outp.Count >= MaxOnHandItems) break;
            // Collapse any internal whitespace (incl. newlines/tabs) to a single space so a chip can't smuggle
            // a line break into the ON_HAND prompt block (defense-in-depth — the block is already framed as DATA).
            var s = System.Text.RegularExpressions.Regex.Replace((raw ?? "").Trim(), @"\s+", " ").ToLowerInvariant();
            if (s.Length == 0) continue;
            if (s.Length > MaxOnHandItemLen) s = s[..MaxOnHandItemLen].Trim();
            if (s.Length == 0 || !seen.Add(s)) continue;
            outp.Add(s);
        }
        return outp.Count > 0 ? outp : null;
    }

    /// <summary>Parse a plain "YYYY-MM-DD" anchor date for the planner (null/blank/invalid → null, the caller's
    /// local "today" is then used). Same loose parse as the family endpoints' ParseDate.</summary>
    private static DateOnly? ParseLocalDate(string? s) =>
        DateOnly.TryParse(s, System.Globalization.CultureInfo.InvariantCulture,
            System.Globalization.DateTimeStyles.None, out var d) ? d : null;

    /// <summary>
    /// The friendly NON-AI day/week plan used when Gemini is off/unavailable: for each requested date, seed each
    /// requested slot with one deterministic idea drawn (in order) from the caller's saved recipes, then their
    /// recent foods, then planned meals — cycling so days vary. Macros are zero (no AI estimate). Ingredients are
    /// empty (the deterministic floor has no recipe breakdown), so nothing is mislabelled. Mirrors FallbackOptions.
    /// </summary>
    private static IReadOnlyList<PlanMealDayDto> FallbackPlan(
        EatContext ctx, IReadOnlyList<DateOnly> dates, IReadOnlyList<string> slots)
    {
        // The pool of dish titles to seed from, most-intentful first; de-duped, blanks dropped.
        var pool = new List<string>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        void AddPool(IEnumerable<string> titles)
        {
            foreach (var t in titles)
            {
                var title = (t ?? "").Trim();
                if (title.Length > 0 && seen.Add(title)) pool.Add(title);
            }
        }
        AddPool(ctx.MyRecipes);
        AddPool(ctx.PlannedMeals);
        AddPool(ctx.RecentFoods);

        var days = new List<PlanMealDayDto>();
        var idx = 0;
        foreach (var date in dates)
        {
            var daySlots = new List<PlanMealSlotDto>();
            foreach (var slot in slots)
            {
                if (pool.Count == 0) break;
                var title = pool[idx % pool.Count];
                idx++;
                daySlots.Add(new PlanMealSlotDto
                {
                    Slot = slot,
                    Title = title,
                    Why = "From your recipes, recent meals, and plan.",
                    Macros = new MacroSet(),
                    Ingredients = Array.Empty<EatIngredientDto>(),
                });
            }
            if (daySlots.Count > 0)
                days.Add(new PlanMealDayDto { LocalDate = date.ToString("yyyy-MM-dd"), Slots = daySlots });
        }
        return days;
    }

    /// <summary>Map the parsed Gemini options to the wire DTO (macros already CLAMPED), DETERMINISTICALLY
    /// labelling each ingredient against the household grocery list: <c>onList</c> + the current <c>listedQty</c>
    /// (null when not on the list). The cross-reference is case/space-insensitive and "xN"-aware, reusing the
    /// grocery tool's normalization — the model never decides this.</summary>
    private static IReadOnlyList<EatOptionDto> ToEatOptionDtos(
        IReadOnlyList<EatOption> options, IReadOnlyDictionary<string, int> groceryByName) =>
        options.Select(o => new EatOptionDto
        {
            Title = o.Title,
            Why = o.Why,
            Macros = o.Macros,
            Ingredients = o.Ingredients.Select(i => LabelIngredient(i.Name, i.Quantity, groceryByName)).ToList(),
            Steps = o.Steps,
        }).ToList();

    /// <summary>Build one labelled ingredient DTO: cross-reference its NAME (the "xN" stripped, case/space-
    /// insensitive) against the household grocery list. On a match, <c>onList=true</c> + <c>listedQty</c> = the
    /// quantity currently on the list; otherwise <c>onList=false</c>, <c>listedQty=null</c>.</summary>
    private static EatIngredientDto LabelIngredient(
        string name, string quantity, IReadOnlyDictionary<string, int> groceryByName)
    {
        var key = FamilyMealsChoresEndpoints.Normalize(GroceryEndpoints.SplitQuantity(name).BaseName);
        var onList = key.Length > 0 && groceryByName.TryGetValue(key, out var listed);
        return new EatIngredientDto
        {
            Name = name,
            Quantity = quantity ?? "",
            OnList = onList,
            ListedQty = onList ? groceryByName[key] : (int?)null,
        };
    }

    private const int MaxFallbackOptions = 5;
    private const int MaxFallbackHave = 12;
    /// <summary>Max days the "plan my day / week" planner spans (mirrors the 7-day meal-plan window).</summary>
    private const int MaxPlanDays = 7;

    /// <summary>The caller-scoped "what should I eat?" context: the model snapshot + the remaining budget + the
    /// raw lists used to build the deterministic fallback. Carries NO identity.</summary>
    private sealed record EatContext(
        string Snapshot, int RemCal, double RemP, double RemC, double RemF,
        IReadOnlyList<string> OnHand, IReadOnlyDictionary<string, int> GroceryByName,
        IReadOnlyList<string> PlannedMeals, IReadOnlyList<string> RecentFoods,
        IReadOnlyList<string> MyRecipes, string Craving, string Constraints);

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
    /// <summary>Reusable image validation for other endpoints (e.g. the Bill Splitter receipt route): same
    /// mime/size/base64 checks as the photo routes, returning a 400 <paramref name="bad"/> on failure.</summary>
    internal static bool TryValidateImageInternal(
        ImageRequest? body, out string base64, out string mimeType, out IResult bad) =>
        TryValidateImage(body, out base64, out mimeType, out bad);

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
    // Voice-capture helpers
    // ===================================================================================

    /// <summary>The EXISTING owner-scoped write endpoint each voice domain maps to (no new write paths). An
    /// unknown domain returns "" and the intent is dropped.</summary>
    private static string VoiceEndpointFor(string domain) => domain switch
    {
        "food" => "/api/tracker/food",
        "exercise" => "/api/tracker/exercise",
        "hydration" => "/api/tracker/hydration",
        "coffee" => "/api/tracker/coffee",
        "weight" => "/api/tracker/weight",
        "supplement" => "/api/tracker/supplement",
        "sleep" => "/api/tracker/sleep",
        "family" => "/api/family/quick-add",
        _ => "",
    };

    /// <summary>The friendly always-200 floor: AI off / unconfigured / error -> no intents + a "type instead"
    /// hint, so the mic NEVER surfaces a 503/500 (mirrors /ask + /what-to-eat).</summary>
    private static VoiceParseResponse VoiceFloor() => new()
    {
        Transcript = "",
        AiUsed = false,
        Intents = new(),
        Message = "Voice is unavailable, type instead.",
    };

    /// <summary>Validate an inline-audio clip the same way images are validated: a known mime + a decodable
    /// payload under the size cap, returning a 400 <paramref name="bad"/> on failure.</summary>
    private static bool TryValidateAudio(
        VoiceParseRequest? body, out string base64, out string mimeType, out IResult bad)
    {
        base64 = "";
        mimeType = "";
        bad = Results.BadRequest(new { message = "A valid audio clip (webm/ogg/wav/mp3/m4a) under 10 MB is required." });

        var mime = (body?.MimeType ?? "").Trim();
        var data = (body?.AudioBase64 ?? "").Trim();
        if (mime.Length == 0 || data.Length == 0) return false;
        if (!GeminiService.AllowedAudioMimeTypes.Contains(mime)) return false;

        // Strip an optional data-URL prefix ("data:audio/webm;base64,...") before decoding.
        var comma = data.IndexOf(',');
        if (data.StartsWith("data:", StringComparison.OrdinalIgnoreCase) && comma >= 0)
            data = data[(comma + 1)..];

        // Cheap length bound before decode (base64 ≈ 4/3 expansion).
        if ((long)data.Length / 4 * 3 > GeminiService.MaxAudioBytes) return false;

        byte[] decoded;
        try { decoded = Convert.FromBase64String(data); }
        catch (FormatException) { return false; }
        if (decoded.Length == 0 || decoded.Length > GeminiService.MaxAudioBytes) return false;

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
