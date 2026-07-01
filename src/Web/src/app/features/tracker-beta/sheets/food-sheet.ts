import {
  ChangeDetectionStrategy, Component, computed, effect, inject, model, signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgTemplateOutlet } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { MatIconModule } from '@angular/material/icon';
import { MatSnackBar } from '@angular/material/snack-bar';
import { firstValueFrom, timeout } from 'rxjs';

import { Api } from '../../../core/api';
import { TrackerStore } from '../../../core/tracker-store';
import {
  AddFoodRequest, CustomFoodDto, FoodSearchItemDto, MealItemDto, Meal,
} from '../../../core/models';
import { OptimisticTracker } from '../state/optimistic-tracker';
import { BottomSheet } from '../ui/bottom-sheet';
import { group } from '../util/units';
import { pickImages, confirmPhotoNotice } from '../../tracker/ai-image';

/**
 * Strata FOOD sheet — the primary food-logging surface of Tracker Beta.
 *
 * Opens (empty query) to the caller's Recents + Favorites FIRST via `api.savedFoods(undefined, true)`,
 * so the common case (re-log something you eat often) is one tap with zero typing. Typing runs a
 * >=250ms-debounced `api.searchFoods({ q })` (inputmode=search, enterkeyhint=search). Every result is a
 * multi-select tile; selections accumulate in a pinned running kcal/macro tally bar, and one "Add N"
 * commit fires a SINGLE optimistic `addFoods([...])` batch (instant ring tick + reconcile on settle).
 *
 * Three first-class fast lanes sit at the top:
 *   • Scan  — barcode lookup via `api.searchFoods({ barcode })` (manual UPC entry; mobile cameras give the
 *             number). A no-match steers; a 503 steers to "search by name".
 *   • Snap  — `api.photoMeal(image)` → a reviewable item list the user trims → `addFoods([...])`.
 *   • Brain — `api.buildDay({ text })` → reads back the drafted FOOD items → `api.bulkCommitDay(...)`.
 * Each lane degrades gracefully on a 503 (AI/provider unconfigured) to a friendly inline steer — the
 * sheet stays fully usable via name search / recents.
 *
 * Self-styled with the inherited Strata `var(--*)` tokens (no global --tech-*); 44px targets, aria, and
 * the page-host reduced-motion killswitch handle motion. Read-only (shared) views disable all commits.
 *
 * Contract:
 *   selector: app-food-sheet
 *   input:    open (model<boolean>, two-way) — drives the BottomSheet
 *
 * Usage: `<app-food-sheet [(open)]="foodSheetOpen" />`
 */

/** Which fast lane (if any) is expanded; 'list' is the default search/recents view. */
type Pane = 'list' | 'scan' | 'snap' | 'brain';

/** A normalized, selectable candidate row (from saved, recents, or USDA/FatSecret search). */
interface Candidate {
  /** Stable selection key (so re-selecting the same item toggles it). */
  key: string;
  description: string;
  brand?: string;
  servingDesc?: string;
  calories: number;
  proteinG: number;
  carbG: number;
  fatG: number;
  /** Provider tag for the wire (`source` on AddFoodRequest); undefined => manual/saved. */
  source?: string;
  fdcId?: number;
  /** Recents are read-only re-adds (id 0) — purely cosmetic distinction here. */
  isRecent?: boolean;
}

/** A reviewable item produced by Snap/Brain that the user can trim before committing. */
interface ReviewItem {
  key: string;
  description: string;
  calories: number;
  proteinG: number;
  carbG: number;
  fatG: number;
  /** Whether this item is included in the commit (user can uncheck before adding). */
  keep: boolean;
  /** The meal this item logs to — defaults per item, re-assignable in review so one batch can split
   *  across breakfast/lunch/dinner/snack (multiple meals) or pile into one (parts of a meal). */
  meal: Meal;
  /** Which uploaded photo this item came from (1-based), for a grouping hint when several were snapped. */
  photo?: number;
}

const MEALS: { value: Meal; label: string; short: string }[] = [
  { value: 'breakfast', label: 'Breakfast', short: 'B' },
  { value: 'lunch', label: 'Lunch', short: 'L' },
  { value: 'dinner', label: 'Dinner', short: 'D' },
  { value: 'snack', label: 'Snack', short: 'S' },
];

