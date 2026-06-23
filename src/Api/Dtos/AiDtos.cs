namespace Ccusage.Api.Dtos;

/// <summary>
/// Request/response DTOs for the AI-assist endpoints (<c>/api/ai</c>), which proxy Google Gemini to
/// estimate nutrition macros, suggest a daily calorie/macro goal, and estimate calories burned for an
/// exercise. Every free-text field is treated strictly as DATA in the model prompt: the model only ever
/// returns JSON we parse and CLAMP, so a hostile string can never inject absurd values or be executed.
/// </summary>

// ===================================================================================
// estimate-macros
// ===================================================================================

/// <summary>
/// Estimate nutrition for a free-text food description. <see cref="Quantity"/> is an optional free-text
/// amount/serving (e.g. "2 eggs", "100 g", "1 cup"); when blank the model assumes a single serving.
/// </summary>
public sealed class EstimateMacrosRequest
{
    public string? Description { get; set; }
    public string? Quantity { get; set; }
}

/// <summary>
/// An AI macro estimate. All numbers are model output CLAMPED to sane ranges (calories 0..5000, macros
/// 0..500 g). When the model is unavailable (quota/parse failure) the endpoint returns 503; this DTO is
/// only emitted on success.
/// </summary>
public sealed class EstimateMacrosResponse
{
    public int Calories { get; set; }
    public double ProteinG { get; set; }
    public double CarbsG { get; set; }
    public double FatG { get; set; }

    /// <summary>Optional short model note (e.g. an assumption it made); null when none.</summary>
    public string? Note { get; set; }
}

// ===================================================================================
// suggest-goal
// ===================================================================================

/// <summary>
/// Request body for goal suggestion. Intentionally EMPTY: the endpoint reads the CALLER's own
/// <c>TrackerProfile</c> server-side (age/height/weight/sex/activity/goal direction) and never trusts
/// client-sent stats.
/// </summary>
public sealed class SuggestGoalRequest
{
}

/// <summary>
/// A suggested daily target. Numbers are model output CLAMPED to sane ranges (calories 0..5000, macros
/// 0..500 g).
/// </summary>
public sealed class SuggestGoalResponse
{
    public int CalorieTarget { get; set; }
    public double ProteinG { get; set; }
    public double CarbsG { get; set; }
    public double FatG { get; set; }

    /// <summary>One short sentence explaining the suggestion; null when the model gave none.</summary>
    public string? Rationale { get; set; }
}

// ===================================================================================
// estimate-exercise
// ===================================================================================

/// <summary>Estimate calories burned for a free-text exercise name over a duration in minutes.</summary>
public sealed class EstimateExerciseRequest
{
    public string? Name { get; set; }
    public int? DurationMin { get; set; }
}

/// <summary>
/// An AI exercise-calorie estimate. <see cref="CaloriesBurned"/> is model output CLAMPED to 0..5000.
/// </summary>
public sealed class EstimateExerciseResponse
{
    public int CaloriesBurned { get; set; }

    /// <summary>Optional short model note (e.g. "assumes a 70 kg adult"); null when none.</summary>
    public string? Note { get; set; }
}

// ===================================================================================
// parse-exercise — natural-language exercise log ("3x10 squats", "jogged 2mi")
// ===================================================================================

/// <summary>Free-text exercise description to parse into a structured, loggable exercise.</summary>
public sealed class ParseExerciseRequest
{
    public string? Text { get; set; }
}

/// <summary>
/// A parsed exercise. Numbers are model output CLAMPED to sane ranges (calories 0..5000, duration
/// 0..1440 min, sets/reps 0..1000). Calories are estimated from the CALLER's own body weight (read
/// server-side), defaulting to a typical adult when no weight is on file.
/// </summary>
public sealed class ParseExerciseResponse
{
    public string Name { get; set; } = "";
    public int Calories { get; set; }
    public int? DurationMin { get; set; }
    public int? Sets { get; set; }
    public int? Reps { get; set; }

