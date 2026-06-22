import { Component, inject, signal } from '@angular/core';

import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';

import { Api } from '../../core/api';
import { ChatContactDto } from '../../core/models';

/** Opens with the item being assigned + who (if anyone) it's currently assigned to. */
export interface AssignContactData {
  itemName: string;
  currentUserId: number | null;
}

/** The picked contact's AppUser id, or null to CLEAR the assignment. Undefined closed = cancel. */
export type AssignContactResult = { userId: number | null };

/**
 * Pick which contact to pre-assign a bill item to. The list is the caller's mutual chat contacts (the
 * same circle used elsewhere) — the server re-validates the contact relationship on assign. Identity is
 * shown by display name + avatar only; no emails. A "No one (clear)" row removes any existing assignment.
 */
@Component({
  selector: 'app-assign-contact-dialog',
  imports: [MatDialogModule, MatButtonModule, MatIconModule, MatProgressSpinnerModule],
  template: `
    <h2 mat-dialog-title class="ac-title">Assign "{{ data.itemName }}"</h2>
    <mat-dialog-content class="ac-body">
      @if (loading()) {
        <div class="ac-load"><mat-spinner diameter="28" /></div>
      } @else if (error()) {
        <p class="ac-empty">Couldn't load your contacts. Try again.</p>
      } @else {
        <button type="button" class="ac-row ac-row--clear" (click)="pick(null)"
                [class.ac-row--active]="data.currentUserId == null">
          <span class="ac-avatar ac-avatar--clear"><mat-icon aria-hidden="true">person_off</mat-icon></span>
          <span class="ac-name">No one (open for claiming)</span>
          @if (data.currentUserId == null) { <mat-icon class="ac-check" aria-hidden="true">check</mat-icon> }
        </button>

        @if (contacts().length === 0) {
          <p class="ac-empty">You have no contacts yet. Items stay open for public claiming.</p>
        }
        @for (c of contacts(); track c.userId) {
          <button type="button" class="ac-row" (click)="pick(c.userId)"
                  [class.ac-row--active]="c.userId === data.currentUserId">
            @if (c.picture) {
              <img class="ac-avatar" [src]="c.picture" alt="" referrerpolicy="no-referrer" />
            } @else {
              <span class="ac-avatar ac-avatar--init">{{ initials(c.name) }}</span>
            }
            <span class="ac-name">{{ c.name }}</span>
            @if (c.userId === data.currentUserId) { <mat-icon class="ac-check" aria-hidden="true">check</mat-icon> }
          </button>
        }
      }
    </mat-dialog-content>
    <mat-dialog-actions class="ac-actions" align="end">
      <button mat-stroked-button type="button" (click)="cancel()">Cancel</button>
    </mat-dialog-actions>
  `,
  styles: `
    .ac-title { font-family: var(--tech-font-ui); font-weight: 700; color: var(--tech-text);
      overflow-wrap: anywhere; }
    .ac-body { display: flex; flex-direction: column; gap: 4px;
      min-width: min(360px, 84vw); padding-top: 4px !important; }
    .ac-load { display: flex; justify-content: center; padding: 24px 0; }
    .ac-empty { margin: 8px 0; color: var(--tech-text-dim); font-size: .9rem; }
    .ac-row { display: flex; align-items: center; gap: 10px; width: 100%; text-align: left;
      background: transparent; border: 1px solid transparent; border-radius: var(--tech-r-control);
      padding: 8px 10px; cursor: pointer; color: var(--tech-text); min-height: 48px;
      &:hover { background: var(--tech-panel-2, rgba(255,255,255,.04)); }
      &--active { border-color: var(--tech-accent, #3fd8d0); }
      &--clear { border-bottom: 1px solid var(--tech-border); border-radius: var(--tech-r-control); margin-bottom: 4px; } }
    .ac-avatar { width: 32px; height: 32px; border-radius: 50%; flex: none; object-fit: cover;
      display: inline-flex; align-items: center; justify-content: center;
      background: var(--tech-panel-2, #1b2230); font-size: .8rem; font-weight: 700;
      &--init { color: var(--tech-text-secondary); }
      &--clear mat-icon { color: var(--tech-text-dim); font-size: 18px; height: 18px; width: 18px; } }
    .ac-name { flex: 1 1 auto; overflow-wrap: anywhere; }
    .ac-check { color: var(--tech-accent, #3fd8d0); flex: none; }
    .ac-actions { padding: var(--tech-space-3) var(--tech-space-4);
      button { border-radius: var(--tech-r-control); font-weight: 600; min-height: 44px; } }
  `,
})
export class AssignContactDialog {
  private ref = inject(MatDialogRef<AssignContactDialog, AssignContactResult>);
  private api = inject(Api);
  readonly data = inject<AssignContactData>(MAT_DIALOG_DATA);

  readonly contacts = signal<ChatContactDto[]>([]);
  readonly loading = signal(true);
  readonly error = signal(false);

  constructor() {
    this.api.myContacts().subscribe({
      next: list => { this.contacts.set(list); this.loading.set(false); },
      error: () => { this.error.set(true); this.loading.set(false); },
    });
  }

  initials(name: string): string {
    const parts = (name || '').split(/\s+/).filter(Boolean);
    return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || 'U';
  }

  pick(userId: number | null): void {
    this.ref.close({ userId });
  }

  cancel(): void {
    this.ref.close();
  }
}
