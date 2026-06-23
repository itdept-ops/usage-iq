import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import { FamilyWeather } from '../../../core/models';

/**
 * Hearth "Weather" glance card — current conditions, rendered ONLY when the page-owned snapshot returned a
 * non-null `weather` (the page guards `@if (today()?.weather)`), exactly like the live family-home weather
 * card. No network of its own; the weather object is passed in. The OpenWeather icon URL is built with a
 * small COPIED helper (no live import).
 */
@Component({
  selector: 'fb-weather-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="wx">
      <img class="wx__icon" [src]="iconUrl()" [alt]="weather().description" referrerpolicy="no-referrer" />
      <div class="wx__text">
        <span class="wx__temp">{{ round(weather().tempF) }}°</span>
        <span class="wx__desc">{{ weather().description }}</span>
        <span class="wx__loc">{{ weather().location }} · feels {{ round(weather().feelsLikeF) }}°</span>
      </div>
    </section>
  `,
  styles: [`
    .wx {
      display: flex; align-items: center; gap: 14px;
      border-radius: var(--r-card, 24px); padding: 16px;
      background: var(--bg-rise); border: 1px solid var(--glass-edge);
      box-shadow: var(--lift-1); scroll-snap-align: start;
    }
    .wx__icon { width: 56px; height: 56px; flex: 0 0 auto; }
    .wx__text { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
    .wx__temp { font-family: var(--font-display, inherit); font-size: 26px; font-weight: 800; color: var(--ink); }
    .wx__desc { font-size: 14px; color: var(--ink); text-transform: capitalize; }
    .wx__loc { font-size: 12px; color: var(--ink-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  `],
})
export class WeatherCard {
  readonly weather = input.required<FamilyWeather>();

  readonly iconUrl = computed(() => `https://openweathermap.org/img/wn/${this.weather().icon}@2x.png`);

  round(f: number): number {
    return Math.round(f);
  }
}
