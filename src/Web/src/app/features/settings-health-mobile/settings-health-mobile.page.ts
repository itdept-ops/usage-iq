import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { MatIconModule } from '@angular/material/icon';

import { Api } from '../../core/api';
import { HealthStatus, HealthSettingsPatch, HealthSyncNowResult } from '../../core/models';
import { BetaPullRefresh, BetaSkeleton, BetaToaster, ToastController } from '../beta-ui';
import {
  beginFitbitAuthorize, consumePendingFitbitCode,
} from '../settings-health/fitbit-oauth';

/** One per-signal toggle row's static metadata. */
interface SignalToggle {
  key: 'syncSteps' | 'syncSleep' | 'syncHeartRate' | 'syncWorkouts';
  label: string;
  icon: string;
  hint: string;
}

/**
 * Wearable health sync — the mobile-first twin of the live {@link SettingsHealth} settings page, rebuilt on
 * the shared beta-ui "Strata" kit (a ROSE → AMBER "move" accent re-skins the screen via the per-page accent
 * contract). Connect a Fitbit so steps, sleep, resting-HR and workouts auto-flow into the tracker.
 *
 * DATA PARITY + PRIVACY: every value comes from the SAME owner-scoped endpoints the live page uses
 * ({@link Api.healthStatus} / healthConnect / healthSettings / healthSyncNow / healthDisconnect). Sleep +
 * resting HR stay owner-only server-side; the client never sees the refresh token. Three states — not
 * configured, not connected (Connect-with-Fitbit OAuth+PKCE), and connected (toggles + Sync-now + Disconnect).
 *
 * ISOLATION: gated by `platform.mobile` + the SAME `health.sync` route guard; it consumes the kit + the SAME
 * Api/DTOs + the shared {@link fitbit-oauth} helper as the live counterpart. No live page is imported/modified.
 */
