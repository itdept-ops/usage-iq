import { CommonModule } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { forkJoin } from 'rxjs';

import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import {
  MatDialog, MatDialogModule, MatDialogRef,
} from '@angular/material/dialog';

import { Api } from '../../core/api';
import { AuthService } from '../../core/auth';
import {
  AccessPolicy, AuditEntry, ChatContactDto, LoginEvent, ManagedUser, PermissionItem, PERM, PERM_GROUP_OF, PERM_GROUP_ORDER,
} from '../../core/models';

/**
 * Tiny modal that prompts for the email-reveal key (single password-style input). Closes with the
 * trimmed key on submit, or `undefined` on cancel. The key lives only in the caller's memory — this
 * dialog never persists it. Kept in this file to keep the email-gate feature self-contained.
 */
@Component({
  selector: 'app-email-reveal-dialog',
  imports: [
    FormsModule, MatDialogModule, MatFormFieldModule, MatInputModule, MatButtonModule, MatIconModule,
  ],
  template: `
    <h2 mat-dialog-title id="email-reveal-title">Show emails</h2>
    <mat-dialog-content>
      <p class="erd-sub">Enter the reveal key to show real email addresses on this page. The key is held in
        memory only for this session and is never saved.</p>
      <form (ngSubmit)="submit()">
        <mat-form-field appearance="outline" class="erd-field" subscriptSizing="dynamic">
          <mat-label>Reveal key</mat-label>
          <input matInput #keyInput type="password" name="revealKey" autocomplete="off"
                 aria-label="Email reveal key" [(ngModel)]="key" cdkFocusInitial />
          <mat-icon matPrefix>lock</mat-icon>
        </mat-form-field>
      </form>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button type="button" (click)="cancel()">Cancel</button>
      <button mat-flat-button color="primary" type="button" [disabled]="!key.trim()"
              (click)="submit()">Show emails</button>
    </mat-dialog-actions>
  `,
  styles: [`
    .erd-sub { margin: 0 0 14px; max-width: 380px; font-size: 13px; line-height: 1.5; color: var(--tech-text-secondary); }
    .erd-field { width: 320px; max-width: 100%; }
    [mat-dialog-title] { font-family: var(--tech-font-ui); }
  `],
})
export class EmailRevealDialog {
  private ref = inject(MatDialogRef<EmailRevealDialog, string | undefined>);
  key = '';

  submit(): void {
    const k = this.key.trim();
    if (k) this.ref.close(k);
  }

  cancel(): void { this.ref.close(undefined); }
}

/** Lazy-loaded login-history state for one expanded user row. */
interface LoginHistory {
  loading: boolean;
  loaded: boolean;
  error: boolean;
  events: LoginEvent[];
}

/** Lazy-loaded chat-contacts (circle) state for one expanded user row. Only shown to contact managers. */
interface ContactsState {
  loading: boolean;
  loaded: boolean;
  error: boolean;
  /** That user's current contacts. */
  contacts: ChatContactDto[];
  /** Search box for the add-control (filters the directory). */
  query: string;
  /** AppUser id currently being added/removed (disables that control + shows progress). */
  busyUserId: number | null;
}

/** A catalog group with its ordered permission items — drives the grouped matrix columns. */
interface PermGroup {
  name: string;
  perms: PermissionItem[];
}

@Component({
  selector: 'app-users',
  imports: [
    CommonModule, FormsModule, MatCardModule, MatFormFieldModule, MatInputModule, MatButtonModule,
    MatIconModule, MatCheckboxModule, MatSlideToggleModule, MatProgressBarModule, MatProgressSpinnerModule, MatTooltipModule, MatSnackBarModule,
    MatDialogModule,
  ],
  templateUrl: './users.html',
  styleUrl: './users.scss',
})
export class Users {
  private api = inject(Api);
  private snack = inject(MatSnackBar);
  private dialog = inject(MatDialog);
  readonly auth = inject(AuthService);
  readonly PERM = PERM;

  // ---- Email reveal (gated by a key) ----
  // The key lives in COMPONENT MEMORY ONLY — never localStorage, never a URL. Null => emails are masked.
  private revealKey: string | null = null;
  /** True once a key has yielded real emails — drives the toggle label/icon + masked placeholders. */
  readonly emailsRevealed = signal(false);
  /** In-flight guard for the reveal/hide re-fetch (disables the toggle, shows progress). */
  readonly revealing = signal(false);

  /** The caller's own email, used to detect a successful reveal (their own email is always returned real). */
  private get myEmail(): string | null {
    return this.auth.session()?.email?.toLowerCase() ?? null;
  }