@Component({
  selector: 'app-food-sheet',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, NgTemplateOutlet, MatIconModule, BottomSheet],
  template: `
    <app-bottom-sheet [(open)]="open" detent="full" label="Log food" (closed)="onClosed()">
      <div class="fs">
        <!-- Meal target + fast-lane row -->
        <header class="fs-head">
          <div class="fs-meal" role="group" aria-label="Meal">
            @for (m of MEALS; track m.value) {
              <button type="button" class="fs-meal-chip"
                      [class.on]="meal() === m.value"
                      [attr.aria-pressed]="meal() === m.value"
                      (click)="meal.set(m.value)">{{ m.label }}</button>
            }
          </div>

          <div class="fs-lanes" role="tablist" aria-label="Quick add methods">
            <button type="button" class="fs-lane" role="tab"
                    [class.on]="pane() === 'scan'" [attr.aria-selected]="pane() === 'scan'"
                    (click)="togglePane('scan')">
              <mat-icon aria-hidden="true">barcode_reader</mat-icon><span>Scan</span>
            </button>
            <button type="button" class="fs-lane" role="tab"
                    [class.on]="pane() === 'snap'" [attr.aria-selected]="pane() === 'snap'"
                    (click)="togglePane('snap')">
              <mat-icon aria-hidden="true">photo_camera</mat-icon><span>Snap</span>
            </button>
            <button type="button" class="fs-lane" role="tab"
                    [class.on]="pane() === 'brain'" [attr.aria-selected]="pane() === 'brain'"
                    (click)="togglePane('brain')">
              <mat-icon aria-hidden="true">auto_awesome</mat-icon><span>Brain-dump</span>
            </button>
          </div>
        </header>

        <!-- ============ SCAN ============ -->
        @if (pane() === 'scan') {
          <section class="fs-pane" aria-label="Scan a barcode">
            @if (laneDown()) {
              <p class="fs-steer">{{ laneDown() }}</p>
            } @else {
              <label class="fs-field">
                <span class="fs-field-label">Barcode (UPC/EAN)</span>
                <input class="fs-input" type="text" inputmode="numeric" enterkeyhint="search"
                       autocomplete="off" [(ngModel)]="barcode" (keydown.enter)="runScan()"
                       placeholder="Enter the number under the bars" aria-label="Barcode number" />
              </label>
              <button type="button" class="fs-go" [disabled]="busy() || !barcode().trim()" (click)="runScan()">
                {{ busy() ? 'Looking up…' : 'Look up' }}
              </button>
              @if (scanMsg()) { <p class="fs-steer">{{ scanMsg() }}</p> }
            }
          </section>
        }

        <!-- ============ SNAP ============ -->
        @if (pane() === 'snap') {
          <section class="fs-pane" aria-label="Snap a meal photo">
            @if (laneDown()) {
              <p class="fs-steer">{{ laneDown() }}</p>
            } @else if (review().length === 0) {
              <button type="button" class="fs-go" [disabled]="busy()" (click)="runSnap()">
                <mat-icon aria-hidden="true">photo_camera</mat-icon>
                {{ busy() ? 'Reading photos…' : 'Take / choose photos' }}
              </button>
              <p class="fs-steer">Add one or several photos — a spread, or different meals — then set the meal for each item.</p>
              @if (snapMsg()) { <p class="fs-steer">{{ snapMsg() }}</p> }
            } @else {
              <ng-container [ngTemplateOutlet]="reviewTpl" />
            }
          </section>
        }

        <!-- ============ BRAIN-DUMP ============ -->
        @if (pane() === 'brain') {
          <section class="fs-pane" aria-label="Describe your day">
            @if (laneDown()) {
              <p class="fs-steer">{{ laneDown() }}</p>
            } @else if (review().length === 0) {
              <label class="fs-field">
                <span class="fs-field-label">What did you eat?</span>
                <textarea class="fs-input fs-textarea" rows="3" enterkeyhint="done"
                          [(ngModel)]="brainText" aria-label="Describe what you ate"
                          placeholder="e.g. 2 eggs, toast & coffee for breakfast, a chicken burrito for lunch"></textarea>
              </label>
              <button type="button" class="fs-go" [disabled]="busy() || !brainText().trim()" (click)="runBrain()">
                {{ busy() ? 'Thinking…' : 'Draft my food' }}
              </button>
              @if (brainMsg()) { <p class="fs-steer">{{ brainMsg() }}</p> }
            } @else {
              <ng-container [ngTemplateOutlet]="reviewTpl" />
            }
          </section>
        }

        <!-- ============ LIST (search + recents/favorites) ============ -->
        @if (pane() === 'list') {
          <label class="fs-search">
            <mat-icon class="fs-search-icon" aria-hidden="true">search</mat-icon>
            <input class="fs-input" type="search" inputmode="search" enterkeyhint="search"
                   autocomplete="off" [ngModel]="query()" (ngModelChange)="onQuery($event)"
                   placeholder="Search foods" aria-label="Search foods" />
            @if (query()) {
              <button type="button" class="fs-clear" aria-label="Clear search" (click)="onQuery('')">
                <mat-icon aria-hidden="true">close</mat-icon>
              </button>
            }
          </label>

          @if (searchUnavailable()) {
            <p class="fs-steer">Food search is offline right now — pick from your recents below, or use Brain-dump to describe a meal.</p>
          }

          <section class="fs-list" aria-live="polite" [attr.aria-busy]="busy()">
            @if (busy() && candidates().length === 0) {
              @for (i of [1,2,3,4]; track i) { <div class="fs-skel"></div> }
            } @else if (candidates().length === 0) {
              <p class="fs-empty">
                @if (query()) { No matches — try Brain-dump to describe it. }
                @else if (recentsError()) { Couldn't load your recents just now — search above to log, or reopen to retry. }
                @else { No saved or recent foods yet. Search above to add one. }
              </p>
            } @else {
              @if (!query()) { <p class="fs-section-label">Recents &amp; favorites</p> }
              @for (c of candidates(); track c.key) {
                <button type="button" class="fs-row" [class.on]="isSelected(c.key)"
                        [attr.aria-pressed]="isSelected(c.key)" (click)="toggle(c)">
                  <span class="fs-check" aria-hidden="true">
                    <mat-icon>{{ isSelected(c.key) ? 'check_circle' : 'radio_button_unchecked' }}</mat-icon>
                  </span>
                  <span class="fs-row-main">
                    <span class="fs-row-name">{{ c.description }}</span>
                    @if (c.brand || c.servingDesc) {
                      <span class="fs-row-sub">{{ c.brand }}{{ c.brand && c.servingDesc ? ' · ' : '' }}{{ c.servingDesc }}</span>
                    }
                  </span>
                  <span class="fs-row-kcal">{{ group(c.calories) }}<small>kcal</small></span>
                </button>
              }
            }
          </section>
        }

        <!-- ============ Pinned running tally / commit ============ -->
        @if (selected().length > 0 && pane() === 'list') {
          <div class="fs-tally" role="status" aria-live="polite">
            <div class="fs-tally-info">
              <strong>{{ selected().length }} selected</strong>
              <span class="fs-tally-macros">
                {{ group(tally().calories) }} kcal ·
                P {{ group(tally().proteinG) }} ·
                C {{ group(tally().carbG) }} ·
                F {{ group(tally().fatG) }}
              </span>
            </div>
            <button type="button" class="fs-add" [disabled]="opt.readOnly() || busy()" (click)="commitSelected()">
              Add {{ selected().length }}
            </button>
          </div>
        }
      </div>

      <!-- Shared review template for Snap + Brain-dump results -->
      <ng-template #reviewTpl>
        <div class="fs-review-head">
          <p class="fs-section-label">Review — set a meal per item, uncheck anything wrong</p>
          @if (pane() === 'snap') {
            <button type="button" class="fs-morephotos" [disabled]="busy()" (click)="addMorePhotos()">
              <mat-icon aria-hidden="true">add_a_photo</mat-icon>{{ busy() ? 'Reading…' : 'Add photos' }}
            </button>
          }
        </div>
        <div class="fs-list">
          @for (r of review(); track r.key) {
            <div class="fs-rrow" [class.off]="!r.keep">
              <button type="button" class="fs-rcheck" (click)="toggleReview(r.key)"
                      [attr.aria-pressed]="r.keep"
                      [attr.aria-label]="(r.keep ? 'Exclude ' : 'Include ') + r.description">
                <mat-icon aria-hidden="true">{{ r.keep ? 'check_circle' : 'radio_button_unchecked' }}</mat-icon>
              </button>
              <div class="fs-rbody">
                <div class="fs-rtop">
                  <span class="fs-row-name">{{ r.description }}</span>
                  <span class="fs-row-kcal">{{ group(r.calories) }}<small>kcal</small></span>
                </div>
                <span class="fs-row-sub">P {{ group(r.proteinG) }} · C {{ group(r.carbG) }} · F {{ group(r.fatG) }}@if (r.photo) {<span class="fs-rphoto"> · photo {{ r.photo }}</span>}</span>
                <div class="fs-rmeal" role="group" [attr.aria-label]="'Meal for ' + r.description">
                  @for (m of MEALS; track m.value) {
                    <button type="button" class="fs-rmeal-chip" [class.on]="r.meal === m.value"
                            [attr.aria-pressed]="r.meal === m.value" [attr.aria-label]="m.label"
                            (click)="setReviewMeal(r.key, m.value)">{{ m.short }}</button>
                  }
                </div>
              </div>
            </div>
          }
        </div>
        <div class="fs-tally">
          <div class="fs-tally-info">
            <strong>{{ reviewKept().length }} to add</strong>
            <span class="fs-tally-macros">{{ group(reviewTally().calories) }} kcal@if (reviewMeals().length > 1) { · {{ reviewMeals().join(' · ') }} }</span>
          </div>
          <button type="button" class="fs-ghost" (click)="resetReview()">Start over</button>
          <button type="button" class="fs-add" [disabled]="opt.readOnly() || busy() || reviewKept().length === 0"
                  (click)="commitReview()">Add {{ reviewKept().length }}</button>
        </div>
      </ng-template>
    </app-bottom-sheet>
  `,
  styles: [`
    :host { display: contents; }

    .fs {
      display: flex; flex-direction: column; gap: 14px;
      padding-top: 4px; color: var(--ink);
    }

    /* ---- header: meal chips + fast lanes ---- */
    .fs-head { display: flex; flex-direction: column; gap: 12px; }
    .fs-meal { display: flex; gap: 8px; flex-wrap: wrap; }
    .fs-meal-chip {
      min-height: 36px; padding: 0 14px; border-radius: var(--r-pill);
      border: 1px solid var(--hairline); background: var(--bg-sink); color: var(--ink-dim);
      font: 500 13px var(--font-ui); cursor: pointer;
      transition: background 120ms var(--ease-out), color 120ms var(--ease-out);
    }
    .fs-meal-chip.on {
      background: color-mix(in srgb, var(--tech-accent, var(--cal-a)) 22%, transparent);
      border-color: color-mix(in srgb, var(--tech-accent, var(--cal-a)) 50%, transparent); color: var(--ink);
    }

    .fs-lanes { display: flex; gap: 8px; }
    .fs-lane {
      flex: 1 1 0; min-height: 44px; display: flex; align-items: center; justify-content: center;
      gap: 6px; border-radius: var(--r-tile); border: 1px solid var(--hairline);
      background: var(--bg-sink); color: var(--ink-dim); font: 500 13px var(--font-ui); cursor: pointer;
      transition: transform 120ms var(--ease-out), background 120ms var(--ease-out), color 120ms var(--ease-out);
    }
    .fs-lane mat-icon { font-size: 20px; width: 20px; height: 20px; }
    .fs-lane.on { background: var(--bg-rise); color: var(--ink); box-shadow: var(--lift-1); }
    .fs-lane:active { transform: scale(.97) translateY(1px); box-shadow: var(--press); }

    /* ---- search ---- */
    .fs-search {
      display: flex; align-items: center; gap: 8px; min-height: 48px;
      padding: 0 10px; border-radius: var(--r-tile); background: var(--bg-sink);
      box-shadow: var(--press); border: 1px solid var(--hairline);
    }
    .fs-search-icon { color: var(--ink-faint); font-size: 22px; width: 22px; height: 22px; }
    .fs-input {
      flex: 1 1 auto; min-width: 0; background: transparent; border: 0; outline: none;
      color: var(--ink); font: 400 15px var(--font-ui);
    }
    .fs-input::placeholder { color: var(--ink-faint); }
    .fs-clear {
      display: flex; align-items: center; justify-content: center; width: 36px; height: 36px;
      border: 0; background: transparent; color: var(--ink-faint); cursor: pointer; border-radius: var(--r-pill);
    }

    /* ---- list rows ---- */
    .fs-list { display: flex; flex-direction: column; gap: 6px; overscroll-behavior: contain; }
    .fs-section-label {
      margin: 4px 2px 0; font: 500 11px var(--font-ui); text-transform: uppercase;
      letter-spacing: .04em; color: var(--ink-dim);
    }
    .fs-empty { padding: 18px 4px; color: var(--ink-dim); font-size: 14px; text-align: center; }
    .fs-steer { padding: 10px 4px; color: var(--ink-dim); font-size: 14px; line-height: 1.45; }

    .fs-row {
      display: flex; align-items: center; gap: 10px; width: 100%; min-height: 56px;
      padding: 8px 12px; border-radius: var(--r-tile); border: 1px solid transparent;
      background: var(--bg-sink); color: var(--ink); text-align: left; cursor: pointer;
      transition: background 120ms var(--ease-out), border-color 120ms var(--ease-out);
    }
    .fs-row.on {
      background: color-mix(in srgb, var(--tech-accent, var(--cal-a)) 14%, var(--bg-sink));
      border-color: color-mix(in srgb, var(--tech-accent, var(--cal-a)) 45%, transparent);
    }
    .fs-row:active { box-shadow: var(--press); }
    .fs-check { display: flex; color: var(--ink-faint); }
    .fs-row.on .fs-check { color: var(--tech-accent, var(--cal-a)); }
    .fs-check mat-icon { font-size: 24px; width: 24px; height: 24px; }
    .fs-row-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .fs-row-name {
      font: 500 15px var(--font-ui); color: var(--ink);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .fs-row-sub {
      font: 400 12px var(--font-ui); color: var(--ink-faint);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .fs-row-kcal {
      flex: 0 0 auto; font: 600 16px var(--font-display); font-variant-numeric: tabular-nums;
      color: var(--ink); display: flex; align-items: baseline; gap: 3px;
    }
    .fs-row-kcal small { font: 500 10px var(--font-ui); text-transform: uppercase; color: var(--ink-faint); }

    /* ---- review rows (Snap + Brain): keep-toggle + per-item meal selector ---- */
    .fs-review-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .fs-morephotos {
      flex: 0 0 auto; display: inline-flex; align-items: center; gap: 5px;
      min-height: 34px; padding: 0 12px; border-radius: var(--r-pill);
      border: 1px solid var(--glass-edge); background: var(--bg-rise); color: var(--ink);
      font: 600 12.5px var(--font-ui); cursor: pointer;
      touch-action: manipulation; -webkit-tap-highlight-color: transparent;
    }
    .fs-morephotos mat-icon { font-size: 18px; width: 18px; height: 18px; }
    .fs-morephotos:active:not(:disabled) { transform: scale(.97); }
    .fs-morephotos:disabled { opacity: .5; cursor: default; }

    .fs-rrow {
      display: flex; align-items: flex-start; gap: 10px; width: 100%;
      padding: 10px 12px; border-radius: var(--r-tile); border: 1px solid transparent;
      background: color-mix(in srgb, var(--tech-accent, var(--cal-a)) 12%, var(--bg-sink));
      transition: opacity 120ms var(--ease-out), background 120ms var(--ease-out);
    }
    .fs-rrow.off { opacity: .55; background: var(--bg-sink); }
    .fs-rcheck {
      flex: 0 0 auto; display: flex; align-items: center; margin-top: 1px; padding: 2px;
      border: 0; background: transparent; color: var(--tech-accent, var(--cal-a)); cursor: pointer;
      -webkit-tap-highlight-color: transparent; touch-action: manipulation;
    }
    .fs-rrow.off .fs-rcheck { color: var(--ink-faint); }
    .fs-rcheck mat-icon { font-size: 24px; width: 24px; height: 24px; }
    .fs-rcheck:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; border-radius: 50%; }
    .fs-rbody { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
    .fs-rtop { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
    .fs-rphoto { color: var(--ink-faint); }

    /* Per-item meal segment (B/L/D/S) — full labels sit on the header chips just above. */
    .fs-rmeal { display: flex; gap: 4px; margin-top: 2px; }
    .fs-rmeal-chip {
      flex: 1 1 0; min-width: 0; min-height: 32px; padding: 0 4px;
      border-radius: var(--r-pill); border: 1px solid var(--glass-edge);
      background: var(--bg-rise); color: var(--ink-dim);
      font: 700 12px var(--font-ui); cursor: pointer;
      touch-action: manipulation; -webkit-tap-highlight-color: transparent;
      transition: background 120ms var(--ease-out), color 120ms var(--ease-out), border-color 120ms var(--ease-out);
    }
    .fs-rmeal-chip.on {
      background: linear-gradient(135deg, var(--cal-a), var(--cal-b));
      border-color: transparent; color: #fff;
    }
    .fs-rmeal-chip:active { transform: scale(.95); }
    .fs-rmeal-chip:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }

    /* ---- fast-lane pane fields ---- */
    .fs-pane { display: flex; flex-direction: column; gap: 12px; }
    .fs-field { display: flex; flex-direction: column; gap: 6px; }
    .fs-field-label {
      font: 500 11px var(--font-ui); text-transform: uppercase; letter-spacing: .04em; color: var(--ink-dim);
    }
    .fs-field .fs-input {
      min-height: 48px; padding: 0 12px; border-radius: var(--r-tile);
      background: var(--bg-sink); box-shadow: var(--press); border: 1px solid var(--hairline);
    }
    .fs-textarea { min-height: 84px; padding: 10px 12px; resize: vertical; line-height: 1.4; }

    .fs-go {
      display: flex; align-items: center; justify-content: center; gap: 8px; min-height: 48px;
      border: 0; border-radius: var(--r-tile); cursor: pointer;
      background: linear-gradient(135deg, var(--tech-accent, var(--cal-a)), var(--tech-accent-2, var(--cal-b))); color: #fff;
      font: 600 15px var(--font-ui);
      transition: transform 120ms var(--ease-out), filter 120ms var(--ease-out);
    }
    .fs-go mat-icon { font-size: 20px; width: 20px; height: 20px; }
    .fs-go:active:not(:disabled) { transform: scale(.98) translateY(1px); }
    .fs-go:disabled { opacity: .5; cursor: default; }

    /* ---- pinned tally / commit bar ---- */
    .fs-tally {
      position: sticky; bottom: 0; display: flex; align-items: center; gap: 12px;
      margin-top: 2px; padding: 12px; border-radius: var(--r-tile);
      background: var(--bg-rise); box-shadow: var(--lift-2); border: 1px solid var(--glass-edge);
    }
    .fs-tally-info { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
    .fs-tally-info strong { font: 600 15px var(--font-ui); color: var(--ink); }
    .fs-tally-macros {
      font: 500 12px var(--font-ui); color: var(--ink-dim); font-variant-numeric: tabular-nums;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .fs-add {
      flex: 0 0 auto; min-height: 44px; padding: 0 20px; border: 0; border-radius: var(--r-pill);
      background: linear-gradient(135deg, var(--tech-accent, var(--cal-a)), var(--tech-accent-2, var(--cal-b))); color: #fff;
      font: 600 15px var(--font-ui); cursor: pointer;
      transition: transform 120ms var(--ease-out), filter 120ms var(--ease-out);
    }
    .fs-add:active:not(:disabled) { transform: scale(.97) translateY(1px); }
    .fs-add:disabled { opacity: .5; cursor: default; }
    .fs-ghost {
      flex: 0 0 auto; min-height: 44px; padding: 0 14px; border: 1px solid var(--hairline);
      border-radius: var(--r-pill); background: transparent; color: var(--ink-dim);
      font: 500 14px var(--font-ui); cursor: pointer;
    }

    /* ---- skeletons ---- */
    .fs-skel {
      height: 56px; border-radius: var(--r-tile);
      background: linear-gradient(100deg, var(--bg-sink) 30%, var(--bg-rise) 50%, var(--bg-sink) 70%);
      background-size: 200% 100%; animation: fs-shimmer 1.4s var(--ease-out) infinite;
    }
    @keyframes fs-shimmer { to { background-position: -200% 0; } }
  `],
})
export class FoodSheet {
  protected readonly opt = inject(OptimisticTracker);
  private readonly store = inject(TrackerStore);
  private readonly api = inject(Api);
  private readonly snack = inject(MatSnackBar);

