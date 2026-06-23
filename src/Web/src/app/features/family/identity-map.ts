import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import type { EChartsOption } from 'echarts';

import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';

import { Api } from '../../core/api';
import {
  IdentityAutoSignal, IdentityImportPreview, IdentityMapData, IdentityProposedTime, IdentityRole,
  IdentityRoleTotal,
} from '../../core/models';
import { ChartComponent } from '../../shared/chart';
import { ConfirmData, FamilyConfirmDialog } from './confirm-dialog';

/** A date-range preset for the main aggregation window. */
interface RangePreset { key: string; label: string; days: number; }

/** One unmatched/matched import row with the user's chosen role + a "remember this" toggle (UI-only). */
interface ImportRow {
  item: IdentityProposedTime;
  /** The role the user has assigned (defaults to the rule suggestion). null = skip this event. */
  roleId: number | null;
  /** When true (and a role is chosen), commit upserts a rule from the event's keyword. */
  remember: boolean;
}

/** One auto-derived activity signal with the user's chosen role (defaults to the server's best-effort match).
 *  null = skip this signal on Apply. */
interface AutoRow {
  signal: IdentityAutoSignal;
  /** The role this signal will be applied to. null = skip. */
  roleId: number | null;
}

/**
 * Family Hub — the Identity Map page (features/family/identity, a child of /family gated by identity.map).
 * A PRIVATE, owner-scoped web of the ROLES you play (Parent, Coder, Athlete…) and how much TIME goes into
 * each. You define roles (name + colour), log time against them (the always-available manual path), and see
 * the split as an ECharts radial "web" (a colour-coded sunburst/donut with totals + a percentage breakdown)
 * over a selectable range.
 *
 * OPTIONAL calendar import: when the user's Google Calendar is connected, an "Import from calendar" panel
 * reads their OWN events over a window, classifies each into a role by stored keyword RULES, and lets them
 * confirm matched events + assign unmatched ones (optionally saving the choice as a rule so re-imports
 * auto-classify). Re-import is idempotent (deduped on the source event id). The page works fully WITHOUT a
 * calendar — import degrades gracefully when not configured/connected. No AI; classification is deterministic.
 */
@Component({
  selector: 'app-family-identity-map',
  standalone: true,
  imports: [
    FormsModule, MatIconModule, MatButtonModule, MatTooltipModule, MatProgressSpinnerModule,
    MatFormFieldModule, MatInputModule, MatSelectModule, MatSlideToggleModule, MatSnackBarModule,
    ChartComponent,
  ],
  templateUrl: './identity-map.html',
  styleUrls: ['./family.scss', './identity-map.scss'],
})
export class FamilyIdentityMap {
  private api = inject(Api);
  private dialog = inject(MatDialog);
  private snack = inject(MatSnackBar);

  // ---- page state ----
  readonly loading = signal(true);
  readonly error = signal(false);

  readonly roles = signal<IdentityRole[]>([]);
  readonly totals = signal<IdentityRoleTotal[]>([]);

  /** The range presets (Last 7 / 30 / 90 days). 'custom' is handled by the two date inputs. */
  readonly rangePresets: readonly RangePreset[] = [
    { key: '7', label: 'Last 7 days', days: 7 },
    { key: '30', label: 'Last 30 days', days: 30 },
    { key: '90', label: 'Last 90 days', days: 90 },
  ];
  /** The active preset key, or 'custom' when the user edits the from/to inputs directly. */
  readonly rangeKey = signal<string>('30');
  /** Custom range bounds (ISO "YYYY-MM-DD"); only used when rangeKey === 'custom'. */
  readonly fromDate = signal<string>(this.isoDaysAgo(30));
  readonly toDate = signal<string>(this.todayIso());

  /** A small default palette for new roles (mirrors the family calendar's overlay palette for consistency). */
  private static readonly PALETTE = [
    '#3d8bff', '#8b7cff', '#3fd8d0', '#3dd68c', '#f2b340', '#ff5c6c', '#a855f7', '#ec4899',
  ];

  // ---- "Add role" form ----
  readonly newRoleName = signal<string>('');
  readonly newRoleColor = signal<string>(FamilyIdentityMap.PALETTE[0]);
  readonly addingRole = signal(false);

  // ---- "Log time" form ----
  readonly logRoleId = signal<number | null>(null);
  readonly logDate = signal<string>(this.todayIso());
  readonly logMinutes = signal<number | null>(60);
  readonly logNote = signal<string>('');
  readonly logging = signal(false);