  readonly perms = signal<PermissionItem[]>([]);
  readonly users = signal<ManagedUser[]>([]);
  readonly audit = signal<AuditEntry[]>([]);
  readonly loading = signal(true);
  readonly savingId = signal<number | null>(null);
  // The user currently being force-logged-out (disables that row's Sign-out control + shows busy state).
  readonly loggingOutId = signal<number | null>(null);

  // Per-user login history: which rows are expanded + their lazy-loaded sign-in logs (keyed by user id).
  readonly expanded = signal<Set<number>>(new Set());
  readonly logins = signal<Map<number, LoginHistory>>(new Map());

  // Per-user chat contacts (the circle), lazy-loaded on first expand (keyed by user id). Only loaded
  // for managers — gated by chat.contacts.manage, same gate the backend enforces.
  readonly contacts = signal<Map<number, ContactsState>>(new Map());
  // The chat directory (all enabled users except the caller), loaded once for the add-control search.
  readonly directory = signal<ChatContactDto[]>([]);
  private directoryLoaded = false;
  /** Polite SR announcement for the contacts editor (add/remove); read by an aria-live region. */
  readonly contactsStatus = signal('');
  /** Visible only to contact managers; mirrors the chat.contacts.manage backend gate. */
  readonly canManageContacts = computed(() => this.auth.hasPermission(PERM.chatContactsManage));
  /**
   * The in-row contacts editor is now keyed by AppUser id and renders only display names (email-privacy
   * slice 3B) — no other-user address is fetched or shown — so it no longer needs the email-reveal gate.
   * It's shown to any contact manager; the login-history part of the expanded row stays visible regardless.
   */
  readonly canEditContacts = computed(() => this.canManageContacts());

  // new-user form
  readonly newEmail = signal('');
  readonly newEnabled = signal(true);
  readonly newPerms = signal<Set<string>>(new Set([PERM.dashboardView]));
  readonly adding = signal(false);

  // access policy (open sign-up + default permissions)
  readonly policy = signal<AccessPolicy | null>(null);
  readonly policyPerms = signal<Set<string>>(new Set());
  readonly savingPolicy = signal(false);
  readonly canManage = computed(() => this.auth.hasPermission(PERM.usersManage));

  /**
   * Permission catalog grouped by UI group, in catalog order. Groups follow PERM_GROUP_ORDER;
   * any keys without a known group fall into a trailing "Other" bucket so nothing is dropped.
   */
  readonly groups = computed<PermGroup[]>(() => {
    const byGroup = new Map<string, PermissionItem[]>();
    for (const p of this.perms()) {
      const g = PERM_GROUP_OF[p.key] ?? 'Other';
      (byGroup.get(g) ?? byGroup.set(g, []).get(g)!).push(p);
    }
    const ordered: PermGroup[] = [];
    for (const name of PERM_GROUP_ORDER) {
      const perms = byGroup.get(name);
      if (perms?.length) { ordered.push({ name, perms }); byGroup.delete(name); }
    }
    // Any leftover groups (e.g. "Other" or future groups) appended in encounter order.
    for (const [name, perms] of byGroup) if (perms.length) ordered.push({ name, perms });
    return ordered;
  });

  /**
   * Catalog groups for the default-permissions picker. Excludes users.manage: the server refuses to
   * store it as a default (open sign-up must never auto-grant admin), so we don't offer it here.
   */
  readonly policyGroups = computed<PermGroup[]>(() =>
    this.groups()
      .map(g => ({ name: g.name, perms: g.perms.filter(p => p.key !== PERM.usersManage) }))
      .filter(g => g.perms.length),
  );

  /** Total <td> count of a body row — drives the colspan of the expanded login-history sub-row. */
  readonly columnCount = computed(() =>
    2 + this.groups().reduce((n, g) => n + g.perms.length, 0) + 2, // User + Enabled + perms + Expand + Actions
  );

  constructor() { this.load(); }

  private load(): void {
    this.loading.set(true);
    forkJoin({ perms: this.api.permissionCatalog(), users: this.api.users(this.revealKey ?? undefined) }).subscribe({
      next: r => { this.perms.set(r.perms); this.users.set(r.users); this.loading.set(false); },
      error: () => { this.loading.set(false); this.snack.open('Failed to load users', 'Dismiss', { duration: 4000 }); },
    });
    this.loadAudit();
    this.loadPolicy();
  }

