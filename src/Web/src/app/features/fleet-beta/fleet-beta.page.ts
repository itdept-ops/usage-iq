import {
  ChangeDetectionStrategy, Component, computed, inject, signal, viewChild,
} from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { Api } from '../../core/api';
import { AuthService } from '../../core/auth';
import { Fleet, FleetMachine, FleetUser, PERM, UsageFilter } from '../../core/models';
import { CompactPipe } from '../../shared/format';
import {
  BetaPullRefresh, BetaSectionHeader, BetaSegmentedControl, BetaSkeleton,
  BetaToaster, Segment, ToastController,
} from '../beta-ui';

import { FleetMachineCard } from './components/machine-card';
import { FleetUserLeaderboard } from './components/user-leaderboard';
import { FleetMachineSheet } from './components/machine-sheet';
import { FleetUserSheet } from './components/user-sheet';
import { FleetActionSheet, FleetActionResult } from './components/action-sheet';
import {
  compactUsd, FleetAction, FleetActionRequest, FleetActionTarget, isLocalName, isOnline,
} from './fleet-beta.model';

/** The empty filter the fleet rollup starts from (date-range-only, like the live /fleet page). */
const EMPTY_FILTER: UsageFilter = {
  from: null, to: null, projectIds: [], models: [], sources: [], machine: [], includeSidechain: true,
};

/**
 * BETA FLEET — a NEW mobile-first, native-app view over the SAME fleet rollup the live `/fleet` page
 * shows, rebuilt on the shared beta-ui "Strata" kit (`@use '../beta-ui/beta-kit'`). One signature
 * accent — a vivid CYAN (#22d3ee → #06b6d4) — re-skins the whole screen via the per-page contract.
 *
 * Layout: an immersive header (title + accent bloom + a fleet glance: machines count, total spend,
 * total tokens on big Clash Display numerals), a Day/Month-style RANGE pill row, a Machines / Users
 * BetaSegmentedControl, then either a column of MACHINE cards (online pulse + per-machine spend/tokens
 * StatTiles + a relative-spend bar; tap → a detail BetaBottomSheet) or a per-USER leaderboard (ranked
 * accent bars + share %). Pull-to-refresh, spring-stagger entrance, BetaSkeleton loaders, and a tasteful
 * empty state.
 *
 * DATA PARITY: every figure comes from the SAME `Api.fleet(filter)` endpoint + `Fleet`/`FleetMachine`/
 * `FleetUser` DTOs the live page uses — the server owns all per-machine/per-user aggregation; this page
 * never re-aggregates. The range presets reuse the live page's exact local-date formatter so ranges match.
 *
 * ISOLATION: gated by `platform.mobile` + any-of [`fleet.view`, `reporter.manage`] (mirrors the live /fleet
 * gate). Consumes the kit + the SAME read-only fleet endpoint. No live page is imported or modified; the
 * flagship tracker-beta + the kit are consumed, never changed. State lives in this page's signals; the
 * only route-level provider is its own ToastController.
 */