  /** Two-way open state, wired straight through to the BottomSheet. */
  readonly open = model<boolean>(false);

  protected readonly MEALS = MEALS;
  protected readonly group = group;

  // ---- view state ----
  protected readonly pane = signal<Pane>('list');
  protected readonly meal = signal<Meal>('breakfast');
  protected readonly busy = signal(false);

  // ---- search / list ----
  protected readonly query = signal('');
  protected readonly candidates = signal<Candidate[]>([]);
  protected readonly searchUnavailable = signal(false);
  /** True when the recents/saved load failed or timed out — drives a distinct (non-"empty") steer. */
  protected readonly recentsError = signal(false);
  /** Selected candidate rows, keyed for stable toggling across re-queries. */
  private readonly chosen = signal<Map<string, Candidate>>(new Map());
  protected readonly selected = computed(() => [...this.chosen().values()]);

  /** A debounce token + a request epoch so a slow earlier query never overwrites a newer one. */
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private queryEpoch = 0;

  // ---- fast lanes ----
  protected readonly barcode = signal('');
  protected readonly scanMsg = signal('');
  protected readonly snapMsg = signal('');
  protected readonly brainText = signal('');
  protected readonly brainMsg = signal('');
  /** Set when the active lane's provider is 503 (unconfigured) — shows a friendly steer in-pane. */
  protected readonly laneDown = signal('');
  /** Reviewable items produced by Snap / Brain (trimmed before commit). */
  protected readonly review = signal<ReviewItem[]>([]);
  /** The build-day idempotency id; required to commit the brain-dump draft. */
  private brainBuildId: string | null = null;

