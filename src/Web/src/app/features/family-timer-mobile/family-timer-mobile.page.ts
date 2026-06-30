import {
  ChangeDetectionStrategy, Component, DestroyRef, OnDestroy, computed,
  effect, inject, signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { MatIconModule } from '@angular/material/icon';

import { Api } from '../../core/api';
import { FamilyTimer, TimerAiResult } from '../../core/models';
import { WakeLockService } from '../../core/wake-lock';
import {
  BetaPullRefresh, BetaBottomSheet, BetaSkeleton, BetaFab, BetaToaster,
  BetaEmptyState, BetaErrorState, ToastController,
} from '../beta-ui';

/** A one-tap preset countdown. `seconds` seeds a new timer; `label` is its friendly name. */
interface Preset {
  label: string;
  icon: string;
  seconds: number;
}

/** A timer plus its live, ticked-down remaining seconds (recomputed each tick from `endsUtc`). */
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
 * Family Timer — the mobile-first twin of the live /family/timer widget, rebuilt on the shared beta-ui
 * "Strata" kit (`@use '../beta-ui/beta-kit'`). One signature accent — a cool TEAL → INDIGO — re-skins the
 * whole screen via the per-page accent contract. An immersive scrolling header (an accent bloom + a tiny
 * running/finished stat strip), a grid of glassy active-timer cards each ticking live with a big mono
 * mm:ss readout + a one-tap Stop, a {@link BetaBottomSheet} "Start a timer" composer (presets, a custom
 * minutes + label form, and the ✨ quick natural-language parser), and a {@link BetaFab} to open it.
 * Pull-to-refresh, skeleton loaders, and elevated empty/error states round it out.
 *
 * DATA PARITY: every timer comes straight from the SAME household-scoped endpoints the live page uses —
 * {@link Api.familyTimers} (active soonest-ending first), with writes via {@link Api.createFamilyTimer} /
 * {@link Api.deleteFamilyTimer} and the optional {@link Api.parseTimerAi} VERBATIM. The client ticks each
 * countdown down locally from `endsUtc` (identical to the live page), chimes once on local zero, and a
 * 20s background poll keeps timers other members start/cancel in sync. People are rendered by display
 * name only — never an email (email-privacy).
 *
 * ISOLATION: gated by `platform.mobile` on the SAME /family/timer route the live widget carries; it
 * consumes the kit + the SAME Api/models/WakeLockService as the live counterpart. No live page is
 * imported or modified. Mobile-first (44px+ targets, safe-area insets) and centers on desktop; reduced
 * motion collapses the kit animations via the a11y killswitch.
 */
@Component({
  selector: 'app-family-timer-mobile',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [ToastController],
  imports: [
    FormsModule, MatIconModule,
    BetaPullRefresh, BetaBottomSheet, BetaSkeleton, BetaFab, BetaToaster,
    BetaEmptyState, BetaErrorState,
  ],
  template: `
    <!-- ─────────────── PULL-TO-REFRESH OWNS THE SCROLL ─────────────── -->
    <app-bs-pull-refresh class="ft-ptr" [busy]="refreshing()" (refresh)="reload(false)">
      <div class="ft-scroll" aria-live="polite">

        <!-- ─── IMMERSIVE HEADER: title + a tiny stat strip ─── -->
        <header class="ft-hero">
          <p class="ft-hero__kicker"><mat-icon aria-hidden="true">timer</mat-icon> Family timers</p>
          <h1 class="ft-hero__title">Shared timers</h1>
          <p class="ft-hero__sub">Household countdowns everyone sees in real time.</p>

          @if (!loading() && !error()) {
            <div class="ft-stats">
              <div class="ft-stat">
                <span class="ft-stat__n mono-num">{{ active().length }}</span>
                <span class="ft-stat__l">{{ active().length === 1 ? 'running' : 'running' }}</span>
              </div>
              <div class="ft-stat">
                <span class="ft-stat__n mono-num">{{ doneCount() }}</span>
                <span class="ft-stat__l">just finished</span>
              </div>
            </div>
          }
        </header>

        @if (loading()) {
          <!-- skeleton card grid -->
          <div class="ft-grid" aria-hidden="true">
            @for (n of skeletonCells; track n) {
              <app-bs-skeleton height="148px" radius="var(--r-tile)" />
            }
          </div>

        } @else if (error()) {
          <app-bs-error
            icon="cloud_off"
            title="Couldn't load timers"
            body="Something went wrong reaching the household timers. Give it another go."
            (retry)="reload(true)" />

        } @else if (active().length) {
          <!-- ─── ACTIVE TIMER CARDS ─── -->
          <div class="ft-grid">
            @for (lt of active(); track lt.timer.id; let i = $index) {
              <article class="ft-card ft-reveal" [style.--ri]="i" [class.is-up]="lt.remaining === 0">
                <div class="ft-card__top">
                  <span class="ft-card__label">{{ lt.timer.label }}</span>
                  <button type="button" class="ft-card__stop" [disabled]="busyId() === lt.timer.id"
                          (click)="cancel(lt.timer)" [attr.aria-label]="'Stop ' + lt.timer.label">
                    <mat-icon aria-hidden="true">close</mat-icon>
                  </button>
                </div>

                <div class="ft-card__time mono-num" [class.is-up]="lt.remaining === 0">
                  @if (lt.remaining === 0) { Done! } @else { {{ format(lt.remaining) }} }
                </div>

                <!-- live progress arc proxy: a thin track that drains as time runs out -->
                <div class="ft-card__bar" aria-hidden="true">
                  <span class="ft-card__fill" [style.width.%]="pctLeft(lt)"></span>
                </div>

                <div class="ft-card__by">
                  <span class="ft-card__avatar" aria-hidden="true">{{ initials(lt.timer.startedByName) }}</span>
                  <span class="ft-card__name">{{ lt.timer.startedByName }}</span>
                </div>
              </article>
            }
          </div>

        } @else {
          <!-- EMPTY: nothing running -->
          <app-bs-empty
            icon="hourglass_empty"
            title="No timers running"
            body="Tap the + to start a shared countdown the whole family can watch."
            ctaLabel="Start a timer" ctaIcon="add" (action)="openComposer()" />
        }
      </div>
    </app-bs-pull-refresh>

    <!-- ─── START FAB ─── -->
    @if (!loading() && !error()) {
      <app-bs-fab icon="add" label="Start a timer" [extended]="true" [fixed]="true" (action)="openComposer()" />
    }

    <!-- ─────────────── START-A-TIMER COMPOSER SHEET ─────────────── -->
    <app-bs-sheet [(open)]="composerOpen" detent="full" [dismissable]="!starting()" label="Start a timer">
      <div class="fc">
        <div class="fc__head">
          <h3 class="fc__title">Start a timer</h3>
          <button type="button" class="fc__close" (click)="closeComposer()" aria-label="Close" [disabled]="starting()">
            <mat-icon aria-hidden="true">close</mat-icon>
          </button>
        </div>

        <!-- ✨ Quick (natural-language) parse → confirm chip → Start -->
        <div class="fc__quick">
          <label class="fc__qfield">
            <mat-icon class="fc__qicon" aria-hidden="true">auto_awesome</mat-icon>
            <input class="fc__qinput" type="text" placeholder="“20 min pasta”"
                   [ngModel]="quickText()" (ngModelChange)="quickText.set($event)"
                   (keydown.enter)="parseQuick(); $event.preventDefault()"
                   name="quick" autocomplete="off" maxlength="120" [disabled]="quickBusy()" />
            <button type="button" class="fc__qgo" (click)="parseQuick()"
                    [disabled]="quickBusy() || !quickText().trim()" aria-label="Read this timer">
              @if (quickBusy()) { <span class="fc__spin" aria-hidden="true"></span> }
              @else { <mat-icon aria-hidden="true">arrow_forward</mat-icon> }
            </button>
          </label>

          @if (quickStatus(); as s) {
            <p class="fc__qstatus" role="status">{{ s }}</p>
          }

          @if (quickProposal(); as p) {
            <div class="fc__chip">
              <span class="fc__chip-body">
                <b>{{ p.label || 'Timer' }}</b>
                <i class="mono-num">{{ durationLabel(p.durationSeconds) }}</i>
              </span>
              <button type="button" class="fc__chip-x" (click)="clearQuick()" aria-label="Discard">
                <mat-icon aria-hidden="true">close</mat-icon>
              </button>
              <button type="button" class="fc__chip-go" (click)="startQuick()" [disabled]="starting()">
                <mat-icon aria-hidden="true">play_arrow</mat-icon> Start
              </button>
            </div>
          }
        </div>

        <div class="fc__div"><span>or pick a preset</span></div>

        <!-- presets -->
        <div class="fc__presets">
          @for (p of presets; track p.label) {
            <button type="button" class="fc__preset" [disabled]="starting()" (click)="startPreset(p)">
              <mat-icon class="fc__preset-ic" aria-hidden="true">{{ p.icon }}</mat-icon>
              <span class="fc__preset-l">{{ p.label }}</span>
              <span class="fc__preset-m mono-num">{{ durationLabel(p.seconds) }}</span>
            </button>
          }
        </div>

        <div class="fc__div"><span>or set a custom one</span></div>

        <!-- custom -->
        <div class="fc__custom">
          <label class="fc__field">
            <span class="fc__label">Label <i>(optional)</i></span>
            <input class="fc__input" type="text" placeholder="e.g. Lily screen time"
                   [ngModel]="label()" (ngModelChange)="label.set($event)"
                   name="label" autocomplete="off" maxlength="80" [disabled]="starting()" />
          </label>
          <label class="fc__field fc__field--mins">
            <span class="fc__label">Minutes</span>
            <input class="fc__input mono-num" type="number" inputmode="numeric" min="1" max="1440" step="1"
                   placeholder="15" [ngModel]="customMinutes()"
                   (ngModelChange)="customMinutes.set($event === null || $event === '' ? null : +$event)"
                   name="mins" [disabled]="starting()" />
          </label>
        </div>

        <button type="button" class="fc__start" (click)="startCustom()" [disabled]="starting()">
          @if (starting()) { <span class="fc__spin" aria-hidden="true"></span> Starting… }
          @else { <mat-icon aria-hidden="true">play_arrow</mat-icon> Start countdown }
        </button>
      </div>
    </app-bs-sheet>

    <app-bs-toaster />
  `,
  styleUrl: './family-timer-mobile.page.scss',
})
export class FamilyTimerMobilePage implements OnDestroy {
  private api = inject(Api);
  private toast = inject(ToastController);
  private destroyRef = inject(DestroyRef);
  private wakeLock = inject(WakeLockService);

  /** True while we currently hold a screen wake lock (so we release exactly once when timers stop). */
  private holdingWakeLock = false;

  readonly presets = PRESETS;
  readonly skeletonCells = Array.from({ length: 4 }, (_, i) => i);

  readonly timers = signal<FamilyTimer[]>([]);
  readonly loading = signal(true);
  readonly error = signal(false);
  readonly refreshing = signal(false);

  /** Drives the per-second re-render of all countdowns. */
  private readonly now = signal(Date.now());
  /** A timer id currently being cancelled (disables its Stop button). */
  readonly busyId = signal<number | null>(null);
  readonly starting = signal(false);

  /** Composer sheet state. */
  readonly composerOpen = signal(false);

  /** Custom-timer form state. */
  readonly customMinutes = signal<number | null>(null);
  readonly label = signal('');

  // ---- ✨ Quick timer (natural-language → confirm chip → Start) ----
  readonly quickText = signal('');
  readonly quickBusy = signal(false);
  readonly quickStatus = signal('');
  readonly quickProposal = signal<TimerAiResult | null>(null);

  /** Original total seconds per timer (first time we saw it), so the drain bar has a denominator. */
  private readonly totals = new Map<number, number>();
  /** Timer ids we've already chimed on locally, so the chime fires exactly once per timer. */
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

  /** Whether anything is running (drives the wake lock). */
  readonly hasActive = computed(() => this.active().length > 0);
  /** Recently-finished timers still returned by the server (for the stat strip). */
  readonly doneCount = computed(() => this.timers().filter((t) => t.done).length);

  constructor() {
    void this.reload(true);

    // One shared 1s tick drives every countdown; it also detects local "reached 0" to chime once.
    this.tickHandle = setInterval(() => {
      this.now.set(Date.now());
      this.checkForFinished();
    }, 1000);

    // Light background refresh so a timer another member started/cancelled appears for us too.
    const poll = setInterval(() => void this.reload(false), 20_000);
    this.destroyRef.onDestroy(() => clearInterval(poll));

    // Keep the screen awake while a countdown is running; let it sleep again the moment nothing's active.
    // Reference-counted + feature-detected in WakeLockService (a silent no-op where unsupported).
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
    if (this.holdingWakeLock) {
      this.holdingWakeLock = false;
      this.wakeLock.release();
    }
    this.audioCtx?.close().catch(() => {});
  }

  // ─────────────── LOAD ───────────────

  async reload(initial: boolean): Promise<void> {
    if (initial) this.loading.set(true); else this.refreshing.set(true);
    try {
      const list = await firstValueFrom(this.api.familyTimers());
      const next = list ?? [];
      this.timers.set(next);
      if (initial) this.error.set(false);
      // Pre-seed totals + alerted for timers as we learn about them.
      for (const t of next) {
        this.seedTotal(t);
        if (t.done || Date.parse(t.endsUtc) <= Date.now()) this.alerted.add(t.id);
      }
    } catch {
      if (initial) this.error.set(true);
    } finally {
      this.loading.set(false);
      if (!initial) this.refreshing.set(false);
    }
  }

  /** Record a sensible "total" for the drain bar the first time we see a timer (remaining at load). */
  private seedTotal(t: FamilyTimer): void {
    if (this.totals.has(t.id)) return;
    const left = Math.max(1, Math.round((Date.parse(t.endsUtc) - Date.now()) / 1000));
    this.totals.set(t.id, left);
  }

  /** Local "reached zero" detection: chime once, then refresh to pick up the server `done` flag. */
  private checkForFinished(): void {
    const now = Date.now();
    let anyFired = false;
    for (const t of this.timers()) {
      if (t.done || this.alerted.has(t.id)) continue;
      if (Date.parse(t.endsUtc) <= now) {
        this.alerted.add(t.id);
        anyFired = true;
        this.chime();
        this.toast.show(`⏰ ${t.label} is done!`, { tone: 'success', durationMs: 6000 });
      }
    }
    if (anyFired) void this.reload(false);
  }

  /** Width-% of time remaining for a timer's drain bar (clamped 0..100). */
  pctLeft(lt: LiveTimer): number {
    const total = this.totals.get(lt.timer.id) ?? lt.remaining ?? 1;
    if (total <= 0) return 0;
    return Math.max(0, Math.min(100, (lt.remaining / total) * 100));
  }

  // ─────────────── COMPOSER ───────────────

  openComposer(): void {
    this.composerOpen.set(true);
  }

  closeComposer(): void {
    if (this.starting()) return;
    this.composerOpen.set(false);
  }

  // ─────────────── START ───────────────

  /** Start one of the preset countdowns (uses the typed label if given, else the preset's name). */
  async startPreset(p: Preset): Promise<void> {
    await this.start(p.seconds, this.label().trim() || p.label);
  }

  /** Start a custom countdown from the entered minutes (1–1440) + optional label. */
  async startCustom(): Promise<void> {
    const mins = this.customMinutes();
    if (mins == null || !(mins > 0)) {
      this.toast.show('Enter how many minutes the timer should run.', { tone: 'warn' });
      return;
    }
    const clamped = Math.min(24 * 60, Math.max(1, Math.round(mins)));
    await this.start(clamped * 60, this.label().trim() || 'Timer');
  }

  // ---- ✨ Quick timer ----

  /**
   * Parse the natural-language text ("20 min pasta") into a proposed { label, durationSeconds } and stage it
   * as a confirm chip — it CREATES NOTHING until the user taps Start. Degrades gracefully on a 503/any error.
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
          : this.messageOf(e, "I couldn't read that just now. Try again, or use a preset below."),
      );
    } finally {
      this.quickBusy.set(false);
    }
  }

  /** Start the confirmed quick-timer proposal via the existing create endpoint, then clear the box. */
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
      this.seedTotal(created);
      this.totals.set(created.id, Math.max(1, seconds));
      this.timers.update((list) => [created, ...list.filter((t) => t.id !== created.id)]);
      this.now.set(Date.now());
      this.label.set('');
      this.customMinutes.set(null);
      this.composerOpen.set(false);
      this.toast.show(`Started “${created.label}”`, { tone: 'success', durationMs: 1800 });
      return true;
    } catch {
      this.toast.show("Couldn't start that timer. Please try again.", { tone: 'warn' });
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
      this.totals.delete(t.id);
      this.toast.show('Timer stopped', { tone: 'success', durationMs: 1600 });
    } catch {
      this.toast.show("Couldn't stop that timer.", { tone: 'warn' });
    } finally {
      this.busyId.set(null);
    }
  }

  // ─────────────── helpers ───────────────

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

  /** A friendly "20 min" / "1 h 30 min" / "45 sec" label for a duration chip. */
  durationLabel(seconds: number): string {
    const s = Math.max(0, Math.round(seconds));
    if (s < 60) return `${s} sec`;
    const hrs = Math.floor(s / 3600);
    const mins = Math.round((s % 3600) / 60);
    if (hrs > 0) return mins > 0 ? `${hrs} h ${mins} min` : `${hrs} h`;
    return `${mins} min`;
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
      /* ignore — the toaster alert is the reliable path */
    }
  }
}
