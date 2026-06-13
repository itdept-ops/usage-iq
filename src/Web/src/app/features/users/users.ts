import { CommonModule } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
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
import { ManagedUser, PermissionItem, PERM } from '../../core/models';

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

  readonly perms = signal<PermissionItem[]>([]);
  readonly users = signal<ManagedUser[]>([]);
  readonly loading = signal(true);
  readonly savingId = signal<number | null>(null);

  // new-user form
  readonly newEmail = signal('');
  readonly newEnabled = signal(true);
  readonly newPerms = signal<Set<string>>(new Set([PERM.dashboardView]));
  readonly adding = signal(false);

  constructor() { this.load(); }

  private load(): void {
    this.loading.set(true);
    forkJoin({ perms: this.api.permissionCatalog(), users: this.api.users() }).subscribe({
      next: r => { this.perms.set(r.perms); this.users.set(r.users); this.loading.set(false); },
      error: () => { this.loading.set(false); this.snack.open('Failed to load users', 'Dismiss', { duration: 4000 }); },
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
        this.snack.open(`Added ${u.email}`, 'OK', { duration: 2500 });
      },
      error: (err: HttpErrorResponse) => {
        this.adding.set(false);
        this.snack.open(err.error?.message ?? 'Could not add user', 'Dismiss', { duration: 5000 });
      },
    });
  }
}
