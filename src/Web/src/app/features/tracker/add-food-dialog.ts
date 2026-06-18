import { Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { Subject, debounceTime, distinctUntilChanged, switchMap, of, catchError } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';

import { Api } from '../../core/api';
import { AddFoodRequest, FoodSearchItemDto, Meal } from '../../core/models';
import { BarcodeScanner } from './barcode-scanner';

/** What the dialog opens with: the active day + which meal section the user tapped "Add food" on. */
export interface AddFoodData {
  date: string;
  meal: Meal;
}

/** Which sub-panel of the add-food flow is showing. */
type Mode = 'search' | 'scan';

const MEALS: { value: Meal; label: string }[] = [
  { value: 'breakfast', label: 'Breakfast' },
  { value: 'lunch', label: 'Lunch' },
  { value: 'dinner', label: 'Dinner' },
  { value: 'snack', label: 'Snacks' },
];

/**
 * Add-food dialog. Three ways in: a debounced USDA name search, a live barcode scan (native
 * BarcodeDetector or a lazily-loaded @zxing fallback) that prefills from a UPC lookup, and a manual
 * entry escape hatch (always available; the only path when USDA is unconfigured → 503). Once a food is
 * picked the user sets a quantity (servings or grams, scaled by `basis`) and a target meal; the dialog
 * snapshots the scaled calories/macros into an {@link AddFoodRequest} and resolves with it.
 */
@Component({
  selector: 'app-add-food-dialog',
  imports: [
    FormsModule, MatDialogModule, MatFormFieldModule, MatInputModule, MatButtonModule,
    MatButtonToggleModule, MatIconModule, MatProgressBarModule, BarcodeScanner,
  ],
  templateUrl: './add-food-dialog.html',
  styleUrl: './add-food-dialog.scss',
})
export class AddFoodDialog {
  private api = inject(Api);
  private ref = inject(MatDialogRef<AddFoodDialog, AddFoodRequest>);
  readonly data = inject<AddFoodData>(MAT_DIALOG_DATA);

  readonly meals = MEALS;
  readonly mode = signal<Mode>('search');

  // ---- search ----
  readonly query = signal('');
  readonly searching = signal(false);
  readonly results = signal<FoodSearchItemDto[]>([]);
  /** True once a search came back 503 — USDA isn't configured; steer to manual entry. */
  readonly searchUnavailable = signal(false);
  readonly searchError = signal<string | null>(null);
  private readonly queryStream = new Subject<string>();

  // ---- selection / quantity ----
  readonly selected = signal<FoodSearchItemDto | null>(null);
  /** "manual" === a hand-entered food (no FDC id); the form fields below drive the snapshot. */
  readonly manual = signal(false);
  readonly meal = signal<Meal>(this.data.meal);
  readonly quantity = signal(1);

  // ---- manual-entry fields ----
  readonly mDesc = signal('');
  readonly mBrand = signal('');
  readonly mCalories = signal<number | null>(null);
  readonly mProtein = signal<number | null>(null);
  readonly mCarb = signal<number | null>(null);
  readonly mFat = signal<number | null>(null);

  readonly saving = signal(false);
  readonly saveError = signal<string | null>(null);

  /** Unit hint for the quantity field, driven by the selected food's basis. */
  readonly quantityUnit = computed(() => this.selected()?.basis === 'per100g' ? 'grams' : 'servings');

  /**
   * The scaled calories/macros for the current selection + quantity. perServing scales by the serving
   * count; per100g scales grams ÷ 100. Manual entries are taken verbatim (no scaling — the user typed
   * the totals they want logged).
   */
  readonly scaled = computed(() => {
    if (this.manual()) {
      return {
        calories: this.mCalories() ?? 0,
        proteinG: this.mProtein() ?? 0,
        carbG: this.mCarb() ?? 0,
        fatG: this.mFat() ?? 0,
      };
    }
    const f = this.selected();
    const q = this.quantity();
    if (!f || !(q > 0)) return { calories: 0, proteinG: 0, carbG: 0, fatG: 0 };
    const factor = f.basis === 'per100g' ? q / 100 : q;
    const round = (n: number) => Math.round(n * factor * 10) / 10;
    return {
      calories: Math.round(f.calories * factor),
      proteinG: round(f.proteinG),
      carbG: round(f.carbG),
      fatG: round(f.fatG),
    };
  });

  /** A short human serving description for the entry ("2 servings" / "150 grams"). */
  readonly servingDesc = computed(() => {
    if (this.manual()) return undefined;
    const f = this.selected();
    if (!f) return undefined;
    const unit = f.basis === 'per100g' ? 'g' : (this.quantity() === 1 ? 'serving' : 'servings');
    const sizeNote = f.servingSize && f.servingUnit ? ` (${f.servingSize}${f.servingUnit})` : '';
    return `${this.quantity()} ${unit}${f.basis === 'per100g' ? '' : sizeNote}`;
  });

  readonly canSave = computed(() => {
    if (this.saving()) return false;
    if (this.manual()) return this.mDesc().trim().length > 0 && (this.mCalories() ?? 0) >= 0 && this.mCalories() != null;
    return !!this.selected() && this.quantity() > 0;
  });

  constructor() {
    // Debounced USDA name search; a 503 flips to the manual-entry steer.
    this.queryStream.pipe(
      debounceTime(300),
      distinctUntilChanged(),
      switchMap(q => {
        const term = q.trim();
        if (term.length < 2) { this.searching.set(false); return of<FoodSearchItemDto[] | null>([]); }
        this.searching.set(true);
        this.searchError.set(null);
        return this.api.searchFoods({ q: term }).pipe(
          catchError((e: HttpErrorResponse) => {
            this.searching.set(false);
            if (e.status === 503) { this.searchUnavailable.set(true); }
            else { this.searchError.set('Food search failed. Try again, or enter the food manually.'); }
            return of<FoodSearchItemDto[] | null>(null);
          }),
        );
      }),
      takeUntilDestroyed(),
    ).subscribe(list => {
      this.searching.set(false);
      if (list) { this.results.set(list); }
    });

    // Keep the query stream fed from the signal.
    effect(() => this.queryStream.next(this.query()));
  }

  setMode(m: Mode): void {
    this.mode.set(m);
    this.saveError.set(null);
  }

  /** Pick a search/scan result → move to the quantity step. */
  pick(food: FoodSearchItemDto): void {
    this.manual.set(false);
    this.selected.set(food);
    this.quantity.set(food.basis === 'per100g' ? (food.servingSize ?? 100) : 1);
  }

  /** Start a fresh manual entry (used by the "enter manually" affordances). */
  startManual(): void {
    this.manual.set(true);
    this.selected.set(null);
    this.mode.set('search');
  }

  /** Drop the current selection and go back to searching. */
  clearSelection(): void {
    this.selected.set(null);
    this.manual.set(false);
  }

  /** A scanned/typed barcode → look it up; prefill on a hit, else steer to manual. */
  onBarcode(code: string): void {
    this.searching.set(true);
    this.searchError.set(null);
    this.api.searchFoods({ barcode: code }).pipe(
      catchError((e: HttpErrorResponse) => {
        if (e.status === 503) this.searchUnavailable.set(true);
        return of<FoodSearchItemDto[] | null>(null);
      }),
    ).subscribe(list => {
      this.searching.set(false);
      this.mode.set('search');
      if (list && list.length > 0) {
        this.pick(list[0]);
      } else {
        this.searchError.set(`No product found for ${code}. Try a name search or enter it manually.`);
        this.startManual();
        this.mDesc.set('');
      }
    });
  }

  basisLabel(f: FoodSearchItemDto): string {
    return f.basis === 'per100g' ? 'per 100 g' : 'per serving';
  }

  save(): void {
    if (!this.canSave()) return;
    const s = this.scaled();
    const f = this.selected();
    const body: AddFoodRequest = {
      date: this.data.date,
      meal: this.meal(),
      fdcId: this.manual() ? undefined : f?.fdcId,
      description: this.manual() ? this.mDesc().trim() : (f?.description ?? ''),
      brand: this.manual() ? (this.mBrand().trim() || undefined) : f?.brand,
      quantity: this.manual() ? 1 : this.quantity(),
      servingDesc: this.servingDesc(),
      calories: s.calories,
      proteinG: s.proteinG,
      carbG: s.carbG,
      fatG: s.fatG,
    };
    // Resolve with the request; the page persists it through the store and refreshes the day.
    this.ref.close(body);
  }

  cancel(): void {
    this.ref.close();
  }
}