  constructor() {
    // Seed Recents + Favorites the first time the sheet opens, and whenever it re-opens stale.
    effect(() => {
      if (this.open() && this.pane() === 'list' && this.query().trim() === '') {
        void this.loadRecents();
      }
    });
  }

  // ---- running tally ----
  protected readonly tally = computed(() => this.sum(this.selected()));
  protected readonly reviewKept = computed(() => this.review().filter(r => r.keep));
  protected readonly reviewTally = computed(() => this.sum(this.reviewKept()));

  private sum(xs: { calories: number; proteinG: number; carbG: number; fatG: number }[]) {
    return xs.reduce((a, x) => ({
      calories: a.calories + x.calories, proteinG: a.proteinG + x.proteinG,
      carbG: a.carbG + x.carbG, fatG: a.fatG + x.fatG,
    }), { calories: 0, proteinG: 0, carbG: 0, fatG: 0 });
  }

  // ── lane switching ──────────────────────────────────────────────────────────

  protected togglePane(p: Exclude<Pane, 'list'>): void {
    this.laneDown.set('');
    this.scanMsg.set(''); this.snapMsg.set(''); this.brainMsg.set('');
    this.review.set([]); this.brainBuildId = null;
    this.pane.update(cur => (cur === p ? 'list' : p));
  }