@Component({
  selector: 'app-fleet-beta',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [ToastController],
  imports: [
    MatIconModule, RouterLink, CompactPipe,
    BetaPullRefresh, BetaSegmentedControl, BetaSectionHeader, BetaSkeleton, BetaToaster,
    FleetMachineCard, FleetUserLeaderboard, FleetMachineSheet, FleetUserSheet, FleetActionSheet,
  ],
  template: `
    <app-bs-pull-refresh class="fb-ptr" [busy]="refreshing()" (refresh)="refreshAll()">
      <div class="fb-scroll">

        <!-- Immersive header: title + fleet glance. -->
        <header class="hh">
          <div class="hh__row">
            <div class="hh__text">
              <span class="hh__eyebrow"><span class="hh__spark" aria-hidden="true"></span> Fleet</span>
              <h1 class="hh__title">Fleet</h1>
              <p class="hh__sub">Machines &amp; spend across your fleet</p>
            </div>
            @if (onlineCount() > 0) {
              <span class="hh__online" [attr.aria-label]="onlineCount() + ' online now'">
                <span class="hh__online-dot" aria-hidden="true"></span>
                {{ onlineCount() }} online
              </span>
            }
          </div>

          <!-- Glance: machines + users + total spend + total tokens + records. -->
          <div class="hh__glance">
            <div class="hh__stat">
              <span class="hh__stat-n">{{ totals().machineCount | compact }}</span>
              <span class="hh__stat-l">{{ totals().machineCount === 1 ? 'machine' : 'machines' }}</span>
            </div>
            <span class="hh__div" aria-hidden="true"></span>
            <div class="hh__stat">
              <span class="hh__stat-n">{{ totals().userCount | compact }}</span>
              <span class="hh__stat-l">{{ totals().userCount === 1 ? 'user' : 'users' }}</span>
            </div>
            <span class="hh__div" aria-hidden="true"></span>
            <div class="hh__stat">
              <span class="hh__stat-n">{{ spendLabel() }}</span>
              <span class="hh__stat-l">total spend</span>
            </div>
            <span class="hh__div" aria-hidden="true"></span>
            <div class="hh__stat">
              <span class="hh__stat-n">{{ totals().tokens | compact }}</span>
              <span class="hh__stat-l">tokens</span>
            </div>
            <span class="hh__div" aria-hidden="true"></span>
            <div class="hh__stat">
              <span class="hh__stat-n">{{ totals().records | compact }}</span>
              <span class="hh__stat-l">records</span>
            </div>
          </div>

          <!-- Range pills (+ a Custom toggle that reveals From/To date inputs). -->
          <div class="hh__pills" role="radiogroup" aria-label="Date range">
            @for (p of presets; track p.key) {
              <button type="button" class="pill" role="radio"
                      [class.pill--on]="activePreset() === p.key"
                      [attr.aria-checked]="activePreset() === p.key"
                      (click)="setDatePreset(p.key)">{{ p.label }}</button>
            }
            <button type="button" class="pill" role="radio"
                    [class.pill--on]="activePreset() === 'custom'"
                    [attr.aria-checked]="activePreset() === 'custom'"
                    [attr.aria-expanded]="customOpen()"
                    (click)="toggleCustom()">Custom</button>
          </div>

          <!-- Custom From/To range with Apply / Reset. -->
          @if (customOpen()) {
            <div class="hh__range">
              <label class="hh__date">
                <span class="hh__date-l">From</span>
                <input type="date" [value]="filter().from ?? ''"
                       (input)="patch('from', $any($event.target).value || null)" aria-label="From date" />
              </label>
              <label class="hh__date">
                <span class="hh__date-l">To</span>
                <input type="date" [value]="filter().to ?? ''"
                       (input)="patch('to', $any($event.target).value || null)" aria-label="To date" />
              </label>
              <div class="hh__range-btns">
                <button type="button" class="hh__rbtn" (click)="resetRange()">
                  <mat-icon aria-hidden="true">clear</mat-icon> Reset
                </button>
                <button type="button" class="hh__rbtn hh__rbtn--go" (click)="applyRange()">
                  <mat-icon aria-hidden="true">filter_list</mat-icon> Apply
                </button>
              </div>
            </div>
          }
        </header>

        <!-- Machines / Users toggle. -->
        <app-bs-segmented class="fb-seg" [segments]="boards" [(value)]="board" label="Fleet board" />

        <!-- Machine controls: a sort segmented + an "Online only" filter chip. Only over the Machines board. -->
        @if (board() === 'machines' && !loading() && !error() && totals().machineCount > 0) {
          <div class="fb-controls">
            <app-bs-segmented class="fb-sort" [segments]="sorts" [(value)]="sort" label="Sort machines" />
            <button type="button" class="fb-chip" [class.fb-chip--on]="onlineOnly()"
                    [attr.aria-pressed]="onlineOnly()"
                    (click)="onlineOnly.set(!onlineOnly())">
              <span class="fb-chip__dot" aria-hidden="true"></span>
              Online only
              @if (onlineCount() > 0) { <span class="fb-chip__n">{{ onlineCount() }}</span> }
            </button>
          </div>
        }

        @if (loading()) {
          <!-- Skeleton loaders matching the resolved layout. -->
          <div class="fb-skel">
            @for (s of [0,1,2,3]; track s) {
              <app-bs-skeleton height="118px" radius="var(--r-card)" />
            }
          </div>
        } @else if (error()) {
          <div class="fb-state">
            <span class="fb-state__ic" aria-hidden="true"><mat-icon>cloud_off</mat-icon></span>
            <p class="fb-state__msg">Couldn't load the fleet — is the API running?</p>
            <button type="button" class="fb-state__btn" (click)="reload(true)">
              <mat-icon aria-hidden="true">refresh</mat-icon> Try again
            </button>
          </div>
        } @else if (board() === 'machines') {

          <app-bs-section-header class="fb-sh" icon="dns"
            title="Machines" [subtitle]="machineSubtitle()" />

          @if (visibleMachines().length) {
            <div class="fb-cards">
              @for (m of visibleMachines(); track m.name; let i = $index) {
                <div class="fb-card-in" [style.--i]="i" [class.fb-defer]="i >= 3">
                  <app-fleet-machine-card [machine]="m" [maxCost]="maxMachineCost()"
                    [totalCost]="totals().cost" (open)="openMachine(m)" />
                </div>
              }
            </div>
          } @else if (onlineOnly() && machines().length) {
            <!-- The range HAS machines, but the Online-only filter hid them all. -->
            <div class="fb-state">
              <span class="fb-state__ic" aria-hidden="true"><mat-icon>wifi_off</mat-icon></span>
              <p class="fb-state__msg">No machines are online right now. {{ machines().length }} reported recently.</p>
              <button type="button" class="fb-state__btn" (click)="onlineOnly.set(false)">
                <mat-icon aria-hidden="true">dns</mat-icon> Show all machines
              </button>
            </div>
          } @else {
            <div class="fb-state">
              <span class="fb-state__ic" aria-hidden="true"><mat-icon>dns</mat-icon></span>
              @if (activePreset() === 'all') {
                <!-- All-time already shows nothing → no machine has EVER reported. Point forward: add a reporter. -->
                <p class="fb-state__msg">No machine has reported yet. Connect one to start tracking your fleet.</p>
                <a class="fb-state__btn" routerLink="/reporter">
                  <mat-icon aria-hidden="true">add_link</mat-icon> Connect a machine
                </a>
              } @else {
                <p class="fb-state__msg">No machines have reported in this range.</p>
                <button type="button" class="fb-state__btn" (click)="setDatePreset('all')">
                  <mat-icon aria-hidden="true">all_inclusive</mat-icon> View all time
                </button>
              }
            </div>
          }

        } @else {

          <app-bs-section-header class="fb-sh" icon="leaderboard"
            title="Top users" [subtitle]="userSubtitle()" />

          <div class="fb-lb-card">
            <app-fleet-user-leaderboard [users]="users()" (select)="openUser($event)" />
          </div>
        }
      </div>
    </app-bs-pull-refresh>

    <!-- Tap-through machine detail (+ management when reporter.manage). -->
    <app-fleet-machine-sheet [(open)]="sheetOpen" [machine]="activeMachine()"
      [totalCost]="totals().cost" [canManage]="canManage()"
      (copied)="onCopied($event)" (manage)="onMachineManage($event)" />

    <!-- Tap-through user detail (+ management when reporter.manage). -->
    <app-fleet-user-sheet [(open)]="userSheetOpen" [user]="activeUser()"
      [canManage]="canManage()" (manage)="onUserManage($event)" />

    <!-- Shared confirm sheet for combine/move + delete + revoke. -->
    <app-fleet-action-sheet [(open)]="actionOpen" [request]="actionRequest()" (done)="onActionDone($event)" />

    <app-bs-toaster />
  `,
  styleUrl: './fleet-beta.page.scss',
})
export class FleetBetaPage {
  private readonly api = inject(Api);
  private readonly toast = inject(ToastController);
  private readonly auth = inject(AuthService);

