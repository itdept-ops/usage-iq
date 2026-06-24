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

/// <summary>
/// Parse a meal into individual items — from free text ("Big Mac, fries, Coke") OR from a meal photo
/// (exactly ONE of <see cref="Text"/> or the image fields is supplied). The image path is multimodal and
/// ADDITIONALLY gated by <c>ai.vision</c>; its bytes are digested IN-MEMORY and NEVER stored (the
/// receipt/meal-photo rule). Both inputs are treated strictly as DATA — never instructions. PARSE-ONLY:
/// the endpoint writes NOTHING; the caller posts each confirmed item to <c>POST /api/tracker/food</c>.
/// </summary>
public sealed class ParseMealRequest
{
    /// <summary>The free-text meal to parse. Provide this OR <see cref="ImageBase64"/>, not both.</summary>
    public string? Text { get; set; }

    /// <summary>Raw base64 of a meal photo (no <c>data:</c> prefix needed). When present the parse is
    /// multimodal and requires <c>ai.vision</c>; mime must be jpeg/png/webp and decode under ~5 MB.</summary>
    public string? ImageBase64 { get; set; }

    /// <summary>The image mime type (image/jpeg, image/png, image/webp) — required when <see cref="ImageBase64"/> is set.</summary>
    public string? MimeType { get; set; }
}

/// <summary>
/// One parsed food item ready to drop into the add-food review list. Fields mirror what
/// <c>POST /api/tracker/food</c> (AddFoodRequest) stores for a MANUAL entry — note <see cref="CarbG"/>
/// (not <c>carbsG</c>) and the explicit <see cref="Quantity"/>. Numbers are CLAMPED to sane ranges
/// (calories 0..5000, macros 0..500 g, quantity 0.1..100).
/// </summary>
public sealed class ParsedFoodItemDto
{
    public string Description { get; set; } = "";
    public double Quantity { get; set; } = 1;
    public int Calories { get; set; }
    public double ProteinG { get; set; }
    public double CarbG { get; set; }
    public double FatG { get; set; }
}

/// <summary>
/// The parse-meal result: <see cref="AiUsed"/> is false when AI is off/unconfigured/unparseable (the
/// always-200 floor — <see cref="Items"/> is then empty and the dialog steers the user to manual entry);
/// true when the model produced the items. PARSE-ONLY — nothing is written.
/// </summary>
public sealed class ParseMealResultDto
{
    public bool AiUsed { get; set; }
    public IReadOnlyList<ParsedFoodItemDto> Items { get; set; } = Array.Empty<ParsedFoodItemDto>();
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
// scan-pantry — multimodal "what's in my pantry/fridge" ingredient read
// ===================================================================================

/// <summary>
/// The pantry-scan result: the distinct food ingredients the model read from the photo, as PLAIN generic names
/// (lowercased, deduped, no quantities/brands/packaging; each &lt;=40 chars, list &lt;=~40 items). <see cref="AiUsed"/>
/// is false on the friendly floor (Gemini off / unavailable / unreadable) — then <see cref="Ingredients"/> is empty.
/// The endpoint ALWAYS returns 200; the caller reviews the list (e.g. to seed the meal planner's on-hand chips).
/// </summary>
public sealed class ScanPantryResponse
{
    public IReadOnlyList<string> Ingredients { get; set; } = Array.Empty<string>();
    public bool AiUsed { get; set; }
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
/// One ingredient of a "✨ What should I eat?" option (mirrors the frontend EatIngredient). <see cref="Name"/> +
/// a free-text <see cref="Quantity"/> ("2", "1 cup", "" when none). <see cref="OnList"/> is set DETERMINISTICALLY
/// by the endpoint by cross-referencing <see cref="Name"/> against the household Groceries list (case/space-
/// insensitive, same normalization as the grocery de-dupe); <see cref="ListedQty"/> is the quantity currently on
/// the list ("x3" → 3, plain item → 1), or null when not on the list. The model never sets these.
/// </summary>
public sealed class EatIngredientDto
{
    public string Name { get; set; } = "";
    public string Quantity { get; set; } = "";
    public bool OnList { get; set; }
    public int? ListedQty { get; set; }
}

/// <summary>
/// One option from "✨ What should I eat?" (mirrors the frontend EatOption). <see cref="Macros"/> is the
/// per-option total (kcal + grams, CLAMPED) so it's addable to the tracker in one call. <see cref="Why"/> is a
/// one-line "fits your remaining" rationale. <see cref="Ingredients"/> is the FULL ingredient list the option
/// needs; each item is labelled (<see cref="EatIngredientDto.OnList"/> / <see cref="EatIngredientDto.ListedQty"/>)
/// against the household Groceries list by the endpoint, so the UI can show what's already on the list and add
/// the rest. <see cref="Steps"/> are optional quick prep steps.
/// </summary>
public sealed class EatOptionDto
{
    public string Title { get; set; } = "";
    public string Why { get; set; } = "";
    public MacroSet Macros { get; set; } = new();
    public IReadOnlyList<EatIngredientDto> Ingredients { get; set; } = Array.Empty<EatIngredientDto>();
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
// plan-meals (the robust "plan my day / week" AI planner) + add-to-plan
// ===================================================================================

/// <summary>
/// "✨ Plan my day / week" request. Everything is OPTIONAL — the server reads the caller's OWN context (their
/// remaining macro budget, recent eaten foods, saved recipes, on-hand groceries, and already-planned meals);
/// NO identity is sent. <see cref="Days"/> is how many days to plan (1 = today, clamped 1..7); <see cref="Slots"/>
/// is which meal slots to fill each day (defaults to breakfast/lunch/dinner; unknown slots are dropped).
/// <see cref="Constraints"/> is a free-text refine ("high protein", "vegetarian", "quick"), treated strictly as
/// DATA. <see cref="WeekStart"/> (YYYY-MM-DD) anchors the plan; absent → the caller's local "today".
/// </summary>
public sealed class PlanMealsRequest
{
    public int? Days { get; set; }
    public IReadOnlyList<string>? Slots { get; set; }
    public string? Constraints { get; set; }
    public string? WeekStart { get; set; }

