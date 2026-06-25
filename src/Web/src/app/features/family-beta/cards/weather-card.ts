import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';

import { FamilyWeather } from '../../../core/models';
import { UnitService } from '../../../core/unit.service';

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
        <span class="wx__temp">{{ temp() }}°{{ unit() }}</span>
        <span class="wx__desc">{{ weather().description }}</span>
        <span class="wx__loc">{{ weather().location }} · feels {{ feels() }}°{{ unit() }}</span>
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
  private readonly units = inject(UnitService);

  readonly weather = input.required<FamilyWeather>();

  readonly iconUrl = computed(() => `https://openweathermap.org/img/wn/${this.weather().icon}@2x.png`);

  /** °C in Metric, °F in Imperial — the wire only carries Fahrenheit, so convert client-side. */
  readonly unit = computed(() => (this.units.imperial() ? 'F' : 'C'));
  readonly temp = computed(() => this.round(this.display(this.weather().tempF)));
  readonly feels = computed(() => this.round(this.display(this.weather().feelsLikeF)));

  /** Wire is Fahrenheit; show as-is in Imperial, convert F->C in Metric. */
  private display(f: number): number {
    return this.units.imperial() ? f : (f - 32) * (5 / 9);
  }

  private round(f: number): number {
    return Math.round(f);
  }
}