  /** Row-level management (combine/move, delete, revoke). The board is read-only without it. */
  readonly canManage = computed(() => this.auth.hasPermission(PERM.reporterManage));

  // ---- range filter (date-only — the fleet is a coarse roll-up, mirroring the live page) ----
  readonly filter = signal<UsageFilter>({ ...EMPTY_FILTER });
  readonly activePreset = signal<string>('all');
  /** Whether the custom From/To range editor is expanded. */
  readonly customOpen = signal(false);
  readonly presets = [
    { key: '7d', label: '7d' }, { key: '30d', label: '30d' }, { key: '90d', label: '90d' },
    { key: 'mtd', label: 'Month' }, { key: 'all', label: 'All' },
  ] as const;

  // ---- board toggle ----
  readonly board = signal<string>('machines');
  readonly boards: Segment[] = [
    { key: 'machines', label: 'Machines' },
    { key: 'users', label: 'Users' },
  ];

  // ---- machine sort + online-only filter (client-side over the loaded fleet) ----
  readonly sort = signal<string>('spend');
  readonly sorts: Segment[] = [
    { key: 'spend', label: 'Spend' },
    { key: 'tokens', label: 'Tokens' },
    { key: 'seen', label: 'Last seen' },
    { key: 'name', label: 'Name' },
  ];
  readonly onlineOnly = signal(false);

