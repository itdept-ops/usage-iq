import {
  ChangeDetectionStrategy, Component, OnDestroy, computed, input, signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';

import { FamilyBriefing, FamilyToday, FamilyTodayEvent, FamilyTodayTimer } from '../../../core/models';

/** What the hero is currently surfacing, in priority order. */
type HeroMode = 'event' | 'timer' | 'narrative' | 'calm';

/**
 * The Hearth "Now" hero — the warm focal card at the top of the column. It degrades gracefully so it is
 * NEVER empty: the caller's soonest upcoming event today (with a live countdown chip) → else the soonest
 * still-running timer (countdown) → else the AI morning `briefing.narrative` → else a calm "all clear"
 * line. `today` + `briefing` are passed in (the page owns the shared best-effort loads), so this card
 * holds no network of its own.
 *
 * The `nextEventOf` reducer is COPIED verbatim from family-home.ts:114 (not imported), matching the
 * Atrium EventWidget copy, so the card stays decoupled from the live page.
 */
@Component({
  selector: 'fb-now-hero',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, MatIconModule],
  template: `
    <section class="hero" [class.hero--calm]="mode() === 'calm'">
      <span class="hero__eyebrow">
        <mat-icon aria-hidden="true">{{ icon() }}</mat-icon>
        {{ eyebrow() }}
      </span>

      @switch (mode()) {
        @case ('event') {
          <a class="hero__main" routerLink="/family/calendar">
            <span class="hero__title">{{ event()!.title }}</span>
            <span class="hero__meta">
              {{ event()!.allDay ? 'All day' : event()!.localTime }}
              @if (countdown(); as cd) { <span class="hero__count">· in {{ cd }}</span> }
            </span>
          </a>
        }
        @case ('timer') {
          <a class="hero__main" routerLink="/family/timer">
            <span class="hero__title">{{ timer()!.label || 'Timer' }}</span>
            <span class="hero__meta">
              @if (countdown(); as cd) { <span class="hero__count">{{ cd }} left</span> }
              @else { Ending now }
            </span>
          </a>
        }
        @case ('narrative') {
          <p class="hero__narrative">{{ narrative() }}</p>
        }
        @default {
          <p class="hero__narrative">Nothing on the calendar right now — enjoy the quiet.</p>
        }
      }
    </section>
  `,
  styles: [`
    .hero {
      display: flex; flex-direction: column; gap: 8px;
      border-radius: var(--r-card, 24px);
      padding: 20px;
      background: linear-gradient(150deg, var(--hearth-a) -10%, var(--hearth-b) 120%);
      color: #1a0f06;
      box-shadow: var(--lift-2);
      scroll-snap-align: start;
    }
    .hero--calm {
      background: var(--bg-rise);
      color: var(--ink);
      border: 1px solid var(--glass-edge);
    }
    .hero__eyebrow {
      display: inline-flex; align-items: center; gap: 6px;
      font-size: 12px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase;
      opacity: .85;
    }
    .hero__eyebrow mat-icon { font-size: 16px; width: 16px; height: 16px; }
    .hero__main { display: flex; flex-direction: column; gap: 4px; text-decoration: none; color: inherit; }
    .hero__title {
      font-family: var(--font-display, inherit);
      font-weight: 800; font-size: 24px; line-height: 1.15;
      overflow: hidden; text-overflow: ellipsis; display: -webkit-box;
      -webkit-line-clamp: 2; -webkit-box-orient: vertical;
    }
    .hero__meta { font-size: 14px; font-weight: 600; opacity: .9; }
    .hero__count { font-variant-numeric: tabular-nums; }
    .hero__narrative {
      margin: 0; font-size: 16px; line-height: 1.45; font-weight: 500;
    }
    .hero__main:focus-visible { outline: 2px solid #1a0f06; outline-offset: 3px; border-radius: 8px; }
  `],
})
export class NowHero implements OnDestroy {
  /** The shared Today snapshot (page-owned, best-effort). */
  readonly today = input<FamilyToday | null>(null);
  /** The shared morning briefing (page-owned, best-effort). */
  readonly briefing = input<FamilyBriefing | null>(null);

  /** A 1s ticker so the countdown chips stay live without per-card network. */
  private readonly nowMs = signal(Date.now());
  private readonly ticker = setInterval(() => this.nowMs.set(Date.now()), 1000);

  /** COPIED from family-home.ts:114 — do NOT import FamilyHome. */
  private nextEventOf(evs: FamilyTodayEvent[]): FamilyTodayEvent | null {
    if (!evs.length) return null;
    const now = Date.now();
    const upcoming = evs
      .filter(e => !e.allDay && e.startUtc && Date.parse(e.startUtc) >= now)
      .sort((a, b) => (a.startUtc ?? '').localeCompare(b.startUtc ?? ''));
    if (upcoming.length) return upcoming[0];
    return evs.find(e => e.allDay) ?? null;
  }

  readonly event = computed<FamilyTodayEvent | null>(() => this.nextEventOf(this.today()?.events ?? []));

  /** The soonest still-running timer (endsUtc still ahead), if any. */
  readonly timer = computed<FamilyTodayTimer | null>(() => {
    const now = this.nowMs();
    const live = (this.today()?.timers ?? [])
      .filter(t => Date.parse(t.endsUtc) > now)
      .sort((a, b) => a.endsUtc.localeCompare(b.endsUtc));
    return live[0] ?? null;
  });

  readonly narrative = computed(() => this.briefing()?.narrative?.trim() || '');

  readonly mode = computed<HeroMode>(() => {
    if (this.event()) return 'event';
    if (this.timer()) return 'timer';
    if (this.narrative()) return 'narrative';
    return 'calm';
  });

  readonly icon = computed(() => {
    switch (this.mode()) {
      case 'event': return 'event';
      case 'timer': return 'timer';
      case 'narrative': return 'auto_awesome';
      default: return 'wb_sunny';
    }
  });

  readonly eyebrow = computed(() => {
    switch (this.mode()) {
      case 'event': return 'Up next';
      case 'timer': return 'Timer running';
      case 'narrative': return 'Today';
      default: return 'All clear';
    }
  });

  /** A friendly "2h 5m" / "8m" / "45s" countdown to the active event start or timer end. */
  readonly countdown = computed<string | null>(() => {
    const now = this.nowMs();
    let target: number | null = null;
    if (this.mode() === 'event') {
      const e = this.event();
      target = e && !e.allDay && e.startUtc ? Date.parse(e.startUtc) : null;
    } else if (this.mode() === 'timer') {
      const t = this.timer();
      target = t ? Date.parse(t.endsUtc) : null;
    }
    if (target == null || Number.isNaN(target)) return null;
    let secs = Math.max(0, Math.round((target - now) / 1000));
    if (secs <= 0) return null;
    const h = Math.floor(secs / 3600); secs -= h * 3600;
    const m = Math.floor(secs / 60); const s = secs - m * 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m`;
    return `${s}s`;
  });

  ngOnDestroy(): void {
    clearInterval(this.ticker);
  }
}
