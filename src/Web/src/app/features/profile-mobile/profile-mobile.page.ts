import {
  ChangeDetectionStrategy, Component, computed, inject, signal,
} from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { MatIconModule } from '@angular/material/icon';

import { Api } from '../../core/api';
import { AuthService } from '../../core/auth';
import { DisplayNameMode, ProfilePrefs } from '../../core/models';
import {
  BetaPullRefresh, BetaSegmentedControl, BetaSkeleton, BetaToaster, ToastController,
  type Segment,
} from '../beta-ui';

/** One presence/sharing toggle row's static copy. */
interface ToggleRow {
  readonly key: 'appearOffline' | 'shareAutoContext' | 'shareActivity' | 'viewActivityFeed' | 'nudgesOptOut';
  readonly icon: string;
  readonly title: string;
  readonly blurb: string;
  /** The on-state phrase shown in the row's live status pill. */
  readonly onWord: string;
  readonly offWord: string;
}

/**
 * Profile "How others see me" — the MOBILE twin of the live `/profile` page, rebuilt on the shared
 * beta-ui "Strata" kit (`@use '../beta-ui/beta-kit'`) with a signature INDIGO → VIOLET accent. It is a
 * native-feel settings sheet: a live PREVIEW chip of how the caller's name renders to others, a
 * {@link BetaSegmentedControl}-style name-mode picker (Full / First / First L. / Nickname) with a
 * conditional nickname field + optional status line, then grouped toggle rows for presence + activity
 * sharing. One sticky save bar commits the whole editable set.
 *
 * DATA PARITY + PRIVACY: it seeds from `auth.me()` (GET /api/auth/me) and writes the WHOLE editable set
 * via the SAME `Api.setProfile` (PATCH /api/auth/profile) the live page uses — the server stays the
 * source of truth (it sanitizes nickname/status + treats '' as "clear"), and the saved result is mirrored
 * back into the session via `auth.applyProfilePrefs`. The name-preview formatter is COPIED verbatim from
 * the live page (a faithful mirror of the server's DisplayName.Format), so the preview agrees exactly.
 * This page only ever reads/writes the CALLER's own prefs — never anyone else's, never an email.
 *
 * ISOLATION: gated by `platform.mobile` on the SAME `/profile` route (no extra permission — like the live
 * page, any authenticated user can govern how THEY appear). Imports only the kit + the shared Api/auth the
 * live page already uses. No live page is imported or modified.
 */