@Component({
  selector: 'app-settings-health-mobile',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [ToastController],
  imports: [MatIconModule, BetaPullRefresh, BetaSkeleton, BetaToaster],
  template: `
    <app-bs-pull-refresh class="hs-ptr" [busy]="refreshing()" [disabled]="loading() || !canRefresh()"
                         (refresh)="reload()">
      <div class="hs-scroll" aria-live="polite">

        <!-- ─── HERO ─── -->
        <header class="hs-hero">
          <p class="hs-hero__kicker"><mat-icon aria-hidden="true">watch</mat-icon> Wearable</p>
          <h1 class="hs-hero__title">Health sync</h1>
          <p class="hs-hero__sub">Connect a wearable to auto-sync steps, sleep, heart rate and workouts.</p>
        </header>

        @if (loading()) {
          <div class="hs-list" aria-hidden="true">
            <app-bs-skeleton height="120px" radius="var(--r-tile)" />
            <app-bs-skeleton height="180px" radius="var(--r-tile)" />
          </div>

        } @else if (errored()) {
          <div class="hs-state">
            <span class="hs-state__orb"><mat-icon aria-hidden="true">cloud_off</mat-icon></span>
            <h2 class="hs-state__title">Couldn't load</h2>
            <p class="hs-state__body">Something went wrong fetching your wearable settings. Give it another go.</p>
            <button type="button" class="hs-state__cta" (click)="reload()">
              <mat-icon aria-hidden="true">refresh</mat-icon> Try again
            </button>
          </div>

        } @else if (status(); as s) {

          @if (!s.configured) {
            <!-- ─── NOT CONFIGURED ─── -->
            <div class="hs-state">
              <span class="hs-state__orb"><mat-icon aria-hidden="true">build_circle</mat-icon></span>
              <h2 class="hs-state__title">Not set up here</h2>
              <p class="hs-state__body">Wearable sync hasn't been configured on this server yet. Once it is,
                you'll be able to connect your device and sync automatically.</p>
            </div>

          } @else if (!s.connected) {
            <!-- ─── CONNECT ─── -->
            <section class="hs-connect">
              <span class="hs-connect__badge" aria-hidden="true"><mat-icon>watch</mat-icon></span>
              <h2 class="hs-connect__title">Connect a wearable</h2>
              <p class="hs-connect__body">Link your Fitbit to pull steps &amp; active calories, sleep, resting
                heart rate and workouts — automatically, every day.</p>
              <button type="button" class="hs-cta" (click)="connect()">
                <mat-icon aria-hidden="true">link</mat-icon> Connect with Fitbit
              </button>
              <p class="hs-connect__scopes">Requests access to: {{ s.scopes }}</p>
            </section>

          } @else {
            <!-- ─── CONNECTED ─── -->
            <section class="hs-card hs-status" [class.is-warn]="statusTone() === 'warn'">
              <span class="hs-status__ic" aria-hidden="true">
                <mat-icon>{{ statusTone() === 'warn' ? 'sync_problem' : 'check_circle' }}</mat-icon>
              </span>
              <div class="hs-status__body">
                <p class="hs-status__line"><strong>{{ s.provider }}</strong> connected</p>
                <p class="hs-status__sub">Last sync {{ lastSyncLabel() }} · {{ s.lastSyncStatus }}</p>
              </div>
            </section>

            @if (authExpired()) {
              <section class="hs-card hs-reconnect">
                <mat-icon aria-hidden="true">error_outline</mat-icon>
                <div class="hs-reconnect__body">
                  <p class="hs-reconnect__line">Access expired</p>
                  <p class="hs-reconnect__sub">Reconnect to resume automatic syncing.</p>
                </div>
                <button type="button" class="hs-btn hs-btn--accent" (click)="connect()">Reconnect</button>
              </section>
            }

            <button type="button" class="hs-cta" [disabled]="syncing()" (click)="syncNow()">
              <mat-icon aria-hidden="true">sync</mat-icon>
              @if (syncing()) { Syncing… } @else { Sync now }
            </button>

            @if (result(); as r) {
              <section class="hs-card hs-summary">
                <p class="hs-summary__head">
                  <mat-icon aria-hidden="true">task_alt</mat-icon>
                  @if (r.fromDate && r.toDate) {
                    Synced {{ r.fromDate }} → {{ r.toDate }} — {{ summaryTotal(r) }} entr{{ summaryTotal(r) === 1 ? 'y' : 'ies' }} written
                  } @else { Sync complete }
                </p>
                @for (row of summaryRows(r); track row.label) {
                  <div class="hs-summary__row">
                    <span class="hs-summary__label">{{ row.label }}</span>
                    <span class="hs-summary__nums">
                      <b>+{{ row.imported }}</b> new · <b>{{ row.updated }}</b> upd ·
                      <span class="muted">{{ row.skipped }}</span> skip
                    </span>
                  </div>
                }
              </section>
            }

            <!-- toggles -->
            <section class="hs-card">
              <button type="button" class="hs-row hs-row--toggle" [attr.aria-pressed]="s.autoSyncEnabled"
                      [disabled]="savingKey() === 'autoSyncEnabled'" (click)="toggle('autoSyncEnabled')">
                <span class="hs-row__ic" aria-hidden="true"><mat-icon>autorenew</mat-icon></span>
                <span class="hs-row__body">
                  <span class="hs-row__label">Automatic sync</span>
                  <span class="hs-row__hint">Pull new data on a schedule.</span>
                </span>
                <span class="hs-switch" [class.is-on]="s.autoSyncEnabled" aria-hidden="true">
                  <span class="hs-switch__knob"></span>
                </span>
              </button>

              @for (t of signalToggles; track t.key) {
                <button type="button" class="hs-row hs-row--toggle" [attr.aria-pressed]="s[t.key]"
                        [disabled]="savingKey() === t.key" (click)="toggle(t.key)">
                  <span class="hs-row__ic" aria-hidden="true"><mat-icon>{{ t.icon }}</mat-icon></span>
                  <span class="hs-row__body">
                    <span class="hs-row__label">{{ t.label }}</span>
                    <span class="hs-row__hint">{{ t.hint }}</span>
                  </span>
                  <span class="hs-switch" [class.is-on]="s[t.key]" aria-hidden="true">
                    <span class="hs-switch__knob"></span>
                  </span>
                </button>
              }
            </section>

            <!-- disconnect -->
            <button type="button" class="hs-disconnect" [disabled]="disconnecting()" (click)="disconnect()">
              <mat-icon aria-hidden="true">link_off</mat-icon>
              @if (disconnecting()) { Disconnecting… } @else { Disconnect wearable }
            </button>
            <p class="hs-disconnect__hint">Stops syncing and forgets your token. Already-synced entries stay in your tracker.</p>
          }
        }
      </div>
    </app-bs-pull-refresh>

    <app-bs-toaster />
  `,
  styleUrl: './settings-health-mobile.page.scss',
})
export class SettingsHealthMobilePage {
  private api = inject(Api);
  private toast = inject(ToastController);

  readonly status = signal<HealthStatus | null>(null);
  readonly loading = signal(true);
  readonly errored = signal(false);
  readonly refreshing = signal(false);
  readonly connecting = signal(false);
  readonly syncing = signal(false);
  readonly disconnecting = signal(false);
  readonly savingKey = signal<string | null>(null);
  readonly result = signal<HealthSyncNowResult | null>(null);

  readonly signalToggles: readonly SignalToggle[] = [
    { key: 'syncSteps', label: 'Steps & active calories', icon: 'directions_walk',
      hint: 'Daily steps, distance and burn.' },
    { key: 'syncSleep', label: 'Sleep', icon: 'bedtime', hint: 'Logged to your wake date. Private to you.' },
    { key: 'syncHeartRate', label: 'Resting heart rate', icon: 'favorite', hint: 'Sensitive — kept owner-only.' },
    { key: 'syncWorkouts', label: 'Workouts', icon: 'fitness_center', hint: 'Recorded exercises become entries.' },
  ];

