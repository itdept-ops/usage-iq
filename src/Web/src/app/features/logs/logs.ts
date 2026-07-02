import { CommonModule } from '@angular/common';
import { Component, inject, signal, computed, ChangeDetectionStrategy } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';

import { Api } from '../../core/api';
import { RequestLogEntry } from '../../core/models';

@Component({
  selector: 'app-logs',
  imports: [
    CommonModule,
    FormsModule,
    MatCardModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatButtonModule,
    MatIconModule,
    MatProgressBarModule,
    MatTooltipModule,
    MatSnackBarModule,
  ],
  templateUrl: './logs.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './logs.scss',
})
export class Logs {
  private api = inject(Api);
  private snack = inject(MatSnackBar);

  readonly logs = signal<RequestLogEntry[]>([]);
  readonly loading = signal(true);
  readonly expandedId = signal<number | null>(null);

  /** How many rows to render at once; grows via showMore() to avoid dirty-checking all ~300 rows. */
  private static readonly PAGE_SIZE = 50;
  readonly visibleCount = signal(Logs.PAGE_SIZE);
  readonly visibleLogs = computed(() => this.logs().slice(0, this.visibleCount()));

  readonly method = signal('');
  readonly status = signal('');
  readonly q = signal('');

  readonly methods = ['GET', 'POST', 'PUT', 'DELETE'];
  readonly statuses = [
    { v: '', l: 'All statuses' },
    { v: '2xx', l: '2xx success' },
    { v: '3xx', l: '3xx redirect' },
    { v: '4xx', l: '4xx client' },
    { v: '5xx', l: '5xx server' },
  ];

  constructor() {
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.visibleCount.set(Logs.PAGE_SIZE);
    this.api
      .requestLogs({ method: this.method(), status: this.status(), q: this.q().trim(), take: 300 })
      .subscribe({
        next: (r) => {
          this.logs.set(r);
          this.loading.set(false);
        },
        error: () => {
          this.loading.set(false);
          this.snack.open('Failed to load logs', 'Dismiss', { duration: 4000 });
        },
      });
  }

  toggle(id: number): void {
    this.expandedId.set(this.expandedId() === id ? null : id);
  }

  showMore(): void {
    this.visibleCount.update((n) => n + Logs.PAGE_SIZE);
  }

  statusClass(code: number): string {
    if (code >= 500) return 'st-5xx';
    if (code >= 400) return 'st-4xx';
    if (code >= 300) return 'st-3xx';
    return 'st-2xx';
  }

  fmtBytes(n: number | null): string {
    if (n == null) return '—';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  /** Pretty-print a JSON body for display; fall back to the raw string. */
  pretty(body: string | null): string {
    if (!body) return '';
    try {
      return JSON.stringify(JSON.parse(body), null, 2);
    } catch {
      return body;
    }
  }
}
