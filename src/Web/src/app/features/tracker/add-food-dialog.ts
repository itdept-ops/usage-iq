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
import { AddFoodRequest, CustomFoodDto, FoodSearchItemDto, Meal } from '../../core/models';
import { BarcodeScanner } from './barcode-scanner';

/** What the dialog opens with: the active day + which meal section the user tapped "Add food" on. */
export interface AddFoodData {
  date: string;
  meal: Meal;
}

/** Which sub-panel of the add-food flow is showing. */
type Mode = 'search' | 'scan' | 'saved';

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

  /**
   * The barcode (scanned or typed) whose lookup returned NO product, or null. Drives a distinct
   * "not found" notice in the scan panel — explicitly different from the idle/scanning state and from
   * an empty name-search — with affordances to switch to a name search or to manual entry.
   */
  readonly barcodeNotFound = signal<string | null>(null);

  // ---- "My foods" (per-user saved library) ----
  readonly savedQuery = signal('');
  readonly savedLoading = signal(false);
  readonly saved = signal<CustomFoodDto[]>([]);
  private readonly savedQueryStream = new Subject<string>();
  private savedLoadedOnce = false;

  // ---- selection / quantity ----
  readonly selected = signal<FoodSearchItemDto | null>(null);
  /**
   * Provider the current selection came from ("usda" | "fatsecret" | "custom"), or null for a manual
   * entry. Carried into the log request so the backend knows whether to auto-save / bump a saved food.
   */
  readonly selectedSource = signal<string | null>(null);
  /** "manual" === a hand-entered food (no FDC id); the form fields below drive the snapshot. */
  readonly manual = signal(false);
  readonly meal = signal<Meal>(this.data.meal);
  readonly quantity = signal(1);

  /** The original serving text of a picked saved food (preserved verbatim at quantity 1). */
  readonly pickedServingDesc = signal<string | undefined>(undefined);

  // ---- manual-entry fields ----
  readonly mDesc = signal('');
  readonly mBrand = signal('');
  readonly mCalories = signal<number | null>(null);
  readonly mProtein = signal<number | null>(null);
  readonly mCarb = signal<number | null>(null);
  readonly mFat = signal<number | null>(null);

  readonly saving = signal(false);
  readonly saveError = signal<string | null>(null);

  /** Unit hint for the quantity field, driven by the selected food's basis (manual = servings). */
  readonly quantityUnit = computed(() =>
    !this.manual() && this.selected()?.basis === 'per100g' ? 'grams' : 'servings');

  /**
   * The scaled calories/macros for the current selection/manual entry + quantity. A picked food's
   * perServing scales by the serving count, per100g by grams ÷ 100. A MANUAL entry's calories/macros
   * are PER ONE serving and scale by the quantity — exactly like the picked-food path — so the logged
   * total matches what the user sees here.
   */
  readonly scaled = computed(() => {
    const q = this.quantity();
    if (this.manual()) {
      if (!(q > 0)) return { calories: 0, proteinG: 0, carbG: 0, fatG: 0 };
      const round = (n: number | null) => Math.round((n ?? 0) * q * 10) / 10;
      return {
        calories: Math.round((this.mCalories() ?? 0) * q),
        proteinG: round(this.mProtein()),
        carbG: round(this.mCarb()),
        fatG: round(this.mFat()),
      };
    }
    const f = this.selected();
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
    if (this.manual()) {
      const q = this.quantity();
      return `${q} ${q === 1 ? 'serving' : 'servings'}`;
    }
    const f = this.selected();
    if (!f) return undefined;
    // A re-picked saved food at quantity 1 keeps its original serving text verbatim.
    const orig = this.pickedServingDesc();
    if (orig && this.quantity() === 1) return orig;
    const unit = f.basis === 'per100g' ? 'g' : (this.quantity() === 1 ? 'serving' : 'servings');
    const sizeNote = f.servingSize && f.servingUnit ? ` (${f.servingSize}${f.servingUnit})` : '';
    return `${this.quantity()} ${unit}${f.basis === 'per100g' ? '' : sizeNote}`;
  });

  readonly canSave = computed(() => {
    if (this.saving()) return false;
    if (this.manual()) {
      return this.mDesc().trim().length > 0 && this.mCalories() != null
        && (this.mCalories() ?? 0) >= 0 && this.quantity() > 0;
    }
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

    // Debounced "My foods" filter — re-fetches the caller's saved library on each keystroke.
    this.savedQueryStream.pipe(
      debounceTime(250),
      distinctUntilChanged(),
      switchMap(q => {
        this.savedLoading.set(true);
        return this.api.savedFoods(q.trim() || undefined).pipe(
          catchError(() => of<CustomFoodDto[]>([])),
        );
      }),
      takeUntilDestroyed(),
    ).subscribe(list => {
      this.savedLoading.set(false);
      this.saved.set(list);
    });

    effect(() => this.savedQueryStream.next(this.savedQuery()));
  }

  setMode(m: Mode): void {
    this.mode.set(m);
    this.saveError.set(null);
    this.barcodeNotFound.set(null);
    // Lazy-load the saved library the first time the "My foods" tab is opened.
    if (m === 'saved' && !this.savedLoadedOnce) {
      this.savedLoadedOnce = true;
      this.savedQueryStream.next(this.savedQuery());
    }
  }

  /** Pick a search/scan result → move to the quantity step, carrying its provider source. */
  pick(food: FoodSearchItemDto): void {
    this.manual.set(false);
    this.pickedServingDesc.set(undefined);
    this.selectedSource.set(food.source || null);
    this.selected.set(food);
    this.quantity.set(food.basis === 'per100g' ? (food.servingSize ?? 100) : 1);
  }

  /** Pick a saved "My foods" entry → quantity step (source="custom" so the backend bumps its use count). */
  pickSaved(food: CustomFoodDto): void {
    this.manual.set(false);
    this.pickedServingDesc.set(food.servingDesc || undefined);
    this.selectedSource.set('custom');
    this.selected.set({
      fdcId: 0,
      description: food.description,
      brand: food.brand,
      calories: food.calories,
      proteinG: food.proteinG,
      carbG: food.carbG,
      fatG: food.fatG,
      basis: 'perServing',
      source: 'custom',
      sourceId: String(food.id),
    });
    this.quantity.set(1);
  }

  /** Remove a saved food from the caller's library (× on a "My foods" row). */
  deleteSaved(food: CustomFoodDto, ev: Event): void {
    ev.stopPropagation();
    this.saved.update(list => list.filter(f => f.id !== food.id));
    this.api.deleteSavedFood(food.id).subscribe({ error: () => this.savedQueryStream.next(this.savedQuery()) });
  }

  /** Start a fresh manual entry (used by the "enter manually" affordances). */
  startManual(): void {
    this.manual.set(true);
    this.selected.set(null);
    this.selectedSource.set(null);
    this.pickedServingDesc.set(undefined);
    this.barcodeNotFound.set(null);
    this.quantity.set(1);
    this.mode.set('search');
  }

  /** Drop the current selection and go back to searching. */
  clearSelection(): void {
    this.selected.set(null);
    this.selectedSource.set(null);
    this.pickedServingDesc.set(undefined);
    this.manual.set(false);
  }

  /**
   * A scanned/typed barcode → look it up. On a hit, prefill the quantity step. On NO match (neither
   * provider matched, not a 503), stay on the scan panel and raise a distinct {@link barcodeNotFound}
   * notice with affordances to switch to name search or manual entry — never silently show nothing.
   */
  onBarcode(code: string): void {
    this.searching.set(true);
    this.searchError.set(null);
    this.barcodeNotFound.set(null);
    this.api.searchFoods({ barcode: code }).pipe(
      catchError((e: HttpErrorResponse) => {
        if (e.status === 503) this.searchUnavailable.set(true);
        return of<FoodSearchItemDto[] | null>(null);
      }),
    ).subscribe(list => {
      this.searching.set(false);
      if (list && list.length > 0) {
        this.mode.set('search');
        this.pick(list[0]);
      } else if (this.searchUnavailable()) {
        // Lookup unavailable (503) — fall back to the existing "search isn't configured" steer.
        this.mode.set('search');
      } else {
        // A genuine empty barcode lookup: surface the explicit not-found notice (stays on scan).
        this.barcodeNotFound.set(code);
      }
    });
  }

  /** Switch from the barcode not-found notice to a fresh name search. */
  searchByName(): void {
    this.barcodeNotFound.set(null);
    this.query.set('');
    this.mode.set('search');
  }

  basisLabel(f: FoodSearchItemDto): string {
    return f.basis === 'per100g' ? 'per 100 g' : 'per serving';
  }

  save(): void {
    if (!this.canSave()) return;
    const s = this.scaled();
    const f = this.selected();
    const src = this.manual() ? null : this.selectedSource();
    const body: AddFoodRequest = {
      date: this.data.date,
      meal: this.meal(),
      // Only USDA hits carry a real FDC id; FatSecret/custom/manual logs leave it unset.
      fdcId: (!this.manual() && src === 'usda') ? f?.fdcId : undefined,
      description: this.manual() ? this.mDesc().trim() : (f?.description ?? ''),
      brand: this.manual() ? (this.mBrand().trim() || undefined) : f?.brand,
      quantity: this.quantity(),
      servingDesc: this.servingDesc(),
      calories: s.calories,
      proteinG: s.proteinG,
      carbG: s.carbG,
      fatG: s.fatG,
      // Manual entries send NO source so the backend auto-saves them to "My foods".
      source: src ?? undefined,
    };
    // Resolve with the request; the page persists it through the store and refreshes the day.
    this.ref.close(body);
  }

  cancel(): void {
    this.ref.close();
  }
}