  // ---- data ----
  readonly fleet = signal<Fleet | null>(null);
  readonly loading = signal(true);
  readonly error = signal(false);
  readonly refreshing = signal(false);

  // ---- detail sheets ----
  readonly sheetOpen = signal(false);
  readonly activeMachine = signal<FleetMachine | null>(null);
  readonly userSheetOpen = signal(false);
  readonly activeUser = signal<FleetUser | null>(null);

  // ---- management confirm sheet ----
  readonly actionOpen = signal(false);
  readonly actionRequest = signal<FleetActionRequest | null>(null);
  private readonly actionSheet = viewChild(FleetActionSheet);

  /** Cost-desc machines (the server may sort; we enforce a stable view). The canonical fleet set —
   *  totals/maxCost/onlineCount read this; the displayed list is {@link visibleMachines}. */
  readonly machines = computed<FleetMachine[]>(() =>
    [...(this.fleet()?.machines ?? [])].sort((a, b) => b.costUsd - a.costUsd));

  /** The machines actually rendered: the chosen SORT applied, then the optional Online-only filter. */
  readonly visibleMachines = computed<FleetMachine[]>(() => {
    const sorted = [...this.machines()];
    switch (this.sort()) {
      case 'tokens': sorted.sort((a, b) => b.tokens - a.tokens); break;
      case 'name': sorted.sort((a, b) => a.name.localeCompare(b.name)); break;
      case 'seen': sorted.sort((a, b) =>
        (b.lastSeenUtc ? Date.parse(b.lastSeenUtc) : 0) - (a.lastSeenUtc ? Date.parse(a.lastSeenUtc) : 0)); break;
      default: /* spend — already cost-desc */ break;
    }
    return this.onlineOnly() ? sorted.filter(m => isOnline(m.lastSeenUtc)) : sorted;
  });

  readonly users = computed<FleetUser[]>(() =>
    [...(this.fleet()?.users ?? [])].sort((a, b) => b.costUsd - a.costUsd));

  readonly totals = computed(() => {
    const m = this.machines();
    return {
      machineCount: m.length,
      userCount: this.users().length,
      records: m.reduce((a, x) => a + x.records, 0),
      tokens: m.reduce((a, x) => a + x.tokens, 0),
      cost: m.reduce((a, x) => a + x.costUsd, 0),
    };
  });

  readonly spendLabel = computed(() => compactUsd(this.totals().cost));

  /** Top machine cost — drives every card's relative-spend bar. */
  readonly maxMachineCost = computed(() =>
    this.machines().reduce((a, m) => Math.max(a, m.costUsd), 0) || 1);

  /** Count of machines that reported within the online window (the header live badge). */
  readonly onlineCount = computed(() =>
    this.machines().filter(m => isOnline(m.lastSeenUtc)).length);

  readonly machineSubtitle = computed(() => {
    const n = this.totals().machineCount;
    const online = this.onlineCount();
    if (n === 0) return 'none in this range';
    return online > 0 ? `${n} reporting · ${online} online` : `${n} reporting`;
  });

  readonly userSubtitle = computed(() => {
    const n = this.totals().userCount;
    return n === 0 ? 'none in this range' : `${n} ranked by spend`;
  });

  constructor() {
    this.reload(true);
  }

  // ---- range pills (apply instantly; same formatter as the live page) ----
  setDatePreset(kind: string): void {
    const fmt = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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
    this.customOpen.set(false);
    this.filter.update(f => ({ ...f, from, to }));
    this.reload(true);
  }

  // ---- custom From/To range ----
  patch<K extends keyof UsageFilter>(key: K, value: UsageFilter[K]): void {
    this.filter.update(f => ({ ...f, [key]: value }));
  }

  /** Toggle the custom range editor; marking the preset "custom" so no pill reads as active. */
  toggleCustom(): void {
    const open = !this.customOpen();
    this.customOpen.set(open);
    if (open) this.activePreset.set('custom');
  }

  /** Apply the typed From/To range (no preset selected). */
  applyRange(): void {
    this.activePreset.set('custom');
    this.reload(true);
  }

  /** Clear the typed range back to all-time and collapse the editor. */
  resetRange(): void {
    this.filter.update(f => ({ ...f, from: null, to: null }));
    this.activePreset.set('all');
    this.customOpen.set(false);
    this.reload(true);
  }

