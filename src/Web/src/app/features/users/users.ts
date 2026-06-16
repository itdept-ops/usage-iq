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
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';

import { Api } from '../../core/api';
import { AuthService } from '../../core/auth';
import {
  AccessPolicy, AuditEntry, LoginEvent, ManagedUser, PermissionItem, PERM, PERM_GROUP_OF, PERM_GROUP_ORDER,
} from '../../core/models';

/** Lazy-loaded login-history state for one expanded user row. */
interface LoginHistory {
  loading: boolean;
  loaded: boolean;
  error: boolean;
  events: LoginEvent[];
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
    MatIconModule, MatCheckboxModule, MatSlideToggleModule, MatProgressBarModule, MatTooltipModule, MatSnackBarModule,
  ],
  templateUrl: './users.html',
  styleUrl: './users.scss',
})
export class Users {
  private api = inject(Api);
  private snack = inject(MatSnackBar);
  readonly auth = inject(AuthService);
  readonly PERM = PERM;

  readonly perms = signal<PermissionItem[]>([]);
  readonly users = signal<ManagedUser[]>([]);
  readonly audit = signal<AuditEntry[]>([]);
  readonly loading = signal(true);
  readonly savingId = signal<number | null>(null);

  // Per-user login history: which rows are expanded + their lazy-loaded sign-in logs (keyed by user id).
  readonly expanded = signal<Set<number>>(new Set());
  readonly logins = signal<Map<number, LoginHistory>>(new Map());

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
    forkJoin({ perms: this.api.permissionCatalog(), users: this.api.users() }).subscribe({
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
    this.api.auditLog().subscribe({ next: a => this.audit.set(a), error: () => { /* non-critical */ } });
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
        this.snack.open(`Saved ${u.email}`, 'OK', { duration: 2500 });
      },
      error: (err: HttpErrorResponse) => {
        this.savingId.set(null);
        this.snack.open(err.error?.message ?? 'Save failed', 'Dismiss', { duration: 5000 });
        this.load();
      },
    });
  }

  remove(u: ManagedUser): void {
    if (!confirm(`Remove ${u.email}? They will lose access immediately.`)) return;
    this.api.deleteUser(u.id).subscribe({
      next: () => {
        this.users.update(list => list.filter(x => x.id !== u.id));
        this.loadAudit();
        this.snack.open(`Removed ${u.email}`, 'OK', { duration: 2500 });
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
        this.users.update(list => [...list, u].sort((a, b) => a.email.localeCompare(b.email)));
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