  // ── list: search + recents ────────────────────────────────────────────────────

  private async loadRecents(): Promise<void> {
    // Only fetch when we have nothing to show (avoids re-hitting on every keystroke-clear).
    if (this.candidates().length > 0) return;
    this.busy.set(true);
    this.recentsError.set(false);
    try {
      // 8s timeout: if the saved/recents endpoint stalls, fall back to a usable state instead of leaving
      // the skeletons spinning forever (the sheet stays usable — you can still search + log).
      const saved = await firstValueFrom(this.api.savedFoods(undefined, true).pipe(timeout(8000)));
      this.candidates.set(saved.map(s => this.fromSaved(s)));
    } catch {
      this.candidates.set([]);
      this.recentsError.set(true);
    } finally {
      this.busy.set(false);
    }
  }

  protected onQuery(q: string): void {
    this.query.set(q);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    const trimmed = q.trim();
    if (trimmed === '') {
      // Back to recents/favorites; drop any stale search hits so the seed effect refills.
      this.candidates.set([]);
      this.searchUnavailable.set(false);
      this.recentsError.set(false);
      void this.loadRecents();
      return;
    }
    this.debounceTimer = setTimeout(() => void this.runSearch(trimmed), 280);
  }

  private async runSearch(q: string): Promise<void> {
    const epoch = ++this.queryEpoch;
    this.busy.set(true);
    this.searchUnavailable.set(false);
    try {
      const hits = await firstValueFrom(this.api.searchFoods({ q }));
      if (epoch !== this.queryEpoch) return; // a newer query superseded this one
      this.candidates.set(hits.map(h => this.fromSearch(h)));
    } catch (e) {
      if (epoch !== this.queryEpoch) return;
      if (e instanceof HttpErrorResponse && e.status === 503) this.searchUnavailable.set(true);
      this.candidates.set([]);
    } finally {
      if (epoch === this.queryEpoch) this.busy.set(false);
    }
  }

