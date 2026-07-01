import {
  ChangeDetectionStrategy, Component, booleanAttribute, computed, inject, input, output,
} from '@angular/core';
import { Haptics } from '../../core/haptics';

/** Visual weight of a chip. `soft` (default) is a tinted glass token; `solid` fills with the accent gradient; `outline` is a hairline pill. */
export type ChipVariant = 'soft' | 'solid' | 'outline';

/**
 * BETA-KIT Chip — a compact pill token. Carries a label plus an OPTIONAL leading glyph: either an
 * `icon` (emoji / single glyph) OR, when no icon is set, an auto initial-badge derived from the
 * label (the first letter in a tinted round chip). When `removable` it grows a trailing "×" delete
 * affordance that emits `(removed)` — the caller owns the actual removal. When `selectable` it
 * behaves as a toggle pill (role=button, aria-pressed) and emits `(toggled)` with the next state.
 * Three variants (soft / solid / outline) all read --accent-a/--accent-b so a page's accent reskins
 * them. A new beta-kit primitive (no flagship equivalent). The bundled {@link BetaChipGroup}
 * (app-bs-chip-group) lays chips out as a wrapping row OR a horizontal scroll rail. Targets stay
 * >=44px tall; keyboard + aria wired. Honors reduced-motion. Composes {@link Haptics} for a faint
 * tick on toggle/remove; otherwise dependency-free + tree-shakeable.
 *
 * CONTRACT (next phase depends on this VERBATIM):
 *   selector:  app-bs-chip
 *   inputs:    label (string, required — the chip text),
 *              icon (string, default '' — a leading glyph/emoji; overrides the initial-badge),
 *              variant (ChipVariant 'soft'|'solid'|'outline', default 'soft'),
 *              removable (boolean, default false — shows the trailing × delete affordance),
 *              selectable (boolean, default false — toggle-pill behavior), selected (boolean, default false),
 *              badge (boolean, default true — show the auto initial-badge when no icon is set),
 *              disabled (boolean, default false)
 *   outputs:   removed (void — the × was activated), toggled (boolean — the next selected state; selectable only)
 *
 *   selector:  app-bs-chip-group  (bundled wrapper)
 *   inputs:    scroll (boolean, default false — horizontal scroll rail vs. wrapping row),
 *              label (string, aria-label for the group)
 *   content:   projected <app-bs-chip> children via <ng-content>
 *
 * Usage: `<app-bs-chip label="Vegan" icon="🥦" removable (removed)="drop('vegan')" />`
 *        `<app-bs-chip-group scroll><app-bs-chip label="All" selectable selected /> …</app-bs-chip-group>`
 */
