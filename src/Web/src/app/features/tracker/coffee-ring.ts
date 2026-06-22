import { Component, computed, input } from '@angular/core';

/**
 * A lightweight SVG coffee ring — the caffeine twin of {@link HydrationRing}. Shows progress of
 * `cups` toward `goalCups`, with the headline being the cup count and a "x of y cups" caption
 * (plus the day's caffeine in mg when known). Pure SVG (no chart lib), theme-driven via --tech
 * tokens. A visually-hidden text equivalent is supplied via the role="img" aria-label.
 *
 * LIMIT semantics (the key difference from hydration): the coffee goal is a CAP, not a target. The
 * ring turns the WARNING colour once `cups` EXCEEDS `goalCups` — there is no "celebratory success"
 * state, because going over your coffee limit is not something to celebrate.
 */
@Component({
  selector: 'app-coffee-ring',
  template: `
    <svg viewBox="0 0 120 120" class="ring" role="img" [attr.aria-label]="ariaLabel()">
      <circle class="ring__track" cx="60" cy="60" [attr.r]="radius" fill="none" stroke-width="11" />
      <circle class="ring__bar" cx="60" cy="60" [attr.r]="radius" fill="none" stroke-width="11"
              stroke-linecap="round" transform="rotate(-90 60 60)"
              [class.ring__bar--over]="over()"
              [attr.stroke-dasharray]="circumference"
              [attr.stroke-dashoffset]="dashOffset()" />
      <text x="60" y="55" class="ring__value" text-anchor="middle">{{ headline() }}</text>
      <text x="60" y="73" class="ring__label" text-anchor="middle">{{ caption() }}</text>
    </svg>
  `,
  styleUrl: './coffee-ring.scss',
})
export class CoffeeRing {
  /** Total cups of coffee logged for the day. */
  readonly cups = input.required<number>();
  /** The resolved daily coffee goal/cap, in cups (> 0). */
  readonly goalCups = input.required<number>();
  /** Total caffeine (mg) logged for the day; surfaced in the caption when > 0. */
  readonly caffeineMg = input<number>(0);

  readonly radius = 52;
  readonly circumference = 2 * Math.PI * this.radius;

  /** Progress toward the cap (0..1+, clamped at 1 for the arc fill). */
  private readonly progress = computed(() => {
    const g = this.goalCups();
    if (!g || g <= 0) return 0;
    return this.cups() / g;
  });

  /** True once the cup count EXCEEDS the cap — drives the warning colour + caption (NOT success). */
  readonly over = computed(() => {
    const g = this.goalCups();
    return g > 0 && this.cups() > g;
  });

  readonly dashOffset = computed(() => {
    const g = this.goalCups();
    if (!g || g <= 0) return this.circumference;
    return this.circumference * (1 - Math.min(1, this.progress()));
  });

  /** The big centre number: the cup count. */
  readonly headline = computed(() => `${this.cups()}`);

  /** Sub-caption: "x of y cups" (+ caffeine mg when known), or an over-limit note past the cap. */
  readonly caption = computed(() => {
    const have = this.cups();
    const want = this.goalCups();
    const mg = this.caffeineMg();
    const caf = mg > 0 ? ` · ${mg} mg` : '';
    if (this.over()) return `${have} cups · over limit${caf}`;
    return `${have} of ${want} cups${caf}`;
  });

  readonly ariaLabel = computed(() => {
    const have = this.cups();
    const want = this.goalCups();
    const mg = this.caffeineMg();
    const caf = mg > 0 ? ` (${mg} mg caffeine)` : '';
    if (this.over()) {
      return `Over your coffee limit: ${have} of a ${want} cup limit${caf}.`;
    }
    return `${have} of a ${want} cup coffee limit${caf}.`;
  });
}