  private loadPolicy(): void {
    this.api.getAccessPolicy().subscribe({
      next: p => { this.policy.set(p); this.policyPerms.set(new Set(p.defaultPermissions)); },
      error: () => { /* non-critical — panel hides if policy unavailable */ },
    });
  }

  private loadAudit(): void {
    this.api.auditLog(this.revealKey ?? undefined).subscribe({ next: a => this.audit.set(a), error: () => { /* non-critical */ } });
  }

  // ---- Email-reveal toggle ----

  /** Toggle entry point: prompt for a key when hidden; clear + re-fetch (masked) when revealed. */
  toggleEmails(): void {
    if (this.emailsRevealed()) { this.hideEmails(); return; }
    this.promptForKey();
  }

  /** Open the key prompt; on submit, re-fetch users + audit WITH the key and verify the reveal worked. */
  private promptForKey(): void {
    const ref = this.dialog.open(EmailRevealDialog, { width: '380px', autoFocus: 'dialog', restoreFocus: true });
    ref.afterClosed().subscribe((key: string | undefined) => {
      if (!key) return; // cancelled
      this.applyRevealKey(key);
    });
  }

  /**
   * Re-fetch users + audit with the candidate key. The server returns real emails only when the key is
   * correct; the caller's OWN email is always real, so we confirm success by checking that SOME OTHER
   * user's email came back non-null (or, in a single-user tenant, that any audit email did). Wrong key
   * => everything but our own row stays null => snackbar + stay hidden.
   */
  private applyRevealKey(key: string): void {
    this.revealing.set(true);
    forkJoin({ users: this.api.users(key), audit: this.api.auditLog(key) }).subscribe({
      next: ({ users, audit }) => {
        this.revealing.set(false);
        if (this.didReveal(users, audit)) {
          this.revealKey = key;
          this.users.set(users);
          this.audit.set(audit);
          this.emailsRevealed.set(true);
          this.snack.open('Emails revealed', 'OK', { duration: 2000 });
        } else {
          this.revealKey = null;
          this.snack.open('Incorrect key', 'Dismiss', { duration: 4000 });
        }
      },
      error: () => {
        this.revealing.set(false);
        this.snack.open('Incorrect key', 'Dismiss', { duration: 4000 });
      },
    });
  }

  /**
   * Did the key actually unmask anything? True if any email belonging to someone OTHER than the caller
   * came back non-null (their own email is always real, so it can't confirm the key). Falls back to the
   * audit log's actor/target emails so a single-admin tenant can still confirm a correct key.
   */
  private didReveal(users: ManagedUser[], audit: AuditEntry[]): boolean {
    const mine = this.myEmail;
    const isOther = (e: string | null) => !!e && e.toLowerCase() !== mine;
    return users.some(u => isOther(u.email))
      || audit.some(a => isOther(a.actorEmail) || isOther(a.targetEmail));
  }

  /** Clear the in-memory key and re-fetch masked (emails back to hidden). */
  private hideEmails(): void {
    this.revealKey = null;
    this.emailsRevealed.set(false);
    this.load();
  }

  // ---- Per-user login history (expandable rows, lazy-loaded on first expand) ----
  isExpanded(id: number): boolean { return this.expanded().has(id); }

  loginHistory(id: number): LoginHistory | undefined { return this.logins().get(id); }

  toggleExpand(u: ManagedUser): void {
    const next = new Set(this.expanded());
    if (next.has(u.id)) {
      next.delete(u.id);
    } else {
      next.add(u.id);
      // Lazy-load on first expand only; cached thereafter (and across collapses).
      if (!this.logins().has(u.id)) this.loadLogins(u.id);
      // Contacts editor loads for any contact manager (now userId-keyed, name-only — no email reveal
      // needed); same lazy-once pattern.
      if (this.canEditContacts()) {
        if (!this.contacts().has(u.id)) this.loadContacts(u);
        this.ensureDirectory();
      }
    }
    this.expanded.set(next);
  }

  private setLoginHistory(id: number, state: LoginHistory): void {
    this.logins.update(m => new Map(m).set(id, state));
  }

  private loadLogins(id: number): void {
    this.setLoginHistory(id, { loading: true, loaded: false, error: false, events: [] });
    this.api.userLogins(id).subscribe({
      next: events => this.setLoginHistory(id, { loading: false, loaded: true, error: false, events }),
      error: () => this.setLoginHistory(id, { loading: false, loaded: true, error: true, events: [] }),
    });
  }

  // ---- Per-user chat contacts (the circle) — admin editor in the expanded row (chat.contacts.manage) ----
  contactsState(id: number): ContactsState | undefined { return this.contacts().get(id); }