    /// <summary>Free-text distance the model extracted (e.g. "2 mi"), or null when none.</summary>
    public string? DistanceText { get; set; }
    public string? Note { get; set; }
}

// ===================================================================================
// suggest-workout
// ===================================================================================

/// <summary>Ask for a workout plan for a focus area over a number of minutes with optional equipment.</summary>
public sealed class SuggestWorkoutRequest
{
    public string? Focus { get; set; }
    public int? Minutes { get; set; }
    public string? Equipment { get; set; }
}

/// <summary>A single suggested exercise in a workout plan.</summary>
public sealed class WorkoutItemDto
{
    public string Name { get; set; } = "";
    public string SetsReps { get; set; } = "";
    public string? Note { get; set; }
}

/// <summary>A suggested workout. <see cref="EstCalories"/> is model output CLAMPED to 0..5000.</summary>
public sealed class SuggestWorkoutResponse
{
    public string Title { get; set; } = "";
    public IReadOnlyList<WorkoutItemDto> Items { get; set; } = Array.Empty<WorkoutItemDto>();
    public int EstCalories { get; set; }
}

// ===================================================================================
// parse-meal / photo-meal — multi-item meal parsing
// ===================================================================================

/// <summary>Free-text meal description to parse into individual items ("Big Mac, fries, Coke").</summary>
public sealed class ParseMealRequest
{
    public string? Text { get; set; }
}

/// <summary>One parsed food item; numbers CLAMPED to sane ranges (calories 0..5000, macros 0..500 g).</summary>
public sealed class MealItemDto
{
    public string Description { get; set; } = "";
    public int Calories { get; set; }
    public double ProteinG { get; set; }
    public double CarbsG { get; set; }
    public double FatG { get; set; }
}

/// <summary>A parsed meal: zero or more items, each with clamped macros.</summary>
public sealed class ParseMealResponse
{
    public IReadOnlyList<MealItemDto> Items { get; set; } = Array.Empty<MealItemDto>();
}

/// <summary>
/// A base64-encoded image plus its mime type, for the multimodal photo features. <see cref="MimeType"/>
/// must be one of image/jpeg, image/png, image/webp; the decoded payload must be under ~5 MB (400 otherwise).
/// The bytes are sent to the model as DATA only; we only ever parse + clamp the JSON it returns.
/// </summary>
public sealed class ImageRequest
{
    public string? ImageBase64 { get; set; }
    public string? MimeType { get; set; }
}

// ===================================================================================
// read-label — multimodal nutrition-label read
// ===================================================================================

/// <summary>A single nutrition-label read; numbers CLAMPED (calories 0..5000, macros 0..500 g).</summary>
public sealed class ReadLabelResponse
{
    public string Description { get; set; } = "";
    public int Calories { get; set; }
    public double ProteinG { get; set; }
    public double CarbsG { get; set; }
    public double FatG { get; set; }

    /// <summary>The serving size the label states (e.g. "1 cup (240 ml)"), or null when not read.</summary>
    public string? ServingSize { get; set; }
}

// ===================================================================================
// suggest-foods — from the caller's remaining calories/macros today (read server-side)
// ===================================================================================

/// <summary>Empty: the endpoint reads the caller's OWN remaining calories + macros for today server-side.</summary>
public sealed class SuggestFoodsRequest
{
}

/// <summary>A suggested food to round out the day; numbers CLAMPED (calories 0..5000, protein 0..500 g).</summary>
public sealed class FoodSuggestionDto
{
    public string Food { get; set; } = "";
    public string? Why { get; set; }
    public int Calories { get; set; }
    public double ProteinG { get; set; }
}

/// <summary>Food suggestions to help the caller hit their remaining targets.</summary>
public sealed class SuggestFoodsResponse
{
    public IReadOnlyList<FoodSuggestionDto> Suggestions { get; set; } = Array.Empty<FoodSuggestionDto>();
}

// ===================================================================================
// what-to-eat — macro-aware "what should I eat?" options (read server-side)
// ===================================================================================