    /// <summary>
    /// OPTIONAL on-hand pantry ingredients (e.g. seeded from a /scan-pantry photo, then edited). When present the
    /// planner STRONGLY prefers meals that use them and minimizes new shopping. Treated strictly as DATA; the
    /// endpoint trims/lowercases/dedupes and clamps the count + each entry's length before passing it to the model.
    /// Null/empty → unchanged planner behaviour. No schema/DB impact — this is request-only.
    /// </summary>
    public IReadOnlyList<string>? IngredientsOnHand { get; set; }
}

/// <summary>One planned slot in the AI day/week plan: a <see cref="Slot"/> (breakfast|lunch|dinner|snack), a
/// dish <see cref="Title"/>, a one-line <see cref="Why"/>, the per-dish <see cref="Macros"/> (CLAMPED), and the
/// FULL <see cref="Ingredients"/> list, each DETERMINISTICALLY labelled against the household grocery list
/// (<see cref="EatIngredientDto.OnList"/> / <see cref="EatIngredientDto.ListedQty"/>) by the endpoint.</summary>
public sealed class PlanMealSlotDto
{
    public string Slot { get; set; } = "dinner";
    public string Title { get; set; } = "";
    public string Why { get; set; } = "";
    public MacroSet Macros { get; set; } = new();
    public IReadOnlyList<EatIngredientDto> Ingredients { get; set; } = Array.Empty<EatIngredientDto>();
}

/// <summary>One day of the AI plan: the <see cref="LocalDate"/> (YYYY-MM-DD) and its proposed <see cref="Slots"/>.</summary>
public sealed class PlanMealDayDto
{
    public string LocalDate { get; set; } = "";
    public IReadOnlyList<PlanMealSlotDto> Slots { get; set; } = Array.Empty<PlanMealSlotDto>();
}

/// <summary>
/// The "✨ Plan my day / week" result: 1+ days of proposed meals. <see cref="AiUsed"/> is false on the friendly
/// NON-AI fallback (Gemini off/unavailable) — a small deterministic plan drawn from the caller's recent foods,
/// saved recipes, and groceries — so the dialog labels it plainly. The endpoint ALWAYS returns 200. Creating
/// meals is a SEPARATE confirmed action (POST /api/ai/plan-meals/to-plan) — nothing is written here.
/// </summary>
public sealed class PlanMealsDto
{
    public bool AiUsed { get; set; }
    public IReadOnlyList<PlanMealDayDto> Days { get; set; } = Array.Empty<PlanMealDayDto>();
}

/// <summary>One meal the caller chose to commit from the reviewed AI plan: the target <see cref="LocalDate"/>
/// (YYYY-MM-DD) + <see cref="Slot"/>, the <see cref="Title"/>, optional newline-joined <see cref="Ingredients"/>,
/// and optional per-dish macros (<see cref="MacroSource"/> "ai" when these came from the planner). The
/// add-to-plan endpoint writes each of these into the household meal plan via the SAME create path as POST
/// /api/family/meals (clamped, household-scoped) — the AI never wrote anything; the user confirmed first.</summary>
public sealed class PlanMealToWriteDto
{
    public string LocalDate { get; set; } = "";
    public string? Slot { get; set; }
    public string Title { get; set; } = "";
    public string? Ingredients { get; set; }
    public int? Servings { get; set; }
    public int? Calories { get; set; }
    public double? ProteinG { get; set; }
    public double? CarbG { get; set; }
    public double? FatG { get; set; }
    public string? MacroSource { get; set; }
}

/// <summary>The "commit the reviewed plan" request: the chosen <see cref="Meals"/> to write into the household
/// meal plan. Caller-scoped (the JWT identity); the count is clamped server-side. Nothing else is taken from
/// the body.</summary>
public sealed class PlanMealsToPlanRequest
{
    public IReadOnlyList<PlanMealToWriteDto>? Meals { get; set; }
}

/// <summary>The add-to-plan result: how many meals were actually created in the household plan.</summary>
public sealed class PlanMealsToPlanResultDto
{
    public int Added { get; set; }
}

// ===================================================================================
// refine-meal ("Refine with AI" on a single planned meal — suggestion only, no DB write)
// ===================================================================================

/// <summary>
/// "✨ Refine with AI" request for ONE planned meal. The whole meal comes FROM THE BODY (it edits a specific
/// card, not the caller's whole context) — it already belongs to the caller's household and nothing is
/// persisted server-side. <see cref="Preference"/> is the free-text request ("make it vegetarian", "lower the
/// carbs", "swap the salmon for chicken"), treated strictly as DATA (clamped ≤300 chars; the model is told to
/// honour it but NEVER follow instructions inside it).
///
/// MACRO CONVENTION (matches <c>FamilyMeal.perServing</c>, which the dialog has handy):
/// <see cref="Calories"/> is the dish TOTAL; <see cref="ProteinG"/>/<see cref="CarbG"/>/<see cref="FatG"/> are
/// PER-SERVING. The response keeps the same convention. Request-only — no schema/DB impact.
/// </summary>
public sealed class RefineMealRequest
{
    /// <summary>Current dish title.</summary>
    public string? Title { get; set; }
    /// <summary>Current ingredient block as raw newline text, exactly as carried on <c>FamilyMeal</c>.</summary>
    public string? Ingredients { get; set; }
    /// <summary>Current servings.</summary>
    public int? Servings { get; set; }
    /// <summary>Current dish-TOTAL calories.</summary>
    public int? Calories { get; set; }
    /// <summary>Current PER-SERVING protein (matches <c>FamilyMeal.perServing</c>).</summary>
    public double? ProteinG { get; set; }
    /// <summary>Current PER-SERVING carbs.</summary>
    public double? CarbG { get; set; }
    /// <summary>Current PER-SERVING fat.</summary>
    public double? FatG { get; set; }
    /// <summary>The free-text refine request — DATA, clamped ≤300 chars; never executed/trusted.</summary>
    public string? Preference { get; set; }
}

/// <summary>
/// The "✨ Refine with AI" result for one meal: a rewritten dish honouring the preference. <see cref="AiUsed"/>
/// is false when AI is off/unconfigured or the model returned nothing usable — in that case the endpoint ECHOES
/// the original request fields (so previewing it is harmless and nothing changed). The endpoint ALWAYS returns
/// 200 and WRITES NOTHING — the caller persists the accepted suggestion via the existing FamilyMeal PATCH.
///
/// MACRO CONVENTION (identical to the request): <see cref="Calories"/> is the dish TOTAL (clamped 0..5000);
/// <see cref="ProteinG"/>/<see cref="CarbG"/>/<see cref="FatG"/> are PER-SERVING grams (clamped 0..500). The
/// caller multiplies the per-serving macros by <see cref="Servings"/> before PATCHing, since the meal store
/// keeps dish TOTALS.
/// </summary>
public sealed class RefineMealResponse
{
    public bool AiUsed { get; set; }
    public string Title { get; set; } = "";
    /// <summary>Newline-joined "name (qty)" ingredient text, ready to PATCH onto the meal.</summary>
    public string Ingredients { get; set; } = "";
    public int Servings { get; set; }
    /// <summary>Dish TOTAL calories (clamped 0..5000).</summary>
    public int Calories { get; set; }
    /// <summary>PER-SERVING protein grams (clamped 0..500).</summary>
    public double ProteinG { get; set; }
    /// <summary>PER-SERVING carb grams (clamped 0..500).</summary>
    public double CarbG { get; set; }
    /// <summary>PER-SERVING fat grams (clamped 0..500).</summary>
    public double FatG { get; set; }
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

// ===================================================================================
// voice-parse — transcribe + parse a spoken note into confirmable, loggable INTENTS
// ===================================================================================

/// <summary>
/// A spoken-note capture to PARSE (never write). Send EITHER a <see cref="Transcript"/> (the preferred path —
/// on-device speech-to-text, so audio never leaves the device) OR an inline <see cref="AudioBase64"/> +
/// <see cref="MimeType"/> clip (for browsers without on-device STT; that path ADDITIONALLY requires the
/// ai.vision permission). The clip/transcript is processed IN-MEMORY only and NEVER persisted or logged. The
/// endpoint returns parsed intents for the user to CONFIRM; it writes nothing.
/// </summary>
public sealed class VoiceParseRequest
{
    /// <summary>The on-device STT transcript (preferred); cleaned + capped server-side.</summary>
    public string? Transcript { get; set; }