  private setContactsState(id: number, patch: Partial<ContactsState>): void {
    this.contacts.update(m => {
      const prev = m.get(id) ?? { loading: false, loaded: false, error: false, contacts: [], query: '', busyUserId: null };
      return new Map(m).set(id, { ...prev, ...patch });
    });
  }

  private loadContacts(u: ManagedUser): void {
    // Addressed by AppUser id (email-privacy); the editor renders display names only.
    this.setContactsState(u.id, { loading: true, loaded: false, error: false, contacts: [], query: '', busyUserId: null });
    this.api.userContacts(u.id).subscribe({
      next: contacts => this.setContactsState(u.id, { loading: false, loaded: true, error: false, contacts }),
      error: () => this.setContactsState(u.id, { loading: false, loaded: true, error: true, contacts: [] }),
    });
  }

  /** Fetch the directory once (the add-control's search pool). Failure is non-fatal — the list stays empty. */
  private ensureDirectory(): void {
    if (this.directoryLoaded) return;
    this.directoryLoaded = true;
    this.api.chatDirectory().subscribe({
      next: dir => this.directory.set(dir),
      error: () => { this.directoryLoaded = false; /* allow a retry on next expand */ },
    });
  }

  setContactsQuery(id: number, q: string): void { this.setContactsState(id, { query: q }); }

  /**
   * Directory candidates for a user's add-control: everyone in the directory except the user themselves
   * and anyone already in their circle, filtered by the search box. Identity is by AppUser id; the
   * filter matches display name only (no email is carried).
   */
  addCandidates(u: ManagedUser): ChatContactDto[] {
    const state = this.contactsState(u.id);
    const have = new Set((state?.contacts ?? []).map(c => c.userId));
    const q = (state?.query ?? '').trim().toLowerCase();
    return this.directory()
      .filter(c => c.userId !== u.id && !have.has(c.userId))
      .filter(c => !q || c.name.toLowerCase().includes(q));
  }

  addContact(u: ManagedUser, contactUserId: number): void {
    const added = this.directory().find(c => c.userId === contactUserId);
    this.setContactsState(u.id, { busyUserId: contactUserId });
    this.api.addUserContact(u.id, contactUserId).subscribe({
      next: contacts => {
        this.setContactsState(u.id, { contacts, query: '', busyUserId: null });
        this.contactsStatus.set(`Added ${added?.name || 'contact'} to circle.`);
        this.loadAudit();
      },
      error: (err: HttpErrorResponse) => {
        this.setContactsState(u.id, { busyUserId: null });
        this.snack.open(err.error?.message ?? 'Could not add contact', 'Dismiss', { duration: 5000 });
      },
    });
  }

  removeContact(u: ManagedUser, contactUserId: number): void {
    const removed = this.contactsState(u.id)?.contacts.find(c => c.userId === contactUserId);
    this.setContactsState(u.id, { busyUserId: contactUserId });
    this.api.removeUserContact(u.id, contactUserId).subscribe({
      next: contacts => {
        this.setContactsState(u.id, { contacts, busyUserId: null });
        this.contactsStatus.set(`Removed ${removed?.name || 'contact'} from circle.`);
        this.loadAudit();
      },
      error: (err: HttpErrorResponse) => {
        this.setContactsState(u.id, { busyUserId: null });
        this.snack.open(err.error?.message ?? 'Could not remove contact', 'Dismiss', { duration: 5000 });
      },
    });
  }

  /** Two-letter initials for a contact avatar fallback (display name only — no email). */
  contactInitials(c: ChatContactDto): string {
    const parts = (c.name || '').split(/[\s@.]+/).filter(Boolean);
    return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || 'U';
  }

  /** First-letter avatar fallback for a managed user (name first, email next, else "?"). Null-safe. */
  userInitial(u: ManagedUser): string {
    return ((u.name || u.email || '?').charAt(0) || '?').toUpperCase();
  }

  /** Whether a managed user's email is currently masked (null) — drives the masked-chip placeholder. */
  isMasked(u: ManagedUser): boolean { return u.email == null; }

  /** A human label for a user in toasts/confirms that never shows null — email if present, else name, else id. */
  private userLabel(u: ManagedUser): string { return u.email || u.name || `user #${u.id}`; }

  hasPerm(u: ManagedUser, key: string): boolean { return u.permissions.includes(key); }

  togglePerm(u: ManagedUser, key: string, checked: boolean): void {
    u.permissions = checked
      ? [...new Set([...u.permissions, key])]
      : u.permissions.filter(p => p !== key);
  }

