import {
  ChangeDetectionStrategy, Component, computed, inject, signal,
} from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { Api } from '../../core/api';
import { Fleet, FleetMachine, FleetUser, UsageFilter } from '../../core/models';
import { CompactPipe } from '../../shared/format';
import {
  BetaPullRefresh, BetaSectionHeader, BetaSegmentedControl, BetaSkeleton,
  BetaToaster, Segment, ToastController,
} from '../beta-ui';

import { FleetMachineCard } from './components/machine-card';
import { FleetUserLeaderboard } from './components/user-leaderboard';
import { FleetMachineSheet } from './components/machine-sheet';
import { compactUsd, isOnline } from './fleet-beta.model';

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
    FleetMachineCard, FleetUserLeaderboard, FleetMachineSheet,
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

          <!-- Glance: machines + total spend + total tokens. -->
          <div class="hh__glance">
            <div class="hh__stat">
              <span class="hh__stat-n">{{ totals().machineCount | compact }}</span>
              <span class="hh__stat-l">{{ totals().machineCount === 1 ? 'machine' : 'machines' }}</span>
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
          </div>

          <!-- Range pills. -->
          <div class="hh__pills" role="radiogroup" aria-label="Date range">
            @for (p of presets; track p.key) {
              <button type="button" class="pill" role="radio"
                      [class.pill--on]="activePreset() === p.key"
                      [attr.aria-checked]="activePreset() === p.key"
                      (click)="setDatePreset(p.key)">{{ p.label }}</button>
            }
          </div>
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
            <app-fleet-user-leaderboard [users]="users()" />
          </div>
        }
      </div>
    </app-bs-pull-refresh>

    <!-- Tap-through machine detail. -->
    <app-fleet-machine-sheet [(open)]="sheetOpen" [machine]="activeMachine()"
      [totalCost]="totals().cost" (copied)="onCopied($event)" />

    <app-bs-toaster />
  `,
  styleUrl: './fleet-beta.page.scss',
})
export class FleetBetaPage {
  private readonly api = inject(Api);
  private readonly toast = inject(ToastController);

  // ---- range filter (date-only — the fleet is a coarse roll-up, mirroring the live page) ----
  readonly filter = signal<UsageFilter>({ ...EMPTY_FILTER });
  readonly activePreset = signal<string>('all');
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

  // ---- detail sheet ----
  readonly sheetOpen = signal(false);
  readonly activeMachine = signal<FleetMachine | null>(null);

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
    this.filter.update(f => ({ ...f, from, to }));
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

  // ---- detail sheet ----
  openMachine(m: FleetMachine): void {
    this.activeMachine.set(m);
    this.sheetOpen.set(true);
  }

  /** The sheet copied a value to the clipboard — confirm with a toast (ok = success, else warn). */
  onCopied(ev: { label: string; ok: boolean }): void {
    this.toast.show(
      ev.ok ? `${ev.label} copied` : `Couldn’t copy — long-press to select`,
      { tone: ev.ok ? 'success' : 'warn', durationMs: 1600 },
    );
  }
}