/// <summary>
/// "✨ What should I eat?" request. Everything is OPTIONAL — on open the frontend sends an empty body and the
/// server reads the caller's OWN context (today's logged foods + goal, recent foods, on-hand groceries, planned
/// meals). NO identity is sent: the caller is resolved from the JWT (email-keyed tracker + household meals).
/// <see cref="Craving"/>/<see cref="Constraints"/> are a free-text refine ("high protein", "quick", a craving),
/// both treated strictly as DATA; <see cref="Meal"/> is the slot hint ("breakfast"|"lunch"|"dinner"|"snack").
/// </summary>
public sealed class WhatToEatRequest
{
    public string? Craving { get; set; }
    public string? Constraints { get; set; }
    public string? Meal { get; set; }
}

/// <summary>
/// One option from "✨ What should I eat?" (mirrors the frontend EatOption). <see cref="Macros"/> is the
/// per-option total (kcal + grams, CLAMPED) so it's addable to the tracker in one call. <see cref="Why"/> is a
/// one-line "fits your remaining" rationale. <see cref="Have"/> are ingredients the caller already has on hand;
/// <see cref="Missing"/> are the few items still needed (add to grocery). <see cref="Steps"/> are optional quick
/// prep steps.
/// </summary>
public sealed class EatOptionDto
{
    public string Title { get; set; } = "";
    public string Why { get; set; } = "";
    public MacroSet Macros { get; set; } = new();
    public IReadOnlyList<string> Have { get; set; } = Array.Empty<string>();
    public IReadOnlyList<string> Missing { get; set; } = Array.Empty<string>();
    public IReadOnlyList<string> Steps { get; set; } = Array.Empty<string>();
}

/// <summary>
/// The "✨ What should I eat?" result: 0+ macro-aware options. <see cref="AiUsed"/> is false on the friendly
/// NON-AI fallback (Gemini off/unavailable) — a small deterministic list built from planned meals + on-hand
/// groceries — so the dialog labels it plainly instead of showing a 503. The endpoint always returns 200.
/// </summary>
public sealed class WhatToEatDto
{
    public bool AiUsed { get; set; }
    public IReadOnlyList<EatOptionDto> Options { get; set; } = Array.Empty<EatOptionDto>();
}

// ===================================================================================
// meal-feedback
// ===================================================================================

/// <summary>A free-text meal to get a quick verdict + healthier swaps for.</summary>
public sealed class MealFeedbackRequest
{
    public string? Description { get; set; }
}

/// <summary>A short verdict on a meal, whether it fits the caller's goal, and up to a few swap ideas.</summary>
public sealed class MealFeedbackResponse
{
    public string Verdict { get; set; } = "";
    public bool GoodForGoal { get; set; }
    public IReadOnlyList<string> Swaps { get; set; } = Array.Empty<string>();
}

// ===================================================================================
// recipe-macros
// ===================================================================================

/// <summary>A free-text recipe + number of servings to compute the per-serving macros for.</summary>
public sealed class RecipeMacrosRequest
{
    public string? Recipe { get; set; }
    public int? Servings { get; set; }
}

/// <summary>Per-serving macros for a recipe; numbers CLAMPED (calories 0..5000, macros 0..500 g).</summary>
public sealed class MacroSet
{
    public int Calories { get; set; }
    public double ProteinG { get; set; }
    public double CarbsG { get; set; }
    public double FatG { get; set; }
}

/// <summary>The result of a recipe-macro calculation: the per-serving macro breakdown.</summary>
public sealed class RecipeMacrosResponse
{
    public MacroSet PerServing { get; set; } = new();
}

// ===================================================================================
// daily-coach (GET, cached) / weekly-review (GET, cached) / weight-insight (GET, cached)
// ===================================================================================

/// <summary>A short daily-coaching insight + a few actionable tips, from the caller's day so far.</summary>
public sealed class DailyCoachResponse
{
    public string Insight { get; set; } = "";
    public IReadOnlyList<string> Tips { get; set; } = Array.Empty<string>();
}