@Component({
  selector: 'app-bs-chip',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'bs-chip',
    '[class.v-soft]': "variant() === 'soft'",
    '[class.v-solid]': "variant() === 'solid'",
    '[class.v-outline]': "variant() === 'outline'",
    '[class.is-selected]': 'selectable() && selected()',
    '[class.is-disabled]': 'disabled()',
    '[attr.role]': "selectable() ? 'button' : null",
    '[attr.tabindex]': 'selectable() && !disabled() ? 0 : null',
    '[attr.aria-pressed]': 'selectable() ? selected() : null',
    '[attr.aria-disabled]': 'disabled() ? true : null',
    '(click)': 'onToggle()',
    '(keydown)': 'onKeydown($event)',
  },
  template: `
    @if (icon()) {
      <span class="bs-chip-icon" aria-hidden="true">{{ icon() }}</span>
    } @else if (badge()) {
      <span class="bs-chip-badge" aria-hidden="true">{{ initial() }}</span>
    }
    <span class="bs-chip-label">{{ label() }}</span>
    @if (removable()) {
      <button type="button" class="bs-chip-x" aria-label="Remove"
              [disabled]="disabled()"
              (click)="onRemove($event)"
              (keydown)="onRemoveKeydown($event)">
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
          <path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>
        </svg>
      </button>
    }
  `,
  styles: [`
    :host(.bs-chip) {
      display: inline-flex; align-items: center; gap: 6px;
      min-height: 44px; box-sizing: border-box;
      padding: 6px 12px; border-radius: var(--r-pill);
      font-family: var(--font-ui); font-size: 13px; font-weight: 700; letter-spacing: .01em;
      color: var(--ink); border: 1px solid transparent;
      -webkit-tap-highlight-color: transparent; touch-action: manipulation;
      transition: transform 120ms var(--ease-out), background 160ms var(--ease-out),
                  border-color 160ms var(--ease-out), box-shadow 160ms var(--ease-out), color 160ms var(--ease-out);
    }
    /* soft — tinted glass token */
    :host(.bs-chip.v-soft) { background: var(--glass); border-color: var(--hairline); }
    /* solid — accent gradient with on-accent ink */
    :host(.bs-chip.v-solid) {
      background: linear-gradient(135deg, var(--accent-a), var(--accent-b));
      color: var(--ink-on-accent); box-shadow: var(--lift-1);
    }
    /* outline — hairline pill on the base */
    :host(.bs-chip.v-outline) { background: transparent; border-color: var(--hairline); color: var(--ink-dim); }

    /* selectable interactions */
    :host(.bs-chip[role='button']) { cursor: pointer; }
    :host(.bs-chip[role='button']:active) { transform: scale(.96); }
    :host(.bs-chip.is-selected.v-soft),
    :host(.bs-chip.is-selected.v-outline) {
      background: linear-gradient(135deg, var(--accent-a), var(--accent-b));
      color: var(--ink-on-accent); border-color: transparent; box-shadow: var(--lift-1);
    }
    :host(.bs-chip.is-disabled) { opacity: .5; pointer-events: none; }
    :host(.bs-chip:focus-visible) { outline: 2px solid var(--focus); outline-offset: 2px; }

    .bs-chip-icon { font-size: 15px; line-height: 1; }
    .bs-chip-badge {
      flex: 0 0 auto; width: 20px; height: 20px; display: inline-flex;
      align-items: center; justify-content: center; border-radius: var(--r-pill);
      font-size: 11px; font-weight: 800; text-transform: uppercase;
      background: linear-gradient(135deg, var(--accent-a), var(--accent-b));
      color: var(--ink-on-accent);
    }
    /* on a solid/selected chip the badge inverts to a translucent scrim so it reads on the gradient */
    :host(.bs-chip.v-solid) .bs-chip-badge,
    :host(.bs-chip.is-selected) .bs-chip-badge {
      background: rgba(0, 0, 0, .18); color: var(--ink-on-accent);
    }
    .bs-chip-label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 22ch; }
    .bs-chip-x {
      flex: 0 0 auto; margin: -6px -6px -6px 0; width: 32px; height: 32px;
      display: inline-flex; align-items: center; justify-content: center;
      border: none; background: transparent; color: currentColor; opacity: .7;
      border-radius: var(--r-pill); cursor: pointer;
      -webkit-tap-highlight-color: transparent; touch-action: manipulation;
      transition: opacity 120ms var(--ease-out), background 120ms var(--ease-out);
    }
    .bs-chip-x:hover, .bs-chip-x:focus-visible { opacity: 1; background: rgba(127, 127, 127, .18); }
    .bs-chip-x:disabled { opacity: .35; pointer-events: none; }
    .bs-chip-x:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
  `],
})
export class BetaChip {
  /** The chip text. */
  readonly label = input.required<string>();
  /** Optional leading glyph/emoji; when set it overrides the auto initial-badge. */
  readonly icon = input<string>('');
  /** Visual weight. */
  readonly variant = input<ChipVariant>('soft');
  /** Show the trailing × delete affordance. Accepts a bare attribute (`removable`). */
  readonly removable = input(false, { transform: booleanAttribute });
  /** Toggle-pill behavior (role=button + aria-pressed). */
  readonly selectable = input(false, { transform: booleanAttribute });
  /** Selected state (only meaningful when selectable). */
  readonly selected = input(false, { transform: booleanAttribute });
  /** Show the auto initial-badge when no icon is set. */
  readonly badge = input(true, { transform: booleanAttribute });
  /** When true the chip is inert. */
  readonly disabled = input(false, { transform: booleanAttribute });
  /** Fired when the × delete affordance is activated. */
  readonly removed = output<void>();
  /** Fired with the NEXT selected state when a selectable chip is toggled. */
  readonly toggled = output<boolean>();

  private readonly haptics = inject(Haptics);

  /** First letter of the label, for the initial-badge. */
  protected readonly initial = computed(() => (this.label().trim()[0] ?? '?').toUpperCase());

  /** Body click: toggles when selectable. */
  protected onToggle(): void {
    if (this.disabled() || !this.selectable()) return;
    this.haptics.select();
    this.toggled.emit(!this.selected());
  }

  protected onKeydown(e: KeyboardEvent): void {
    if (!this.selectable() || this.disabled()) return;
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      this.onToggle();
    }
  }

  /** × click: emit (removed). Stop propagation so a selectable chip doesn't also toggle. */
  protected onRemove(e: Event): void {
    e.stopPropagation();
    if (this.disabled()) return;
    this.haptics.tap();
    this.removed.emit();
  }

  protected onRemoveKeydown(e: KeyboardEvent): void {
    // Keep Enter/Space on the × from bubbling to the host toggle handler.
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') e.stopPropagation();
  }
}

/**
 * BETA-KIT ChipGroup — a layout wrapper for {@link BetaChip} children. Default is a WRAPPING row
 * (chips flow onto multiple lines); `scroll` switches to a single-line horizontal scroll rail with
 * momentum + hidden scrollbar (edge-to-edge under the gutters). Purely presentational — no selection
 * state of its own (each chip owns that). role=group with an aria-label.
 *
 * CONTRACT — selector: app-bs-chip-group; inputs: scroll (boolean, default false), label (string).
 */
@Component({
  selector: 'app-bs-chip-group',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'bs-chip-group',
    role: 'group',
    '[attr.aria-label]': 'label() || null',
    '[class.is-scroll]': 'scroll()',
  },
  template: `<ng-content></ng-content>`,
  styles: [`
    :host(.bs-chip-group) {
      display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
    }
    :host(.bs-chip-group.is-scroll) {
      flex-wrap: nowrap; overflow-x: auto; overflow-y: hidden;
      -webkit-overflow-scrolling: touch; scroll-snap-type: x proximity;
      scrollbar-width: none; padding-bottom: 2px;
    }
    :host(.bs-chip-group.is-scroll)::-webkit-scrollbar { display: none; }
    :host(.bs-chip-group.is-scroll) ::ng-deep app-bs-chip {
      flex: 0 0 auto; scroll-snap-align: start;
    }
  `],
})
export class BetaChipGroup {
  /** Horizontal scroll rail (true) vs. wrapping row (false). */
  readonly scroll = input<boolean>(false);
  /** aria-label for the group. */
  readonly label = input<string>('');
}
