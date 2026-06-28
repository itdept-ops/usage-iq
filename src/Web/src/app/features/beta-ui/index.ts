// ============================================================================
// BETA-KIT — shared beta-UI foundation (the "Strata" design system, generalized).
//
// The SCSS token contract lives in ./_beta-kit.scss (adopt via `@use '../beta-ui/beta-kit'`).
// This barrel re-exports the standalone Angular primitives the (non-flagship) beta pages adopt.
// Everything is dependency-free + tree-shakeable; no imports from the flagship tracker-beta.
// ============================================================================

export { BetaBottomSheet, type SheetDetent } from './bottom-sheet';
export { BetaSwipeRow, type SwipeSide } from './swipe-row';
export { BetaPullRefresh } from './pull-to-refresh';
export { BetaSegmentedControl, type Segment } from './segmented-control';
export { BetaFab } from './fab';
export { BetaToaster, ToastController, type ToastMsg, type ToastTone } from './toast';
export { BetaSkeleton } from './skeleton';
export { BetaSectionHeader } from './section-header';
export { BetaStatTile } from './stat-tile';
export { BetaSvgRing } from './svg-ring';
export { BetaEmptyState, BetaErrorState } from './state-block';
