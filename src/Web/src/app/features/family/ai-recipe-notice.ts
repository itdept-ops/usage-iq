/**
 * One-time privacy notice for the meal planner's "✨ From a recipe" assist — mirrors the tracker's photo /
 * read-label notice ({@link ../tracker/ai-image.ts confirmPhotoNotice}). The FIRST time a family member turns
 * pasted recipe text into a meal we surface a confirm so they know the text is sent to Google Gemini and is
 * not stored by Usage IQ. Gated by a localStorage flag, so it shows only once; declining aborts WITHOUT
 * setting the flag (the notice returns next time). Framework-free so any dialog/component can call it.
 */

/** localStorage key gating the one-time "your recipe text goes to Gemini" notice. */
const RECIPE_NOTICE_KEY = 'usage_iq_ai_recipe_notice';

/** The one-time notice copy shown before the FIRST "From a recipe" use. */
const RECIPE_NOTICE_TEXT =
  'The recipe text you paste is sent to Google Gemini to pull out the dish and ingredients — it is not stored by Usage IQ.';

/**
 * Has the one-time recipe-privacy notice already been acknowledged? Lets a caller pre-check (e.g. to vary a
 * button label) without showing the prompt.
 */
export function recipeNoticeAcknowledged(): boolean {
  try {
    return localStorage.getItem(RECIPE_NOTICE_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Gate the FIRST "From a recipe" use behind a one-time privacy notice. If already acknowledged (localStorage
 * flag {@link RECIPE_NOTICE_KEY}), resolves `true` immediately with no prompt. Otherwise shows the
 * {@link RECIPE_NOTICE_TEXT} confirm: on accept it sets the flag and resolves `true` (proceed); on cancel it
 * resolves `false` (abort) WITHOUT setting the flag, so the notice shows again next time.
 */
export function confirmRecipeNotice(): Promise<boolean> {
  if (recipeNoticeAcknowledged()) return Promise.resolve(true);
  const proceed = typeof window !== 'undefined' && window.confirm(RECIPE_NOTICE_TEXT);
  if (proceed) {
    try {
      localStorage.setItem(RECIPE_NOTICE_KEY, '1');
    } catch {
      // Non-fatal: a blocked localStorage just means we re-show the notice next time.
    }
  }
  return Promise.resolve(proceed);
}
