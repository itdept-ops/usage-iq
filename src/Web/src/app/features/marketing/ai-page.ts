import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { MarketingNav } from './marketing-nav';
import { MarketingFooter } from './marketing-footer';

/** A single AI assist (one endpoint), as shown in a card. */
interface AiAssist {
  /** Card title — the human-readable name of the assist. */
  title: string;
  /** Material icon for the card. */
  icon: string;
  /** Whether this assist takes an image (camera/photo). */
  multimodal: boolean;
  /** Where in the product this lives (uiEntryPoint, trimmed for marketing). */
  where: string;
  /** What the user types / snaps (exampleInput). */
  youSay: string;
  /** Label for the input chip — "You say" vs "You snap". */
  youSayVerb: string;
  /** One line: "the prompt asks Gemini to…" (promptGist). */
  promptAsks: string;
  /** The response type name. */
  returnsType: string;
  /** The fields on the response. */
  returnsFields: string[];
  /** A compact JSON example of what comes back (exampleReturn). */
  exampleReturn: string;
}

interface AiGroup {
  /** Group heading. */
  group: string;
  /** Short blurb under the group heading. */
  blurb: string;
  /** Material icon for the group. */
  icon: string;
  /** The assists in this group. */
  assists: AiAssist[];
}

/** "How it works" pillar card. */
interface Pillar {
  icon: string;
  title: string;
  text: string;
}

/**
 * Public marketing showcase for Usage IQ's AI — Google Gemini woven through
 * the food & fitness tracker. Every claim here is extracted from the shipped
 * endpoints under POST/GET /api/ai/*.
 */
@Component({
  selector: 'app-ai-page',
  imports: [RouterLink, MatIconModule, MarketingNav, MarketingFooter],
  templateUrl: './ai-page.html',
  styleUrls: ['./marketing-page.scss', './ai-page.scss'],
})
export class AiPage {
  /** (2) How it works — the posture behind every assist. */
  readonly pillars: Pillar[] = [
    {
      icon: 'auto_awesome',
      title: 'Powered by Google Gemini',
      text: 'Every assist runs on Gemini (gemini-2.5-flash), called server-side — your front end never holds a model key.',
    },
    {
      icon: 'data_object',
      title: 'Tight prompts, strict JSON',
      text: 'Each feature uses a pre-built prompt that forces a strict JSON shape and treats your text or photo strictly as data — never as instructions.',
    },
    {
      icon: 'straighten',
      title: 'Numbers clamped to sane ranges',
      text: 'Calories, macros, durations, and fluid amounts are clamped server-side, so a wild estimate can never land in your log.',
    },
    {
      icon: 'edit_note',
      title: 'Always editable, never auto-logged',
      text: 'Results prefill an editable review — you confirm or tweak every field before anything is saved.',
    },
    {
      icon: 'lock',
      title: 'Permission-gated, off by default',
      text: 'AI is behind the tracker.ai permission, off by default. When it is off, every assist simply disappears and the tracker still works.',
    },
  ];

