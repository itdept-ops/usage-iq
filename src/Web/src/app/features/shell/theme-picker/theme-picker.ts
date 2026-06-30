import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';

import { ThemeService, COLOR_SCHEMES, type ThemeMode } from '../../../core/theme';

/**
 * THEME PICKER — the FiMobile appearance control. Two axes, both owned by {@link ThemeService}:
 *   • Mode    — System / Light / Dark   (segmented control, persisted to `uiq.theme`)
 *   • Scheme  — Blue (default) + 9 color schemes (swatch grid, persisted to `uiq.scheme`)
 *
 * Reproduces the template's "appearance settings" panel (the light/dark toggle + the 9-swatch
 * color-scheme picker) as a single reusable, isolated standalone component. Used in two places:
 * the shell account menu (compact) and the /preferences page (full). It edits no app state beyond
 * the theme service, so it's safe to mount anywhere.
 *
 * Selector: app-theme-picker.
 */
@Component({
  selector: 'app-theme-picker',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, MatTooltipModule],
  template: `
    <div class="tp">
      <div class="tp__block">
        <span class="tp__label">Appearance</span>
        <div class="tp__seg" role="radiogroup" aria-label="Theme mode">
          @for (m of modes; track m.value) {
            <button
              type="button"
              class="tp__seg-opt"
              role="radio"
              [class.tp__seg-opt--on]="theme.mode() === m.value"
              [attr.aria-checked]="theme.mode() === m.value"
              [attr.aria-label]="m.label + ' mode'"
              [matTooltip]="m.label"
              (click)="theme.setMode(m.value)"
            >
              <mat-icon aria-hidden="true">{{ m.icon }}</mat-icon>
              <span class="tp__seg-text">{{ m.label }}</span>
            </button>
          }
        </div>
      </div>

      <div class="tp__block">
        <span class="tp__label">Color</span>
        <div class="tp__swatches" role="radiogroup" aria-label="Color scheme">
          @for (s of schemes; track s.value) {
            <button
              type="button"
              class="tp__swatch"
              role="radio"
              [style.--sw]="s.swatch"
              [class.tp__swatch--on]="theme.scheme() === s.value"
              [attr.aria-checked]="theme.scheme() === s.value"
              [attr.aria-label]="s.label"
              [matTooltip]="s.label"
              (click)="theme.setScheme(s.value)"
            >
              @if (theme.scheme() === s.value) {
                <mat-icon class="tp__swatch-check" aria-hidden="true">check</mat-icon>
              }
            </button>
          }
        </div>
      </div>
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .tp {
        display: flex;
        flex-direction: column;
        gap: 14px;
      }
      .tp__block {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .tp__label {
        font-family: var(--tech-font-ui);
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--tech-text-secondary);
      }

      /* Segmented mode control */
      .tp__seg {
        display: flex;
        gap: 4px;
        padding: 4px;
        border-radius: var(--tech-r-control);
        background: var(--tech-bg-sunken);
        border: 1px solid var(--tech-border);
      }
      .tp__seg-opt {
        flex: 1 1 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        min-height: 36px;
        padding: 0 8px;
        border: 0;
        border-radius: calc(var(--tech-r-control) - 3px);
        background: transparent;
        color: var(--tech-text-secondary);
        font: inherit;
        font-family: var(--tech-font-ui);
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        transition:
          background var(--tech-t-control, 140ms) ease,
          color var(--tech-t-control, 140ms) ease;
      }
      .tp__seg-opt mat-icon {
        font-size: 18px;
        width: 18px;
        height: 18px;
      }
      .tp__seg-opt:hover {
        color: var(--tech-text);
      }
      .tp__seg-opt--on {
        background: var(--tech-panel);
        color: var(--tech-text);
        box-shadow: var(--tech-shadow-panel);
      }
      .tp__seg-opt:focus-visible {
        outline: none;
        box-shadow: var(--tech-focus-ring);
      }

      /* Swatch grid */
      .tp__swatches {
        display: grid;
        grid-template-columns: repeat(10, 1fr);
        gap: 8px;
      }
      .tp__swatch {
        position: relative;
        aspect-ratio: 1;
        min-width: 0;
        padding: 0;
        border: 2px solid transparent;
        border-radius: 50%;
        background: var(--sw);
        cursor: pointer;
        display: grid;
        place-items: center;
        box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.12);
        transition:
          transform 120ms ease,
          border-color 120ms ease;
      }
      .tp__swatch:hover {
        transform: scale(1.08);
      }
      .tp__swatch--on {
        border-color: var(--tech-text);
      }
      .tp__swatch-check {
        font-size: 15px;
        width: 15px;
        height: 15px;
        color: #fff;
        filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.55));
      }
      .tp__swatch:focus-visible {
        outline: none;
        border-color: var(--tech-text);
        box-shadow: var(--tech-focus-ring);
      }

      /* On a very narrow menu the 10-up swatch row wraps to two rows. */
      @media (max-width: 360px) {
        .tp__swatches {
          grid-template-columns: repeat(5, 1fr);
        }
        .tp__seg-text {
          display: none;
        }
      }
    `,
  ],
})
export class ThemePicker {
  protected readonly theme = inject(ThemeService);

  protected readonly modes: ReadonlyArray<{ value: ThemeMode; label: string; icon: string }> = [
    { value: 'system', label: 'System', icon: 'brightness_auto' },
    { value: 'light', label: 'Light', icon: 'light_mode' },
    { value: 'dark', label: 'Dark', icon: 'dark_mode' },
  ];

  protected readonly schemes = COLOR_SCHEMES;
}