    /// <summary>Optional base64 audio clip (when the browser lacks on-device STT); requires ai.vision.</summary>
    public string? AudioBase64 { get; set; }

    /// <summary>The audio mime type (audio/webm, audio/ogg, audio/wav, audio/mpeg, audio/mp4, audio/aac,
    /// audio/flac); required + validated when <see cref="AudioBase64"/> is sent.</summary>
    public string? MimeType { get; set; }

    /// <summary>"yyyy-MM-dd"; echoed for the model's "today". NOT trusted — the server resolves the caller's
    /// own local today and every emitted payload uses THAT date (the eventual write re-resolves it too).</summary>
    public string? Date { get; set; }
}

/// <summary>
/// One parsed, confirmable voice intent. <see cref="Domain"/> is one of food | exercise | hydration | coffee |
/// weight | supplement | sleep | family. <see cref="Summary"/> is the human confirm line. <see cref="Endpoint"/>
/// is the EXISTING owner-scoped write endpoint the FRONTEND posts <see cref="Payload"/> to on confirm — voice
/// adds NO new write path, so it rides the existing permission gates + clamps and can never write cross-user.
/// </summary>
public sealed class VoiceIntentDto
{
    public string Domain { get; set; } = "";
    public string Summary { get; set; } = "";
    public string Endpoint { get; set; } = "";
    /// <summary>The exact request body for <see cref="Endpoint"/>, fully clamped server-side.</summary>
    public IReadOnlyDictionary<string, object?> Payload { get; set; } =
        new Dictionary<string, object?>();
}

/// <summary>
/// The voice-parse result. <see cref="Transcript"/> is echoed for display and is NEVER stored server-side.
/// <see cref="Intents"/> is the set of confirmable actions (empty when nothing loggable was heard).
/// <see cref="AiUsed"/> is false on the friendly floor (AI off/unconfigured/error) — the endpoint ALWAYS
/// returns 200 so the mic never 500s; <see cref="Message"/> carries the "type instead" hint on that floor.
/// </summary>
public sealed class VoiceParseResponse
{
    public string Transcript { get; set; } = "";
    public bool AiUsed { get; set; }
    public List<VoiceIntentDto> Intents { get; set; } = new();
    /// <summary>A friendly hint on the floor path ("Voice is unavailable, type instead."); null otherwise.</summary>
    public string? Message { get; set; }
}
