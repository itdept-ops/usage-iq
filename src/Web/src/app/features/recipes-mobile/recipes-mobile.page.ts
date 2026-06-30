import {
  ChangeDetectionStrategy, Component, computed, inject, signal,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { MatIconModule } from '@angular/material/icon';

import { Api } from '../../core/api';
import { Recipe, RecipeUpsertRequest, SavedRecipeIngredient } from '../../core/models';
import {
  BetaPullRefresh, BetaSegmentedControl, BetaBottomSheet, BetaSwipeRow, BetaSkeleton,
  BetaFab, BetaToaster, ToastController, type Segment,
} from '../beta-ui';

/** One editable ingredient row — a stable key keeps @for tracking + inputs stable while typing. */
interface IngredientRow {
  key: number;
  name: string;
  quantity: string;
}

/**
 * Recipes "Cookbook" — the mobile-first twin of the live /recipes Tool, rebuilt on the shared beta-ui
 * "Strata" kit (`@use '../beta-ui/beta-kit'`). One signature accent — a warm SAFFRON → PAPRIKA — re-skins
 * the whole screen via the per-page accent contract. An immersive scrolling header (an accent bloom + a
 * little kcal/recipe-count stat strip), a {@link BetaSegmentedControl} flipping the list between the
 * caller's OWN recipes and "Shared with me", a list of glassy recipe cards (each a {@link BetaSwipeRow}
 * on owned rows: swipe left to delete, right to edit), a {@link BetaBottomSheet} DETAIL (per-serving
 * macros, ingredients, ordered steps, notes + the share toggle on owned recipes), a second sheet that is
 * the ADD/EDIT FORM, and a {@link BetaFab} to create. Pull-to-refresh, skeleton loaders, and elevated
 * empty/error states round it out.
 *
 * DATA PARITY + PRIVACY: every recipe comes straight from the SAME owner-scoped, share-gated
 * `/api/recipes` endpoints the live page uses — {@link Api.recipes} (own, newest-first), {@link
 * Api.recipesSharedWithMe} (read-only shares; owner DISPLAY NAME only — never an email). Writes go through
 * {@link Api.createRecipe} / {@link Api.updateRecipe} / {@link Api.setRecipeShare} / {@link
 * Api.deleteRecipe} VERBATIM; the upsert body is built exactly like the live editor dialog. The server
 * enforces all ownership + visibility, so the UI only ever offers edit/delete/share on rows the server
 * returned as `owned: true`.
 *
 * ISOLATION: gated by `platform.mobile` + the SAME `recipes.use` the live /recipes route carries; it
 * consumes the kit + the SAME Api as the live counterpart. No live page is imported or modified. Layout
 * is mobile-first (44px targets, safe-area insets, no 390px overflow) and centers on desktop; reduced
 * motion collapses the kit animations via the a11y killswitch.
 */
@Component({
  selector: 'app-recipes-mobile',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [ToastController],
  imports: [
    DecimalPipe, FormsModule, MatIconModule,
    BetaPullRefresh, BetaSegmentedControl, BetaBottomSheet, BetaSwipeRow, BetaSkeleton,
    BetaFab, BetaToaster,
  ],
  template: `
    <!-- ─────────────── PULL-TO-REFRESH OWNS THE SCROLL ─────────────── -->
    <app-bs-pull-refresh class="rc-ptr" [busy]="refreshing()" (refresh)="reload()">
      <div class="rc-scroll" aria-live="polite">

        <!-- ─── IMMERSIVE HEADER: title + accent bloom + a tiny stat strip ─── -->
        <header class="rc-hero">
          <p class="rc-hero__kicker"><mat-icon aria-hidden="true">menu_book</mat-icon> Cookbook</p>
          <h1 class="rc-hero__title">My Recipes</h1>
          <p class="rc-hero__sub">Your recipes with macros — share read-only with contacts.</p>

          @if (!loading() && !errored()) {
            <div class="rc-stats">
              <div class="rc-stat">
                <span class="rc-stat__n mono-num">{{ mineCount() }}</span>
                <span class="rc-stat__l">{{ mineCount() === 1 ? 'recipe' : 'recipes' }}</span>
              </div>
              <div class="rc-stat">
                <span class="rc-stat__n mono-num">{{ sharedCount() }}</span>
                <span class="rc-stat__l">shared with you</span>
              </div>
              @if (sharedByMeCount(); as sb) {
                <div class="rc-stat">
                  <span class="rc-stat__n mono-num">{{ sb }}</span>
                  <span class="rc-stat__l">you share</span>
                </div>
              }
            </div>
          }
        </header>

        @if (loading()) {
          <!-- skeleton list -->
          <div class="rc-seg-wrap" aria-hidden="true">
            <app-bs-skeleton width="100%" height="44px" radius="var(--r-pill)" />
          </div>
          <div class="rc-list" aria-hidden="true">
            @for (n of skeletonCells; track n) {
              <app-bs-skeleton height="92px" radius="var(--r-tile)" />
            }
          </div>

        } @else if (errored()) {
          <div class="rc-state">
            <span class="rc-state__orb"><mat-icon aria-hidden="true">cloud_off</mat-icon></span>
            <h2 class="rc-state__title">Couldn't load your recipes</h2>
            <p class="rc-state__body">Something went wrong fetching your cookbook. Give it another go.</p>
            <button type="button" class="rc-state__cta" (click)="reload()">
              <mat-icon aria-hidden="true">refresh</mat-icon> Try again
            </button>
          </div>

        } @else {
          <!-- ─── TAB SWITCH: Mine | Shared ─── -->
          <div class="rc-seg-wrap">
            <app-bs-segmented class="rc-seg"
              [segments]="tabSegments()" [value]="tab()" label="Show recipes"
              (change)="setTab($event)" />
          </div>

          @if (activeList(); as list) {
            @if (list.length) {
              <div class="rc-list">
                @for (r of list; track r.id; let i = $index) {
                  @if (r.owned) {
                    <!-- OWNED: swipe left to delete, right to edit -->
                    <app-bs-swipe-row class="rc-swipe rc-reveal" [id]="'recipe-' + r.id" [style.--ri]="i"
                      leftLabel="Delete" rightLabel="Edit" [disabled]="isBusy(r.id)"
                      [label]="r.title"
                      (swipe)="onSwipe(r, $event)">
                      <button type="button" class="rc-card" (click)="openDetail(r)"
                              [class.is-busy]="isBusy(r.id)"
                              [attr.aria-label]="cardAria(r)">
                        <span class="rc-card__glyph" aria-hidden="true"><mat-icon>restaurant</mat-icon></span>
                        <span class="rc-card__body">
                          <span class="rc-card__title">{{ r.title }}</span>
                          <span class="rc-card__meta">
                            <span class="mono-num">{{ r.servings }}</span> serving{{ r.servings === 1 ? '' : 's' }}
                            · <span class="mono-num">{{ r.calories | number }}</span> kcal
                            @if (r.ingredients.length) {
                              · <span class="mono-num">{{ r.ingredients.length }}</span> ingr.
                            }
                          </span>
                        </span>
                        @if (r.shareWithContacts) {
                          <span class="rc-card__share" aria-hidden="true"
                                title="Shared with your contacts"><mat-icon>group</mat-icon></span>
                        }
                        <mat-icon class="rc-card__go" aria-hidden="true">chevron_right</mat-icon>
                      </button>
                    </app-bs-swipe-row>
                  } @else {
                    <!-- SHARED-WITH-ME: read-only, tap for detail -->
                    <button type="button" class="rc-card rc-card--shared rc-reveal"
                            [id]="'recipe-' + r.id" [style.--ri]="i"
                            (click)="openDetail(r)" [attr.aria-label]="cardAria(r)">
                      <span class="rc-card__glyph" aria-hidden="true"><mat-icon>restaurant</mat-icon></span>
                      <span class="rc-card__body">
                        <span class="rc-card__title">{{ r.title }}</span>
                        <span class="rc-card__meta">
                          @if (r.ownerName) {
                            <mat-icon class="rc-card__owner-ic" aria-hidden="true">person</mat-icon>{{ r.ownerName }} ·
                          }
                          <span class="mono-num">{{ r.calories | number }}</span> kcal
                        </span>
                      </span>
                      <mat-icon class="rc-card__go" aria-hidden="true">chevron_right</mat-icon>
                    </button>
                  }
                }
              </div>

              @if (tab() === 'mine') {
                <p class="rc-foot" aria-hidden="true">Swipe a recipe left to delete · right to edit</p>
              }

            } @else {
              <!-- EMPTY for the active tab -->
              <div class="rc-empty">
                <span class="rc-empty__orb">
                  <mat-icon aria-hidden="true">{{ tab() === 'mine' ? 'restaurant_menu' : 'group' }}</mat-icon>
                </span>
                @if (tab() === 'mine') {
                  <h2 class="rc-empty__title">No recipes yet</h2>
                  <p class="rc-empty__body">Tap the + to save your first go-to recipe.</p>
                  <button type="button" class="rc-empty__cta" (click)="openCreate()">
                    <mat-icon aria-hidden="true">add</mat-icon> New recipe
                  </button>
                } @else {
                  <h2 class="rc-empty__title">Nothing shared with you</h2>
                  <p class="rc-empty__body">When a mutual contact shares a recipe, it shows up here read-only.</p>
                }
              </div>
            }
          }
        }
      </div>
    </app-bs-pull-refresh>

    <!-- ─── CREATE FAB (only on the "mine" tab) ─── -->
    @if (!loading() && !errored() && tab() === 'mine') {
      <app-bs-fab icon="add" label="New recipe" [extended]="true" [fixed]="true" (action)="openCreate()" />
    }

    <!-- ─────────────── DETAIL BOTTOM SHEET ─────────────── -->
    <app-bs-sheet [(open)]="detailOpen" detent="half" [label]="selected()?.title || 'Recipe detail'">
      @if (selected(); as r) {
        <div class="rd">
          <div class="rd__head">
            <span class="rd__glyph" aria-hidden="true"><mat-icon>restaurant</mat-icon></span>
            <div class="rd__titles">
              <h3 class="rd__title">{{ r.title }}</h3>
              <span class="rd__sub">
                @if (!r.owned && r.ownerName) {
                  <mat-icon aria-hidden="true">person</mat-icon> Shared by {{ r.ownerName }}
                } @else {
                  <mat-icon aria-hidden="true">restaurant</mat-icon>
                  {{ r.servings }} serving{{ r.servings === 1 ? '' : 's' }}
                }
              </span>
            </div>
          </div>

          <!-- per-serving macros -->
          <div class="rd__macros">
            <div class="rd__macro"><span class="rd__macro-n mono-num">{{ r.calories | number }}</span><span class="rd__macro-l">kcal</span></div>
            <div class="rd__macro"><span class="rd__macro-n mono-num">{{ r.proteinG | number:'1.0-0' }}</span><span class="rd__macro-l">protein</span></div>
            <div class="rd__macro"><span class="rd__macro-n mono-num">{{ r.carbG | number:'1.0-0' }}</span><span class="rd__macro-l">carbs</span></div>
            <div class="rd__macro"><span class="rd__macro-n mono-num">{{ r.fatG | number:'1.0-0' }}</span><span class="rd__macro-l">fat</span></div>
          </div>
          <p class="rd__macros-note">Per serving · {{ totalCalories(r) | number }} kcal for the whole recipe</p>

          @if (r.ingredients.length) {
            <div class="rd__block">
              <span class="rd__block-title"><mat-icon aria-hidden="true">list_alt</mat-icon> Ingredients</span>
              <ul class="rd__ings">
                @for (ing of r.ingredients; track $index) {
                  <li class="rd__ing">
                    <span class="rd__ing-name">{{ ing.name }}</span>
                    @if (ing.quantity) { <span class="rd__ing-qty">{{ ing.quantity }}</span> }
                  </li>
                }
              </ul>
            </div>
          }

          @if (r.steps.length) {
            <div class="rd__block">
              <span class="rd__block-title"><mat-icon aria-hidden="true">format_list_numbered</mat-icon> Steps</span>
              <ol class="rd__steps">
                @for (step of r.steps; track $index) { <li>{{ step }}</li> }
              </ol>
            </div>
          }

          @if (r.notes) {
            <div class="rd__block">
              <span class="rd__block-title"><mat-icon aria-hidden="true">sticky_note_2</mat-icon> Notes</span>
              <p class="rd__notes">{{ r.notes }}</p>
            </div>
          }

          <!-- owner controls / shared note -->
          @if (r.owned) {
            <button type="button" class="rd__share" [class.is-on]="r.shareWithContacts"
                    [disabled]="isBusy(r.id)" (click)="toggleShare(r)">
              <mat-icon aria-hidden="true">{{ r.shareWithContacts ? 'group' : 'group_off' }}</mat-icon>
              <span class="rd__share-txt">
                <b>{{ r.shareWithContacts ? 'Shared with your contacts' : 'Private to you' }}</b>
                <i>Tap to {{ r.shareWithContacts ? 'stop sharing' : 'share read-only' }}</i>
              </span>
              <span class="rd__switch" [class.is-on]="r.shareWithContacts" aria-hidden="true">
                <span class="rd__switch-knob"></span>
              </span>
            </button>

            <div class="rd__actions">
              <button type="button" class="rd__btn" [disabled]="isBusy(r.id)" (click)="openEdit(r)">
                <mat-icon aria-hidden="true">edit</mat-icon> Edit
              </button>
              <button type="button" class="rd__btn rd__btn--del" [disabled]="isBusy(r.id)" (click)="remove(r)">
                <mat-icon aria-hidden="true">delete_outline</mat-icon> Delete
              </button>
            </div>
          } @else {
            <p class="rd__shared-note">
              <mat-icon aria-hidden="true">visibility</mat-icon>
              Shared with you read-only@if (r.ownerName) { by {{ r.ownerName }} }.
            </p>
          }
        </div>
      }
    </app-bs-sheet>

    <!-- ─────────────── ADD / EDIT FORM SHEET ─────────────── -->
    <app-bs-sheet [(open)]="formOpen" detent="full" [dismissable]="!saving()"
                  [label]="editing() ? 'Edit recipe' : 'New recipe'">
      <form class="rf" (ngSubmit)="save()">
        <div class="rf__head">
          <h3 class="rf__title">{{ editing() ? 'Edit recipe' : 'New recipe' }}</h3>
          <button type="button" class="rf__close" (click)="closeForm()" aria-label="Cancel" [disabled]="saving()">
            <mat-icon aria-hidden="true">close</mat-icon>
          </button>
        </div>

        <label class="rf__field">
          <span class="rf__label">Title</span>
          <input class="rf__input" type="text" [ngModel]="fTitle()" (ngModelChange)="fTitle.set($event)"
                 name="title" placeholder="e.g. Sunday chili" autocomplete="off" maxlength="120" required />
        </label>

        <div class="rf__row">
          <label class="rf__field rf__field--sm">
            <span class="rf__label">Servings</span>
            <input class="rf__input mono-num" type="number" inputmode="numeric" min="1" step="1"
                   [ngModel]="fServings()" (ngModelChange)="fServings.set(+$event)" name="servings" />
          </label>
          <label class="rf__field rf__field--sm">
            <span class="rf__label">kcal / serving</span>
            <input class="rf__input mono-num" type="number" inputmode="numeric" min="0" step="1"
                   [ngModel]="fCalories()" (ngModelChange)="fCalories.set(+$event)" name="calories" />
          </label>
        </div>

        <div class="rf__row">
          <label class="rf__field rf__field--sm">
            <span class="rf__label">Protein (g)</span>
            <input class="rf__input mono-num" type="number" inputmode="decimal" min="0" step="0.1"
                   [ngModel]="fProtein()" (ngModelChange)="fProtein.set(+$event)" name="protein" />
          </label>
          <label class="rf__field rf__field--sm">
            <span class="rf__label">Carbs (g)</span>
            <input class="rf__input mono-num" type="number" inputmode="decimal" min="0" step="0.1"
                   [ngModel]="fCarb()" (ngModelChange)="fCarb.set(+$event)" name="carb" />
          </label>
          <label class="rf__field rf__field--sm">
            <span class="rf__label">Fat (g)</span>
            <input class="rf__input mono-num" type="number" inputmode="decimal" min="0" step="0.1"
                   [ngModel]="fFat()" (ngModelChange)="fFat.set(+$event)" name="fat" />
          </label>
        </div>

        <!-- ingredients -->
        <div class="rf__section">
          <span class="rf__section-title"><mat-icon aria-hidden="true">list_alt</mat-icon> Ingredients</span>
          @for (row of fRows(); track row.key) {
            <div class="rf__ing">
              <input class="rf__input rf__ing-name" type="text" placeholder="Ingredient"
                     [ngModel]="row.name" (ngModelChange)="setRowName(row.key, $event)"
                     [name]="'ing-name-' + row.key" autocomplete="off" />
              <input class="rf__input rf__ing-qty" type="text" placeholder="Qty"
                     [ngModel]="row.quantity" (ngModelChange)="setRowQty(row.key, $event)"
                     [name]="'ing-qty-' + row.key" autocomplete="off" />
              <button type="button" class="rf__ing-del" (click)="removeRow(row.key)" aria-label="Remove ingredient">
                <mat-icon aria-hidden="true">remove_circle_outline</mat-icon>
              </button>
            </div>
          }
          <button type="button" class="rf__add" (click)="addRow()">
            <mat-icon aria-hidden="true">add</mat-icon> Add ingredient
          </button>
        </div>

        <!-- steps -->
        <label class="rf__field">
          <span class="rf__label"><mat-icon class="rf__label-ic" aria-hidden="true">format_list_numbered</mat-icon> Steps <i>(one per line)</i></span>
          <textarea class="rf__input rf__area" rows="4" [ngModel]="fSteps()" (ngModelChange)="fSteps.set($event)"
                    name="steps" placeholder="Brown the meat&#10;Add the beans&#10;Simmer 30 min"></textarea>
        </label>

        <!-- notes -->
        <label class="rf__field">
          <span class="rf__label"><mat-icon class="rf__label-ic" aria-hidden="true">sticky_note_2</mat-icon> Notes</span>
          <textarea class="rf__input rf__area" rows="2" [ngModel]="fNotes()" (ngModelChange)="fNotes.set($event)"
                    name="notes" placeholder="Anything to remember"></textarea>
        </label>

        <!-- share -->
        <button type="button" class="rf__share" [class.is-on]="fShare()" (click)="fShare.set(!fShare())">
          <mat-icon aria-hidden="true">{{ fShare() ? 'group' : 'group_off' }}</mat-icon>
          <span class="rf__share-txt">
            <b>{{ fShare() ? 'Shared with your contacts' : 'Private to you' }}</b>
            <i>Tap to {{ fShare() ? 'stop sharing' : 'share read-only' }}</i>
          </span>
          <span class="rd__switch" [class.is-on]="fShare()" aria-hidden="true"><span class="rd__switch-knob"></span></span>
        </button>

        <div class="rf__actions">
          <button type="button" class="rf__btn rf__btn--ghost" (click)="closeForm()" [disabled]="saving()">Cancel</button>
          <button type="submit" class="rf__btn rf__btn--save" [disabled]="!canSave()">
            @if (saving()) { <span class="rf__spin" aria-hidden="true"></span> Saving… }
            @else { <mat-icon aria-hidden="true">check</mat-icon> {{ editing() ? 'Save changes' : 'Create recipe' }} }
          </button>
        </div>
      </form>
    </app-bs-sheet>

    <app-bs-toaster />
  `,
  styleUrl: './recipes-mobile.page.scss',
})
export class RecipesMobilePage {
  private api = inject(Api);
  private toast = inject(ToastController);
  private route = inject(ActivatedRoute);

  /** The caller's own recipes (newest-first from the server). */
  readonly mine = signal<Recipe[]>([]);
  /** Recipes shared TO the caller by mutual contacts. */
  readonly shared = signal<Recipe[]>([]);

  readonly loading = signal(true);
  readonly errored = signal(false);
  readonly refreshing = signal(false);

  /** Which list the segmented control shows. */
  readonly tab = signal<'mine' | 'shared'>('mine');

  /** Per-recipe in-flight ids (share toggle / delete) so only that card's controls disable. */
  private readonly busyIds = signal<Set<number>>(new Set());

  /** Detail sheet state + the recipe it's showing. */
  readonly detailOpen = signal(false);
  readonly selected = signal<Recipe | null>(null);

  /** Form sheet state. `editing` is the recipe being edited, or null for a create. */
  readonly formOpen = signal(false);
  readonly editing = signal<Recipe | null>(null);
  readonly saving = signal(false);

  // ---- form fields (mirror the live editor dialog) ----
  readonly fTitle = signal('');
  readonly fServings = signal(1);
  readonly fCalories = signal(0);
  readonly fProtein = signal(0);
  readonly fCarb = signal(0);
  readonly fFat = signal(0);
  readonly fNotes = signal('');
  readonly fSteps = signal('');
  readonly fShare = signal(false);
  private keySeq = 0;
  readonly fRows = signal<IngredientRow[]>([]);

  readonly skeletonCells = Array.from({ length: 4 }, (_, i) => i);

  readonly mineCount = computed(() => this.mine().length);
  readonly sharedCount = computed(() => this.shared().length);
  /** How many of the caller's own recipes are currently shared with contacts. */
  readonly sharedByMeCount = computed(() => this.mine().filter(r => r.shareWithContacts).length);

  readonly tabSegments = computed<Segment[]>(() => [
    { key: 'mine', label: `Mine${this.mineCount() ? ' · ' + this.mineCount() : ''}` },
    { key: 'shared', label: `Shared${this.sharedCount() ? ' · ' + this.sharedCount() : ''}` },
  ]);

  /** The list backing the active tab. */
  readonly activeList = computed<Recipe[]>(() => (this.tab() === 'mine' ? this.mine() : this.shared()));

  readonly canSave = computed(() => this.fTitle().trim().length > 0 && !this.saving());

  constructor() {
    void this.reload();
  }

  // ─────────────── LOAD ───────────────

  async reload(): Promise<void> {
    const wasLoaded = !this.loading();
    if (wasLoaded) this.refreshing.set(true); else this.loading.set(true);
    this.errored.set(false);
    try {
      const [mine, shared] = await Promise.all([
        firstValueFrom(this.api.recipes()),
        firstValueFrom(this.api.recipesSharedWithMe()),
      ]);
      this.mine.set(mine ?? []);
      this.shared.set(shared ?? []);
      // Keep the open detail sheet in sync with the freshly loaded row (if still present).
      const sel = this.selected();
      if (sel) {
        const next = [...(mine ?? []), ...(shared ?? [])].find(r => r.id === sel.id);
        this.selected.set(next ?? null);
        if (!next) this.detailOpen.set(false);
      }
    } catch {
      this.errored.set(true);
    } finally {
      this.loading.set(false);
      if (wasLoaded) {
        this.refreshing.set(false);
        this.toast.show('Recipes refreshed', { tone: 'success', durationMs: 1600 });
      }
    }
    this.focusFromQuery();
  }

  /**
   * Deep-link from Search: ?focus={id} flips to the right tab (mine / shared), opens the recipe's detail
   * sheet, and scrolls its card into view — parity with the desktop /recipes consumer (which expands +
   * scrolls + flashes). The desktop card is an inline accordion; here detail is a bottom sheet, so we open
   * it. No-op when the param is absent/invalid, so a normal visit behaves exactly as before. Only acts once.
   */
  private focused = false;
  private focusFromQuery(): void {
    if (this.focused) return;
    const raw = this.route.snapshot.queryParamMap.get('focus');
    const id = raw ? Number(raw) : NaN;
    if (!Number.isInteger(id)) return;
    const inMine = this.mine().find((r) => r.id === id);
    const target = inMine ?? this.shared().find((r) => r.id === id);
    if (!target) return;
    this.focused = true;
    this.tab.set(inMine ? 'mine' : 'shared'); // ensure the card renders under the active tab
    this.openDetail(target);
    setTimeout(() => {
      document.getElementById('recipe-' + id)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }

  setTab(key: string): void {
    this.tab.set(key === 'shared' ? 'shared' : 'mine');
  }

  // ─────────────── helpers ───────────────

  isBusy(id: number): boolean {
    return this.busyIds().has(id);
  }

  private setBusy(id: number, on: boolean): void {
    this.busyIds.update((set) => {
      const next = new Set(set);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  /** Total kcal for the whole recipe (per-serving × servings) — a friendly secondary stat. */
  totalCalories(r: Recipe): number {
    return Math.max(0, Math.round(r.calories * Math.max(1, r.servings)));
  }

  cardAria(r: Recipe): string {
    const macros = `${Math.round(r.calories)} kcal per serving`;
    if (!r.owned) {
      return `${r.title}${r.ownerName ? ', shared by ' + r.ownerName : ''}, ${macros}. Open details.`;
    }
    return `${r.title}, ${r.servings} serving${r.servings === 1 ? '' : 's'}, ${macros}. Open details.`;
  }

  // ─────────────── DETAIL SHEET ───────────────

  openDetail(r: Recipe): void {
    this.selected.set(r);
    this.detailOpen.set(true);
  }

  /** A swipe-row commit on an owned card: left = delete, right = edit. */
  onSwipe(r: Recipe, side: 'left' | 'right'): void {
    if (side === 'left') void this.remove(r);
    else this.openEdit(r);
  }

  // ─────────────── ACTIONS (reuse the live Api verbatim) ───────────────

  /** Toggle the owner-scoped share-with-contacts flag on an OWN recipe. */
  async toggleShare(r: Recipe): Promise<void> {
    if (!r.owned || this.isBusy(r.id)) return;
    const share = !r.shareWithContacts;
    this.setBusy(r.id, true);
    try {
      const res = await firstValueFrom(this.api.setRecipeShare(r.id, share));
      this.patchMine(r.id, { shareWithContacts: res.shareWithContacts });
      this.toast.show(res.shareWithContacts ? 'Shared with your contacts' : 'Sharing turned off',
        { tone: 'success', durationMs: 1800 });
    } catch {
      this.toast.show("Couldn't update sharing — try again", { tone: 'warn' });
    } finally {
      this.setBusy(r.id, false);
    }
  }

  /** Delete an OWN recipe (with a confirm). Removes it from "mine" on success. */
  async remove(r: Recipe): Promise<void> {
    if (!r.owned || this.isBusy(r.id)) return;
    if (typeof confirm === 'function' && !confirm(`Delete “${r.title}”? This can't be undone.`)) return;
    this.setBusy(r.id, true);
    try {
      await firstValueFrom(this.api.deleteRecipe(r.id));
      this.mine.update((rs) => rs.filter((x) => x.id !== r.id));
      if (this.selected()?.id === r.id) this.detailOpen.set(false);
      this.toast.show('Recipe deleted', { tone: 'success', durationMs: 1800 });
    } catch {
      this.toast.show("Couldn't delete the recipe — try again", { tone: 'warn' });
    } finally {
      this.setBusy(r.id, false);
    }
  }

  /** Reflect a patched field on a "mine" row + the open detail sheet. */
  private patchMine(id: number, patch: Partial<Recipe>): void {
    this.mine.update((rs) => rs.map((x) => (x.id === id ? { ...x, ...patch } : x)));
    const sel = this.selected();
    if (sel?.id === id) this.selected.set({ ...sel, ...patch });
  }

  // ─────────────── ADD / EDIT FORM ───────────────

  openCreate(): void {
    this.editing.set(null);
    this.seedForm(null);
    this.detailOpen.set(false);
    this.formOpen.set(true);
  }

  openEdit(r: Recipe): void {
    if (!r.owned) return;
    this.editing.set(r);
    this.seedForm(r);
    this.detailOpen.set(false);
    this.formOpen.set(true);
  }

  closeForm(): void {
    if (this.saving()) return;
    this.formOpen.set(false);
  }

  private seedForm(r: Recipe | null): void {
    this.fTitle.set(r?.title ?? '');
    this.fServings.set(Math.max(1, r?.servings ?? 1));
    this.fCalories.set(r?.calories ?? 0);
    this.fProtein.set(r?.proteinG ?? 0);
    this.fCarb.set(r?.carbG ?? 0);
    this.fFat.set(r?.fatG ?? 0);
    this.fNotes.set(r?.notes ?? '');
    this.fSteps.set((r?.steps ?? []).join('\n'));
    this.fShare.set(r?.shareWithContacts ?? false);
    this.fRows.set((r?.ingredients ?? []).map((i) => ({ key: this.keySeq++, name: i.name, quantity: i.quantity })));
  }

  addRow(): void {
    this.fRows.update((rs) => [...rs, { key: this.keySeq++, name: '', quantity: '' }]);
  }

  setRowName(key: number, name: string): void {
    this.fRows.update((rs) => rs.map((r) => (r.key === key ? { ...r, name } : r)));
  }

  setRowQty(key: number, quantity: string): void {
    this.fRows.update((rs) => rs.map((r) => (r.key === key ? { ...r, quantity } : r)));
  }

  removeRow(key: number): void {
    this.fRows.update((rs) => rs.filter((r) => r.key !== key));
  }

  /** Build the upsert body EXACTLY like the live editor dialog (trim, clamp, drop blank rows). */
  private buildRequest(): RecipeUpsertRequest {
    const ingredients: SavedRecipeIngredient[] = this.fRows()
      .map((r) => ({ name: r.name.trim(), quantity: r.quantity.trim() }))
      .filter((i) => i.name.length > 0);
    const steps = this.fSteps().split('\n').map((s) => s.trim()).filter(Boolean);
    return {
      title: this.fTitle().trim(),
      servings: Math.max(1, Math.round(this.fServings() || 1)),
      calories: Math.max(0, Math.round(this.fCalories() || 0)),
      proteinG: Math.max(0, this.fProtein() || 0),
      carbG: Math.max(0, this.fCarb() || 0),
      fatG: Math.max(0, this.fFat() || 0),
      ingredients,
      steps,
      notes: this.fNotes().trim(),
      shareWithContacts: this.fShare(),
    };
  }

  async save(): Promise<void> {
    if (!this.canSave()) {
      if (!this.fTitle().trim()) this.toast.show('Give the recipe a title first.', { tone: 'warn' });
      return;
    }
    this.saving.set(true);
    const req = this.buildRequest();
    const editRow = this.editing();
    try {
      const saved = editRow
        ? await firstValueFrom(this.api.updateRecipe(editRow.id, req))
        : await firstValueFrom(this.api.createRecipe(req));
      if (editRow) {
        this.mine.update((rs) => rs.map((x) => (x.id === saved.id ? saved : x)));
        if (this.selected()?.id === saved.id) this.selected.set(saved);
        this.toast.show('Recipe updated', { tone: 'success', durationMs: 1800 });
      } else {
        this.mine.update((rs) => [saved, ...rs]);
        this.tab.set('mine');
        this.toast.show(`Saved “${saved.title}”`, { tone: 'success', durationMs: 2000 });
      }
      this.formOpen.set(false);
    } catch {
      this.toast.show("Couldn't save the recipe — try again", { tone: 'warn' });
    } finally {
      this.saving.set(false);
    }
  }
}
