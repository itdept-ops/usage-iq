import { Component, computed, input } from '@angular/core';

/**
 * A lightweight SVG calorie ring. Shows progress of `caloriesIn` toward `goal` (when a goal is set),
 * with the headline number being the calories REMAINING (goal − in + out) — or net calories when no
 * goal exists. Pure SVG (no chart lib) so it stays tiny and theme-driven via --tech tokens. The ring
 * turns to the warn colour once the goal is exceeded.
 */
@Component({
  selector: 'app-calorie-ring',
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
  styleUrl: './calorie-ring.scss',
})
export class CalorieRing {
  readonly caloriesIn = input.required<number>();
  readonly caloriesOut = input.required<number>();
  readonly netCalories = input.required<number>();
  /** The daily calorie goal, or null/undefined when none is set. */
  readonly goal = input<number | null | undefined>(null);
  /** Remaining = goal − in + out (server-supplied); null when no goal. */
  readonly remaining = input<number | null | undefined>(null);

  readonly radius = 52;
  readonly circumference = 2 * Math.PI * this.radius;

  /** Progress of net intake toward the goal (0..1+, clamped at 1 for the arc fill). */
  private readonly progress = computed(() => {
    const g = this.goal();
    if (!g || g <= 0) return 0;
    return Math.max(0, this.netCalories()) / g;
  });

  readonly over = computed(() => {
    const g = this.goal();
    return !!g && g > 0 && this.netCalories() > g;
  });

  readonly dashOffset = computed(() => {
    const g = this.goal();
    // No goal → show a full subtle ring (net displayed in the centre).
    if (!g || g <= 0) return 0;
    return this.circumference * (1 - Math.min(1, this.progress()));
  });

  readonly headline = computed(() => {
    const g = this.goal();
    if (g && g > 0) {
      const remaining = Math.round(this.remaining() ?? (g - this.netCalories()));
      // When over goal, show the overage as a positive number ("over" is conveyed by the caption/colour).
      return (this.over() ? Math.abs(remaining) : remaining).toLocaleString();
    }
    return Math.round(this.netCalories()).toLocaleString();
  });

  readonly caption = computed(() => {
    if (this.over()) return 'over goal';
    return (this.goal() && this.goal()! > 0) ? 'remaining' : 'net kcal';
  });

  readonly ariaLabel = computed(() => {
    const g = this.goal();
    if (g && g > 0) {
      if (this.over()) {
        return `${this.headline()} calories over your goal of ${g.toLocaleString()}. ${this.caloriesIn()} in, ${this.caloriesOut()} burned.`;
      }
      return `${this.headline()} calories remaining of a ${g.toLocaleString()} goal. ${this.caloriesIn()} in, ${this.caloriesOut()} burned.`;
    }
    return `Net ${this.headline()} calories. ${this.caloriesIn()} in, ${this.caloriesOut()} burned.`;
  });
}
