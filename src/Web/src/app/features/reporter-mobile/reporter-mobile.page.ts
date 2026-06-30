import {
  ChangeDetectionStrategy, Component, computed, inject, signal,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { MatIconModule } from '@angular/material/icon';

import { Api } from '../../core/api';
import { AuthService } from '../../core/auth';
import { IngestKey, IngestKeyCreated, PERM } from '../../core/models';
import {
  BetaPullRefresh, BetaSegmentedControl, BetaBottomSheet, BetaSkeleton,
  BetaFab, BetaToaster, ToastController, type Segment,
} from '../beta-ui';

/** One condensed setup recipe shown in the "How to connect" sheet. */
interface SetupStep {
  readonly icon: string;
  readonly title: string;
  readonly blurb: string;
  /** Copyable command lines (each rendered as its own copy chip). */
  readonly cmds: readonly { readonly label: string; readonly cmd: string }[];
}

/**
 * Reporter "Ingest keys" — the MOBILE twin of the live `/reporter` page, rebuilt on the shared beta-ui
 * "Strata" kit (`@use '../beta-ui/beta-kit'`) with a signature CYAN → BLUE accent (a "wire / telemetry"
 * hue). It is a native-feel key manager: an immersive header with a tiny live/revoked stat strip, an
 * optional {@link BetaSegmentedControl} (All / Active / Revoked — only when the caller manages the whole
 * fleet), a list of glassy key cards (owner, prefix, last-used, with a swipe-free Revoke button on rows
 * the caller may revoke), a {@link BetaFab} that opens a CREATE {@link BetaBottomSheet} (label → mint),
 * a one-time fresh-key reveal card with copy, and a second sheet that condenses the install/run SETUP
 * GUIDE (desktop agent + console reporter commands, copyable). Pull-to-refresh, skeletons, empty + error.
 *
 * DATA PARITY + PRIVACY: every key comes from the SAME reporter/ingest-key endpoints the live page uses —
 * {@link Api.ingestKeys} (GET, server-scoped: manage sees all, self/view see own), {@link
 * Api.createIngestKey} and {@link Api.revokeIngestKey} VERBATIM. The fresh raw key is shown ONCE (never
 * re-fetchable). The server enforces all ownership: this UI only offers Revoke on rows it could revoke
 * (`canManage` OR `isMine`), exactly like the live page, and never surfaces an email (owner DISPLAY NAME
 * only). The run commands are built from `window.location.origin` + the just-minted key, mirroring live.
 *
 * ISOLATION: gated by `platform.mobile` on the SAME `/reporter` route + the SAME reporter.* perms the live
 * route carries; it consumes the kit + the SAME Api/auth as the live counterpart. No live page is imported
 * or modified. Mobile-first (44px targets, safe-area insets), centers on desktop.
 */
@Component({
  selector: 'app-reporter-mobile',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [ToastController],
  imports: [
    DatePipe, FormsModule, MatIconModule,
    BetaPullRefresh, BetaSegmentedControl, BetaBottomSheet, BetaSkeleton,
    BetaFab, BetaToaster,
  ],
  template: `
    <!-- ─────────────── PULL-TO-REFRESH OWNS THE SCROLL ─────────────── -->
    <app-bs-pull-refresh class="rp-ptr" [busy]="refreshing()" (refresh)="reload()">
      <div class="rp-scroll" aria-live="polite">

        <!-- ─── IMMERSIVE HEADER: title + stat strip ─── -->
        <header class="rp-hero">
          <p class="rp-hero__kicker"><mat-icon aria-hidden="true">sensors</mat-icon> Reporter</p>
          <h1 class="rp-hero__title">Ingest keys</h1>
          <p class="rp-hero__sub">Mint a key, run a reporter, and stream token usage here — prompts never leave your machine.</p>

          @if (!loading() && !errored()) {
            <div class="rp-stats">
              <div class="rp-stat">
                <span class="rp-stat__n mono-num">{{ activeCount() }}</span>
                <span class="rp-stat__l">active</span>
              </div>
              <div class="rp-stat">
                <span class="rp-stat__n mono-num">{{ revokedCount() }}</span>
                <span class="rp-stat__l">revoked</span>
              </div>
              @if (canManage()) {
                <div class="rp-stat">
                  <span class="rp-stat__n mono-num">{{ keys().length }}</span>
                  <span class="rp-stat__l">fleet-wide</span>
                </div>
              }
            </div>
          }

          <button type="button" class="rp-guidebtn" (click)="guideOpen.set(true)">
            <mat-icon aria-hidden="true">menu_book</mat-icon> How to connect a reporter
            <mat-icon class="rp-guidebtn__go" aria-hidden="true">chevron_right</mat-icon>
          </button>
        </header>

        @if (loading()) {
          <!-- skeleton list -->
          <div class="rp-list" aria-hidden="true">
            @for (n of skeletonCells; track n) {
              <app-bs-skeleton height="84px" radius="var(--r-tile)" />
            }
          </div>

        } @else if (errored()) {
          <div class="rp-state">
            <span class="rp-state__orb"><mat-icon aria-hidden="true">cloud_off</mat-icon></span>
            <h2 class="rp-state__title">Couldn't load your keys</h2>
            <p class="rp-state__body">Something went wrong reaching the ingest-key service. Give it another go.</p>
            <button type="button" class="rp-state__cta" (click)="reload()">
              <mat-icon aria-hidden="true">refresh</mat-icon> Try again
            </button>
          </div>

        } @else {
          <!-- ─── FILTER (only when the caller manages the whole fleet) ─── -->
          @if (canManage() && keys().length) {
            <div class="rp-seg-wrap">
              <app-bs-segmented class="rp-seg"
                [segments]="filterSegments()" [value]="filter()" label="Filter keys"
                (change)="setFilter($event)" />
            </div>
          }

          @if (visibleKeys(); as list) {
            @if (list.length) {
              <div class="rp-list">
                @for (k of list; track k.id; let i = $index) {
                  <div class="rp-card rp-reveal" [style.--ri]="i" [class.is-revoked]="k.revoked"
                       [class.is-busy]="isBusy(k.id)">
                    <span class="rp-card__dot" [class.off]="k.revoked" aria-hidden="true"></span>
                    <span class="rp-card__body">
                      <span class="rp-card__line1">
                        <span class="rp-card__name">{{ k.name }}</span>
                        <code class="rp-card__prefix mono">{{ k.prefix }}</code>
                        @if (k.revoked) { <span class="rp-card__badge">revoked</span> }
                      </span>
                      <span class="rp-card__line2">
                        <mat-icon class="rp-card__owner-ic" aria-hidden="true">person</mat-icon>
                        <span class="rp-card__owner" [class.mine]="isMine(k)">
                          {{ k.ownerName || 'unlinked' }}@if (isMine(k)) { <span class="rp-card__you">you</span> }
                        </span>
                        <span class="rp-card__sep" aria-hidden="true">·</span>
                        @if (k.lastUsedUtc) {
                          <span class="rp-card__used">used {{ k.lastUsedUtc | date: 'MMM d, HH:mm' }}</span>
                        } @else {
                          <span class="rp-card__used rp-card__used--never">never used</span>
                        }
                      </span>
                    </span>
                    @if (!k.revoked && (canManage() || isMine(k))) {
                      <button type="button" class="rp-card__revoke" [disabled]="isBusy(k.id)"
                              [attr.aria-label]="'Revoke key ' + k.name" (click)="revoke(k)">
                        <mat-icon aria-hidden="true">block</mat-icon>
                      </button>
                    }
                  </div>
                }
              </div>
            } @else {
              <!-- EMPTY -->
              <div class="rp-empty">
                <span class="rp-empty__orb"><mat-icon aria-hidden="true">vpn_key_off</mat-icon></span>
                @if (filter() !== 'all' && keys().length) {
                  <h2 class="rp-empty__title">No {{ filter() }} keys</h2>
                  <p class="rp-empty__body">Switch the filter to see your other keys.</p>
                } @else if (canCreate()) {
                  <h2 class="rp-empty__title">No ingest keys yet</h2>
                  <p class="rp-empty__body">{{ canManage() ? 'No keys anywhere yet.' : 'You have no keys yet.' }} Tap the + button below to mint one.</p>
                } @else {
                  <h2 class="rp-empty__title">No ingest keys</h2>
                  <p class="rp-empty__body">There are no keys to show for your access.</p>
                }
              </div>
            }
          }
        }
      </div>
    </app-bs-pull-refresh>

    <!-- ─── CREATE FAB (only for callers who may mint keys) ─── -->
    @if (!loading() && !errored() && canCreate()) {
      <app-bs-fab icon="add" label="Mint key" [extended]="true" [fixed]="true" (action)="openCreate()" />
    }

    <!-- ─────────────── CREATE SHEET ─────────────── -->
    <app-bs-sheet [(open)]="createOpen" detent="half" [dismissable]="!generating()" label="Mint an ingest key">
      <div class="rk">
        <div class="rk__head">
          <span class="rk__glyph" aria-hidden="true"><mat-icon>vpn_key</mat-icon></span>
          <div class="rk__titles">
            <h3 class="rk__title">Mint an ingest key</h3>
            <p class="rk__sub">It's shown <b>once</b> and stored only as a hash — copy it right away.</p>
          </div>
        </div>

        @if (freshKey(); as fk) {
          <!-- one-time reveal -->
          <div class="rk__fresh">
            <div class="rk__fresh-head">
              <mat-icon class="rk__fresh-ic" aria-hidden="true">check_circle</mat-icon>
              <span class="rk__fresh-title">“{{ fk.name }}” minted — copy it now, it won't be shown again.</span>
            </div>
            <code class="rk__fresh-key mono">{{ fk.key }}</code>
            <button type="button" class="rk__copy" (click)="copyKey()">
              <mat-icon aria-hidden="true">{{ copied() ? 'done' : 'content_copy' }}</mat-icon>
              {{ copied() ? 'Copied' : 'Copy key' }}
            </button>
            <button type="button" class="rk__done" (click)="closeCreate()">
              <mat-icon aria-hidden="true">check</mat-icon> Done
            </button>
            <p class="rk__fresh-hint">
              Next: open <button type="button" class="rk__inline" (click)="openGuideFromFresh()">How to connect</button>
              and paste this key into your reporter.
            </p>
          </div>
        } @else {
          <form class="rk__form" (ngSubmit)="generateKey()">
            <label class="rk__field">
              <span class="rk__label">Label</span>
              <input class="rk__input" type="text" name="keyName" maxlength="64" autocomplete="off"
                     placeholder="e.g. laptop, build-server"
                     [ngModel]="newKeyName()" (ngModelChange)="newKeyName.set($event)" />
              <span class="rk__help">Names the machine this key reports under.</span>
            </label>
            <button type="submit" class="rk__mint" [disabled]="generating()">
              @if (generating()) { <span class="rk__spin" aria-hidden="true"></span> Minting… }
              @else { <mat-icon aria-hidden="true">vpn_key</mat-icon> Mint key }
            </button>
          </form>
        }
      </div>
    </app-bs-sheet>

    <!-- ─────────────── SETUP GUIDE SHEET ─────────────── -->
    <app-bs-sheet [(open)]="guideOpen" detent="full" label="How to connect a reporter">
      <div class="rg">
        <div class="rg__head">
          <span class="rg__glyph" aria-hidden="true"><mat-icon>menu_book</mat-icon></span>
          <div class="rg__titles">
            <h3 class="rg__title">Connect a reporter</h3>
            <p class="rg__sub">Pushes to <b class="mono">{{ serverUrl() }}</b>. Mint a key first, then pick a reporter.</p>
          </div>
        </div>

        <!-- flow -->
        <div class="rg__flow" aria-hidden="true">
          <span class="rg__flow-node"><mat-icon>computer</mat-icon> Your machine</span>
          <mat-icon class="rg__flow-arr">arrow_forward</mat-icon>
          <span class="rg__flow-node"><mat-icon>vpn_key</mat-icon> /api/ingest</span>
          <mat-icon class="rg__flow-arr">arrow_forward</mat-icon>
          <span class="rg__flow-node"><mat-icon>cloud</mat-icon> Usage IQ</span>
        </div>

        @for (s of setupSteps(); track s.title) {
          <section class="rg__step">
            <div class="rg__step-head">
              <span class="rg__step-ic" aria-hidden="true"><mat-icon>{{ s.icon }}</mat-icon></span>
              <div class="rg__step-titles">
                <h4 class="rg__step-title">{{ s.title }}</h4>
                <p class="rg__step-blurb">{{ s.blurb }}</p>
              </div>
            </div>
            @for (c of s.cmds; track c.cmd) {
              <div class="rg__cmd">
                <div class="rg__cmd-top">
                  <span class="rg__cmd-label">{{ c.label }}</span>
                  <button type="button" class="rg__cmd-copy" [attr.aria-label]="'Copy: ' + c.label"
                          (click)="copy(c.cmd, 'Command copied')">
                    <mat-icon aria-hidden="true">content_copy</mat-icon>
                  </button>
                </div>
                <code class="rg__cmd-code mono">{{ c.cmd }}</code>
              </div>
            }
          </section>
        }

        <p class="rg__foot">
          <mat-icon aria-hidden="true">lock</mat-icon>
          The server stays authoritative — it prices, resolves the project, and de-dupes, so re-runs are
          idempotent. Usage is attributed to its machine and the account that owns the key.
        </p>
      </div>
    </app-bs-sheet>

    <app-bs-toaster />
  `,
  styleUrl: './reporter-mobile.page.scss',
})
export class ReporterMobilePage {
  private api = inject(Api);
  private toast = inject(ToastController);
  readonly auth = inject(AuthService);

  /** Every key the server returns for this caller (scoped server-side: manage=all, self/view=own). */
  readonly keys = signal<IngestKey[]>([]);

  readonly loading = signal(true);
  readonly errored = signal(false);
  readonly refreshing = signal(false);

  /** Per-key in-flight ids (revoke) so only that card's button disables. */
  private readonly busyIds = signal<Set<number>>(new Set());

  /** This dashboard's origin IS the reporter's `--url` value (mirrors the live page). */
  readonly serverUrl = signal(window.location.origin);

  // ---- create sheet ----
  readonly createOpen = signal(false);
  readonly newKeyName = signal('');
  readonly generating = signal(false);
  /** The most recently minted key — shown once in the sheet, never re-fetchable. */
  readonly freshKey = signal<IngestKeyCreated | null>(null);
  readonly copied = signal(false);

  // ---- setup guide sheet ----
  readonly guideOpen = signal(false);

  // ---- fleet filter (only meaningful for managers) ----
  readonly filter = signal<'all' | 'active' | 'revoked'>('all');

  readonly skeletonCells = Array.from({ length: 4 }, (_, i) => i);

  /** Full-fleet management (sees + may revoke every key). */
  readonly canManage = computed(() => this.auth.hasPermission(PERM.reporterManage));
  /** May mint/revoke own keys (both self-service + full-manage callers). */
  readonly canCreate = computed(() =>
    this.auth.hasAnyPermission(PERM.reporterManage, PERM.reporterSelf),
  );

  readonly activeCount = computed(() => this.keys().filter(k => !k.revoked).length);
  readonly revokedCount = computed(() => this.keys().filter(k => k.revoked).length);

  readonly filterSegments = computed<Segment[]>(() => [
    { key: 'all', label: `All${this.keys().length ? ' · ' + this.keys().length : ''}` },
    { key: 'active', label: `Active${this.activeCount() ? ' · ' + this.activeCount() : ''}` },
    { key: 'revoked', label: `Revoked${this.revokedCount() ? ' · ' + this.revokedCount() : ''}` },
  ]);

  /** The list backing the active filter (managers only ever change the filter). */
  readonly visibleKeys = computed<IngestKey[]>(() => {
    const all = this.keys();
    switch (this.filter()) {
      case 'active': return all.filter(k => !k.revoked);
      case 'revoked': return all.filter(k => k.revoked);
      default: return all;
    }
  });

  /** Condensed install/run guide — built from the live page's exact commands + serverUrl. */
  readonly setupSteps = computed<SetupStep[]>(() => {
    const url = this.serverUrl();
    const key = this.freshKey()?.key ?? '<your-key>';
    return [
      {
        icon: 'desktop_windows',
        title: 'Desktop agent (Windows · easiest)',
        blurb: 'A system-tray app — paste this server\'s URL + your key once in its Settings screen and it watches your logs in the background.',
        cmds: [
          { label: 'Run from source (.NET 9 SDK)', cmd: 'dotnet run --project src/Agent' },
          {
            label: 'Publish a self-contained tray exe',
            cmd: 'dotnet publish src/Agent -c Release -r win-x64 --self-contained '
              + '-p:PublishSingleFile=true -o publish/agent',
          },
        ],
      },
      {
        icon: 'terminal',
        title: 'Console reporter (headless / cron)',
        blurb: 'A small cross-platform .NET console app for servers, CI, systemd, Task Scheduler, or cron. Pass --once for a single pass.',
        cmds: [
          {
            label: 'Clone + build',
            cmd: 'git clone https://github.com/itdept-ops/usage-iq && cd usage-iq\n'
              + 'dotnet build src/Reporter -c Release',
          },
          { label: 'Run the built binary', cmd: `usage-iq-reporter --url ${url} --key ${key}` },
          { label: '…or straight from source', cmd: `dotnet run --project src/Reporter -- --url ${url} --key ${key}` },
        ],
      },
      {
        icon: 'event_repeat',
        title: 'Keep it running',
        blurb: 'Run the watcher under your OS service manager so it survives reboots, or schedule --once on a timer.',
        cmds: [
          {
            label: 'Linux (systemd)',
            cmd: `[Service]\nEnvironment=REPORTER_URL=${url}\nEnvironment=REPORTER_KEY=uiq_…\n`
              + 'ExecStart=/opt/usage-iq/usage-iq-reporter\nRestart=always',
          },
          {
            label: 'cron (hourly --once)',
            cmd: `0 * * * * usage-iq-reporter --url ${url} --key uiq_… --once`,
          },
        ],
      },
    ];
  });

  constructor() {
    void this.reload();
  }

  // ─────────────── LOAD ───────────────

  async reload(): Promise<void> {
    const wasLoaded = !this.loading();
    if (wasLoaded) this.refreshing.set(true); else this.loading.set(true);
    this.errored.set(false);
    try {
      const keys = await firstValueFrom(this.api.ingestKeys());
      this.keys.set(keys ?? []);
    } catch {
      this.errored.set(true);
    } finally {
      this.loading.set(false);
      if (wasLoaded) {
        this.refreshing.set(false);
        this.toast.show('Keys refreshed', { tone: 'success', durationMs: 1600 });
      }
    }
  }

  setFilter(key: string): void {
    this.filter.set(key === 'active' ? 'active' : key === 'revoked' ? 'revoked' : 'all');
  }

  // ─────────────── helpers ───────────────

  /** True when a key is owned by the signed-in caller (matched by AppUser id; no email exposed). */
  isMine(k: IngestKey): boolean {
    const me = this.auth.userId();
    return me != null && k.ownerUserId === me;
  }

  isBusy(id: number): boolean {
    return this.busyIds().has(id);
  }

  private setBusy(id: number, on: boolean): void {
    this.busyIds.update((set) => {
      const next = new Set(set);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  // ─────────────── CREATE ───────────────

  openCreate(): void {
    this.freshKey.set(null);
    this.copied.set(false);
    this.newKeyName.set('');
    this.createOpen.set(true);
  }

  closeCreate(): void {
    if (this.generating()) return;
    this.createOpen.set(false);
  }

  async generateKey(): Promise<void> {
    if (this.generating()) return;
    this.generating.set(true);
    try {
      const created = await firstValueFrom(this.api.createIngestKey(this.newKeyName().trim()));
      this.freshKey.set(created);
      this.copied.set(false);
      this.newKeyName.set('');
      await this.reload();
      this.toast.show(`Minted “${created.name}”`, { tone: 'success', durationMs: 2000 });
    } catch (e) {
      const msg = (e instanceof HttpErrorResponse && e.error?.message) || 'Could not mint the key — try again';
      this.toast.show(msg, { tone: 'warn' });
    } finally {
      this.generating.set(false);
    }
  }

  copyKey(): void {
    const k = this.freshKey();
    if (k) void this.copy(k.key, 'Key copied').then((ok) => this.copied.set(ok));
  }

  /** Jump from the fresh-key reveal straight into the setup guide. */
  openGuideFromFresh(): void {
    this.createOpen.set(false);
    this.guideOpen.set(true);
  }

  // ─────────────── REVOKE ───────────────

  async revoke(k: IngestKey): Promise<void> {
    if (k.revoked || this.isBusy(k.id)) return;
    if (!this.canManage() && !this.isMine(k)) return;
    if (typeof confirm === 'function' && !confirm(`Revoke “${k.name}”? Its reporter stops on the next request.`)) return;
    this.setBusy(k.id, true);
    try {
      await firstValueFrom(this.api.revokeIngestKey(k.id));
      // Reflect the revoke locally (keep the row so the revoked filter/stat stays truthful).
      this.keys.update((ks) => ks.map((x) => (x.id === k.id ? { ...x, revoked: true } : x)));
      this.toast.show(`Revoked “${k.name}”`, { tone: 'success', durationMs: 1800 });
    } catch {
      this.toast.show('Revoke failed — try again', { tone: 'warn' });
    } finally {
      this.setBusy(k.id, false);
    }
  }

  // ─────────────── COPY ───────────────

  /** Copy arbitrary text (commands / key) with a toast; resolves to whether it succeeded. */
  async copy(text: string, label = 'Copied'): Promise<boolean> {
    try {
      await (navigator.clipboard?.writeText(text) ?? Promise.reject(new Error('no clipboard')));
      this.toast.show(label, { tone: 'success', durationMs: 1600 });
      return true;
    } catch {
      this.toast.show('Copy failed — select and copy manually', { tone: 'warn' });
      return false;
    }
  }
}