  // ── selection ──────────────────────────────────────────────────────────────

  protected isSelected(key: string): boolean {
    return this.chosen().has(key);
  }

  protected toggle(c: Candidate): void {
    const next = new Map(this.chosen());
    if (next.has(c.key)) next.delete(c.key); else next.set(c.key, c);
    this.chosen.set(next);
  }

  protected async commitSelected(): Promise<void> {
    const items = this.selected();
    if (items.length === 0 || this.opt.readOnly()) return;
    const bodies = items.map(c => this.toRequest(c));
    this.chosen.set(new Map()); // clear the tally optimistically; the batch handles its own retry/snackbar
    await this.opt.addFoods(bodies);
    this.open.set(false);
  }

  // ── SCAN ─────────────────────────────────────────────────────────────────────

  protected async runScan(): Promise<void> {
    const code = this.barcode().trim();
    if (!code || this.busy()) return;
    this.busy.set(true);
    this.scanMsg.set('');
    try {
      const hits = await firstValueFrom(this.api.searchFoods({ barcode: code }));
      if (hits.length === 0) {
        this.scanMsg.set('No product matched that barcode. Try searching by name instead.');
        return;
      }
      // Surface the matches into the multi-select list so the user confirms before logging.
      this.candidates.set(hits.map(h => this.fromSearch(h)));
      this.barcode.set('');
      this.pane.set('list');
    } catch (e) {
      if (e instanceof HttpErrorResponse && e.status === 503) {
        this.laneDown.set('Barcode lookup is offline right now — search for the food by name instead.');
      } else {
        this.scanMsg.set('Couldn’t look that up. Check the number and try again.');
      }
    } finally {
      this.busy.set(false);
    }
  }