@Component({
  selector: 'app-profile-mobile',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [ToastController],
  imports: [
    MatIconModule,
    BetaPullRefresh, BetaSegmentedControl, BetaSkeleton, BetaToaster,
  ],
  template: `
    <app-bs-pull-refresh class="pm-ptr" [busy]="refreshing()" (refresh)="reload()">
      <div class="pm-scroll" aria-live="polite">

        <!-- ─── IMMERSIVE HEADER: title + the live name-preview chip ─── -->
        <header class="pm-hero">
          <p class="pm-hero__kicker">
            <mat-icon aria-hidden="true">visibility</mat-icon> How others see you
          </p>
          <h1 class="pm-hero__title">Your profile</h1>

          @if (loading()) {
            <div class="pm-preview pm-preview--skel">
              <app-bs-skeleton width="44px" height="44px" [circle]="true" />
              <app-bs-skeleton width="52%" height="16px" radius="var(--r-pill)" />
            </div>
          } @else {
            <!-- A live preview of the exact name + status others will see. -->
            <div class="pm-preview" [class.is-offline]="appearOffline()">
              <span class="pm-preview__avatar" aria-hidden="true">{{ initial() }}</span>
              <span class="pm-preview__body">
                <span class="pm-preview__name">{{ preview() }}</span>
                <span class="pm-preview__meta">
                  @if (appearOffline()) {
                    <span class="pm-preview__dot pm-preview__dot--off" aria-hidden="true"></span> Appears offline
                  } @else {
                    <span class="pm-preview__dot" aria-hidden="true"></span>
                    {{ status().trim() || 'Online' }}
                  }
                </span>
              </span>
            </div>
          }
        </header>

        @if (loading()) {
          <!-- skeleton form -->
          <div class="pm-card" aria-hidden="true">
            <app-bs-skeleton height="44px" radius="var(--r-pill)" />
            <app-bs-skeleton height="56px" radius="var(--r-card)" />
            <app-bs-skeleton height="56px" radius="var(--r-card)" />
          </div>

        } @else if (loadError()) {
          <div class="pm-state">
            <span class="pm-state__orb"><mat-icon aria-hidden="true">error_outline</mat-icon></span>
            <h2 class="pm-state__title">Couldn't load your profile</h2>
            <p class="pm-state__body">We couldn't reach your settings. Give it another go.</p>
            <button type="button" class="pm-state__cta" (click)="reload()">
              <mat-icon aria-hidden="true">refresh</mat-icon> Try again
            </button>
          </div>

        } @else {
          <!-- ─── DISPLAY NAME ─── -->
          <section class="pm-card">
            <div class="pm-card__head">
              <mat-icon class="pm-card__ic" aria-hidden="true">badge</mat-icon>
              <div class="pm-card__titles">
                <h2 class="pm-card__title">Display name</h2>
                <p class="pm-card__sub">How your name is shown wherever it reaches another person.</p>
              </div>
            </div>

            <app-bs-segmented class="pm-modeseg"
              [segments]="modeSegments" [value]="mode()" label="Choose how your name appears"
              (change)="setMode($event)" />
            <p class="pm-hint">{{ modeHint() }}</p>

            @if (nicknameActive()) {
              <label class="pm-field">
                <span class="pm-field__label">Nickname</span>
                <input class="pm-field__input" type="text" inputmode="text"
                       maxlength="64" autocomplete="off"
                       [value]="nickname()" (input)="onNickname($event)"
                       placeholder="e.g. Sky" aria-label="Nickname" />
                <span class="pm-field__help">Up to 64 characters. Leave blank to fall back to “First&nbsp;L.”.</span>
              </label>
            }
          </section>

          <!-- ─── STATUS MESSAGE ─── -->
          <section class="pm-card">
            <div class="pm-card__head">
              <mat-icon class="pm-card__ic" aria-hidden="true">chat_bubble</mat-icon>
              <div class="pm-card__titles">
                <h2 class="pm-card__title">Status</h2>
                <p class="pm-card__sub">A short line shown next to your name on the roster.</p>
              </div>
            </div>
            <label class="pm-field">
              <input class="pm-field__input" type="text" inputmode="text"
                     maxlength="120" autocomplete="off"
                     [value]="status()" (input)="onStatus($event)"
                     placeholder="What are you up to?" aria-label="Status message" />
              <span class="pm-field__help">Up to 120 characters. Leave blank to clear.</span>
            </label>
          </section>

          <!-- ─── PRESENCE + SHARING TOGGLES ─── -->
          <section class="pm-card">
            <div class="pm-card__head">
              <mat-icon class="pm-card__ic" aria-hidden="true">tune</mat-icon>
              <div class="pm-card__titles">
                <h2 class="pm-card__title">Presence &amp; sharing</h2>
                <p class="pm-card__sub">Control what your circle can see about you.</p>
              </div>
            </div>

            <div class="pm-rows" role="group" aria-label="Presence and sharing settings">
              @for (r of rows; track r.key) {
                <button type="button" class="pm-row" role="switch"
                        [class.is-on]="value(r.key)"
                        [attr.aria-checked]="value(r.key)"
                        [attr.aria-label]="r.title + '. ' + (value(r.key) ? r.onWord : r.offWord) + '.'"
                        (click)="toggle(r.key)">
                  <span class="pm-row__ic" aria-hidden="true"><mat-icon>{{ r.icon }}</mat-icon></span>
                  <span class="pm-row__body">
                    <span class="pm-row__title">{{ r.title }}</span>
                    <span class="pm-row__blurb">{{ r.blurb }}</span>
                  </span>
                  <span class="pm-switch" aria-hidden="true"><span class="pm-switch__knob"></span></span>
                </button>
              }
            </div>

            <!-- Contextual confirmation when Appear-offline is ON (mirrors the live page's callout). -->
            @if (appearOffline()) {
              <div class="pm-callout" role="note">
                <mat-icon aria-hidden="true">visibility_off</mat-icon>
                <span>You're hidden — others won't see you in their online roster. You'll still see everyone else.</span>
              </div>
            }
          </section>

          <!-- ─── DATA EXPORT (gated, mirrors the live page's dashboard.export) ─── -->
          @if (canExport()) {
            <section class="pm-card pm-card--export">
              <div class="pm-card__head">
                <mat-icon class="pm-card__ic" aria-hidden="true">download</mat-icon>
                <div class="pm-card__titles">
                  <h2 class="pm-card__title">Your data</h2>
                  <p class="pm-card__sub">Download everything you own across every domain as a ZIP.</p>
                </div>
              </div>
              <button type="button" class="pm-export-btn" [disabled]="exporting()" (click)="exportMyData()">
                @if (exporting()) {
                  <mat-icon class="pm-spin" aria-hidden="true">progress_activity</mat-icon> Preparing…
                } @else {
                  <mat-icon aria-hidden="true">archive</mat-icon> Download my data
                }
              </button>
            </section>
          }

          <p class="pm-foot" aria-hidden="true">
            The server is the source of truth — your name &amp; status are re-checked on save.
          </p>

          <!-- spacer so content clears the sticky save bar -->
          <div class="pm-savebar-spacer" aria-hidden="true"></div>
        }
      </div>
    </app-bs-pull-refresh>

    <!-- ─── STICKY SAVE BAR ─── -->
    @if (!loading() && !loadError()) {
      <div class="pm-savebar" [class.is-dirty]="dirty()">
        <span class="pm-savebar__hint">
          @if (dirty()) { Unsaved changes } @else { All changes saved }
        </span>
        <button type="button" class="pm-savebar__btn"
                [disabled]="!dirty() || saving()" (click)="save()">
          @if (saving()) {
            <mat-icon class="pm-spin" aria-hidden="true">progress_activity</mat-icon> Saving…
          } @else {
            <mat-icon aria-hidden="true">check</mat-icon> Save
          }
        </button>
      </div>
    }

    <app-bs-toaster />
  `,
  styleUrl: './profile-mobile.page.scss',
})
export class ProfileMobilePage {
  private api = inject(Api);
  private toast = inject(ToastController);
  readonly auth = inject(AuthService);