  save(u: ManagedUser): void {
    this.savingId.set(u.id);
    this.api.updateUser(u.id, { name: u.name, isEnabled: u.isEnabled, permissions: u.permissions }).subscribe({
      next: updated => {
        this.savingId.set(null);
        this.users.update(list => list.map(x => x.id === updated.id ? updated : x));
        this.loadAudit();
        this.snack.open(`Saved ${this.userLabel(u)}`, 'OK', { duration: 2500 });
      },
      error: (err: HttpErrorResponse) => {
        this.savingId.set(null);
        this.snack.open(err.error?.message ?? 'Save failed', 'Dismiss', { duration: 5000 });
        this.load();
      },
    });
  }

  /**
   * Force-log a user out of their current session (invalidates their active JWT). Non-destructive: the
   * account stays enabled and they can sign back in immediately — distinct from Disable, which blocks re-login.
   */
  forceLogout(u: ManagedUser): void {
    this.loggingOutId.set(u.id);
    this.api.forceLogout(u.id).subscribe({
      next: () => {
        this.loggingOutId.set(null);
        this.loadAudit();
        this.snack.open(`Signed ${u.name || this.userLabel(u)} out of their sessions.`, 'OK', { duration: 2500 });
      },
      error: (err: HttpErrorResponse) => {
        this.loggingOutId.set(null);
        this.snack.open(err.error?.message ?? 'Could not sign user out', 'Dismiss', { duration: 5000 });
      },
    });
  }

  remove(u: ManagedUser): void {
    if (!confirm(`Remove ${this.userLabel(u)}? They will lose access immediately.`)) return;
    this.api.deleteUser(u.id).subscribe({
      next: () => {
        this.users.update(list => list.filter(x => x.id !== u.id));
        this.loadAudit();
        this.snack.open(`Removed ${this.userLabel(u)}`, 'OK', { duration: 2500 });
      },
      error: (err: HttpErrorResponse) => this.snack.open(err.error?.message ?? 'Delete failed', 'Dismiss', { duration: 5000 }),
    });
  }

  newHasPerm(key: string): boolean { return this.newPerms().has(key); }

  toggleNewPerm(key: string, checked: boolean): void {
    const set = new Set(this.newPerms());
    if (checked) set.add(key); else set.delete(key);
    this.newPerms.set(set);
  }

  addUser(): void {
    const email = this.newEmail().trim().toLowerCase();
    if (!email.includes('@')) { this.snack.open('Enter a valid email address', 'Dismiss', { duration: 3000 }); return; }
    this.adding.set(true);
    this.api.createUser({ email, isEnabled: this.newEnabled(), permissions: [...this.newPerms()] }).subscribe({
      next: u => {
        this.adding.set(false);
        this.users.update(list => [...list, u].sort((a, b) => (a.email ?? a.name).localeCompare(b.email ?? b.name)));
        this.newEmail.set('');
        this.newEnabled.set(true);
        this.newPerms.set(new Set([PERM.dashboardView]));
        this.loadAudit();
        this.snack.open(`Added ${u.email}`, 'OK', { duration: 2500 });
      },
      error: (err: HttpErrorResponse) => {
        this.adding.set(false);
        this.snack.open(err.error?.message ?? 'Could not add user', 'Dismiss', { duration: 5000 });
      },
    });
  }

  // ---- Access policy ----
  setOpenSignup(enabled: boolean): void {
    this.policy.update(p => p ? { ...p, openSignupEnabled: enabled } : p);
  }

  policyHasPerm(key: string): boolean { return this.policyPerms().has(key); }

  togglePolicyPerm(key: string, checked: boolean): void {
    const set = new Set(this.policyPerms());
    if (checked) set.add(key); else set.delete(key);
    this.policyPerms.set(set);
  }

  savePolicy(): void {
    const p = this.policy();
    if (!p) return;
    this.savingPolicy.set(true);
    const body: AccessPolicy = { openSignupEnabled: p.openSignupEnabled, defaultPermissions: [...this.policyPerms()] };
    this.api.updateAccessPolicy(body).subscribe({
      next: saved => {
        this.savingPolicy.set(false);
        this.policy.set(saved);
        this.policyPerms.set(new Set(saved.defaultPermissions));
        this.loadAudit();
        this.snack.open('Access policy saved', 'OK', { duration: 2500 });
      },
      error: (err: HttpErrorResponse) => {
        this.savingPolicy.set(false);
        this.snack.open(err.error?.message ?? 'Could not save access policy', 'Dismiss', { duration: 5000 });
      },
    });
  }
}