/// <summary>A short weekly review of the caller's last 7 days + one forward-looking suggestion.</summary>
public sealed class WeeklyReviewResponse
{
    public string Summary { get; set; } = "";
    public string Suggestion { get; set; } = "";
}

/// <summary>A short insight on the caller's weight stats + a one-word/phrase trend label.</summary>
public sealed class WeightInsightResponse
{
    public string Insight { get; set; } = "";
    public string Trend { get; set; } = "";
}

// ===================================================================================
// hydration-suggest (reads profile) / parse-hydration / natural-goal
// ===================================================================================

/// <summary>Empty: the endpoint reads the caller's OWN profile server-side to size a hydration target.</summary>
public sealed class HydrationSuggestRequest
{
}

/// <summary>A suggested daily hydration target in ml (CLAMPED 0..10000) + a one-line rationale.</summary>
public sealed class HydrationSuggestResponse
{
    public int TargetMl { get; set; }
    public string? Rationale { get; set; }
}

/// <summary>Free-text drinks to parse into discrete amounts ("2 coffees and a big water").</summary>
public sealed class ParseHydrationRequest
{
    public string? Text { get; set; }
}

/// <summary>One parsed drink; <see cref="Ml"/> is CLAMPED to 0..5000.</summary>
public sealed class HydrationItemDto
{
    public string Label { get; set; } = "";
    public int Ml { get; set; }
}

/// <summary>Parsed drinks from a free-text hydration description.</summary>
public sealed class ParseHydrationResponse
{
    public IReadOnlyList<HydrationItemDto> Items { get; set; } = Array.Empty<HydrationItemDto>();
}

// ===================================================================================
// supplement-macros — estimate macros + kind for a supplement ("whey, 1 scoop")
// ===================================================================================

/// <summary>
/// Estimate the kind + macros for a free-text supplement. <see cref="Name"/> is the supplement (e.g.
/// "whey protein", "creatine", "vitamin D", "lisinopril"); <see cref="Dose"/> is an optional free-text
/// amount ("1 scoop", "5 g", "1 tablet"). Treated strictly as data in the prompt.
/// </summary>
public sealed class SupplementMacrosRequest
{
    public string? Name { get; set; }
    public string? Dose { get; set; }
}

/// <summary>
/// An AI supplement estimate. <see cref="Kind"/> is the lower-cased <c>SupplementKind</c> name ("supplement"
/// | "vitamin" | "protein" | "medication" | "preworkout" | "other"). Numbers are model output CLAMPED to
/// sane ranges (calories 0..5000, macros 0..500 g) — most supplements/vitamins/meds estimate to all-zeros;
/// protein powders carry real calories + protein.
/// </summary>
public sealed class SupplementMacrosResponse
{
    public string Kind { get; set; } = "supplement";
    public int Calories { get; set; }
    public double ProteinG { get; set; }
    public double CarbsG { get; set; }
    public double FatG { get; set; }

    /// <summary>Optional short model note (e.g. an assumption it made); null when none.</summary>
    public string? Note { get; set; }
}

/// <summary>A free-text goal to turn into a concrete plan ("lose 10 lbs in 3 months").</summary>
public sealed class NaturalGoalRequest
{
    public string? Text { get; set; }
}

/// <summary>
/// A structured goal parsed from free text. Calorie/macro numbers are CLAMPED (calories 0..5000, macros
/// 0..500 g); <see cref="Realistic"/> flags whether the model judged the timeline sensible.
/// </summary>
public sealed class NaturalGoalResponse
{
    public int CalorieTarget { get; set; }
    public double ProteinG { get; set; }
    public double CarbsG { get; set; }
    public double FatG { get; set; }
    public string? Timeline { get; set; }
    public bool Realistic { get; set; }
    public string? Rationale { get; set; }
}

// ===================================================================================
// AI Day Builder — build-day (draft + multi-turn refine) / day-summary
// ===================================================================================

