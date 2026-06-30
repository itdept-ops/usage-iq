import {
  ChangeDetectionStrategy, Component, computed, inject, signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { MatIconModule } from '@angular/material/icon';

import { Api } from '../../core/api';
import {
  IdentityMapData, IdentityRole, IdentityRoleInput,
} from '../../core/models';
import {
  BetaPullRefresh, BetaSegmentedControl, BetaBottomSheet, BetaSwipeRow, BetaSkeleton,
  BetaFab, BetaToaster, BetaSvgRing, ToastController, type Segment,
} from '../beta-ui';

/** A date-range preset for the aggregation window (mirrors the live page's presets). */
interface RangePreset { key: string; label: string; days: number; }

/**
 * Identity Map — the mobile-first twin of the live /family/identity page, rebuilt on the shared beta-ui
 * "Strata" kit (`@use '../beta-ui/beta-kit'`). A PRIVATE, owner-scoped web of the ROLES you play
 * (Parent, Coder, Athlete…) and how much TIME goes into each. One signature accent — a VIOLET → INDIGO
 * ramp — re-skins the whole screen via the per-page accent contract.
 *
 * Surfaces: an immersive scrolling hero (accent bloom + a hero {@link BetaSvgRing} showing the top
 * role's share of the window's total, with the total-minutes label inside), a {@link
 * BetaSegmentedControl} for the range window (7 / 30 / 90 days), a colour-coded BAR breakdown of
 * minutes-per-role (the radial "split" re-presented as proportional bars — same numbers, no echarts
 * dependency), a {@link BetaSwipeRow} roles list (swipe left to archive/restore, right to log time), a
 * {@link BetaBottomSheet} QUICK-LOG form (role chip picker + minutes + note), a second sheet to ADD a
 * role (name + colour swatch), and a {@link BetaFab} to log time. Pull-to-refresh, skeletons, and
 * elevated empty/error states round it out — it renders cleanly with ZERO data.
 *
 * DATA PARITY: every byte comes straight from the SAME owner-scoped, identity.map-gated
 * `/api/family/identity` endpoints the live page uses — {@link Api.identityMap} (roles + per-role
 * minute totals over a window), {@link Api.createIdentityRole}, {@link Api.patchIdentityRole}
 * (archive/restore + recolor) and {@link Api.addIdentityTime} (the always-available manual log path),
 * VERBATIM. The server enforces ownership + the identity.map gate; the UI only re-presents.
 *
 * ISOLATION: gated by `platform.mobile` + the SAME `identity.map` the live route carries; it consumes
 * only the kit + the SAME Api/models. No live page is imported or modified. Mobile-first (44px targets,
 * safe-area insets, no 390px overflow), centers on desktop; reduced motion collapses kit animations via
 * the a11y killswitch. The optional calendar-import / auto-suggest flows from the desktop page are left
 * to the desktop surface — this twin focuses on the manual log + the split glance.
 */
@Component({
  selector: 'app-identity-mobile',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [ToastController],
  imports: [
    FormsModule, MatIconModule,
    BetaPullRefresh, BetaSegmentedControl, BetaBottomSheet, BetaSwipeRow, BetaSkeleton,
    BetaFab, BetaToaster, BetaSvgRing,
  ],
  template: `
    <app-bs-pull-refresh class="im-ptr" [busy]="refreshing()" (refresh)="reload()">
      <div class="im-scroll" aria-live="polite">

        <!-- ─── IMMERSIVE HERO: title + accent bloom + the split ring ─── -->
        <header class="im-hero">
          <p class="im-hero__kicker"><mat-icon aria-hidden="true">hub</mat-icon> Identity Map</p>
          <h1 class="im-hero__title">Your roles</h1>
          <p class="im-hero__sub">Log time against the roles you play and watch the split.</p>

          @if (!loading() && !errored()) {
            <div class="im-hero__ring">
              <app-bs-ring [value]="topFraction()" [size]="148" [stroke]="13"
                           [label]="ringAria()">
                <div class="im-ring-mid">
                  <span class="im-ring-mid__n mono-num">{{ minutesLabel(totalMinutes()) }}</span>
                  <span class="im-ring-mid__l">{{ rangeLabel() }}</span>
                </div>
              </app-bs-ring>
              @if (hasTime()) {
                <p class="im-hero__topline">
                  <span class="im-dot" [style.background]="breakdown()[0].color" aria-hidden="true"></span>
                  <b>{{ breakdown()[0].roleName }}</b> leads at {{ breakdown()[0].pct }}%
                </p>
              } @else if (hasRoles()) {
                <p class="im-hero__topline im-hero__topline--muted">No time logged yet this window</p>
              }
            </div>
          }
        </header>

        @if (loading()) {
          <div class="im-seg-wrap" aria-hidden="true">
            <app-bs-skeleton width="100%" height="44px" radius="var(--r-pill)" />
          </div>
          <div class="im-list" aria-hidden="true">
            @for (n of skeletonCells; track n) {
              <app-bs-skeleton height="64px" radius="var(--r-tile)" />
            }
          </div>

        } @else if (errored()) {
          <div class="im-state">
            <span class="im-state__orb"><mat-icon aria-hidden="true">cloud_off</mat-icon></span>
            <h2 class="im-state__title">Couldn't load your map</h2>
            <p class="im-state__body">Something went wrong fetching your roles. Give it another go.</p>
            <button type="button" class="im-state__cta" (click)="reload()">
              <mat-icon aria-hidden="true">refresh</mat-icon> Try again
            </button>
          </div>

        } @else {
          <!-- ─── RANGE WINDOW ─── -->
          <div class="im-seg-wrap">
            <app-bs-segmented class="im-seg"
              [segments]="rangeSegments" [value]="rangeKey()" label="Time window"
              (change)="setRange($event)" />
          </div>

          @if (!hasRoles()) {
            <!-- EMPTY: no roles yet -->
            <div class="im-empty">
              <span class="im-empty__orb"><mat-icon aria-hidden="true">category</mat-icon></span>
              <h2 class="im-empty__title">No roles yet</h2>
              <p class="im-empty__body">Add a role like “Parent”, “Coder” or “Athlete”, then log time against it.</p>
              <button type="button" class="im-empty__cta" (click)="openAddRole()">
                <mat-icon aria-hidden="true">add</mat-icon> Add a role
              </button>
            </div>

          } @else {
            <!-- ─── THE SPLIT: proportional bars (the radial re-presented) ─── -->
            @if (hasTime()) {
              <section class="im-split">
                <h2 class="im-split__h"><mat-icon aria-hidden="true">donut_large</mat-icon> The split</h2>
                @for (r of breakdown(); track r.roleId) {
                  <div class="im-bar-row">
                    <div class="im-bar-top">
                      <span class="im-bar-name">
                        <span class="im-dot" [style.background]="r.color" aria-hidden="true"></span>{{ r.roleName }}
                      </span>
                      <span class="im-bar-val mono-num">{{ minutesLabel(r.minutes) }} · {{ r.pct }}%</span>
                    </div>
                    <div class="im-bar-track">
                      <span class="im-bar-fill" [style.width.%]="r.pct" [style.background]="r.color"></span>
                    </div>
                  </div>
                }
              </section>
            }

            <!-- ─── ROLES: swipe left to archive/restore, right to log ─── -->
            <section class="im-roles">
              <div class="im-roles__head">
                <h2 class="im-roles__h"><mat-icon aria-hidden="true">groups</mat-icon> Roles</h2>
                <button type="button" class="im-roles__add" (click)="openAddRole()">
                  <mat-icon aria-hidden="true">add</mat-icon> Add
                </button>
              </div>
              <div class="im-list">
                @for (role of orderedRoles(); track role.id; let i = $index) {
                  <app-bs-swipe-row class="im-swipe im-reveal" [style.--ri]="i"
                    [leftLabel]="role.archived ? 'Restore' : 'Archive'"
                    rightLabel="Log time" [disabled]="isBusy(role.id)"
                    [label]="role.name"
                    (swipe)="onSwipe(role, $event)">
                    <button type="button" class="im-role" [class.is-archived]="role.archived"
                            [class.is-busy]="isBusy(role.id)"
                            (click)="openLogFor(role)" [attr.aria-label]="roleAria(role)">
                      <span class="im-role__swatch" [style.background]="role.color" aria-hidden="true"></span>
                      <span class="im-role__body">
                        <span class="im-role__name">{{ role.name }}</span>
                        <span class="im-role__meta">
                          @if (role.archived) { Archived · keeps history }
                          @else { <span class="mono-num">{{ minutesLabel(minutesFor(role.id)) }}</span> this window }
                        </span>
                      </span>
                      <mat-icon class="im-role__go" aria-hidden="true">add_circle</mat-icon>
                    </button>
                  </app-bs-swipe-row>
                }
              </div>
              <p class="im-foot" aria-hidden="true">Swipe a role left to {{ anyArchived() ? 'archive / restore' : 'archive' }} · right to log time</p>
            </section>
          }
        }
      </div>
    </app-bs-pull-refresh>

    @if (!loading() && !errored() && hasRoles()) {
      <app-bs-fab icon="more_time" label="Log time" [extended]="true" [fixed]="true" (action)="openLog()" />
    }

    <!-- ─────────────── QUICK-LOG SHEET ─────────────── -->
    <app-bs-sheet [(open)]="logOpen" detent="half" [dismissable]="!logging()" label="Log time">
      <form class="if" (ngSubmit)="logTime()">
        <div class="if__head">
          <h3 class="if__title">Log time</h3>
          <button type="button" class="if__close" (click)="closeLog()" aria-label="Cancel" [disabled]="logging()">
            <mat-icon aria-hidden="true">close</mat-icon>
          </button>
        </div>

        <span class="if__label">Role</span>
        <div class="if__chips" role="radiogroup" aria-label="Role">
          @for (role of activeRoles(); track role.id) {
            <button type="button" class="if__chip" [class.is-sel]="logRoleId() === role.id"
                    role="radio" [attr.aria-checked]="logRoleId() === role.id"
                    [style.--chip]="role.color" (click)="logRoleId.set(role.id)">
              <span class="if__chip-dot" [style.background]="role.color" aria-hidden="true"></span>{{ role.name }}
            </button>
          }
        </div>

        <div class="if__row">
          <label class="if__field if__field--sm">
            <span class="if__flabel">Minutes</span>
            <input class="if__input mono-num" type="number" inputmode="numeric" min="1" max="1440" step="5"
                   [ngModel]="logMinutes()" (ngModelChange)="logMinutes.set($event)" name="minutes" />
          </label>
          <label class="if__field if__field--sm">
            <span class="if__flabel">Date</span>
            <input class="if__input" type="date" [max]="todayIso()"
                   [ngModel]="logDate()" (ngModelChange)="logDate.set($event)" name="date" />
          </label>
        </div>

        <!-- quick minute pills -->
        <div class="if__quick">
          @for (q of quickMinutes; track q) {
            <button type="button" class="if__quick-pill" [class.is-sel]="logMinutes() === q"
                    (click)="logMinutes.set(q)">{{ minutesLabel(q) }}</button>
          }
        </div>

        <label class="if__field">
          <span class="if__flabel">Note <i>(optional)</i></span>
          <input class="if__input" type="text" maxlength="200" autocomplete="off"
                 placeholder="What were you doing?"
                 [ngModel]="logNote()" (ngModelChange)="logNote.set($event)" name="note" />
        </label>

        <div class="if__actions">
          <button type="button" class="if__btn if__btn--ghost" (click)="closeLog()" [disabled]="logging()">Cancel</button>
          <button type="submit" class="if__btn if__btn--save" [disabled]="!canLog()">
            @if (logging()) { <span class="if__spin" aria-hidden="true"></span> Logging… }
            @else { <mat-icon aria-hidden="true">check</mat-icon> Log time }
          </button>
        </div>
      </form>
    </app-bs-sheet>

    <!-- ─────────────── ADD-ROLE SHEET ─────────────── -->
    <app-bs-sheet [(open)]="roleOpen" detent="half" [dismissable]="!addingRole()" label="Add a role">
      <form class="if" (ngSubmit)="addRole()">
        <div class="if__head">
          <h3 class="if__title">Add a role</h3>
          <button type="button" class="if__close" (click)="closeAddRole()" aria-label="Cancel" [disabled]="addingRole()">
            <mat-icon aria-hidden="true">close</mat-icon>
          </button>
        </div>

        <label class="if__field">
          <span class="if__flabel">Name</span>
          <input class="if__input" type="text" maxlength="60" autocomplete="off"
                 placeholder="e.g. Parent, Coder, Athlete"
                 [ngModel]="newRoleName()" (ngModelChange)="newRoleName.set($event)" name="rolename" />
        </label>

        <span class="if__flabel">Colour</span>
        <div class="if__swatches" role="radiogroup" aria-label="Role colour">
          @for (c of palette; track c) {
            <button type="button" class="if__swatch" [class.is-sel]="newRoleColor() === c"
                    role="radio" [attr.aria-checked]="newRoleColor() === c"
                    [style.background]="c" [attr.aria-label]="'Colour ' + c"
                    (click)="newRoleColor.set(c)"></button>
          }
        </div>

        <div class="if__actions">
          <button type="button" class="if__btn if__btn--ghost" (click)="closeAddRole()" [disabled]="addingRole()">Cancel</button>
          <button type="submit" class="if__btn if__btn--save" [disabled]="!canAddRole()">
            @if (addingRole()) { <span class="if__spin" aria-hidden="true"></span> Adding… }
            @else { <mat-icon aria-hidden="true">add</mat-icon> Add role }
          </button>
        </div>
      </form>
    </app-bs-sheet>

    <app-bs-toaster />
  `,
  styleUrl: './identity-mobile.page.scss',
})
export class IdentityMobilePage {
  private api = inject(Api);
  private toast = inject(ToastController);

  // ---- raw server state (verbatim from the live endpoints) ----
  readonly roles = signal<IdentityRole[]>([]);
  readonly totals = signal<IdentityMapData['totals']>([]);

  readonly loading = signal(true);
  readonly errored = signal(false);
  readonly refreshing = signal(false);

  /** Per-role in-flight ids (archive toggle) so only that row's controls disable. */
  private readonly busyIds = signal<Set<number>>(new Set());

  // ---- range window ----
  readonly rangePresets: readonly RangePreset[] = [
    { key: '7', label: 'Last 7 days', days: 7 },
    { key: '30', label: 'Last 30 days', days: 30 },
    { key: '90', label: 'Last 90 days', days: 90 },
  ];
  readonly rangeSegments: Segment[] = this.rangePresets.map((p) => ({ key: p.key, label: `${p.days}d` }));
  readonly rangeKey = signal<string>('30');
  readonly fromDate = signal<string>(this.isoDaysAgo(30));
  readonly toDate = signal<string>(this.todayIso());

  /** Default colour palette (mirrors the live page for parity). */
  readonly palette = [
    '#3d8bff', '#8b7cff', '#3fd8d0', '#3dd68c', '#f2b340', '#ff5c6c', '#a855f7', '#ec4899',
  ];

  // ---- quick-log sheet ----
  readonly logOpen = signal(false);
  readonly logRoleId = signal<number | null>(null);
  readonly logDate = signal<string>(this.todayIso());
  readonly logMinutes = signal<number>(60);
  readonly logNote = signal<string>('');
  readonly logging = signal(false);
  readonly quickMinutes = [15, 30, 45, 60, 90, 120];

  // ---- add-role sheet ----
  readonly roleOpen = signal(false);
  readonly newRoleName = signal<string>('');
  readonly newRoleColor = signal<string>(this.palette[0]);
  readonly addingRole = signal(false);

  readonly skeletonCells = Array.from({ length: 4 }, (_, i) => i);

  /** Non-archived roles, in sort order then name — the chip picker + bar source. */
  readonly activeRoles = computed<IdentityRole[]>(() =>
    [...this.roles()]
      .filter((r) => !r.archived)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)),
  );

  /** All roles (active first, then archived) for the manageable roles list. */
  readonly orderedRoles = computed<IdentityRole[]>(() =>
    [...this.roles()].sort(
      (a, b) =>
        Number(a.archived) - Number(b.archived) ||
        a.sortOrder - b.sortOrder ||
        a.name.localeCompare(b.name),
    ),
  );

  readonly hasRoles = computed<boolean>(() => this.activeRoles().length > 0);
  readonly anyArchived = computed<boolean>(() => this.roles().some((r) => r.archived));

  readonly totalMinutes = computed<number>(() => this.totals().reduce((s, t) => s + t.minutes, 0));
  readonly hasTime = computed<boolean>(() => this.totalMinutes() > 0);

  /** Role-time rows for the bar breakdown, minutes desc, with a % of the total. */
  readonly breakdown = computed(() => {
    const total = this.totalMinutes();
    return [...this.totals()]
      .filter((t) => t.minutes > 0)
      .sort((a, b) => b.minutes - a.minutes)
      .map((t) => ({ ...t, pct: total > 0 ? Math.round((t.minutes / total) * 1000) / 10 : 0 }));
  });

  /** The hero ring fraction = the leading role's share of the window total (0 when no time). */
  readonly topFraction = computed<number>(() => {
    const rows = this.breakdown();
    const total = this.totalMinutes();
    if (rows.length === 0 || total === 0) return 0;
    return rows[0].minutes / total;
  });

  readonly rangeLabel = computed<string>(
    () => this.rangePresets.find((p) => p.key === this.rangeKey())?.label.replace('Last ', '') ?? '30 days',
  );

  readonly ringAria = computed<string>(() => {
    const rows = this.breakdown();
    if (rows.length === 0) return `No time logged in the ${this.rangeLabel()}.`;
    const top = rows.slice(0, 3).map((r) => `${r.roleName} ${r.pct}%`).join(', ');
    return `Time split across ${rows.length} role${rows.length === 1 ? '' : 's'}, ${this.minutesLabel(this.totalMinutes())} total over the ${this.rangeLabel()}. Top: ${top}.`;
  });

  readonly canLog = computed<boolean>(
    () => this.logRoleId() != null && (this.logMinutes() || 0) > 0 && !this.logging(),
  );
  readonly canAddRole = computed<boolean>(() => this.newRoleName().trim().length > 0 && !this.addingRole());

  constructor() {
    void this.reload();
  }

  // ─────────────── LOAD ───────────────

  async reload(): Promise<void> {
    const wasLoaded = !this.loading();
    if (wasLoaded) this.refreshing.set(true); else this.loading.set(true);
    this.errored.set(false);
    try {
      const data = await firstValueFrom(this.api.identityMap(this.fromDate(), this.toDate()));
      this.applyData(data);
      // Default the log-role chip to the first active role so the sheet is ready.
      if (this.logRoleId() == null || !this.activeRoles().some((r) => r.id === this.logRoleId())) {
        this.logRoleId.set(this.activeRoles()[0]?.id ?? null);
      }
    } catch {
      this.errored.set(true);
    } finally {
      this.loading.set(false);
      if (wasLoaded) {
        this.refreshing.set(false);
        this.toast.show('Map refreshed', { tone: 'success', durationMs: 1500 });
      }
    }
  }

  /** Re-fetch the aggregate quietly (after a mutation or a range change). */
  private async refresh(): Promise<void> {
    try {
      const data = await firstValueFrom(this.api.identityMap(this.fromDate(), this.toDate()));
      this.applyData(data);
      if (this.logRoleId() == null || !this.activeRoles().some((r) => r.id === this.logRoleId())) {
        this.logRoleId.set(this.activeRoles()[0]?.id ?? null);
      }
    } catch {
      this.toast.show("Couldn't refresh — try again", { tone: 'warn' });
    }
  }

  private applyData(data: IdentityMapData): void {
    // Defensive: tolerate a thin/partial payload so the page renders an empty state
    // instead of throwing on a non-iterable roles()/totals() during load.
    this.roles.set(data?.roles ?? []);
    this.totals.set(data?.totals ?? []);
  }

  // ─────────────── RANGE ───────────────

  setRange(key: string): void {
    const preset = this.rangePresets.find((p) => p.key === key);
    if (!preset) return;
    this.rangeKey.set(key);
    this.fromDate.set(this.isoDaysAgo(preset.days));
    this.toDate.set(this.todayIso());
    void this.refresh();
  }

  // ─────────────── helpers ───────────────

  isBusy(id: number): boolean {
    return this.busyIds().has(id);
  }

  private setBusy(id: number, on: boolean): void {
    this.busyIds.update((set) => {
      const next = new Set(set);
      if (on) next.add(id); else next.delete(id);
      return next;
    });
  }

  /** Minutes logged for one role in the active window (0 when none). */
  minutesFor(roleId: number): number {
    return this.totals().find((t) => t.roleId === roleId)?.minutes ?? 0;
  }

  roleAria(role: IdentityRole): string {
    if (role.archived) return `${role.name}, archived. Open to log time or swipe to restore.`;
    return `${role.name}, ${this.minutesLabel(this.minutesFor(role.id))} logged this window. Open to log time.`;
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

  // ─────────────── ROLES (swipe) ───────────────

  /** Swipe on a role row: left = archive/restore, right = open the log sheet. */
  onSwipe(role: IdentityRole, side: 'left' | 'right'): void {
    if (side === 'left') void this.toggleArchive(role);
    else this.openLogFor(role);
  }

  /** Toggle a role's archived flag (archived roles keep history but drop out of the picker + split). */
  async toggleArchive(role: IdentityRole): Promise<void> {
    if (this.isBusy(role.id)) return;
    const next = !role.archived;
    this.setBusy(role.id, true);
    try {
      await firstValueFrom(this.api.patchIdentityRole(role.id, { archived: next }));
      await this.refresh();
      this.toast.show(next ? `Archived “${role.name}”` : `Restored “${role.name}”`,
        { tone: 'success', durationMs: 1600 });
    } catch {
      this.toast.show("Couldn't update that role — try again", { tone: 'warn' });
    } finally {
      this.setBusy(role.id, false);
    }
  }

  // ─────────────── ADD ROLE ───────────────

  openAddRole(): void {
    this.newRoleName.set('');
    this.newRoleColor.set(this.nextColor());
    this.roleOpen.set(true);
  }

  closeAddRole(): void {
    if (this.addingRole()) return;
    this.roleOpen.set(false);
  }

  /** A palette colour not yet used by an active role (falls back to rotation). */
  private nextColor(): string {
    const used = new Set(this.roles().map((r) => r.color));
    return this.palette.find((c) => !used.has(c)) ?? this.palette[this.roles().length % this.palette.length];
  }

  async addRole(): Promise<void> {
    if (!this.canAddRole()) {
      if (!this.newRoleName().trim()) this.toast.show('Give the role a name first.', { tone: 'warn' });
      return;
    }
    this.addingRole.set(true);
    const body: IdentityRoleInput = { name: this.newRoleName().trim(), color: this.newRoleColor() };
    try {
      const created = await firstValueFrom(this.api.createIdentityRole(body));
      await this.refresh();
      this.logRoleId.set(created.id);
      this.roleOpen.set(false);
      this.toast.show(`Added “${created.name}”`, { tone: 'success', durationMs: 1800 });
    } catch {
      this.toast.show("Couldn't add that role — is the name already used?", { tone: 'warn' });
    } finally {
      this.addingRole.set(false);
    }
  }

  // ─────────────── LOG TIME ───────────────

  openLog(): void {
    if (this.logRoleId() == null) this.logRoleId.set(this.activeRoles()[0]?.id ?? null);
    this.logDate.set(this.todayIso());
    this.logNote.set('');
    this.logOpen.set(true);
  }

  /** Open the log sheet pre-targeted at one role (from a row tap or right-swipe). */
  openLogFor(role: IdentityRole): void {
    if (role.archived) {
      void this.toggleArchive(role);
      return;
    }
    this.logRoleId.set(role.id);
    this.logDate.set(this.todayIso());
    this.logNote.set('');
    this.logOpen.set(true);
  }

  closeLog(): void {
    if (this.logging()) return;
    this.logOpen.set(false);
  }

  async logTime(): Promise<void> {
    const roleId = this.logRoleId();
    const minutes = this.logMinutes();
    if (roleId == null) {
      this.toast.show('Pick a role to log time against.', { tone: 'warn' });
      return;
    }
    if (!minutes || minutes <= 0) {
      this.toast.show('Enter how many minutes (at least 1).', { tone: 'warn' });
      return;
    }
    this.logging.set(true);
    try {
      await firstValueFrom(
        this.api.addIdentityTime({
          roleId,
          date: this.logDate(),
          minutes: Math.min(1440, Math.round(minutes)),
          note: this.logNote().trim() || null,
        }),
      );
      this.logOpen.set(false);
      this.logNote.set('');
      await this.refresh();
      this.toast.show('Logged — your split is updated', { tone: 'success', durationMs: 1800 });
    } catch {
      this.toast.show("Couldn't log that — try again", { tone: 'warn' });
    } finally {
      this.logging.set(false);
    }
  }

  // ─────────────── date helpers ───────────────

  todayIso(): string {
    return this.toLocalDate(new Date());
  }

  private isoDaysAgo(days: number): string {
    const d = new Date();
    d.setDate(d.getDate() - days);
    return this.toLocalDate(d);
  }

  private toLocalDate(d: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
}