  // ── SNAP ─────────────────────────────────────────────────────────────────────

  protected async runSnap(): Promise<void> {
    if (this.busy()) return;
    if (!(await confirmPhotoNotice())) return;
    let images;
    try {
      // Multi-select: the OS gallery lets the user attach SEVERAL photos at once (one spread, or different
      // meals). They can also add more in batches via "Add photos" in the review.
      images = await pickImages();
    } catch {
      this.snapMsg.set('Couldn’t read those images. Try different photos.');
      return;
    }
    if (images.length === 0) return; // user cancelled the picker
    await this.analyzePhotos(images, this.meal());
  }

  /** Add MORE photos to an in-progress snap review (appended to the existing items). */
  protected async addMorePhotos(): Promise<void> {
    if (this.busy()) return;
    let images;
    try {
      images = await pickImages();
    } catch {
      this.snapMsg.set('Couldn’t read those images. Try different photos.');
      return;
    }
    if (images.length === 0) return;
    // New photos default to the meal of the last reviewed item (keeps a multi-shot session coherent).
    const last = this.review();
    const defMeal = last.length > 0 ? last[last.length - 1].meal : this.meal();
    await this.analyzePhotos(images, defMeal, last.length);
  }

  /**
   * Analyze each photo through photo-meal IN PARALLEL and APPEND the recognized items to the review,
   * tagged with their source photo (1-based, continuing from `photoBase`) and defaulted to `defaultMeal`
   * (re-assignable per item). A single photo that fails is skipped; an all-503 batch steers to search.
   */
  private async analyzePhotos(images: { imageBase64: string; mimeType: string }[], defaultMeal: Meal, photoBase = 0): Promise<void> {
    this.busy.set(true);
    this.snapMsg.set('');
    let anyDown = false;
    try {
      const results = await Promise.all(images.map(img =>
        firstValueFrom(this.api.photoMeal(img)).catch((e: unknown) => {
          if (e instanceof HttpErrorResponse && e.status === 503) anyDown = true;
          return null;
        }),
      ));
      const fresh: ReviewItem[] = [];
      let i = this.review().length;
      results.forEach((res, idx) => {
        for (const m of res?.items ?? []) {
          fresh.push({ ...this.fromMealItem(m, `snap-${i++}`, defaultMeal), photo: photoBase + idx + 1 });
        }
      });
      if (fresh.length === 0) {
        if (this.review().length === 0) {
          this.snapMsg.set(anyDown
            ? 'Photo logging is offline right now — search for the food by name instead.'
            : 'No food recognized in those photos — try clearer shots or search by name.');
          if (anyDown) this.laneDown.set('Photo logging is offline right now — search for the food by name instead.');
        } else {
          this.snapMsg.set('Nothing new recognized in those photos.');
        }
        return;
      }
      this.review.update(rs => [...rs, ...fresh]);
    } catch {
      this.snapMsg.set('Couldn’t read those photos. Try again or search by name.');
    } finally {
      this.busy.set(false);
    }
  }

  // ── BRAIN-DUMP ─────────────────────────────────────────────────────────────────

  protected async runBrain(): Promise<void> {
    const text = this.brainText().trim();
    if (!text || this.busy()) return;
    this.busy.set(true);
    this.brainMsg.set('');
    try {
      const res = await firstValueFrom(this.api.buildDay({ text, date: this.opt.date() }));
      this.brainBuildId = res.buildId;
      // Flatten the drafted meals' food items — PRESERVING each item's meal (the day-builder already
      // splits "eggs for breakfast, a burrito for lunch" across meals), so the review lands pre-grouped
      // and the user just confirms. Falls back to the header meal if the draft omitted one.
      const items: ReviewItem[] = [];
      let i = 0;
      for (const m of res.draft.meals ?? []) {
        for (const f of m.items ?? []) {
          items.push({
            key: `brain-${i++}`, description: f.description,
            calories: f.calories, proteinG: f.proteinG, carbG: f.carbG, fatG: f.fatG, keep: true,
            meal: m.meal ?? this.meal(),
          });
        }
      }
      if (items.length === 0) {
        this.brainMsg.set('I couldn’t pull any food from that. Try naming the dishes and portions.');
        return;
      }
      this.review.set(items);
    } catch (e) {
      if (e instanceof HttpErrorResponse && e.status === 503) {
        this.laneDown.set('The AI day-builder is offline right now — add foods by search instead.');
      } else {
        this.brainMsg.set('Couldn’t draft that. Try again or add foods by search.');
      }
    } finally {
      this.busy.set(false);
    }
  }

  // ── review (Snap + Brain) ──────────────────────────────────────────────────────

  protected toggleReview(key: string): void {
    this.review.update(rs => rs.map(r => (r.key === key ? { ...r, keep: !r.keep } : r)));
  }

  /** Re-assign one reviewed item to a meal (so a single snap/brain batch can split across meals). */
  protected setReviewMeal(key: string, meal: Meal): void {
    this.review.update(rs => rs.map(r => (r.key === key ? { ...r, meal } : r)));
  }