/// <summary>
/// Reconstruct a COMPLETE day (all meals + foods, exercises, hydration, weight, activity) from a free-text
/// end-of-day description and optional meal photos. Supports multi-turn refinement: a prior draft +
/// answers to the prior round's clarifying questions are echoed back. NOTHING is persisted — the model
/// only produces a reviewable, fully-clamped draft. The whole-day write happens later via the separate,
/// transactional <c>POST /api/tracker/day/commit</c>.
/// </summary>
public sealed class BuildDayRequest
{
    /// <summary>The end-of-day brain-dump; cleaned + capped to 4000 chars server-side.</summary>
    public string? Text { get; set; }

    /// <summary>"yyyy-MM-dd"; echoed for display only, NOT trusted (the commit re-parses its own date).</summary>
    public string? Date { get; set; }

    /// <summary>"HH:mm" local time; helps the model resolve "this morning"/"after lunch"/"tonight".</summary>
    public string? LocalTimeOfDay { get; set; }

    /// <summary>Optional meal photos (REUSES <see cref="ImageRequest"/>); capped at 4, each validated.</summary>
    public List<ImageRequest>? Images { get; set; }

    /// <summary>Answers to the prior round's clarifying questions (multi-turn refine); capped at 20.</summary>
    public List<ClarifyAnswer>? Answers { get; set; }

    /// <summary>The echoed-back draft to refine; null on the first build.</summary>
    public DayDraft? PriorDraft { get; set; }
}

/// <summary>An answer to a server-issued clarifying question from the prior refine round.</summary>
public sealed class ClarifyAnswer
{
    /// <summary>The server-issued id from the prior round (e.g. "q1"); &lt;= 64 chars.</summary>
    public string QuestionId { get; set; } = "";

    /// <summary>The text of the question being answered, echoed by the client so the refine prompt keeps
    /// full Q/A context; cleaned + capped. Optional — falls back to the id when absent.</summary>
    public string? QuestionText { get; set; }

    /// <summary>The user's answer; cleaned + capped to 200 chars. Blank = "skip, best-guess".</summary>
    public string Answer { get; set; } = "";
}

/// <summary>
/// The build-day response: an idempotency <see cref="BuildId"/> (required by commit), the editable
/// <see cref="Draft"/>, any clarifying <see cref="Questions"/> (empty when ready to review), and the
/// refine <see cref="Round"/>. Every number in the draft is clamped server-side.
/// </summary>
public sealed class BuildDayResponse
{
    /// <summary>Server-issued idempotency token (a fresh GUID per build); the commit requires it.</summary>
    public string BuildId { get; set; } = "";
    public DayDraft Draft { get; set; } = new();

    /// <summary>Clarifying questions for the next refine round; [] => ready to review. Capped at 4.</summary>
    public List<ClarifyQuestion> Questions { get; set; } = new();

    /// <summary>1 on the first build; prior round + 1 on a refine.</summary>
    public int Round { get; set; }

    /// <summary>Optional one-line model note; &lt;= 200 chars.</summary>
    public string? Notes { get; set; }
}

/// <summary>One clarifying question the model asked. The id is SERVER-generated (never model-chosen).</summary>
public sealed class ClarifyQuestion
{
    public string QuestionId { get; set; } = "";
    public string Text { get; set; } = "";
    /// <summary>"text" | "yesno" | "choice".</summary>
    public string Kind { get; set; } = "text";
    /// <summary>Present when <see cref="Kind"/> == "choice"; capped at 6, each &lt;= 64 chars.</summary>
    public List<string>? Choices { get; set; }
}

/// <summary>
/// The editable day draft: the model's reconstruction of the whole day. Used as both the build-day
/// response and (echoed back, fully untrusted) the refine input. Every number is re-clamped server-side
/// on the way out AND again at commit.
/// </summary>
public sealed class DayDraft
{
    /// <summary>Meals, capped at 5.</summary>
    public List<MealDraft> Meals { get; set; } = new();
    /// <summary>Exercises, capped at 20.</summary>
    public List<DraftExercise> Exercises { get; set; } = new();
    /// <summary>Drinks, capped at 30.</summary>
    public List<DraftDrink> Hydration { get; set; } = new();
    /// <summary>At most one weight reading.</summary>
    public DraftWeight? Weight { get; set; }
    /// <summary>At most one activity record.</summary>
    public DraftActivity? Activity { get; set; }
    /// <summary>The assumptions the model made (resolved portions, sizes); capped at 8, each &lt;= 200.</summary>
    public List<string> Assumptions { get; set; } = new();
    /// <summary>A 1–2 sentence summary of the reconstructed day; &lt;= 200 chars.</summary>
    public string Summary { get; set; } = "";
}

