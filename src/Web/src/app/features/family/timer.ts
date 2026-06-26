import {
  Component,
  DestroyRef,
  OnDestroy,
  computed,
  effect,
  inject,
  input,
  signal,
  ChangeDetectionStrategy,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { catchError, firstValueFrom, of } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';

import { Api } from '../../core/api';
import { FamilyTimer, TimerAiResult } from '../../core/models';
import { WakeLockService } from '../../core/wake-lock';

/** A one-tap preset countdown. `seconds` seeds a new timer; `label` is its friendly name. */
interface Preset {
  label: string;
  icon: string;
  seconds: number;
}

/** A timer plus its live, ticked-down remaining seconds (recomputed each tick from endsUtc). */
interface LiveTimer {
  timer: FamilyTimer;
  remaining: number; // whole seconds left (0 once finished)
}

const PRESETS: Preset[] = [
  { label: 'Homework', icon: 'school', seconds: 30 * 60 },
  { label: 'Cooking', icon: 'skillet', seconds: 10 * 60 },
  { label: 'Screen time', icon: 'tv', seconds: 60 * 60 },
  { label: 'Time-out', icon: 'self_improvement', seconds: 5 * 60 },
];

/**
 * Family Timer — a big, glanceable widget for shared household countdowns. Preset buttons (Homework 30m,
 * Cooking 10m, Screen time 60m, Time-out 5m) plus a Custom minutes entry and an optional label start a
 * timer; the page shows EVERY active household timer ticking live (so both parents see "Lily screen time
 * 12:04"), each with a cancel button. The client ticks down locally from `endsUtc`; when a timer reaches 0
 * it shows a friendly local alert + a soft chime, and the server's notification also arrives via the bell.
 *
 * Embeddable: dropped on the Family home (`embedded` hides the page chrome) and routed at /family/timer.
 * Everyone is rendered by display name only — never an email (email-privacy).
 */
@Component({
  selector: 'app-family-timer',
  imports: [
    NgTemplateOutlet,
    RouterLink,
    FormsModule,
    MatIconModule,
    MatButtonModule,
    MatTooltipModule,
    MatProgressSpinnerModule,
    MatFormFieldModule,
    MatInputModule,
    MatSnackBarModule,
  ],
  templateUrl: './timer.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrls: ['./family.scss', './timer.scss'],
})
export class FamilyTimerWidget implements OnDestroy {
  private api = inject(Api);
  private snack = inject(MatSnackBar);
  private destroyRef = inject(DestroyRef);
  private wakeLock = inject(WakeLockService);

  /** True while we currently hold a screen wake lock (so we release exactly once when timers stop). */
  private holdingWakeLock = false;

  /** When true the widget renders bare (for embedding on the Family home, no hero / back link). */
  readonly embedded = input(false);

  readonly presets = PRESETS;

  readonly timers = signal<FamilyTimer[]>([]);
  readonly loading = signal(true);
  readonly error = signal(false);
  /** Drives the per-second re-render of all countdowns. */
  private readonly now = signal(Date.now());
  /** A timer id currently being started/cancelled (disables its button). */
  readonly busyId = signal<number | null>(null);
  readonly starting = signal(false);

  /** Custom-timer form state. */
  readonly customMinutes = signal<number | null>(null);
  readonly label = signal('');

  // ---- ✨ Quick timer (natural-language → confirm chip → Start) ----
  /** The NL input ("20 min pasta"). */
  readonly quickText = signal('');
  readonly quickBusy = signal(false);
  /** A friendly aria-live status line for the quick-timer box (an error, or a hint). */
  readonly quickStatus = signal('');
  /** The parsed { label, durationSeconds } awaiting the user's Start confirm, or null. */
  readonly quickProposal = signal<TimerAiResult | null>(null);

  /** Timer ids we've already alerted on locally, so the chime fires exactly once per timer. */
  private readonly alerted = new Set<number>();
  private tickHandle?: ReturnType<typeof setInterval>;
  private audioCtx?: AudioContext;

  /** Active (still-running) timers with their live remaining seconds, soonest-ending first. */
  readonly active = computed<LiveTimer[]>(() => {
    const now = this.now();
    return this.timers()
      .filter((t) => !t.done)
      .map((t) => ({
        timer: t,
        remaining: Math.max(0, Math.round((Date.parse(t.endsUtc) - now) / 1000)),
      }))
      .sort((a, b) => a.remaining - b.remaining);
  });

  /** Whether there's anything running to show. */
  readonly hasActive = computed(() => this.active().length > 0);

  constructor() {
    this.reload(true);

    // One shared 1s tick drives every countdown; it also detects local "reached 0" to chime once.
    this.tickHandle = setInterval(() => {
      this.now.set(Date.now());
      this.checkForFinished();
    }, 1000);

    // Light background refresh so a timer another member started/cancelled appears for us too.
    const poll = setInterval(() => this.reload(false), 20_000);
    this.destroyRef.onDestroy(() => clearInterval(poll));

    // Keep the screen awake while a countdown is actually running (the family is watching it tick
    // down), and let it sleep again the moment nothing is active. Reference-counted + feature-detected
    // in WakeLockService, so this is a silent no-op where the API is unsupported (e.g. iOS Safari).
    effect(() => {
      const running = this.hasActive();
      if (running && !this.holdingWakeLock) {
        this.holdingWakeLock = true;
        this.wakeLock.acquire();
      } else if (!running && this.holdingWakeLock) {
        this.holdingWakeLock = false;
        this.wakeLock.release();
      }
    });
  }

  ngOnDestroy(): void {
    if (this.tickHandle) clearInterval(this.tickHandle);
    // Balance any wake lock we still hold so we don't leak a reference on teardown.
    if (this.holdingWakeLock) {
      this.holdingWakeLock = false;
      this.wakeLock.release();
    }
    this.audioCtx?.close().catch(() => {});
  }

  private reload(initial: boolean): void {
    if (initial) this.loading.set(true);
    this.api
      .familyTimers()
      .pipe(
        catchError(() => {
          if (initial) this.error.set(true);
          return of<FamilyTimer[]>([]);
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((list) => {
        this.timers.set(list);
        this.loading.set(false);
        // Pre-seed alerted for timers that already finished before we loaded (don't chime on old ones).
        for (const t of list) {
          if (t.done || Date.parse(t.endsUtc) <= Date.now()) this.alerted.add(t.id);
        }
      });
  }

  /** Local "reached zero" detection: chime + friendly alert once, then refresh to pick up server `done`. */
  private checkForFinished(): void {
    const now = Date.now();
    let anyFired = false;
    for (const t of this.timers()) {
      if (t.done || this.alerted.has(t.id)) continue;
      if (Date.parse(t.endsUtc) <= now) {
        this.alerted.add(t.id);
        anyFired = true;
        this.chime();
        this.snack.open(`⏰ ${t.label} is done!`, 'OK', { duration: 8000 });
      }
    }
    // A fired timer flips to done server-side (and pings the bell); refresh to reflect it.
    if (anyFired) this.reload(false);
  }

  /** Start one of the preset countdowns (uses the typed label if given, else the preset's name). */
  async startPreset(p: Preset): Promise<void> {
    await this.start(p.seconds, this.label().trim() || p.label);
  }

  /** Start a custom countdown from the entered minutes (1–1440) + optional label. */
  async startCustom(): Promise<void> {
    const mins = this.customMinutes();
    if (mins == null || !(mins > 0)) {
      this.snack.open('Enter how many minutes the timer should run.', 'OK', { duration: 3500 });
      return;
    }
    const clamped = Math.min(24 * 60, Math.max(1, Math.round(mins)));
    await this.start(clamped * 60, this.label().trim() || 'Timer');
  }

  // ---- ✨ Quick timer ----

  /**
   * Parse the natural-language text ("20 min pasta") into a proposed { label, durationSeconds } and stage it
   * as a confirm chip — it CREATES NOTHING until the user taps Start. Degrades gracefully: a 503 (AI
   * unavailable / not configured) or any error shows a friendly aria-live line; the presets/custom always work.
   */
  async parseQuick(): Promise<void> {
    const text = this.quickText().trim();
    if (!text || this.quickBusy()) return;
    this.quickBusy.set(true);
    this.quickStatus.set('Reading that…');
    this.quickProposal.set(null);
    try {
      const result = await firstValueFrom(this.api.parseTimerAi(text));
      this.quickProposal.set(result);
      this.quickStatus.set('');
    } catch (e) {
      const status = (e as { status?: number })?.status;
      this.quickStatus.set(
        status === 503
          ? "AI isn't available right now — pick a preset or set custom minutes below."
          : this.messageOf(
              e,
              "I couldn't read that just now. Please try again, or use a preset below.",
            ),
      );
    } finally {
      this.quickBusy.set(false);
    }
  }

  /** Start the confirmed quick-timer proposal via the existing create endpoint, then clear the box on success. */
  async startQuick(): Promise<void> {
    const p = this.quickProposal();
    if (!p || this.starting()) return;
    const ok = await this.start(p.durationSeconds, p.label?.trim() || 'Timer');
    if (ok) {
      this.quickProposal.set(null);
      this.quickText.set('');
      this.quickStatus.set('');
    }
  }

  /** Discard the staged proposal (keeps the text so the user can tweak + re-parse). */
  clearQuick(): void {
    this.quickProposal.set(null);
    this.quickStatus.set('');
  }

  /** A friendly "20 min" / "1 h 30 min" / "45 sec" label for a proposed duration chip. */
  durationLabel(seconds: number): string {
    const s = Math.max(0, Math.round(seconds));
    if (s < 60) return `${s} sec`;
    const hrs = Math.floor(s / 3600);
    const mins = Math.round((s % 3600) / 60);
    if (hrs > 0) return mins > 0 ? `${hrs} h ${mins} min` : `${hrs} h`;
    return `${mins} min`;
  }

  private messageOf(e: unknown, fallback: string): string {
    const msg = (e as { error?: { message?: string } })?.error?.message;
    return typeof msg === 'string' && msg ? msg : fallback;
  }

  /** Start a countdown; returns true on success (so callers like the quick-timer can clear their box). */
  private async start(seconds: number, label: string): Promise<boolean> {
    if (this.starting()) return false;
    this.starting.set(true);
    try {
      const created = await firstValueFrom(
        this.api.createFamilyTimer({ label, durationSeconds: seconds }),
      );
      // Unlock the audio context on this user gesture so the later chime is allowed to play.
      this.primeAudio();
      this.timers.update((list) => [created, ...list.filter((t) => t.id !== created.id)]);
      this.now.set(Date.now());
      this.label.set('');
      this.customMinutes.set(null);
      return true;
    } catch {
      this.snack.open("Couldn't start that timer. Please try again.", 'OK', { duration: 4000 });
      return false;
    } finally {
      this.starting.set(false);
    }
  }

  /** Cancel a running timer (any household member). */
  async cancel(t: FamilyTimer): Promise<void> {
    if (this.busyId() != null) return;
    this.busyId.set(t.id);
    try {
      await firstValueFrom(this.api.deleteFamilyTimer(t.id));
      this.timers.update((list) => list.filter((x) => x.id !== t.id));
      this.alerted.delete(t.id);
    } catch {
      this.snack.open("Couldn't cancel that timer.", 'OK', { duration: 4000 });
    } finally {
      this.busyId.set(null);
    }
  }

  /** mm:ss (or h:mm:ss past an hour) for a remaining-seconds count. */
  format(remaining: number): string {
    const s = Math.max(0, remaining);
    const hrs = Math.floor(s / 3600);
    const mins = Math.floor((s % 3600) / 60);
    const secs = s % 60;
    const mm = String(mins).padStart(2, '0');
    const ss = String(secs).padStart(2, '0');
    return hrs > 0 ? `${hrs}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  initials(name: string): string {
    const parts = (name || '').split(/\s+/).filter(Boolean);
    return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?';
  }

  // ── Audio: a short, soft two-note chime via the Web Audio API (no asset needed) ──

  private primeAudio(): void {
    try {
      this.audioCtx ??= new (
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      )();
      if (this.audioCtx.state === 'suspended') this.audioCtx.resume().catch(() => {});
    } catch {
      /* audio unavailable — the visual alert still fires */
    }
  }

  private chime(): void {
    try {
      this.primeAudio();
      const ctx = this.audioCtx;
      if (!ctx) return;
      const beep = (freq: number, at: number) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, ctx.currentTime + at);
        gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + at + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + 0.45);
        osc.connect(gain).connect(ctx.destination);
        osc.start(ctx.currentTime + at);
        osc.stop(ctx.currentTime + at + 0.5);
      };
      beep(880, 0);
      beep(1175, 0.18);
    } catch {
      /* ignore — the snackbar alert is the reliable path */
    }
  }
}