  readonly loading = signal(true);
  readonly loadError = signal(false);
  readonly saving = signal(false);
  readonly exporting = signal(false);
  /** Pull-to-refresh spinner (re-fetch over an already-loaded page). */
  readonly refreshing = signal(false);

  /** Whether to show the "Download my data" button (the export endpoint is gated by dashboard.export). */
  readonly canExport = computed(() => this.auth.hasPermission('dashboard.export'));

  // ---- editable form state (seeded from /me) ----
  readonly mode = signal<DisplayNameMode>('firstInitial');
  readonly nickname = signal<string>('');
  readonly appearOffline = signal<boolean>(false);
  readonly status = signal<string>('');
  readonly shareAutoContext = signal<boolean>(false);
  readonly shareActivity = signal<boolean>(false);
  readonly viewActivityFeed = signal<boolean>(false);
  readonly nudgesOptOut = signal<boolean>(false);

  /** The last-saved snapshot, to compute the dirty state for the save bar. */
  private readonly saved = signal<ProfilePrefs | null>(null);

  /** The caller's real (full) name, from the session — the formatter's input; never edited here. */
  readonly fullName = computed(
    () => this.auth.session()?.name?.trim() || this.auth.session()?.email || '',
  );

  /** Name-mode picker segments (mirrors the live page's modeOptions, with terse mobile labels). */
  readonly modeSegments: Segment[] = [
    { key: 'full', label: 'Full' },
    { key: 'firstName', label: 'First' },
    { key: 'firstInitial', label: 'First L.' },
    { key: 'nickname', label: 'Nickname' },
  ];

  private readonly modeHints: Record<DisplayNameMode, string> = {
    full: 'Your complete name, exactly as it appears on your account.',
    firstName: 'Just your first name.',
    firstInitial: 'e.g. “Jane D.” — the default, a privacy-friendly middle ground.',
    nickname: 'A name you choose below. Falls back to “First L.” if left blank.',
  };

  /** The hint blurb for the currently-selected mode (shown under the picker). */
  readonly modeHint = computed(() => this.modeHints[this.mode()]);

  /** Whether the nickname field is relevant (only when the Nickname mode is selected). */
  readonly nicknameActive = computed(() => this.mode() === 'nickname');