  // ---- optional calendar import ----
  /** Whether calendar is configured + connected (drives the import affordance). Never required. */
  readonly calendarConfigured = signal(false);
  readonly calendarConnected = signal(false);
  readonly importFrom = signal<string>(this.isoDaysAgo(30));
  readonly importTo = signal<string>(this.todayIso());
  readonly importPreviewing = signal(false);
  readonly importCommitting = signal(false);
  /** The current preview (matched + unmatched rows), or null before a preview is run. */
  readonly preview = signal<IdentityImportPreview | null>(null);
  /** The editable confirm rows derived from the preview (role assignment + "remember"). */
  readonly importRows = signal<ImportRow[]>([]);

  // ---- auto-ingest: "Suggested from your activity" ----
  /** True while deriving signals from recent Hub activity. */
  readonly autoLoading = signal(false);
  /** True while applying confirmed signals to the map. */
  readonly autoApplying = signal(false);
  /** True once a derive has run at least once (so we can distinguish "not run yet" from "ran, nothing found"). */
  readonly autoLoaded = signal(false);
  /** The editable rows derived from the latest suggest (signal + chosen role). */
  readonly autoRows = signal<AutoRow[]>([]);

  /** The colour swatches offered in the add-role + recolor pickers. */
  readonly palette = FamilyIdentityMap.PALETTE;

