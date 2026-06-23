import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';

import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';

import { Api } from '../../core/api';
import { AuthService } from '../../core/auth';
import { DisplayNameMode, ProfilePrefs } from '../../core/models';

interface ModeOption {
  value: DisplayNameMode;
  label: string;
  hint: string;
}

/**
 * "How others see me" — the caller's OWN identity + presence preferences (PATCH /api/auth/profile).
 * Reachable by ANY authenticated user (no permission gate), since it governs how THEY appear to everyone.
 * The display-name preview here mirrors the server's DisplayName.Format formatter exactly; the server is
 * the source of truth (and re-sanitizes nickname/status), so this is a faithful preview, not a duplicate.
 */
@Component({
  selector: 'app-profile',
  imports: [
    FormsModule, MatCardModule, MatFormFieldModule, MatInputModule, MatSelectModule,
    MatButtonModule, MatIconModule, MatProgressBarModule, MatSlideToggleModule, MatSnackBarModule,
  ],
  templateUrl: './profile.html',
  styleUrl: './profile.scss',
})
export class Profile {
  private api = inject(Api);
  private snack = inject(MatSnackBar);
  readonly auth = inject(AuthService);

  readonly loading = signal(true);
  readonly loadError = signal(false);
  readonly saving = signal(false);

  // Editable form state (seeded from /me).
  readonly mode = signal<DisplayNameMode>('firstInitial');
  readonly nickname = signal<string>('');
  readonly appearOffline = signal<boolean>(false);
  readonly status = signal<string>('');
  readonly shareAutoContext = signal<boolean>(false);
  // Activity-feed opt-ins (both default OFF). shareActivity is the real privacy control — the emitter
  // no-ops when it's off, so nothing about you is ever shared. viewActivityFeed gates whether your feed
  // shows your circle (vs only your own events).
  readonly shareActivity = signal<boolean>(false);
  readonly viewActivityFeed = signal<boolean>(false);
  // Receiving peer nudges (default ON — opted in). This is the escape hatch: nudges are circle-gated +
  // cooldowned, so default-on is safe; flip it on to STOP receiving them.
  readonly nudgesOptOut = signal<boolean>(false);

  /** The caller's real (full) name, from the session — the formatter's input; never edited here. */
  readonly fullName = computed(() => this.auth.session()?.name?.trim() || this.auth.session()?.email || '');

  readonly modeOptions: readonly ModeOption[] = [
    { value: 'full', label: 'Full name', hint: 'Your complete name, exactly as it appears on your account.' },
    { value: 'firstName', label: 'First name only', hint: 'Just your first name.' },
    { value: 'firstInitial', label: 'First name + last initial', hint: 'e.g. "Jane D." — the default, a privacy-friendly middle ground.' },
    { value: 'nickname', label: 'Nickname', hint: 'A name you choose below. Falls back to "First L." if left blank.' },
  ];

  /** The hint blurb for the currently-selected mode (shown under the picker). */
  readonly modeHint = computed(() => this.modeOptions.find(o => o.value === this.mode())?.hint ?? '');

  /** Whether the nickname field is relevant (only when the Nickname mode is selected). */
  readonly nicknameActive = computed(() => this.mode() === 'nickname');

  /**
   * A faithful client-side preview of how the chosen name renders to OTHERS — mirrors the server's
   * DisplayName.Format: single-token names pass through; email-shaped names reduce to the local part;
   * FirstInitial = "First L."; Nickname falls back to FirstInitial when blank.
   */
  readonly preview = computed(() => Profile.format(this.fullName(), this.mode(), this.nickname().trim()));

  constructor() {
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.loadError.set(false);
    this.auth.me().subscribe({
      next: me => {
        this.seed(me);
        this.auth.applyMe(me); // keep the session's mirrored prefs fresh too
        this.loading.set(false);
      },
      error: () => {
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
          this.loading.set(false);
        } else {
          this.loading.set(false);
          this.loadError.set(true);
        }
      },
    });
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
  }

  save(): void {
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
      next: saved => {
        this.seed(saved); // reflect the server's sanitized truth (e.g. trimmed/capped/cleared)
        this.auth.applyProfilePrefs(saved);
        this.saving.set(false);
        this.snack.open('Saved — this is how others see you now.', 'OK', { duration: 3000 });
      },
      error: (e: HttpErrorResponse) => {
        this.saving.set(false);
        this.snack.open(e.error?.message ?? 'Could not save your profile.', 'Dismiss', { duration: 5000 });
      },
    });
  }

  /**
   * Mirror of the server's DisplayName.Format. Kept deliberately small + side-effect free; the server
   * remains the source of truth (and re-runs sanitization), so any drift is corrected on save.
   */
  private static format(fullName: string, mode: DisplayNameMode, nickname: string): string {
    const name = Profile.deEmail((fullName || '').trim());
    if (!name) return 'You';

    if (mode === 'nickname') {
      const nick = Profile.deEmail(nickname);
      if (nick) return nick;
      // fall through to FirstInitial when no nickname is set
      return Profile.firstInitial(name);
    }

    const parts = name.split(/\s+/).filter(Boolean);
    if (parts.length <= 1) return name; // single-token names pass through for every mode

    switch (mode) {
      case 'full': return name;
      case 'firstName': return parts[0];
      case 'firstInitial':
      default: return Profile.firstInitial(name);
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