  /** The presence/sharing toggle rows (static copy + which signal each maps to). */
  readonly rows: readonly ToggleRow[] = [
    {
      key: 'appearOffline', icon: 'visibility_off',
      title: 'Appear offline',
      blurb: 'Hide from the online roster. The app still works normally for you.',
      onWord: 'hidden from the roster', offWord: 'visible on the roster',
    },
    {
      key: 'shareAutoContext', icon: 'auto_awesome',
      title: 'Share auto-context',
      blurb: 'Let lightweight auto-derived context ride alongside your presence.',
      onWord: 'sharing context', offWord: 'not sharing context',
    },
    {
      key: 'shareActivity', icon: 'campaign',
      title: 'Share my activity',
      blurb: 'Your non-sensitive wins (workouts, goals) become events for your circle.',
      onWord: 'sharing activity', offWord: 'not sharing activity',
    },
    {
      key: 'viewActivityFeed', icon: 'dynamic_feed',
      title: 'See my circle’s feed',
      blurb: 'Show your circle’s shared events in your feed. You always see your own.',
      onWord: 'circle feed on', offWord: 'own events only',
    },
    {
      key: 'nudgesOptOut', icon: 'notifications_off',
      title: 'Stop peer nudges',
      blurb: 'Turn off the “log your day” / “close your rings” pings from your circle.',
      onWord: 'nudges off', offWord: 'nudges on',
    },
  ];

  /**
   * A faithful client-side preview of how the chosen name renders to OTHERS — COPIED from the live
   * profile.ts (a mirror of the server's DisplayName.Format). The server stays the source of truth.
   */
  readonly preview = computed(() =>
    ProfileMobilePage.format(this.fullName(), this.mode(), this.nickname().trim()),
  );

  /** A single-letter avatar initial from the previewed name. */
  readonly initial = computed(() => {
    const p = this.preview().trim();
    return p ? p.charAt(0).toUpperCase() : '?';
  });

  /** True when the form differs from the last-saved snapshot (drives the save bar). */
  readonly dirty = computed(() => {
    const s = this.saved();
    if (!s) return false;
    return (
      s.displayNameMode !== this.mode() ||
      (s.nickname ?? '') !== this.nickname().trim() ||
      s.appearOffline !== this.appearOffline() ||
      (s.presenceStatus ?? '') !== this.status().trim() ||
      s.shareAutoContext !== this.shareAutoContext() ||
      s.shareActivity !== this.shareActivity() ||
      s.viewActivityFeed !== this.viewActivityFeed() ||
      s.nudgesOptOut !== this.nudgesOptOut()
    );
  });

  constructor() {
    this.reload();
  }

  // ─────────────── LOAD ───────────────

  async reload(): Promise<void> {
    const wasLoaded = !!this.saved();
    if (wasLoaded) this.refreshing.set(true); else this.loading.set(true);
    this.loadError.set(false);
    try {
      const me = await firstValueFrom(this.auth.me());
      this.seed(me);
      this.auth.applyMe(me); // keep the session's mirrored prefs fresh too
    } catch {
      // Fall back to whatever the session already mirrors, so the page is still usable offline of /me.
      const s = this.auth.session();
      if (s && s.displayNameMode) {
        this.seed({
          displayNameMode: s.displayNameMode,
          nickname: s.nickname ?? null,
          appearOffline: s.appearOffline ?? false,
          presenceStatus: s.presenceStatus ?? null,
          shareAutoContext: s.shareAutoContext ?? false,
          shareActivity: s.shareActivity ?? false,
          viewActivityFeed: s.viewActivityFeed ?? false,
          nudgesOptOut: s.nudgesOptOut ?? false,
        });
      } else {
        this.loadError.set(true);
      }
    } finally {
      this.loading.set(false);
      this.refreshing.set(false);
    }
  }

  private seed(p: ProfilePrefs): void {
    this.mode.set(p.displayNameMode);
    this.nickname.set(p.nickname ?? '');
    this.appearOffline.set(p.appearOffline);
    this.status.set(p.presenceStatus ?? '');
    this.shareAutoContext.set(p.shareAutoContext);
    this.shareActivity.set(p.shareActivity);
    this.viewActivityFeed.set(p.viewActivityFeed);
    this.nudgesOptOut.set(p.nudgesOptOut);
    this.saved.set({ ...p, nickname: p.nickname ?? null, presenceStatus: p.presenceStatus ?? null });
  }

  // ─────────────── FORM EDITS ───────────────

  setMode(key: string): void {
    this.mode.set(key as DisplayNameMode);
  }

  onNickname(e: Event): void {
    this.nickname.set((e.target as HTMLInputElement).value);
  }

  onStatus(e: Event): void {
    this.status.set((e.target as HTMLInputElement).value);
  }