  /** Distinct meals across the KEPT items — drives the "→ Breakfast · Lunch" hint on the Add button. */
  protected readonly reviewMeals = computed(() => {
    const set = new Set(this.reviewKept().map(r => r.meal));
    return MEALS.filter(m => set.has(m.value)).map(m => m.label);
  });

  protected resetReview(): void {
    this.review.set([]);
    this.brainBuildId = null;
  }

  protected async commitReview(): Promise<void> {
    const kept = this.reviewKept();
    if (kept.length === 0 || this.opt.readOnly() || this.busy()) return;

    // Brain-dump drafts MUST commit through bulkCommitDay (server holds the buildId draft); Snap items
    // are free-standing food rows → the optimistic addFoods batch (instant ring tick + reconcile).
    if (this.pane() === 'brain' && this.brainBuildId) {
      this.busy.set(true);
      try {
        const draft = this.buildCommitDraft(kept);
        await firstValueFrom(this.api.bulkCommitDay({
          buildId: this.brainBuildId, date: this.opt.date(), draft,
        }));
        // The commit rebuilt the authoritative day server-side; pull it back into the shared store.
        await this.refreshDay();
        this.snack.open(`Added ${kept.length} food${kept.length === 1 ? '' : 's'}`, 'OK',
          { duration: 3000, politeness: 'polite' });
        this.resetReview();
        this.open.set(false);
      } catch {
        this.brainMsg.set('Couldn’t save that. Try again.');
      } finally {
        this.busy.set(false);
      }
      return;
    }

    const bodies = kept.map(r => ({
      date: this.opt.date(), meal: r.meal, description: r.description,
      quantity: 1, calories: r.calories, proteinG: r.proteinG, carbG: r.carbG, fatG: r.fatG,
      source: 'custom',
    } satisfies AddFoodRequest));
    this.resetReview();
    await this.opt.addFoods(bodies);
    this.open.set(false);
  }

  /**
   * Assemble the CommitDayRequest draft from the kept review items. Brain-dump is a FOOD-only flow here,
   * so only the chosen meal's items are committed; the other day domains are left empty (the user adds
   * exercise / water / weight from their own sheets).
   */
  private buildCommitDraft(kept: ReviewItem[]) {
    // Group the kept items by their (re-assignable) meal so a single brain-dump can land across
    // breakfast/lunch/dinner/snack — one draft meal entry per distinct meal, in canonical order.
    const draftItem = (r: ReviewItem) => ({
      description: r.description, calories: r.calories, proteinG: r.proteinG,
      carbG: r.carbG, fatG: r.fatG, confidence: 1, clamped: false,
    });
    const meals = MEALS
      .map(m => ({ meal: m.value, items: kept.filter(r => r.meal === m.value).map(draftItem) }))
      .filter(g => g.items.length > 0);
    return {
      meals,
      exercises: [], hydration: [], weight: null, activity: null,
      assumptions: [], summary: '',
    };
  }

  /** Pull the authoritative day back into the shared store after a server-side commit. */
  private async refreshDay(): Promise<void> {
    // bulkCommitDay rebuilt the day server-side; the store's load() re-syncs the shared day() signal.
    await this.store.load();
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  protected onClosed(): void {
    // Reset transient lane state so a re-open starts clean (keep the chosen meal + recents cache).
    this.pane.set('list');
    this.query.set('');
    this.chosen.set(new Map());
    this.review.set([]);
    this.brainBuildId = null;
    this.barcode.set('');
    this.brainText.set('');
    this.scanMsg.set(''); this.snapMsg.set(''); this.brainMsg.set(''); this.laneDown.set('');
  }

  // ── mappers ──────────────────────────────────────────────────────────────────

  private fromSaved(s: CustomFoodDto): Candidate {
    return {
      key: `saved-${s.isRecent ? 'r' : 's'}-${s.id}-${s.description}-${s.brand ?? ''}`,
      description: s.description, brand: s.brand, servingDesc: s.servingDesc,
      calories: s.calories, proteinG: s.proteinG, carbG: s.carbG, fatG: s.fatG,
      source: 'custom', isRecent: s.isRecent,
    };
  }

  private fromSearch(h: FoodSearchItemDto): Candidate {
    const serving = h.servingSize != null
      ? `${h.servingSize}${h.servingUnit ? ' ' + h.servingUnit : ''}` : undefined;
    return {
      key: `search-${h.source}-${h.fdcId}`,
      description: h.description, brand: h.brand, servingDesc: serving,
      calories: h.calories, proteinG: h.proteinG, carbG: h.carbG, fatG: h.fatG,
      source: h.source, fdcId: h.fdcId,
    };
  }

  private fromMealItem(m: MealItemDto, key: string, meal: Meal): ReviewItem {
    // NOTE: MealItemDto uses `carbsG` (USDA-style), our entries use `carbG`.
    return {
      key, description: m.description, calories: m.calories,
      proteinG: m.proteinG, carbG: m.carbsG, fatG: m.fatG, keep: true, meal,
    };
  }

  private toRequest(c: Candidate): AddFoodRequest {
    return {
      date: this.opt.date(), meal: this.meal(), fdcId: c.fdcId, description: c.description,
      brand: c.brand, quantity: 1, servingDesc: c.servingDesc,
      calories: c.calories, proteinG: c.proteinG, carbG: c.carbG, fatG: c.fatG,
      source: c.source,
    };
  }
}
