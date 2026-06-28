import { Component, computed, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { DecimalPipe, NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';

import { Api } from '../../core/api';
import { Recipe } from '../../core/models';
import { RecipeEditorDialog, RecipeEditorData } from './recipe-editor-dialog';

/**
 * "My Recipes" — the gated /recipes Tool (permissionGuard(recipes.use)). A per-user recipe book over
 * /api/recipes: the caller's OWN recipes (create / edit / delete, each with a per-recipe "Share with my
 * contacts" toggle), plus a "Shared with me" section listing recipes mutual contacts chose to share
 * read-only (owner display name only — never an email). Every card expands to show ingredients (name +
 * quantity), per-serving macros, ordered steps and notes.
 *
 * All visibility + ownership is enforced server-side; the page only ever offers edit/delete/share on rows
 * the server returned as `owned: true`. Mobile-first; themed with the existing --tech-* tokens.
 */
@Component({
  selector: 'app-recipes',
  imports: [
    DecimalPipe,
    NgTemplateOutlet,
    FormsModule,
    MatIconModule,
    MatButtonModule,
    MatSlideToggleModule,
    MatProgressSpinnerModule,
    MatTooltipModule,
  ],
  templateUrl: './recipes.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './recipes.scss',
})
export class Recipes {
  private api = inject(Api);
  private dialog = inject(MatDialog);
  private snack = inject(MatSnackBar);
  private route = inject(ActivatedRoute);

  /** Recipe id to briefly highlight after a deep-link (?focus=) lands and scrolls. */
  readonly flashId = signal<number | null>(null);

  /** The caller's own recipes (newest-first from the server). */
  readonly mine = signal<Recipe[]>([]);
  /** Recipes shared TO the caller by mutual contacts. */
  readonly shared = signal<Recipe[]>([]);

  readonly loading = signal(true);
  readonly error = signal(false);

  /** Ids of recipe cards expanded to show their detail. */
  private readonly expanded = signal<Set<number>>(new Set());
  /** Per-recipe in-flight ids (share toggle / delete) so only that card's controls disable. */
  private readonly busyIds = signal<Set<number>>(new Set());

  readonly mineCount = computed(() => this.mine().length);
  readonly sharedCount = computed(() => this.shared().length);

  constructor() {
    void this.load();
  }

  // ─────────────────────────────────────────── load ────────────────────────────────────────────

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(false);
    try {
      const [mine, shared] = await Promise.all([
        firstValueFrom(this.api.recipes()),
        firstValueFrom(this.api.recipesSharedWithMe()),
      ]);
      this.mine.set(mine ?? []);
      this.shared.set(shared ?? []);
    } catch {
      this.error.set(true);
    } finally {
      this.loading.set(false);
    }
    this.focusFromQuery();
  }

  /** Deep-link from Search: ?focus={id} expands + scrolls to that recipe (mine or shared) and flashes it. */
  private focusFromQuery(): void {
    const raw = this.route.snapshot.queryParamMap.get('focus');
    const id = raw ? Number(raw) : NaN;
    if (!Number.isInteger(id)) return;
    const exists = this.mine().some((r) => r.id === id) || this.shared().some((r) => r.id === id);
    if (!exists) return;
    this.expanded.update((set) => new Set(set).add(id));
    // Wait for the expanded card to render, then scroll + flash.
    setTimeout(() => {
      const el = document.getElementById('recipe-' + id);
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      this.flashId.set(id);
      setTimeout(() => this.flashId.set(null), 2000);
    });
  }

  // ─────────────────────────────────────────── helpers ─────────────────────────────────────────

  isExpanded(id: number): boolean {
    return this.expanded().has(id);
  }

  toggleExpanded(id: number): void {
    this.expanded.update((set) => {
      const next = new Set(set);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

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

  // ─────────────────────────────────────────── actions ─────────────────────────────────────────

  /** Open the editor to create a new recipe; on save, prepend it to "mine". */
  create(): void {
    const ref = this.dialog.open(RecipeEditorDialog, {
      data: { recipe: null } as RecipeEditorData,
      panelClass: 'recipe-editor-pane',
      autoFocus: false,
    });
    ref.afterClosed().subscribe((saved?: Recipe) => {
      if (saved) {
        this.mine.update((rs) => [saved, ...rs]);
        this.snack.open(`Saved “${saved.title}”`, 'OK', { duration: 2500 });
      }
    });
  }

  /** Open the editor for an OWN recipe; on save, replace it in place. */
  edit(r: Recipe): void {
    if (!r.owned) return;
    const ref = this.dialog.open(RecipeEditorDialog, {
      data: { recipe: r } as RecipeEditorData,
      panelClass: 'recipe-editor-pane',
      autoFocus: false,
    });
    ref.afterClosed().subscribe((saved?: Recipe) => {
      if (saved) {
        this.mine.update((rs) => rs.map((x) => (x.id === saved.id ? saved : x)));
        this.snack.open('Recipe updated', 'OK', { duration: 2500 });
      }
    });
  }

  /** Toggle the owner-scoped share-with-contacts flag on an OWN recipe. */
  async toggleShare(r: Recipe, share: boolean): Promise<void> {
    if (!r.owned || this.isBusy(r.id)) return;
    this.setBusy(r.id, true);
    try {
      const res = await firstValueFrom(this.api.setRecipeShare(r.id, share));
      this.mine.update((rs) =>
        rs.map((x) => (x.id === r.id ? { ...x, shareWithContacts: res.shareWithContacts } : x)),
      );
      this.snack.open(
        res.shareWithContacts ? 'Shared with your contacts' : 'Sharing turned off',
        'OK',
        { duration: 2500 },
      );
    } catch {
      this.snack.open("Couldn't update sharing — try again", 'Dismiss', { duration: 4000 });
    } finally {
      this.setBusy(r.id, false);
    }
  }

  /** Delete an OWN recipe (with a confirm). Removes it from "mine" on success. */
  async remove(r: Recipe): Promise<void> {
    if (!r.owned || this.isBusy(r.id)) return;
    if (!confirm(`Delete “${r.title}”? This can't be undone.`)) return;
    this.setBusy(r.id, true);
    try {
      await firstValueFrom(this.api.deleteRecipe(r.id));
      this.mine.update((rs) => rs.filter((x) => x.id !== r.id));
      this.snack.open('Recipe deleted', 'OK', { duration: 2500 });
    } catch {
      this.snack.open("Couldn't delete the recipe — try again", 'Dismiss', { duration: 4000 });
    } finally {
      this.setBusy(r.id, false);
    }
  }
}