  /** Read the current value of a boolean toggle row by its key. */
  value(key: ToggleRow['key']): boolean {
    switch (key) {
      case 'appearOffline': return this.appearOffline();
      case 'shareAutoContext': return this.shareAutoContext();
      case 'shareActivity': return this.shareActivity();
      case 'viewActivityFeed': return this.viewActivityFeed();
      case 'nudgesOptOut': return this.nudgesOptOut();
    }
  }

  /** Flip a boolean toggle row by its key. */
  toggle(key: ToggleRow['key']): void {
    switch (key) {
      case 'appearOffline': this.appearOffline.update(v => !v); break;
      case 'shareAutoContext': this.shareAutoContext.update(v => !v); break;
      case 'shareActivity': this.shareActivity.update(v => !v); break;
      case 'viewActivityFeed': this.viewActivityFeed.update(v => !v); break;
      case 'nudgesOptOut': this.nudgesOptOut.update(v => !v); break;
    }
  }

  // ─────────────── SAVE ───────────────

  save(): void {
    if (!this.dirty() || this.saving()) return;
    this.saving.set(true);
    // Send the full editable set; the server sanitizes nickname/status and treats '' as "clear".
    const body: Partial<ProfilePrefs> = {
      displayNameMode: this.mode(),
      nickname: this.nickname().trim(),
      appearOffline: this.appearOffline(),
      presenceStatus: this.status().trim(),
      shareAutoContext: this.shareAutoContext(),
      shareActivity: this.shareActivity(),
      viewActivityFeed: this.viewActivityFeed(),
      nudgesOptOut: this.nudgesOptOut(),
    };
    this.api.setProfile(body).subscribe({
      next: (saved) => {
        this.seed(saved); // reflect the server's sanitized truth (e.g. trimmed/capped/cleared)
        this.auth.applyProfilePrefs(saved);
        this.saving.set(false);
        this.toast.show('Saved — this is how others see you now.', { tone: 'success', durationMs: 2600 });
      },
      error: (e: HttpErrorResponse) => {
        this.saving.set(false);
        this.toast.show(e.error?.message ?? 'Could not save your profile.', { tone: 'warn' });
      },
    });
  }

  /**
   * Download EVERYTHING this user owns across every domain as a ZIP. The server scopes every query to
   * the caller and strips all secrets/other-people's-emails; this just saves the blob (same as live).
   */
  exportMyData(): void {
    if (this.exporting()) return;
    this.exporting.set(true);
    this.api.exportMyData().subscribe({
      next: (blob) => {
        this.exporting.set(false);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `usage-iq-export-${new Date().toISOString().slice(0, 10)}.zip`;
        a.click();
        URL.revokeObjectURL(url);
        this.toast.show('Your data is downloading.', { tone: 'success', durationMs: 2400 });
      },
      error: () => {
        this.exporting.set(false);
        this.toast.show('Could not export your data.', { tone: 'warn' });
      },
    });
  }

  // ─────────────── NAME FORMATTER (copied verbatim from live profile.ts) ───────────────

  /**
   * Mirror of the server's DisplayName.Format. Kept deliberately small + side-effect free; the server
   * remains the source of truth (and re-runs sanitization), so any drift is corrected on save.
   */
  private static format(fullName: string, mode: DisplayNameMode, nickname: string): string {
    const name = ProfileMobilePage.deEmail((fullName || '').trim());
    if (!name) return 'You';

    if (mode === 'nickname') {
      const nick = ProfileMobilePage.deEmail(nickname);
      if (nick) return nick;
      // fall through to FirstInitial when no nickname is set
      return ProfileMobilePage.firstInitial(name);
    }

    const parts = name.split(/\s+/).filter(Boolean);
    if (parts.length <= 1) return name; // single-token names pass through for every mode

    switch (mode) {
      case 'full':
        return name;
      case 'firstName':
        return parts[0];
      case 'firstInitial':
      default:
        return ProfileMobilePage.firstInitial(name);
    }
  }

  private static firstInitial(name: string): string {
    const parts = name.split(/\s+/).filter(Boolean);
    if (parts.length <= 1) return name;
    const last = parts[parts.length - 1];
    return `${parts[0]} ${last[0].toUpperCase()}.`;
  }

  /** If the value looks email-shaped, reduce it to the local part (never surface an email as a name). */
  private static deEmail(value: string): string {
    const at = value.indexOf('@');
    return at > 0 ? value.slice(0, at) : value;
  }
}