  // ---- data load ----
  reload(initial = false): void {
    if (initial) { this.loading.set(true); this.error.set(false); }
    this.api.fleet(this.filter()).subscribe({
      next: f => { this.fleet.set(f); this.loading.set(false); },
      error: () => { if (initial) this.error.set(true); this.loading.set(false); },
    });
  }

  /** Pull-to-refresh: re-run the fleet load, flip the spinner, confirm with a toast. */
  async refreshAll(): Promise<void> {
    this.refreshing.set(true);
    try {
      const f = await firstValueFrom(this.api.fleet(this.filter()));
      this.fleet.set(f);
      this.error.set(false);
      this.toast.show('Fleet refreshed', { tone: 'success', durationMs: 1600 });
    } catch {
      this.toast.show('Couldn’t refresh — pull again', { tone: 'warn' });
    } finally {
      this.refreshing.set(false);
    }
  }

  // ---- detail sheets ----
  openMachine(m: FleetMachine): void {
    this.activeMachine.set(m);
    this.sheetOpen.set(true);
  }

  openUser(u: FleetUser): void {
    this.activeUser.set(u);
    this.userSheetOpen.set(true);
  }

  /** The sheet copied a value to the clipboard — confirm with a toast (ok = success, else warn). */
  onCopied(ev: { label: string; ok: boolean }): void {
    this.toast.show(
      ev.ok ? `${ev.label} copied` : `Couldn’t copy — long-press to select`,
      { tone: ev.ok ? 'success' : 'warn', durationMs: 1600 },
    );
  }

  // ---- management (reporter.manage) ----
  private readonly userKey = (u: FleetUser): string => (u.userId != null ? 'u' + u.userId : 'n:' + u.name);
  private rawValue(name: string): string { return isLocalName(name) ? '' : name; }
  private friendly(name: string): string { return isLocalName(name) ? 'local (file sync)' : name; }

  /** OTHER machine buckets — the machine reassign picker's targets (raw names). */
  private otherMachineTargets(self: string): FleetActionTarget[] {
    return this.machines()
      .map(m => m.name)
      .filter(name => name !== self)
      .map(name => ({ rawValue: this.rawValue(name), label: this.friendly(name) }));
  }

  /** OTHER user buckets — the user reassign picker's targets (keyed by userId; no email). */
  private otherUserTargets(self: FleetUser): FleetActionTarget[] {
    return this.users()
      .filter(u => this.userKey(u) !== this.userKey(self))
      .map(u => ({ rawValue: '', label: this.friendly(u.name), userId: u.userId ?? null }));
  }

  /** A machine management action was chosen in the machine sheet — open the confirm sheet. */
  onMachineManage(action: FleetAction): void {
    if (!this.canManage()) return;
    const m = this.activeMachine();
    if (!m) return;
    this.openAction({
      action,
      dimension: 'machine',
      rawValue: this.rawValue(m.name),
      label: this.friendly(m.name),
      records: m.records,
      others: action === 'reassign' ? this.otherMachineTargets(m.name) : [],
    });
  }

  /** A user management action was chosen in the user sheet — open the confirm sheet. */
  onUserManage(action: FleetAction): void {
    if (!this.canManage()) return;
    const u = this.activeUser();
    if (!u) return;
    this.openAction({
      action,
      dimension: 'user',
      rawValue: '',
      userId: u.userId ?? null,
      label: this.friendly(u.name),
      records: u.records,
      others: action === 'reassign' ? this.otherUserTargets(u) : [],
    });
  }

  /** Stage the request, reset the confirm sheet's picker, then open it (over the detail sheet). */
  private openAction(req: FleetActionRequest): void {
    this.actionRequest.set(req);
    this.actionSheet()?.reset();
    this.actionOpen.set(true);
  }

  /** A mutation succeeded — close the detail sheets, refresh the fleet, and toast the count. */
  onActionDone(res: FleetActionResult): void {
    const label = this.actionRequest()?.label ?? '';
    this.sheetOpen.set(false);
    this.userSheetOpen.set(false);
    const n = res.count;
    const msg = res.action === 'reassign'
      ? `Moved ${n.toLocaleString()} record${n === 1 ? '' : 's'} from “${label}”.`
      : res.action === 'delete'
        ? `Deleted ${n.toLocaleString()} record${n === 1 ? '' : 's'} from “${label}”.`
        : `Revoked ${n.toLocaleString()} key${n === 1 ? '' : 's'} for “${label}”.`;
    this.toast.show(msg, { tone: 'success', durationMs: 3200 });
    this.reload(false);
  }
}
