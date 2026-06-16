import { CommonModule } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';

import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';

import { Api } from '../../core/api';
import { AuthService } from '../../core/auth';
import { IngestKey, IngestKeyCreated, PERM } from '../../core/models';

/**
 * Setup guide + ingest-key management for the remote reporter (cloud-hosting flow). Reachable by any
 * of reporter.view / reporter.manage / reporter.self (route guard + nav link). A `reporter.manage`
 * caller sees and acts on every key (with an owner column); a `reporter.self` caller manages only
 * their own keys and gets a short "get your own token" explainer. The ingest endpoints enforce the
 * same ownership rules server-side.
 */
@Component({
  selector: 'app-reporter',
  imports: [
    CommonModule, FormsModule, MatCardModule, MatButtonModule, MatIconModule,
    MatFormFieldModule, MatInputModule, MatSnackBarModule,
  ],
  templateUrl: './reporter.html',
  styleUrl: './reporter.scss',
})
export class ReporterPage {
  private api = inject(Api);
  private snack = inject(MatSnackBar);
  readonly auth = inject(AuthService);
  readonly PERM = PERM;

  /** Full-fleet management (can see/revoke every key and the owner column). */
  readonly canManage = computed(() => this.auth.hasPermission(PERM.reporterManage));
  /** May create/revoke own keys (true for both self-service and full-manage callers). */
  readonly canCreate = computed(() => this.auth.hasAnyPermission(PERM.reporterManage, PERM.reporterSelf));
  /** Self-service only (own keys) — drives the "get your own token" explainer. */
  readonly selfServiceOnly = computed(() => this.canCreate() && !this.canManage());

  /** This dashboard's origin is exactly the reporter's `--url` value. */
  readonly serverUrl = signal(window.location.origin);

  // ---- Ingest keys ----
  readonly ingestKeys = signal<IngestKey[]>([]);
  readonly newKeyName = signal('');
  readonly generatingKey = signal(false);
  /** The most recently generated key — shown once, then dismissed (never re-fetchable). */
  readonly freshKey = signal<IngestKeyCreated | null>(null);
  readonly copied = signal(false);

  /** A fully copy-pasteable run command — uses the just-generated key if present. */
  readonly runCommand = computed(() => {
    const key = this.freshKey()?.key ?? '<your-key>';
    return `usage-iq-reporter --url ${this.serverUrl()} --key ${key}`;
  });
  readonly dotnetRunCommand = computed(() => {
    const key = this.freshKey()?.key ?? '<your-key>';
    return `dotnet run --project src/Reporter -- --url ${this.serverUrl()} --key ${key}`;
  });

  constructor() {
    this.loadIngestKeys();
  }

  /** True when a key is owned by the signed-in caller (case-insensitive email match). */
  isMine(k: IngestKey): boolean {
    const me = this.auth.session()?.email?.toLowerCase();
    return !!me && k.ownerEmail?.toLowerCase() === me;
  }

  private loadIngestKeys(): void {
    this.api.ingestKeys().subscribe({ next: k => this.ingestKeys.set(k), error: () => { /* non-critical */ } });
  }

  generateKey(): void {
    if (this.generatingKey()) return;
    this.generatingKey.set(true);
    this.api.createIngestKey(this.newKeyName().trim()).subscribe({
      next: k => {
        this.generatingKey.set(false);
        this.freshKey.set(k);
        this.copied.set(false);
        this.newKeyName.set('');
        this.loadIngestKeys();
      },
      error: (e: HttpErrorResponse) => {
        this.generatingKey.set(false);
        this.snack.open(e.error?.message ?? 'Could not generate key', 'Dismiss', { duration: 5000 });
      },
    });
  }

  copyKey(): void {
    const k = this.freshKey();
    if (k) this.copy(k.key, 'Key copied').then(ok => this.copied.set(ok));
  }

  dismissFreshKey(): void {
    this.freshKey.set(null);
    this.copied.set(false);
  }

  revokeKey(k: IngestKey): void {
    this.api.revokeIngestKey(k.id).subscribe({
      next: () => { this.snack.open(`Revoked "${k.name}"`, 'OK', { duration: 2500 }); this.loadIngestKeys(); },
      error: () => this.snack.open('Revoke failed', 'Dismiss', { duration: 4000 }),
    });
  }

  /** Copy arbitrary text (command snippets) with a toast; returns whether it succeeded. */
  copy(text: string, label = 'Copied'): Promise<boolean> {
    return (navigator.clipboard?.writeText(text) ?? Promise.reject()).then(
      () => { this.snack.open(label, 'OK', { duration: 2000 }); return true; },
      () => { this.snack.open('Copy failed — select and copy manually', 'Dismiss', { duration: 4000 }); return false; },
    );
  }
}