/// <summary>One meal in the draft: its meal slot + its food items.</summary>
public sealed class MealDraft
{
    /// <summary>"breakfast" | "lunch" | "dinner" | "snack".</summary>
    public string Meal { get; set; } = "snack";
    /// <summary>Food items, capped at 25 per meal (and 50 total across the day).</summary>
    public List<DraftFood> Items { get; set; } = new();
}

/// <summary>
/// One drafted food. Numbers are model output CLAMPED to sane ranges (calories 0..5000, macros 0..500 g).
/// Note the SINGULAR <see cref="CarbG"/> (tracker convention) so the draft maps 1:1 onto a FoodEntry at
/// commit with no rename.
/// </summary>
public sealed class DraftFood
{
    public string Description { get; set; } = "";
    /// <summary>The resolved free-text portion ("2 eggs", "1 cup"); display only, &lt;= 128 chars.</summary>
    public string? Quantity { get; set; }
    public string? Brand { get; set; }
    public int Calories { get; set; }
    public double ProteinG { get; set; }
    public double CarbG { get; set; }
    public double FatG { get; set; }
    /// <summary>Model confidence in [0,1]; the UI derives "estimated"/"guess" chips from it.</summary>
    public double Confidence { get; set; }
    /// <summary>True when any number was capped down from the raw model output.</summary>
    public bool Clamped { get; set; }
}

/// <summary>One drafted exercise. Numbers CLAMPED (calories 0..5000, duration 1..1440 min).</summary>
public sealed class DraftExercise
{
    public string Name { get; set; } = "";
    public int? DurationMin { get; set; }
    public int CaloriesBurned { get; set; }
    public double Confidence { get; set; }
    public bool Clamped { get; set; }
}

/// <summary>One drafted drink; <see cref="Ml"/> CLAMPED to 1..5000.</summary>
public sealed class DraftDrink
{
    public string? Label { get; set; }
    public int Ml { get; set; }
}

/// <summary>The drafted body-weight reading; CLAMPED to 1..1000 kg, rounded to 2dp.</summary>
public sealed class DraftWeight
{
    public double WeightKg { get; set; }
    /// <summary>"morning" | "afternoon" | "evening" | "unspecified".</summary>
    public string Slot { get; set; } = "unspecified";
}

/// <summary>The drafted watch activity. Distance is METRES (the model emits distance_km, ×1000 here).</summary>
public sealed class DraftActivity
{
    public int? Steps { get; set; }
    public int? DistanceMeters { get; set; }
    public int? ActiveCalories { get; set; }
    /// <summary>"add" | "override".</summary>
    public string CalorieMode { get; set; } = "add";
}

/// <summary>Ask for an AI end-of-day recap of the LOGGED day (read server-side). Body carries only a date.</summary>
public sealed class DaySummaryRequest
{
    /// <summary>"yyyy-MM-dd"; falls back to today (display timezone) when absent/invalid.</summary>
    public string? Date { get; set; }
}

/// <summary>A celebratory end-of-day recap of the LOGGED day; all strings are length-capped.</summary>
public sealed class DaySummaryResponse
{
    /// <summary>A celebratory one-liner; &lt;= 200 chars.</summary>
    public string Headline { get; set; } = "";
    /// <summary>Up to 4 highlights, each &lt;= 200 chars.</summary>
    public List<string> Highlights { get; set; } = new();
    /// <summary>An optional forward nudge for tomorrow; null when none.</summary>
    public string? Tomorrow { get; set; }
}
