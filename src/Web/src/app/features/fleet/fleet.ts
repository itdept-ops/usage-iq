import { CommonModule } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';

import { Api } from '../../core/api';
import { AuthService } from '../../core/auth';
import { Fleet as FleetModel, FleetDimension, FleetMachine, FleetUser, PERM, UsageFilter } from '../../core/models';
import { CompactPipe, timeAgo } from '../../shared/format';
import { FleetAction, FleetActionData, FleetActionDialog, FleetActionResult } from './fleet-action-dialog';

type Board = 'machines' | 'users';

/**
 * Fleet leaderboards: two cost-ranked tables — Machines and Users — over the filtered range, each row
 * expandable to reveal the linked users/machines. Reachable by fleet.view or reporter.manage.
 * A lightweight date-range filter (reusing the dashboard's quick-range conventions) scopes the rollup.
 */
@Component({
  selector: 'app-fleet',
  imports: [
    CommonModule, FormsModule,
    MatCardModule, MatButtonModule, MatButtonToggleModule, MatFormFieldModule, MatInputModule,
    MatIconModule, MatMenuModule, MatTooltipModule, MatProgressBarModule, MatSnackBarModule, MatDialogModule,
    CompactPipe,
  ],
  templateUrl: './fleet.html',
  styleUrl: './fleet.scss',
})
export class Fleet {
  private api = inject(Api);
  private snack = inject(MatSnackBar);
  private dialog = inject(MatDialog);
  readonly auth = inject(AuthService);

  /** Row-level management (combine/move, delete, revoke). The board is read-only without it. */
  readonly canManage = computed(() => this.auth.hasPermission(PERM.reporterManage));

  // ---- filter state (date range only — fleet is a coarse roll-up) ----
  readonly filter = signal<UsageFilter>({ from: null, to: null, projectIds: [], models: [], sources: [], machine: [], includeSidechain: true });
  readonly activePreset = signal<string>('all');
  readonly presets = [
    { key: '7d', label: '7d' }, { key: '30d', label: '30d' }, { key: '90d', label: '90d' },
    { key: 'mtd', label: 'Month' }, { key: 'all', label: 'All' },
  ] as const;

  readonly fleet = signal<FleetModel | null>(null);
  readonly loading = signal(false);

  /** Which leaderboard the table shows; both come from the same payload. */
  readonly board = signal<Board>('machines');

  /** Expanded row keys per board (machine name / stable user key). */
  private readonly expandedMachines = signal<Set<string>>(new Set());
  private readonly expandedUsers = signal<Set<string>>(new Set());

  /** Stable, non-email key for a user row (the userId when present, else keyed by the
   *  local/orphan bucket name so the local row and each "Unknown user" row stay distinct). */
  userKey(u: FleetUser): string { return u.userId != null ? 'u' + u.userId : 'n:' + u.name; }

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
    this.filter.set({ from: null, to: null, projectIds: [], models: [], sources: [], machine: [], includeSidechain: true });
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

  /** "local" is the synthetic file-sync bucket — surface it as such rather than a real host/user.
   * For users this matches the resolved display name; for machines, the literal "local" row. */
  isLocal(name: string): boolean { return name === 'local'; }

  /**
   * Normalize the raw reporter `agent` kind into a display label for the details badge.
   * Known kinds are "desktop" (WPF tray) and "console" (CLI); anything else is shown verbatim
   * (title-cased), and null/blank means no metadata has been reported.
   */
  agentLabel(agent: string | null): string {
    const a = (agent ?? '').trim().toLowerCase();
    if (a === 'desktop') return 'Desktop';
    if (a === 'console') return 'Console';
    if (!a) return '';
    return agent!.charAt(0).toUpperCase() + agent!.slice(1);
  }

  // ---- management (reporter.manage) ----

  /**
   * Map a row's displayed name to the RAW dimension value the management endpoints expect: the "local"
   * bucket is the empty string server-side (no real host is literally named "local"); everything else is
   * sent verbatim. See the RAW-VALUE NOTE in the fleet contract.
   */
  private rawValue(displayName: string): string {
    return this.isLocal(displayName) ? '' : displayName;
  }

  private friendly(displayName: string): string {
    return this.isLocal(displayName) ? 'local (file sync)' : displayName;
  }

  /** The OTHER MACHINE buckets — combine/transfer targets for the machine reassign picker (raw names). */
  private otherMachineTargets(selfName: string): { rawValue: string; label: string; userId?: number | null }[] {
    return this.machines()
      .map(m => m.name)
      .filter(name => name !== selfName)
      .map(name => ({ rawValue: this.rawValue(name), label: this.friendly(name) }));
  }

  /** The OTHER USER buckets — combine/transfer targets for the user reassign picker (keyed by userId). */
  private otherUserTargets(self: FleetUser): { rawValue: string; label: string; userId?: number | null }[] {
    return this.users()
      .filter(u => this.userKey(u) !== this.userKey(self))
      .map(u => ({ rawValue: '', label: this.friendly(u.name), userId: u.userId ?? null }));
  }

  /** Open a MACHINE management dialog (raw machine names). */
  private openMachineAction(action: FleetAction, m: FleetMachine): void {
    if (!this.canManage()) return;
    const data: FleetActionData = {
      action, dimension: 'machine',
      rawValue: this.rawValue(m.name),
      label: this.friendly(m.name),
      records: m.records,
      others: action === 'reassign' ? this.otherMachineTargets(m.name) : [],
    };
    this.runDialog(data);
  }

  /** Open a USER management dialog (keyed by userId; no email reaches the client). */
  private openUserAction(action: FleetAction, u: FleetUser): void {
    if (!this.canManage()) return;
    const data: FleetActionData = {
      action, dimension: 'user',
      rawValue: '',
      userId: u.userId ?? null,
      label: this.friendly(u.name),
      records: u.records,
      others: action === 'reassign' ? this.otherUserTargets(u) : [],
    };
    this.runDialog(data);
  }

  /** Open the dialog with the prepared data; on success refresh the data and toast the count. */
  private runDialog(data: FleetActionData): void {
    this.dialog.open(FleetActionDialog, { data, width: '520px', maxWidth: '94vw', autoFocus: false })
      .afterClosed().subscribe((res: FleetActionResult | undefined) => {
        if (!res) return;
        this.toastResult(res, data.label);
        this.reload();
      });
  }

  private toastResult(res: FleetActionResult, label: string): void {
    const n = res.count;
    const msg = res.action === 'reassign'
      ? `Moved ${n.toLocaleString()} record${n === 1 ? '' : 's'} from "${label}".`
      : res.action === 'delete'
        ? `Deleted ${n.toLocaleString()} record${n === 1 ? '' : 's'} from "${label}".`
        : `Revoked ${n.toLocaleString()} key${n === 1 ? '' : 's'} for "${label}".`;
    this.snack.open(msg, 'OK', { duration: 4000 });
  }

  // Per-row entry points used by the row menu.
  combineMachine(m: FleetMachine): void { this.openMachineAction('reassign', m); }
  deleteMachine(m: FleetMachine): void { this.openMachineAction('delete', m); }
  combineUser(u: FleetUser): void { this.openUserAction('reassign', u); }
  deleteUser(u: FleetUser): void { this.openUserAction('delete', u); }
  revokeUser(u: FleetUser): void { this.openUserAction('revoke', u); }
}