  /** Non-archived roles, in sort order then name — the picker + chart source. */
  readonly activeRoles = computed<IdentityRole[]>(() =>
    [...this.roles()].filter(r => !r.archived).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)));

  /** Total minutes across all roles in the window (drives the centre label + percentages). */
  readonly totalMinutes = computed<number>(() => this.totals().reduce((s, t) => s + t.minutes, 0));

  /** The role-time rows for the breakdown list, sorted by minutes desc, with a percentage of the total. */
  readonly breakdown = computed(() => {
    const total = this.totalMinutes();
    return [...this.totals()]
      .filter(t => t.minutes > 0)
      .sort((a, b) => b.minutes - a.minutes)
      .map(t => ({ ...t, pct: total > 0 ? Math.round((t.minutes / total) * 1000) / 10 : 0 }));
  });

  /** True once there is at least one role to map time against (else we show the empty state). */
  readonly hasRoles = computed<boolean>(() => this.activeRoles().length > 0);
  /** True when there is any logged time in the window (else the chart shows a gentle "no time yet"). */
  readonly hasTime = computed<boolean>(() => this.totalMinutes() > 0);

  /** Honor the OS "reduce motion" setting — disable chart animation when set. */
  private readonly reduceMotion =
    typeof window !== 'undefined' &&
    !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  /**
   * The ECharts radial "web": a colour-coded donut of minutes-per-role with a tooltip showing each role's
   * share. Colours come straight from each role's own hex. Empty until there's logged time in the window.
   */
  readonly option = computed<EChartsOption>(() => {
    const rows = this.breakdown();
    if (rows.length === 0) return {} as EChartsOption;
    return {
      animation: !this.reduceMotion,
      tooltip: {
        trigger: 'item',
        formatter: (p: { name?: string; value?: number; percent?: number }) =>
          `${p.name}: ${this.minutesLabel(Number(p.value ?? 0))} (${p.percent}%)`,
      },
      legend: { bottom: 0, type: 'scroll' },
      color: rows.map(r => r.color),
      series: [
        {
          type: 'pie',
          radius: ['45%', '72%'],
          avoidLabelOverlap: true,
          label: { show: false },
          itemStyle: { borderColor: '#111722', borderWidth: 2 },
          data: rows.map(r => ({ name: r.roleName, value: r.minutes, itemStyle: { color: r.color } })),
        },
      ],
    } as EChartsOption;
  });

  /** A screen-reader summary of the chart: the top roles and their share of the total. */
  readonly chartAria = computed<string>(() => {
    const rows = this.breakdown();
    if (rows.length === 0) return 'No time logged in this range yet.';
    const top = rows.slice(0, 3).map(r => `${r.roleName} ${r.pct}%`).join(', ');
    return `Time split across ${rows.length} role${rows.length === 1 ? '' : 's'}, `
      + `${this.minutesLabel(this.totalMinutes())} total. Top: ${top}.`;
  });

  /** True if any import row has a role assigned (the Commit button is enabled). */
  readonly canCommitImport = computed<boolean>(() => this.importRows().some(r => r.roleId != null));

  /** True if any auto signal has a role assigned (the Apply button is enabled). */
  readonly canApplyAuto = computed<boolean>(() => this.autoRows().some(r => r.roleId != null));

  constructor() {
    void this.load();
    void this.loadCalendarStatus();
  }

  // ============================================================== loading

  private async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(false);
    try {
      const data = await firstValueFrom(this.api.identityMap(this.fromDate(), this.toDate()));
      this.applyData(data);
      // Default the "log time" role to the first role so the form is ready to use.
      if (this.logRoleId() == null) this.logRoleId.set(this.activeRoles()[0]?.id ?? null);
    } catch {
      this.error.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  /** Re-fetch the aggregate for the current range (after a mutation or a range change). */
  private async refresh(): Promise<void> {
    try {
      const data = await firstValueFrom(this.api.identityMap(this.fromDate(), this.toDate()));
      this.applyData(data);
    } catch {
      this.snack.open("Couldn't refresh just now. Please try again.", 'OK', { duration: 4000 });
    }
  }

  private applyData(data: IdentityMapData): void {
    this.roles.set(data.roles);
    this.totals.set(data.totals);
  }

  private async loadCalendarStatus(): Promise<void> {
    try {
      const s = await firstValueFrom(this.api.identityCalendarStatus());
      this.calendarConfigured.set(!!s.configured);
      this.calendarConnected.set(!!s.connected);
    } catch {
      // The import affordance simply stays hidden — the page is fully usable manual-only.
      this.calendarConfigured.set(false);
      this.calendarConnected.set(false);
    }
  }

  // ============================================================== range

  /** Switch the aggregation window to a preset (recomputes from/to and reloads the chart). */
  selectRange(key: string): void {
    const preset = this.rangePresets.find(p => p.key === key);
    if (!preset) return;
    this.rangeKey.set(key);
    this.fromDate.set(this.isoDaysAgo(preset.days));
    this.toDate.set(this.todayIso());
    void this.refresh();
  }

  /** A custom from/to date changed — mark the range custom and reload (guarding from ≤ to). */
  onCustomRange(): void {
    this.rangeKey.set('custom');
    if (this.fromDate() && this.toDate() && this.fromDate() > this.toDate()) {
      this.snack.open('The start date must be on or before the end date.', 'OK', { duration: 4000 });
      return;
    }
    void this.refresh();
  }

  // ============================================================== roles

  async addRole(): Promise<void> {
    if (this.addingRole()) return;
    const name = this.newRoleName().trim();
    if (!name) {
      this.snack.open('Give the role a name first.', 'OK', { duration: 3500 });
      return;
    }
    this.addingRole.set(true);
    try {
      await firstValueFrom(this.api.createIdentityRole({ name, color: this.newRoleColor() }));
      this.newRoleName.set('');
      // Rotate the default colour so the next add isn't the same hue.
      const i = (FamilyIdentityMap.PALETTE.indexOf(this.newRoleColor()) + 1) % FamilyIdentityMap.PALETTE.length;
      this.newRoleColor.set(FamilyIdentityMap.PALETTE[i]);
      await this.refresh();
      if (this.logRoleId() == null) this.logRoleId.set(this.activeRoles()[0]?.id ?? null);
    } catch (e) {
      this.snack.open(this.messageOf(e, "Couldn't add that role — is the name already used?"), 'OK',
        { duration: 4000 });
    } finally {
      this.addingRole.set(false);
    }
  }

  /** Recolor a role inline (each swatch in the role row calls this). */
  async recolorRole(role: IdentityRole, color: string): Promise<void> {
    if (role.color === color) return;
    try {
      await firstValueFrom(this.api.patchIdentityRole(role.id, { color }));
      await this.refresh();
    } catch {
      this.snack.open("Couldn't update the colour just now.", 'OK', { duration: 4000 });
    }
  }

  /** Rename a role from the inline text input (on blur / Enter). No-op when unchanged or blank. */
  async renameRole(role: IdentityRole, name: string): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed || trimmed === role.name) return;
    try {
      await firstValueFrom(this.api.patchIdentityRole(role.id, { name: trimmed }));
      await this.refresh();
    } catch (e) {
      this.snack.open(this.messageOf(e, "Couldn't rename that role — is the name already used?"), 'OK',
        { duration: 4000 });
    }
  }

  /** Toggle a role's archived flag (archived roles keep history but drop out of the picker + chart). */
  async toggleArchive(role: IdentityRole): Promise<void> {
    try {
      await firstValueFrom(this.api.patchIdentityRole(role.id, { archived: !role.archived }));
      await this.refresh();
    } catch {
      this.snack.open("Couldn't update that role just now.", 'OK', { duration: 4000 });
    }
  }

  /** Delete a role AND all its logged time + rules (with a clear confirm). */
  async deleteRole(role: IdentityRole): Promise<void> {
    const ok = await this.confirm({
      title: `Delete "${role.name}"?`,
      message: 'This removes the role and ALL time logged against it (and any classification rules that point '
        + 'to it). This cannot be undone.',
      destructive: true,
      confirmLabel: 'Delete role',
    });
    if (!ok) return;
    try {
      await firstValueFrom(this.api.deleteIdentityRole(role.id));
      if (this.logRoleId() === role.id) this.logRoleId.set(null);
      await this.refresh();
      if (this.logRoleId() == null) this.logRoleId.set(this.activeRoles()[0]?.id ?? null);
    } catch {
      this.snack.open("Couldn't delete that role just now. Please try again.", 'OK', { duration: 4000 });
    }
  }

  // ============================================================== manual time logging

  async logTime(): Promise<void> {
    if (this.logging()) return;
    const roleId = this.logRoleId();
    const minutes = this.logMinutes();
    if (roleId == null) {
      this.snack.open('Pick a role to log time against.', 'OK', { duration: 3500 });
      return;
    }
    if (minutes == null || minutes <= 0) {
      this.snack.open('Enter how many minutes (at least 1).', 'OK', { duration: 3500 });
      return;
    }
    this.logging.set(true);
    try {
      await firstValueFrom(this.api.addIdentityTime({
        roleId,
        date: this.logDate(),
        minutes: Math.min(1440, Math.round(minutes)),
        note: this.logNote().trim() || null,
      }));
      this.snack.open('Logged. Your time web is updated.', undefined, { duration: 2200 });
      this.logNote.set('');
      await this.refresh();
    } catch (e) {
      this.snack.open(this.messageOf(e, "Couldn't log that just now. Please try again."), 'OK',
        { duration: 4000 });
    } finally {
      this.logging.set(false);
    }
  }

  // ============================================================== calendar import (OPTIONAL)

  /** Read the calendar over the import window + classify by rules. Creates nothing — fills the confirm list. */
  async runPreview(): Promise<void> {
    if (this.importPreviewing()) return;
    if (this.importFrom() && this.importTo() && this.importFrom() > this.importTo()) {
      this.snack.open('The start date must be on or before the end date.', 'OK', { duration: 4000 });
      return;
    }
    this.importPreviewing.set(true);
    try {
      const p = await firstValueFrom(this.api.identityImportPreview(this.importFrom(), this.importTo()));
      this.preview.set(p);
      if (p.notReady) {
        this.importRows.set([]);
        this.snack.open('Connect your Google Calendar (in the Family Calendar) to import time.', 'OK',
          { duration: 5000 });
        return;
      }
      // Build editable rows: matched events default to their suggested role; unmatched start unassigned.
      const rows: ImportRow[] = [...p.matched, ...p.unmatched].map(item => ({
        item,
        roleId: item.suggestedRoleId,
        remember: item.suggestedRoleId == null, // offer "remember" by default only for newly-assigned ones
      }));
      this.importRows.set(rows);
    } catch (e) {
      this.snack.open(this.messageOf(e, "Couldn't read your calendar just now. Please try again."), 'OK',
        { duration: 4000 });
    } finally {
      this.importPreviewing.set(false);
    }
  }

  /** Set the assigned role for one import row (from its dropdown). */
  setImportRole(row: ImportRow, roleId: number | null): void {
    this.importRows.update(rows => rows.map(r => (r === row ? { ...r, roleId } : r)));
  }

  /** Toggle the "remember this mapping" flag for one import row. */
  toggleRemember(row: ImportRow): void {
    this.importRows.update(rows => rows.map(r => (r === row ? { ...r, remember: !r.remember } : r)));
  }

  /** Persist every import row that has a role assigned; upsert "remember" rules so re-imports auto-classify. */
  async commitImport(): Promise<void> {
    if (this.importCommitting()) return;
    const rows = this.importRows().filter(r => r.roleId != null);
    if (rows.length === 0) {
      this.snack.open('Assign a role to at least one event to import it.', 'OK', { duration: 3500 });
      return;
    }
    this.importCommitting.set(true);
    try {
      const res = await firstValueFrom(this.api.identityImportCommit({
        items: rows.map(r => ({
          sourceEventId: r.item.sourceEventId,
          roleId: r.roleId!,
          date: r.item.date,
          minutes: r.item.minutes,
          note: r.item.title,
        })),
        newRules: rows
          .filter(r => r.remember && r.roleId != null)
          .map(r => ({ keyword: this.keywordOf(r.item.title), roleId: r.roleId! }))
          .filter(rule => rule.keyword.length > 0),
      }));
      this.snack.open(
        `Imported ${res.imported} ${res.imported === 1 ? 'block' : 'blocks'}`
        + (res.skipped > 0 ? ` (${res.skipped} already imported)` : '') + '.',
        undefined, { duration: 2800 });
      this.preview.set(null);
      this.importRows.set([]);
      await this.refresh();
    } catch (e) {
      this.snack.open(this.messageOf(e, "Couldn't import those just now. Please try again."), 'OK',
        { duration: 4000 });
    } finally {
      this.importCommitting.set(false);
    }
  }

  /** Discard the current import preview without committing. */
  cancelImport(): void {
    this.preview.set(null);
    this.importRows.set([]);
  }

  // ============================================================== auto-ingest (from your activity)

  /** Derive time signals from the caller's OWN recent Hub activity over the current range (read-only — writes
   *  nothing). Pre-fills each signal with the server's best-effort role match (0 = none → unassigned). */
  async refreshAuto(): Promise<void> {
    if (this.autoLoading()) return;
    this.autoLoading.set(true);
    try {
      const res = await firstValueFrom(this.api.identityAutoSuggest(this.fromDate(), this.toDate()));
      this.autoRows.set((res.signals ?? []).map(signal => ({
        signal,
        // The server returns 0 for "no match"; treat that as unassigned (null) so the user picks.
        roleId: signal.suggestedRoleId && signal.suggestedRoleId > 0 ? signal.suggestedRoleId : null,
      })));
      this.autoLoaded.set(true);
    } catch (e) {
      this.snack.open(this.messageOf(e, "Couldn't read your recent activity just now. Please try again."), 'OK',
        { duration: 4000 });
    } finally {
      this.autoLoading.set(false);
    }
  }

  /** Set the assigned role for one auto signal (from its dropdown). */
  setAutoRole(row: AutoRow, roleId: number | null): void {
    this.autoRows.update(rows => rows.map(r => (r === row ? { ...r, roleId } : r)));
  }

  /** Apply the assigned signals to the map over the SAME window. The server re-derives the authoritative
   *  minutes (client minutes are never trusted) and writes idempotent `auto` rows — re-applying never
   *  double-counts. */
  async applyAuto(): Promise<void> {
    if (this.autoApplying()) return;
    const rows = this.autoRows().filter(r => r.roleId != null);
    if (rows.length === 0) {
      this.snack.open('Assign a role to at least one activity to apply it.', 'OK', { duration: 3500 });
      return;
    }
    this.autoApplying.set(true);
    try {
      const res = await firstValueFrom(this.api.identityAutoApply({
        items: rows.map(r => ({ key: r.signal.key, roleId: r.roleId! })),
        fromUtc: this.fromDate(),
        toUtc: this.toDate(),
      }));
      this.snack.open(
        `Applied ${res.imported} ${res.imported === 1 ? 'activity' : 'activities'}`
        + (res.skipped > 0 ? ` (${res.skipped} already applied)` : '') + '.',
        undefined, { duration: 2800 });
      await this.refresh();
      // Re-derive so the card reflects what's now applied (and stays idempotent on a follow-up Apply).
      await this.refreshAuto();
    } catch (e) {
      this.snack.open(this.messageOf(e, "Couldn't apply those just now. Please try again."), 'OK',
        { duration: 4000 });
    } finally {
      this.autoApplying.set(false);
    }
  }

  // ============================================================== helpers

  /** Look up a role's display name (for the import dropdown labels + breakdown). */
  roleName(id: number | null): string {
    if (id == null) return '';
    return this.roles().find(r => r.id === id)?.name ?? '';
  }

  /** A friendly "2h 30m" / "45m" label from a minute count. */
  minutesLabel(min: number): string {
    const m = Math.max(0, Math.round(min));
    const h = Math.floor(m / 60);
    const rem = m % 60;
    if (h === 0) return `${rem}m`;
    if (rem === 0) return `${h}h`;
    return `${h}h ${rem}m`;
  }

  /** Derive a lower-case keyword from an event title (the longest significant word) for a "remember" rule. */
  private keywordOf(title: string): string {
    const words = (title || '').toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];
    if (words.length === 0) return (title || '').trim().toLowerCase().slice(0, 128);
    return words.sort((a, b) => b.length - a.length)[0]!.slice(0, 128);
  }

  /** Today's local date as ISO "YYYY-MM-DD". */
  private todayIso(): string {
    return this.toLocalDate(new Date());
  }

  /** N days ago as ISO "YYYY-MM-DD" (browser local zone). */
  private isoDaysAgo(days: number): string {
    const d = new Date();
    d.setDate(d.getDate() - days);
    return this.toLocalDate(d);
  }

  private toLocalDate(d: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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