  /** (3) The entry points, grouped exactly as the inventory groups them. */
  readonly groups: AiGroup[] = [
    {
      group: 'Food — from text',
      blurb: 'Type a food, a whole meal, or a recipe and get editable calories and macros back.',
      icon: 'restaurant',
      assists: [
        {
          title: 'Estimate macros from a description',
          icon: 'tune',
          multimodal: false,
          where: 'Add Food dialog, manual entry — the “Estimate with AI” action prefills the per-serving calorie and macro fields.',
          youSayVerb: 'You say',
          youSay: '“grilled chicken breast with rice” · 1 cup rice + 6 oz chicken',
          promptAsks:
            'estimate the nutrition for the food and quantity, treating the text strictly as data.',
          returnsType: 'EstimateMacrosResponse',
          returnsFields: ['calories: int', 'proteinG: number', 'carbsG: number', 'fatG: number', 'note: string?'],
          exampleReturn:
            '{ "calories": 520, "proteinG": 48.5, "carbsG": 45.0,\n  "fatG": 12.0, "note": "Assumes white rice, cooked" }',
        },
        {
          title: 'Parse a multi-item meal',
          icon: 'list_alt',
          multimodal: false,
          where: 'Add Food dialog, “Describe your meal” box — renders a reviewable, per-item list you commit as a batch.',
          youSayVerb: 'You say',
          youSay: '“Big Mac, large fries, and a medium Coke”',
          promptAsks:
            'break the meal into individual items and estimate each one.',
          returnsType: 'ParseMealResponse',
          returnsFields: ['items: MealItemDto[]', '— description, calories, proteinG, carbsG, fatG'],
          exampleReturn:
            '{ "items": [\n   { "description": "Big Mac", "calories": 563, "proteinG": 26 },\n   { "description": "Large fries", "calories": 480, "proteinG": 6 },\n   { "description": "Medium Coke", "calories": 200, "proteinG": 0 }\n] }',
        },
        {
          title: 'Per-serving macros for a recipe',
          icon: 'menu_book',
          multimodal: false,
          where: 'Add Food dialog, Recipe mode — paste an ingredient list plus a servings count to prefill one serving.',
          youSayVerb: 'You say',
          youSay: '“2 cups flour, 3 eggs, 1 cup sugar, 1 stick butter” · serves 8',
          promptAsks:
            'estimate the recipe’s total macros, then divide by the servings to return per-serving values.',
          returnsType: 'RecipeMacrosResponse',
          returnsFields: ['perServing: MacroSet', '— calories, proteinG, carbsG, fatG'],
          exampleReturn:
            '{ "perServing": {\n   "calories": 310, "proteinG": 5.5,\n   "carbsG": 42.0, "fatG": 13.0\n} }',
        },
        {
          title: 'Quick meal feedback',
          icon: 'rate_review',
          multimodal: false,
          where: 'Add Food dialog, manual entry — a quick “rate this meal” action returns a verdict and healthier swaps.',
          youSayVerb: 'You say',
          youSay: '“two slices of pepperoni pizza and a soda”',
          promptAsks:
            'give brief feedback on the meal as a nutrition coach.',
          returnsType: 'MealFeedbackResponse',
          returnsFields: ['verdict: string', 'goodForGoal: bool', 'swaps: string[]'],
          exampleReturn:
            '{ "verdict": "Tasty but heavy on refined carbs and\n   saturated fat.", "goodForGoal": false,\n  "swaps": ["Swap the soda for sparkling water",\n   "Add a side salad", "Choose a thin crust"] }',
        },
      ],
    },
    {
      group: 'Food — from a photo',
      blurb: 'Multimodal: point your camera at a plate or a nutrition label. The image is sent to Google Gemini and is never stored by Usage IQ.',
      icon: 'photo_camera',
      assists: [
        {
          title: 'Photo of a meal → per-item macros',
          icon: 'restaurant_menu',
          multimodal: true,
          where: 'Add Food dialog, “Snap a meal” — results populate an editable per-item list you confirm before committing.',
          youSayVerb: 'You snap',
          youSay: 'A photo of your dinner plate — grilled chicken, rice, broccoli',
          promptAsks:
            'identify each distinct food in the photo and estimate it, treating the image as data only.',
          returnsType: 'ParseMealResponse',
          returnsFields: ['items: MealItemDto[]', '— description, calories, proteinG, carbsG, fatG'],
          exampleReturn:
            '{ "items": [\n   { "description": "Grilled chicken breast",\n     "calories": 280, "proteinG": 52.0 },\n   { "description": "White rice", "calories": 205 },\n   { "description": "Steamed broccoli", "calories": 55 }\n] }',
        },
        {
          title: 'Read a nutrition label → one food',
          icon: 'document_scanner',
          multimodal: true,
          where: 'Add Food dialog, “Scan label” — prefills the manual food fields and the stated serving size.',
          youSayVerb: 'You snap',
          youSay: 'A photo of the Nutrition Facts panel on a cereal box',
          promptAsks:
            'read the label for one serving and return the macros plus the stated serving size.',
          returnsType: 'ReadLabelResponse',
          returnsFields: ['description, calories, proteinG, carbsG, fatG', 'servingSize: string?'],
          exampleReturn:
            '{ "description": "Honey Nut Cereal",\n  "calories": 140, "proteinG": 3.0,\n  "carbsG": 29.0, "fatG": 1.5,\n  "servingSize": "3/4 cup (28 g)" }',
        },
      ],
    },
    {
      group: 'Exercise',
      blurb: 'Log a workout by talking, not by filling a form — calories scale to your own body weight, read server-side.',
      icon: 'fitness_center',
      assists: [
        {
          title: 'Free-text exercise → calories burned',
          icon: 'local_fire_department',
          multimodal: false,
          where: 'Add Exercise dialog, Manual tab — prefills an editable calories field with an “AI estimate” chip.',
          youSayVerb: 'You say',
          youSay: '“rowing machine” · 20 min',
          promptAsks:
            'estimate calories burned for the exercise and duration for a typical ~70 kg adult.',
          returnsType: 'EstimateExerciseResponse',
          returnsFields: ['caloriesBurned: int', 'note: string?'],
          exampleReturn:
            '{ "caloriesBurned": 168,\n  "note": "Assumes a 70 kg adult at a moderate pace" }',
        },
        {
          title: 'Natural-language log → structured entry',
          icon: 'mic',
          multimodal: false,
          where: 'Add Exercise dialog, AI tab (headline feature) — the parsed result prefills name, calories, and duration.',
          youSayVerb: 'You say',
          youSay: '“5 girl push-ups” · “3x10 squats” · “jogged 2 miles”',
          promptAsks:
            'parse reps, sets, distance and intensity, and estimate calories for your own body weight.',
          returnsType: 'ParseExerciseResponse',
          returnsFields: ['name, calories, durationMin', 'sets, reps, distanceText, note'],
          exampleReturn:
            '{ "name": "Knee push-ups", "calories": 4,\n  "sets": 1, "reps": 5, "durationMin": null,\n  "note": "Calories scaled to your body weight" }',
        },
        {
          title: 'Suggest a workout routine',
          icon: 'sports_gymnastics',
          multimodal: false,
          where: 'Add Exercise dialog, AI tab — pick a focus, minutes, and equipment (or a target burn) for a routine to log in one tap.',
          youSayVerb: 'You say',
          youSay: 'Full body · 30 min · dumbbells',
          promptAsks:
            'design one workout for the focus, minutes and equipment, at most 8 items.',
          returnsType: 'SuggestWorkoutResponse',
          returnsFields: ['title: string', 'items: WorkoutItemDto[]', 'estCalories: int'],
          exampleReturn:
            '{ "title": "30-Minute Full-Body Dumbbell Circuit",\n  "items": [\n   { "name": "Goblet squat", "setsReps": "3x12" },\n   { "name": "Dumbbell row", "setsReps": "3x10 each" }\n  ], "estCalories": 240 }',
        },
      ],
    },
    {
      group: 'Goals',
      blurb: 'A one-tap daily target from your own profile, or a plan from a plain-English goal — with a safety check.',
      icon: 'flag',
      assists: [
        {
          title: 'Profile stats → daily target',
          icon: 'auto_graph',
          multimodal: false,
          where: 'Profile dialog — the “Suggest with AI” button reads your own saved profile and prefills the goal fields.',
          youSayVerb: 'You tap',
          youSay: '“Suggest with AI” — the server reads your sex, age, height, weight, activity and goal direction',
          promptAsks:
            'suggest a sensible daily nutrition target from the profile stats alone.',
          returnsType: 'SuggestGoalResponse',
          returnsFields: ['calorieTarget, proteinG, carbsG, fatG', 'rationale: string?'],
          exampleReturn:
            '{ "calorieTarget": 2100, "proteinG": 150,\n  "carbsG": 200, "fatG": 65,\n  "rationale": "A modest deficit supports steady\n   fat loss while protecting muscle." }',
        },
        {
          title: 'Sentence → structured plan',
          icon: 'edit_calendar',
          multimodal: false,
          where: 'Profile dialog, “Describe your goal” field — prefills the goal fields and shows a timeline and realism check.',
          youSayVerb: 'You say',
          youSay: '“lose 10 lbs in 3 months”',
          promptAsks:
            'turn the free-text goal into a concrete daily plan and flag whether the timeline is safe.',
          returnsType: 'NaturalGoalResponse',
          returnsFields: ['calorieTarget, proteinG, carbsG, fatG', 'timeline: string?, realistic: bool, rationale'],
          exampleReturn:
            '{ "calorieTarget": 1700, "proteinG": 140,\n  "timeline": "~0.8 lb/week over 12 weeks",\n  "realistic": true,\n  "rationale": "A safe, sustainable rate." }',
        },
      ],
    },
    {
      group: 'Coaching',
      blurb: 'Goal-aware ideas and encouragement built from your own day and week — server-cached, never auto-fired on load.',
      icon: 'psychology',
      assists: [
        {
          title: 'What should I eat?',
          icon: 'tips_and_updates',
          multimodal: false,
          where: 'Tracker dashboard, calorie-ring card — on-demand food ideas to hit the calories and macros you have left.',
          youSayVerb: 'You tap',
          youSay: '“What should I eat?” with ~520 kcal and 40 g protein still left for the day',
          promptAsks:
            'suggest a few foods to hit the remaining targets, each with a short reason.',
          returnsType: 'SuggestFoodsResponse',
          returnsFields: ['suggestions: FoodSuggestionDto[]', '— food, why?, calories, proteinG'],
          exampleReturn:
            '{ "suggestions": [\n   { "food": "Grilled chicken breast (150 g)",\n     "why": "Lean protein to close your gap",\n     "calories": 250, "proteinG": 46 }\n] }',
        },
        {
          title: 'Daily coach',
          icon: 'self_improvement',
          multimodal: false,
          where: 'Tracker dashboard, “Daily coach” panel — a read on your day so far, cached per day for ~6h.',
          youSayVerb: 'You tap',
          youSay: '“Get daily coaching” after logging breakfast, a workout, and water',
          promptAsks:
            'give brief, supportive coaching — one insight plus up to 4 short tips.',
          returnsType: 'DailyCoachResponse',
          returnsFields: ['insight: string', 'tips: string[]'],
          exampleReturn:
            '{ "insight": "You\'re on track — protein is strong\n   and you have ~500 calories left for dinner.",\n  "tips": ["Aim for a veggie-heavy dinner",\n   "Add a glass of water before your meal"] }',
        },
        {
          title: 'Weekly review',
          icon: 'calendar_view_week',
          multimodal: false,
          where: 'Tracker dashboard, “This week’s AI review” panel — a big-picture read of your last 7 days, cached per ISO week.',
          youSayVerb: 'You tap',
          youSay: '“Get weekly review” — the server reads your last 7 days of intake, burn, and protein',
          promptAsks:
            'review the week and reply with a summary and one forward-looking suggestion.',
          returnsType: 'WeeklyReviewResponse',
          returnsFields: ['summary: string', 'suggestion: string'],
          exampleReturn:
            '{ "summary": "You stayed near your calorie goal\n   on 5 of 7 days and kept protein consistent.",\n  "suggestion": "Plan a lighter weekend dinner to\n   smooth out those two peaks." }',
        },
      ],
    },
    {
      group: 'Weight & hydration',
      blurb: 'A plain-language read of your weight trend, a personalized fluid goal, and drinks parsed from a sentence.',
      icon: 'monitor_weight',
      assists: [
        {
          title: 'Weight trend insight',
          icon: 'trending_down',
          multimodal: false,
          where: 'Weight Trend card — the sparkle button reads your last 90 days of weigh-ins; raw numbers never leave the server.',
          youSayVerb: 'You tap',
          youSay: '“Weight insight” on your weight chart (no typed input)',
          promptAsks:
            'give a brief insight on the body-weight stats and a short trend label.',
          returnsType: 'WeightInsightResponse',
          returnsFields: ['insight: string', 'trend: string'],
          exampleReturn:
            '{ "insight": "You\'re trending gently downward,\n   with mornings lower than evenings.",\n  "trend": "down" }',
        },
        {
          title: 'Suggest a hydration goal',
          icon: 'water_drop',
          multimodal: false,
          where: 'Add-a-drink dialog — the sparkle button reads your profile and offers a daily fluid target to accept in one tap.',
          youSayVerb: 'You tap',
          youSay: '“Suggest my hydration goal” — the server reads your sex, activity, and weight',
          promptAsks:
            'suggest a sensible daily fluid-intake target in millilitres.',
          returnsType: 'HydrationSuggestResponse',
          returnsFields: ['targetMl: int', 'rationale: string?'],
          exampleReturn:
            '{ "targetMl": 2600,\n  "rationale": "Based on your weight and moderate\n   activity, this keeps you well hydrated." }',
        },
        {
          title: 'Parse drinks from text',
          icon: 'local_cafe',
          multimodal: false,
          where: 'Add-a-drink dialog, “Describe what you drank” field — parsed drinks appear as an editable list to review.',
          youSayVerb: 'You say',
          youSay: '“2 coffees and a big water”',
          promptAsks:
            'parse the text into discrete drinks, estimating a typical serving size in millilitres for each.',
          returnsType: 'ParseHydrationResponse',
          returnsFields: ['items: HydrationItemDto[]', '— label, ml'],
          exampleReturn:
            '{ "items": [\n   { "label": "Coffee", "ml": 240 },\n   { "label": "Coffee", "ml": 240 },\n   { "label": "Water (large)", "ml": 500 }\n] }',
        },
      ],
    },
  ];
}
