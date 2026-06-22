import { Component, computed, inject, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { catchError, firstValueFrom, of } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTabsModule } from '@angular/material/tabs';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatMenuModule } from '@angular/material/menu';
import { MAT_DIALOG_DATA, MatDialog, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';

import { Api } from '../../core/api';
import {
  FamilyList, FamilyListItem, FamilyListKind, FamilyShareTarget, Household, HouseholdMember,
} from '../../core/models';
import { FamilyShareDialog, ShareDialogData } from './share-dialog';
import { FamilyConfirmDialog, ConfirmData } from './confirm-dialog';

/** A person who can be assigned a to-do item: a household member, by userId + name + picture (no email). */
interface Assignee {
  userId: number;
  name: string;
  picture?: string | null;
}

/** One AI-proposed item awaiting review: its text + whether the user has it checked (only checked ones add). */
interface ProposedItem {
  text: string;
  keep: boolean;
}

/** The per-list "✨ Add several" panel state (open box, free text, in-flight, status line, proposed items). */
interface AiPanel {
  open: boolean;
  text: string;
  busy: boolean;
  /** A friendly status line for aria-live (an error, "nothing found", or a review prompt). */
  status: string;
  /** The proposed items the user reviews before adding (null until a parse has run). */
  items: ProposedItem[] | null;
  /** True while the confirmed items are being added one-by-one. */
  adding: boolean;
}

function emptyAiPanel(): AiPanel {
  return { open: false, text: '', busy: false, status: '', items: null, adding: false };
}

/** The per-list "✨ What am I missing?" panel state (open box, goal text, in-flight, status, proposed chips). */
interface SuggestPanel {
  open: boolean;
  /** The tiny goal input ("kids birthday party"). */
  goal: string;
  busy: boolean;
  /** A friendly status line for aria-live (an error, "nothing to add", or a review prompt). */
  status: string;
  /** The proposed extra items the user reviews before adding (null until a suggest has run). */
  items: ProposedItem[] | null;
  /** True while the confirmed items are being added one-by-one. */
  adding: boolean;
}

function emptySuggestPanel(): SuggestPanel {
  return { open: false, goal: '', busy: false, status: '', items: null, adding: false };
}

/**
 * Family Lists — the household's shared lists, tabbed by kind: Shopping (fast add + check-off) and To-do
 * (each item can be assigned to a household member, shown as an assignee avatar). Each list supports an
 * add-item input, checkable items (strike-through + who checked it), delete item, rename / delete list,
 * and the same Share dialog as Notes. A list the caller only has a view-only share to is read-only — the
 * add box and item controls disappear, items show as a plain checklist.
 *
 * Everyone (authors, checkers, assignees) is rendered by display name + initials avatar; never an email.
 */
@Component({
  selector: 'app-family-lists',
  imports: [
    NgTemplateOutlet, RouterLink, FormsModule, MatIconModule, MatButtonModule, MatTooltipModule,
    MatProgressSpinnerModule, MatTabsModule, MatCheckboxModule, MatFormFieldModule, MatInputModule,
    MatMenuModule, MatSnackBarModule,
  ],
  templateUrl: './lists.html',
  styleUrls: ['./family.scss', './lists.scss'],
})
export class FamilyLists {
  private api = inject(Api);
  private dialog = inject(MatDialog);
  private snack = inject(MatSnackBar);

  readonly lists = signal<FamilyList[]>([]);
  readonly loading = signal(true);
  readonly error = signal(false);

  /** Household members — the assignee pool for to-do items (avatar picker). Empty until loaded. */
  readonly members = signal<HouseholdMember[]>([]);

  /** Draft "add item" text per list id (keyed so each list keeps its own input). */
  readonly itemDrafts = signal<Record<number, string>>({});
  /** Per-list busy flag (add-item / mutate) to lock the input briefly. */
  readonly busyListId = signal<number | null>(null);

  /** Per-list "✨ Add several" panel state (keyed by list id). */
  readonly aiPanels = signal<Record<number, AiPanel>>({});

  /** Per-list "✨ What am I missing?" panel state (keyed by list id). */
  readonly suggestPanels = signal<Record<number, SuggestPanel>>({});

  readonly shoppingLists = computed(() => this.lists().filter(l => l.kind === 'shopping'));
  readonly todoLists = computed(() => this.lists().filter(l => l.kind === 'todo'));

  constructor() {
    this.reload(true);
    // Household members drive the to-do assignee picker (display identity only).
    this.api.getHousehold()
      .pipe(catchError(() => of<Household | null>(null)), takeUntilDestroyed())
      .subscribe(h => { if (h) this.members.set(h.members); });
  }

  private reload(initial = false): void {
    if (initial) this.loading.set(true);
    this.api.familyLists()
      .pipe(catchError(() => { this.error.set(true); return of<FamilyList[]>([]); }), takeUntilDestroyed())
      .subscribe(list => { this.lists.set(list); this.loading.set(false); });
  }

  initials(name: string): string {
    const parts = (name || '').split(/\s+/).filter(Boolean);
    return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?';
  }

  /** The caller's household member userIds (for the manage check below). */
  private readonly memberIds = computed(() => new Set(this.members().map(m => m.userId)));

  /**
   * True when the caller may MANAGE this list (share / delete the whole list) — i.e. they're a household
   * member of the list's household. A list authored by one of my household members is a household list; a
   * shared-in list (author in another household) is not. Mirrors the server's "creator or member" rule.
   */
  canManage(list: FamilyList): boolean {
    return list.isMine || this.memberIds().has(list.createdByUserId);
  }

  /** Assignee options for a to-do item (household members only). */
  readonly assignees = computed<Assignee[]>(() =>
    this.members().map(m => ({ userId: m.userId, name: m.name, picture: m.picture })));

  private upsert(list: FamilyList): void {
    this.lists.update(all => all.some(l => l.id === list.id)
      ? all.map(l => (l.id === list.id ? list : l))
      : [list, ...all]);
  }

  draftFor(listId: number): string {
    return this.itemDrafts()[listId] ?? '';
  }
  setDraft(listId: number, value: string): void {
    this.itemDrafts.update(d => ({ ...d, [listId]: value }));
  }

  // ---- Lists ----

  /** Create a new list of the given kind via a tiny prompt-style dialog. */
  async createList(kind: FamilyListKind): Promise<void> {
    const name = await this.promptName(kind === 'shopping' ? 'New shopping list' : 'New to-do list',
      kind === 'shopping' ? 'e.g. Groceries' : 'e.g. Weekend chores');
    if (!name) return;
    try {
      const list = await firstValueFrom(this.api.createFamilyList(name, kind));
      this.upsert(list);
    } catch {
      this.snack.open("Couldn't create that list. Please try again.", 'OK', { duration: 4000 });
    }
  }

  async renameList(list: FamilyList): Promise<void> {
    if (!list.canEdit) return;
    const name = await this.promptName('Rename list', list.name, list.name);
    if (!name || name === list.name) return;
    try {
      const updated = await firstValueFrom(this.api.renameFamilyList(list.id, name));
      this.upsert(updated);
    } catch {
      this.snack.open("Couldn't rename that list.", 'OK', { duration: 4000 });
    }
  }

  async deleteList(list: FamilyList): Promise<void> {
    const ok = await this.confirm({
      title: 'Delete this list?',
      message: `“${list.name}” and all its items will be removed for everyone it’s shared with.`,
      destructive: true,
    });
    if (!ok) return;
    try {
      await firstValueFrom(this.api.deleteFamilyList(list.id));
      this.lists.update(all => all.filter(l => l.id !== list.id));
    } catch {
      this.snack.open("Couldn't delete that list.", 'OK', { duration: 4000 });
    }
  }

  // ---- Items ----

  /** Add an item to a list from its draft input (Enter or the add button). */
  async addItem(list: FamilyList): Promise<void> {
    const text = this.draftFor(list.id).trim();
    if (!text || !list.canEdit || this.busyListId() === list.id) return;
    this.busyListId.set(list.id);
    try {
      const updated = await firstValueFrom(this.api.addFamilyListItem(list.id, text));
      this.upsert(updated);
      this.setDraft(list.id, '');
    } catch (e) {
      this.snack.open(this.messageOf(e, "Couldn't add that item."), 'OK', { duration: 4000 });
    } finally {
      this.busyListId.set(null);
    }
  }

  /** Check / uncheck an item (stamps who checked it server-side). */
  async toggleItem(list: FamilyList, item: FamilyListItem): Promise<void> {
    if (!list.canEdit) return;
    try {
      const updated = await firstValueFrom(this.api.patchFamilyListItem(list.id, item.id, { done: !item.done }));
      this.upsert(updated);
    } catch {
      this.snack.open("Couldn't update that item.", 'OK', { duration: 4000 });
    }
  }

  async deleteItem(list: FamilyList, item: FamilyListItem): Promise<void> {
    if (!list.canEdit) return;
    try {
      const updated = await firstValueFrom(this.api.deleteFamilyListItem(list.id, item.id));
      this.upsert(updated);
    } catch {
      this.snack.open("Couldn't remove that item.", 'OK', { duration: 4000 });
    }
  }

  /** Assign a to-do item to a household member (by userId). */
  async assign(list: FamilyList, item: FamilyListItem, userId: number): Promise<void> {
    if (!list.canEdit || item.assignedToUserId === userId) return;
    try {
      const updated = await firstValueFrom(this.api.patchFamilyListItem(list.id, item.id, { assignedToUserId: userId }));
      this.upsert(updated);
    } catch (e) {
      this.snack.open(this.messageOf(e, "Couldn't assign that item."), 'OK', { duration: 4000 });
    }
  }

  // ---- ✨ Add several (AI quick-add) ----

  /** The "✨ Add several" panel for a list (defaults to a closed, empty panel). */
  aiPanel(listId: number): AiPanel {
    return this.aiPanels()[listId] ?? emptyAiPanel();
  }

  private setAiPanel(listId: number, patch: Partial<AiPanel>): void {
    this.aiPanels.update(p => ({ ...p, [listId]: { ...this.aiPanel(listId), ...patch } }));
  }

  /** Open / close the "✨ Add several" box for a list. Opening resets any prior proposals. */
  toggleAi(list: FamilyList): void {
    if (!list.canEdit) return;
    const open = !this.aiPanel(list.id).open;
    this.setAiPanel(list.id, open ? { ...emptyAiPanel(), open: true } : { open: false });
  }

  setAiText(listId: number, value: string): void {
    this.setAiPanel(listId, { text: value });
  }

  /** Clear the AI box + any pending proposals for a list (keeps the panel open). */
  clearAi(listId: number): void {
    this.setAiPanel(listId, { text: '', status: '', items: null });
  }

  /**
   * Send the free text to Gemini and show the parsed items as removable/checkable chips the user reviews.
   * Creates NOTHING — the user confirms with "Add N items". Degrades gracefully: a 503 (AI unavailable / not
   * configured) or any error shows a friendly aria-live line so the user can fall back to manual add.
   */
  async parseAi(list: FamilyList): Promise<void> {
    const panel = this.aiPanel(list.id);
    const text = panel.text.trim();
    if (!text || !list.canEdit || panel.busy) return;
    this.setAiPanel(list.id, { busy: true, status: 'Reading what you typed…', items: null });
    try {
      const result = await firstValueFrom(this.api.parseListItemsAi(text, list.kind));
      const items: ProposedItem[] = (result.items ?? []).map(t => ({ text: t, keep: true }));
      if (items.length === 0) {
        this.setAiPanel(list.id, {
          busy: false, items: null,
          status: result.notes?.trim() ||
            "I couldn't find any items in that. Try \"milk, eggs, bread\" or paste a recipe.",
        });
        return;
      }
      const n = items.length;
      this.setAiPanel(list.id, {
        busy: false, items,
        status: (result.notes?.trim() ? result.notes!.trim() + ' ' : '') +
          `Review ${n === 1 ? 'this item' : `these ${n} items`}, then add ${n === 1 ? 'it' : 'them'}.`,
      });
    } catch (e) {
      const status = (e as { status?: number })?.status;
      this.setAiPanel(list.id, {
        busy: false, items: null,
        status: status === 503
          ? "AI isn't available right now — you can add items manually below."
          : this.messageOf(e, "I couldn't reach the AI just now. Please try again, or add items manually."),
      });
    }
  }

  /** Toggle whether a proposed item will be added. */
  toggleProposed(listId: number, index: number): void {
    const items = this.aiPanel(listId).items;
    if (!items) return;
    this.setAiPanel(listId, { items: items.map((it, i) => i === index ? { ...it, keep: !it.keep } : it) });
  }

  /** Remove a proposed item from the review list entirely. */
  removeProposed(listId: number, index: number): void {
    const items = this.aiPanel(listId).items;
    if (!items) return;
    this.setAiPanel(listId, { items: items.filter((_, i) => i !== index) });
  }

  /** How many proposed items are currently checked-to-add. */
  keepCount(listId: number): number {
    return (this.aiPanel(listId).items ?? []).filter(i => i.keep).length;
  }

  /**
   * Add the checked proposed items to the list via the existing add-item endpoint (one call per item, in
   * order). On success the panel closes; a partial failure keeps the panel open with a status so the user
   * can retry the rest.
   */
  async addProposed(list: FamilyList): Promise<void> {
    const panel = this.aiPanel(list.id);
    if (!list.canEdit || panel.adding || !panel.items) return;
    const chosen = panel.items.filter(i => i.keep);
    if (chosen.length === 0) return;
    this.setAiPanel(list.id, { adding: true, status: `Adding ${chosen.length} item${chosen.length === 1 ? '' : 's'}…` });

    let updated: FamilyList | null = null;
    let added = 0;
    const failed: ProposedItem[] = [];
    for (const item of chosen) {
      try {
        updated = await firstValueFrom(this.api.addFamilyListItem(list.id, item.text));
        added++;
      } catch {
        failed.push(item);
      }
    }
    if (updated) this.upsert(updated);

    if (failed.length === 0) {
      this.setAiPanel(list.id, { ...emptyAiPanel() });
      this.snack.open(`Added ${added} item${added === 1 ? '' : 's'}.`, undefined, { duration: 2000 });
    } else {
      // Keep just the ones that didn't make it so the user can retry them.
      this.setAiPanel(list.id, {
        adding: false, items: failed,
        status: `Added ${added}. ${failed.length} couldn't be added — try again.`,
      });
    }
  }

  // ---- ✨ What am I missing? (AI suggests additional items for a goal) ----

  /** The "✨ What am I missing?" panel for a list (defaults to a closed, empty panel). */
  suggestPanel(listId: number): SuggestPanel {
    return this.suggestPanels()[listId] ?? emptySuggestPanel();
  }

  private setSuggestPanel(listId: number, patch: Partial<SuggestPanel>): void {
    this.suggestPanels.update(p => ({ ...p, [listId]: { ...this.suggestPanel(listId), ...patch } }));
  }

  /** Open / close the "✨ What am I missing?" box for a list. Opening resets any prior proposals. */
  toggleSuggest(list: FamilyList): void {
    if (!list.canEdit) return;
    const open = !this.suggestPanel(list.id).open;
    this.setSuggestPanel(list.id, open ? { ...emptySuggestPanel(), open: true } : { open: false });
  }

  setSuggestGoal(listId: number, value: string): void {
    this.setSuggestPanel(listId, { goal: value });
  }

  /** Clear the goal + any pending proposals for a list (keeps the panel open). */
  clearSuggest(listId: number): void {
    this.setSuggestPanel(listId, { goal: '', status: '', items: null });
  }

  /**
   * Send the goal to Gemini and show the proposed EXTRA items as checkable chips the user reviews. The server
   * de-dupes against the list's current items. Creates NOTHING — the user confirms with "Add N items".
   * Degrades gracefully: a 503 (AI unavailable / not configured) or any error shows a friendly aria-live line.
   */
  async suggestItems(list: FamilyList): Promise<void> {
    const panel = this.suggestPanel(list.id);
    const goal = panel.goal.trim();
    if (!goal || !list.canEdit || panel.busy) return;
    this.setSuggestPanel(list.id, { busy: true, status: 'Thinking about what else you might need…', items: null });
    try {
      const result = await firstValueFrom(this.api.suggestListItemsAi(list.id, goal));
      const items: ProposedItem[] = (result.items ?? []).map(t => ({ text: t, keep: true }));
      if (items.length === 0) {
        this.setSuggestPanel(list.id, {
          busy: false, items: null,
          status: "Looks like you've got it covered — I couldn't think of anything to add.",
        });
        return;
      }
      const n = items.length;
      this.setSuggestPanel(list.id, {
        busy: false, items,
        status: `Here ${n === 1 ? 'is 1 idea' : `are ${n} ideas`} — pick the ones to add.`,
      });
    } catch (e) {
      const status = (e as { status?: number })?.status;
      this.setSuggestPanel(list.id, {
        busy: false, items: null,
        status: status === 503
          ? "AI isn't available right now — you can add items manually below."
          : this.messageOf(e, "I couldn't reach the AI just now. Please try again, or add items manually."),
      });
    }
  }

  /** Toggle whether a proposed suggestion will be added. */
  toggleSuggested(listId: number, index: number): void {
    const items = this.suggestPanel(listId).items;
    if (!items) return;
    this.setSuggestPanel(listId, { items: items.map((it, i) => i === index ? { ...it, keep: !it.keep } : it) });
  }

  /** Remove a proposed suggestion from the review list entirely. */
  removeSuggested(listId: number, index: number): void {
    const items = this.suggestPanel(listId).items;
    if (!items) return;
    this.setSuggestPanel(listId, { items: items.filter((_, i) => i !== index) });
  }

  /** How many proposed suggestions are currently checked-to-add. */
  suggestKeepCount(listId: number): number {
    return (this.suggestPanel(listId).items ?? []).filter(i => i.keep).length;
  }

  /**
   * Add the checked suggestions to the list via the existing add-item endpoint (one call per item, in order).
   * On full success the panel closes; a partial failure keeps just the ones that didn't make it for a retry.
   */
  async addSuggested(list: FamilyList): Promise<void> {
    const panel = this.suggestPanel(list.id);
    if (!list.canEdit || panel.adding || !panel.items) return;
    const chosen = panel.items.filter(i => i.keep);
    if (chosen.length === 0) return;
    this.setSuggestPanel(list.id, { adding: true, status: `Adding ${chosen.length} item${chosen.length === 1 ? '' : 's'}…` });

    let updated: FamilyList | null = null;
    let added = 0;
    const failed: ProposedItem[] = [];
    for (const item of chosen) {
      try {
        updated = await firstValueFrom(this.api.addFamilyListItem(list.id, item.text));
        added++;
      } catch {
        failed.push(item);
      }
    }
    if (updated) this.upsert(updated);

    if (failed.length === 0) {
      this.setSuggestPanel(list.id, { ...emptySuggestPanel() });
      this.snack.open(`Added ${added} item${added === 1 ? '' : 's'}.`, undefined, { duration: 2000 });
    } else {
      this.setSuggestPanel(list.id, {
        adding: false, items: failed,
        status: `Added ${added}. ${failed.length} couldn't be added — try again.`,
      });
    }
  }

  // ---- Sharing ----

  async share(list: FamilyList): Promise<void> {
    const data: ShareDialogData = {
      itemLabel: list.name,
      shares: list.sharedWith,
      onShare: async (userId, canEdit) => {
        const updated = await firstValueFrom(this.api.shareFamilyList(list.id, userId, canEdit));
        this.upsert(updated);
        return updated.sharedWith;
      },
      onUnshare: async (userId) => {
        const updated = await firstValueFrom(this.api.unshareFamilyList(list.id, userId));
        this.upsert(updated);
        return updated.sharedWith;
      },
    };
    const ref = this.dialog.open<FamilyShareDialog, ShareDialogData, boolean>(FamilyShareDialog, {
      data, width: '460px', maxWidth: '94vw', autoFocus: false, panelClass: 'family-dialog',
    });
    await firstValueFrom(ref.afterClosed());
  }

  // ---- Helpers ----

  doneCount(list: FamilyList): number {
    return list.items.filter(i => i.done).length;
  }

  visibleShares(shares: FamilyShareTarget[]): FamilyShareTarget[] {
    return shares.slice(0, 3);
  }
  extraShares(shares: FamilyShareTarget[]): number {
    return Math.max(0, shares.length - 3);
  }

  private promptName(title: string, placeholder: string, initial = ''): Promise<string | undefined> {
    const ref = this.dialog.open<ListNamePrompt, ListNamePromptData, string>(ListNamePrompt, {
      data: { title, placeholder, initial }, width: '420px', maxWidth: '92vw', autoFocus: false, panelClass: 'family-dialog',
    });
    return firstValueFrom(ref.afterClosed());
  }

  private confirm(data: ConfirmData): Promise<boolean | undefined> {
    const ref = this.dialog.open<FamilyConfirmDialog, ConfirmData, boolean>(FamilyConfirmDialog, {
      data, width: '420px', maxWidth: '92vw', panelClass: 'family-dialog',
    });
    return firstValueFrom(ref.afterClosed());
  }

  private messageOf(e: unknown, fallback: string): string {
    const msg = (e as { error?: { message?: string } })?.error?.message;
    return typeof msg === 'string' && msg ? msg : fallback;
  }
}

// ---- Inline name prompt (create / rename a list) ----

interface ListNamePromptData { title: string; placeholder: string; initial: string; }

@Component({
  selector: 'app-list-name-prompt',
  imports: [FormsModule, MatDialogModule, MatFormFieldModule, MatInputModule, MatButtonModule],
  template: `
    <h2 mat-dialog-title class="confirm__title">{{ data.title }}</h2>
    <mat-dialog-content class="confirm__body">
      <mat-form-field appearance="outline" style="width:100%">
        <mat-label>List name</mat-label>
        <input matInput cdkFocusInitial maxlength="200" [placeholder]="data.placeholder"
               [ngModel]="name()" (ngModelChange)="name.set($event)"
               (keydown.enter)="save()" />
      </mat-form-field>
    </mat-dialog-content>
    <mat-dialog-actions align="end" class="confirm__actions">
      <button mat-stroked-button type="button" (click)="ref.close()">Cancel</button>
      <button mat-flat-button color="primary" type="button" [disabled]="!name().trim()" (click)="save()">Save</button>
    </mat-dialog-actions>
  `,
  styles: `
    .confirm__title { font-family: var(--tech-font-ui); font-weight: 700; color: var(--tech-text); }
    .confirm__body { min-width: min(340px, 80vw); padding-top: 6px !important; }
    .confirm__actions { padding: var(--tech-space-3, 12px) var(--tech-space-4, 16px); gap: 8px;
      button { border-radius: var(--tech-r-control); font-weight: 600; min-height: 42px; } }
  `,
})
export class ListNamePrompt {
  protected ref = inject(MatDialogRef<ListNamePrompt, string>);
  readonly data = inject<ListNamePromptData>(MAT_DIALOG_DATA);
  readonly name = signal(this.data.initial ?? '');
  save(): void {
    const n = this.name().trim();
    if (n) this.ref.close(n);
  }
}