  /** Pull-to-refresh only makes sense once we have a status to refresh. */
  readonly canRefresh = computed(() => !!this.status());

  readonly authExpired = computed(() => {
    const s = this.status();
    return !!s?.connected && s.lastSyncStatus === 'AuthExpired';
  });

  readonly statusTone = computed<'ok' | 'warn' | 'idle'>(() => {
    const s = this.status();
    if (!s?.connected) return 'idle';
    switch (s.lastSyncStatus) {
      case 'Ok': return 'ok';
      case 'AuthExpired':
      case 'RateLimited':
      case 'Error': return 'warn';
      default: return 'idle';
    }
  });

  readonly lastSyncLabel = computed(() => {
    const iso = this.status()?.lastSyncUtc;
    if (!iso) return 'never';
    const d = new Date(iso);
    return isNaN(d.getTime()) ? 'never' : d.toLocaleDateString();
  });

  constructor() {
    void this.init();
  }

  private async init(): Promise<void> {
    const pending = consumePendingFitbitCode();
    if (pending) {
      await this.finishConnect(pending.code, pending.redirectUri, pending.verifier);
      return;
    }
    await this.load();
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    this.errored.set(false);
    try {
      this.status.set(await firstValueFrom(this.api.healthStatus()));
    } catch {
      this.errored.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  async reload(): Promise<void> {
    if (this.loading()) return this.load();
    this.refreshing.set(true);
    try {
      this.status.set(await firstValueFrom(this.api.healthStatus()));
      this.toast.show('Refreshed', { tone: 'success', durationMs: 1400 });
    } catch {
      this.toast.show("Couldn't refresh", { tone: 'warn' });
    } finally {
      this.refreshing.set(false);
    }
  }

  async connect(): Promise<void> {
    const s = this.status();
    if (!s?.configured || !s.clientId) return;
    try {
      await beginFitbitAuthorize(s.clientId, s.scopes);
    } catch {
      this.toast.show("Couldn't start the connect flow", { tone: 'warn' });
    }
  }

  private async finishConnect(code: string, redirectUri: string, verifier: string): Promise<void> {
    this.connecting.set(true);
    this.loading.set(true);
    try {
      await firstValueFrom(this.api.healthConnect(code, redirectUri, verifier));
      this.toast.show('Fitbit connected', { tone: 'success' });
    } catch (e) {
      this.toast.show(this.messageOf(e, "Couldn't connect — try again"), { tone: 'warn' });
    } finally {
      this.connecting.set(false);
      await this.load();
    }
  }

  async toggle(key: SignalToggle['key'] | 'autoSyncEnabled'): Promise<void> {
    const s = this.status();
    if (!s) return;
    const patch: HealthSettingsPatch = { [key]: !s[key] };
    this.savingKey.set(key);
    try {
      this.status.set(await firstValueFrom(this.api.healthSettings(patch)));
    } catch (e) {
      this.toast.show(this.messageOf(e, "Couldn't save"), { tone: 'warn' });
    } finally {
      this.savingKey.set(null);
    }
  }

  async syncNow(): Promise<void> {
    if (this.syncing()) return;
    this.syncing.set(true);
    this.result.set(null);
    try {
      this.result.set(await firstValueFrom(this.api.healthSyncNow()));
      this.status.set(await firstValueFrom(this.api.healthStatus()));
      this.toast.show('Sync complete', { tone: 'success', durationMs: 1600 });
    } catch (e) {
      this.toast.show(this.messageOf(e, 'Sync failed'), { tone: 'warn' });
    } finally {
      this.syncing.set(false);
    }
  }

  async disconnect(): Promise<void> {
    if (this.disconnecting()) return;
    this.disconnecting.set(true);
    try {
      await firstValueFrom(this.api.healthDisconnect());
      this.result.set(null);
      await this.load();
      this.toast.show('Disconnected', { tone: 'success' });
    } catch (e) {
      this.toast.show(this.messageOf(e, "Couldn't disconnect"), { tone: 'warn' });
    } finally {
      this.disconnecting.set(false);
    }
  }

  /** Total rows touched across all signals (drives the summary's headline). */
  summaryTotal(r: HealthSyncNowResult): number {
    const each = (x: { imported: number; updated: number }) => x.imported + x.updated;
    return each(r.steps) + each(r.sleep) + each(r.heartRate) + each(r.workouts);
  }

  summaryRows(r: HealthSyncNowResult): { label: string; imported: number; updated: number; skipped: number }[] {
    return [
      { label: 'Steps', ...r.steps },
      { label: 'Sleep', ...r.sleep },
      { label: 'Heart rate', ...r.heartRate },
      { label: 'Workouts', ...r.workouts },
    ];
  }

  private messageOf(e: unknown, fallback: string): string {
    const msg = (e as { error?: { message?: string } })?.error?.message;
    return typeof msg === 'string' && msg ? msg : fallback;
  }
}
