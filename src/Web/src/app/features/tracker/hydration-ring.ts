import { Component, computed, inject, input, ChangeDetectionStrategy } from '@angular/core';

import { UnitService } from '../../core/unit.service';
import { glasses } from './units';

/**
 * A lightweight SVG hydration ring — the fluid-intake twin of {@link CalorieRing}. Shows progress of
 * `hydrationMl` toward `goalMl`, with the headline being the amount logged in the user's units (oz for
 * Imperial / ml for Metric) and a "x of y glasses" caption. Pure SVG (no chart lib), theme-driven via
 * --tech tokens. The ring turns to the success colour once the goal is reached/exceeded. A visually-
 * hidden text equivalent is supplied via the role="img" aria-label.
 */
@Component({
  selector: 'app-hydration-ring',
  template: `
    <svg viewBox="0 0 120 120" class="ring" role="img" [attr.aria-label]="ariaLabel()">
      <circle class="ring__track" cx="60" cy="60" [attr.r]="radius" fill="none" stroke-width="11" />
      <circle
        class="ring__bar"
        cx="60"
        cy="60"
        [attr.r]="radius"
        fill="none"
        stroke-width="11"
        stroke-linecap="round"
        transform="rotate(-90 60 60)"
        [class.ring__bar--met]="met()"
        [attr.stroke-dasharray]="circumference"
        [attr.stroke-dashoffset]="dashOffset()"
      />
      <text x="60" y="55" class="ring__value" text-anchor="middle">{{ headline() }}</text>
      <text x="60" y="73" class="ring__label" text-anchor="middle">{{ caption() }}</text>
    </svg>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './hydration-ring.scss',
})
export class HydrationRing {
  private readonly units = inject(UnitService);

  /** Total fluid intake logged for the day, in millilitres. */
  readonly hydrationMl = input.required<number>();
  /** The resolved daily hydration goal, in millilitres (> 0). */
  readonly goalMl = input.required<number>();
  /** Retained for caller compatibility; display unit now comes from {@link UnitService}. */
  readonly imperial = input<boolean>(false);

  readonly radius = 52;
  readonly circumference = 2 * Math.PI * this.radius;

  /** Progress toward the goal (0..1+, clamped at 1 for the arc fill). */
  private readonly progress = computed(() => {
    const g = this.goalMl();
    if (!g || g <= 0) return 0;
    return this.hydrationMl() / g;
  });

  /** True once the goal is reached or exceeded — drives the celebratory/over colour + caption. */
  readonly met = computed(() => {
    const g = this.goalMl();
    return g > 0 && this.hydrationMl() >= g;
  });

  readonly dashOffset = computed(() => {
    const g = this.goalMl();
    if (!g || g <= 0) return this.circumference;
    return this.circumference * (1 - Math.min(1, this.progress()));
  });

  /** The big centre number: the amount logged, in the user's units (e.g. "48 fl oz" / "1200 ml"). */
  readonly headline = computed(() => this.units.formatVolume(this.hydrationMl()) ?? '0');

  /** Sub-caption: "x of y glasses", or a celebratory note once the goal is met. */
  readonly caption = computed(() => {
    const have = glasses(this.hydrationMl());
    const want = glasses(this.goalMl());
    if (this.met()) return `${have} glasses · goal met`;
    return `${have} of ${want} glasses`;
  });

  readonly ariaLabel = computed(() => {
    const have = this.units.formatVolume(this.hydrationMl());
    const want = this.units.formatVolume(this.goalMl());
    if (this.met()) {
      return `Hydration goal met: ${have} of a ${want} goal (${glasses(this.hydrationMl())} glasses).`;
    }
    return `${have} of a ${want} hydration goal (${glasses(this.hydrationMl())} of ${glasses(this.goalMl())} glasses).`;
  });
}
