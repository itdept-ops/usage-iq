import { CommonModule } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';

import { Api } from '../../core/api';
import { AuthService } from '../../core/auth';
import { Fleet as FleetModel, FleetMachine, FleetUser, UsageFilter } from '../../core/models';
import { CompactPipe, timeAgo } from '../../shared/format';

type Board = 'machines' | 'users';

/**
 * Fleet leaderboards: two cost-ranked tables — Machines and Users — over the filtered range, each row
 * expandable to reveal the linked users/machines. Reachable by dashboard.view or reporter.view|manage.
 * A lightweight date-range filter (reusing the dashboard's quick-range conventions) scopes the rollup.
 */
@Component({
  selector: 'app-fleet',
  imports: [
    CommonModule, FormsModule,
    MatCardModule, MatButtonModule, MatButtonToggleModule, MatFormFieldModule, MatInputModule,
    MatIconModule, MatTooltipModule, MatProgressBarModule, MatSnackBarModule,
    CompactPipe,
  ],
  templateUrl: './fleet.html',
  styleUrl: './fleet.scss',
})
export class Fleet {
  private api = inject(Api);
  private snack = inject(MatSnackBar);
  readonly auth = inject(AuthService);

  // ---- filter state (date range only — fleet is a coarse roll-up) ----
  readonly filter = signal<UsageFilter>({ from: null, to: null, projectIds: [], models: [], sources: [], includeSidechain: true });
  readonly activePreset = signal<string>('all');
  readonly presets = [
    { key: '7d', label: '7d' }, { key: '30d', label: '30d' }, { key: '90d', label: '90d' },
    { key: 'mtd', label: 'Month' }, { key: 'all', label: 'All' },
  ] as const;

  readonly fleet = signal<FleetModel | null>(null);
  readonly loading = signal(false);

  /** Which leaderboard the table shows; both come from the same payload. */
  readonly board = signal<Board>('machines');

  /** Expanded row keys per board (machine name / user email). */
  private readonly expandedMachines = signal<Set<string>>(new Set());
  private readonly expandedUsers = signal<Set<string>>(new Set());

  // Cost-desc ordering (the API may already sort, but we enforce it for a stable view).
  readonly machines = computed<FleetMachine[]>(() =>
    [...(this.fleet()?.machines ?? [])].sort((a, b) => b.costUsd - a.costUsd));
  readonly users = computed<FleetUser[]>(() =>
    [...(this.fleet()?.users ?? [])].sort((a, b) => b.costUsd - a.costUsd));

  readonly totals = computed(() => {
    const m = this.machines();
    const u = this.users();
    return {
      machineCount: m.length,
      userCount: u.length,
      records: m.reduce((a, x) => a + x.records, 0),
      tokens: m.reduce((a, x) => a + x.tokens, 0),
      cost: m.reduce((a, x) => a + x.costUsd, 0),
    };
  });

  /** The cost of the top row on the active board — drives the relative spend bars. */
  readonly maxCost = computed(() => {
    const rows = this.board() === 'machines' ? this.machines() : this.users();
    return rows.reduce((a, r) => Math.max(a, r.costUsd), 0) || 1;
  });

  constructor() {
    this.reload();
  }

  private reload(): void {
    this.loading.set(true);
    this.api.fleet(this.filter()).subscribe({
      next: f => { this.fleet.set(f); this.loading.set(false); },
      error: () => { this.loading.set(false); this.snack.open('Failed to load fleet — is the API running?', 'Dismiss', { duration: 5000 }); },
    });
  }

  patch<K extends keyof UsageFilter>(key: K, value: UsageFilter[K]): void {
    this.filter.update(f => ({ ...f, [key]: value }));
  }

  applyFilters(): void { this.reload(); }

  resetFilters(): void {
    this.filter.set({ from: null, to: null, projectIds: [], models: [], sources: [], includeSidechain: true });
    this.activePreset.set('all');
    this.reload();
  }

  setDatePreset(kind: string): void {
    const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const today = new Date();
    let from: string | null = null;
    if (kind === 'mtd') {
      from = fmt(new Date(today.getFullYear(), today.getMonth(), 1));
    } else if (kind !== 'all') {
      const days = kind === '7d' ? 6 : kind === '30d' ? 29 : 89;
      const d = new Date(today);
      d.setDate(d.getDate() - days);
      from = fmt(d);
    }
    const to = kind === 'all' ? null : fmt(today);
    this.activePreset.set(kind);
    this.filter.update(f => ({ ...f, from, to }));
    this.reload();
  }

  // ---- expand / collapse ----
  isExpanded(key: string): boolean {
    return (this.board() === 'machines' ? this.expandedMachines() : this.expandedUsers()).has(key);
  }

  toggle(key: string): void {
    const sig = this.board() === 'machines' ? this.expandedMachines : this.expandedUsers;
    const next = new Set(sig());
    next.has(key) ? next.delete(key) : next.add(key);
    sig.set(next);
  }

  /** Width % for a row's relative-spend bar. */
  costPct(cost: number): number {
    return Math.max(2, Math.round((cost / this.maxCost()) * 100));
  }

  seen(iso: string | null): string { return timeAgo(iso); }

  /** "local" is the synthetic file-sync bucket — surface it as such rather than a real host/user. */
  isLocal(name: string): boolean { return name === 'local'; }
}
