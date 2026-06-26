import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { CdkDropList, CdkDrag, CdkDragHandle, CdkDragDrop } from '@angular/cdk/drag-drop';

import { AuthService } from '../../core/auth';
import { ViewportService } from '../../core/viewport';
import { BetaPullRefresh } from '../beta-ui';
import { BETA_EXPERIMENTS, BetaExperiment, canSeeExperiment } from './beta-experiments';
import { HubLayoutStore } from './hub-layout-store';

/** A launcher tile = the shared experiment entry + the destination surface's OWN signature accent. */
interface HubTile extends BetaExperiment {
  /** Signature gradient start/end for this destination (drives the icon chip, glow, edge + arrow). */
  readonly accentA: string;
  readonly accentB: string;
  /** A tighter one-liner for the tile (falls back to the shared blurb). */
  readonly desc: string;
}

/**
 * Each destination's SIGNATURE accent gradient, keyed by route (Strata=multi/violet, Bills=cream,
 * Home=violet, Dashboard=pink, Family=amber, Wrapped=purple, Settings=slate). Kept here so the shared
 * {@link BETA_EXPERIMENTS} source (which the nav also iterates) stays presentation-free. Falls back to
 * the hub's own blue accent for any future entry that lacks a mapping.
 */
const SURFACE_ACCENTS: Record<string, { a: string; b: string; desc?: string }> = {
  '/tracker-beta': { a: '#7c5cff', b: '#3b82f6', desc: 'A clean-sheet, mobile-first fitness tracker.' },     // Strata — multi/violet → blue
  '/beta/bills':   { a: '#f0b760', b: '#fef3c7', desc: 'Snap a receipt, split it, share a claim link.' },   // Bills  — cream
  '/beta/home':    { a: '#8b5cff', b: '#4f7bff', desc: 'Your cross-domain glance: rings, events, presence.' }, // Home  — violet
  '/beta/dashboard': { a: '#fb7185', b: '#f472b6', desc: 'Token + cost analytics, glanceable on mobile.' },  // Dashboard — pink
  '/beta/family':  { a: '#f0a35a', b: '#fbbf24', desc: 'Your whole household at a glance.' },                 // Family — amber
  '/beta/wrapped': { a: '#a855f7', b: '#7c5cff', desc: 'Your Hub, the highlight reel.' },                     // Wrapped — purple
  '/beta/settings': { a: '#64748b', b: '#94a3b8', desc: 'Your quick toggles, mobile-first.' },               // Settings — slate
  '/beta/chat':    { a: '#2dd4bf', b: '#0ea5e9', desc: 'Fast, native-feel chat — bubbles, reactions, typing.' }, // Messenger — teal
  '/beta/ask':     { a: '#818cf8', b: '#6366f1', desc: 'Chat with an AI grounded in your own numbers.' },     // Ask — indigo
  '/beta/meals':   { a: '#34d399', b: '#a3e635', desc: 'Plan the week, swipe the days, fill the cart.' },     // Meals — green
  '/beta/people':  { a: '#fb7185', b: '#f43f5e', desc: 'Your circle, online-first — message or nudge in a tap.' }, // People — rose
  '/beta/fleet':   { a: '#22d3ee', b: '#06b6d4', desc: 'Every machine + reporter: live pulses, spend, board.' },  // Fleet — cyan
  '/beta/trophies': { a: '#fbbf24', b: '#f59e0b', desc: 'Your achievements wall — earned badges gleam.' },    // Trophies — gold
  '/beta/automations': { a: '#fb923c', b: '#ef4444', desc: 'If-this-then-that rules as WHEN → THEN cards.' },  // Automations — orange
};

/**
 * Beta hub — a premium MOBILE LAUNCHER for the experimental surfaces, now PERSONALIZABLE: each user can
 * REORDER the tiles (drag by the handle, or arrow-nudge) and SHOW/HIDE which ones appear, via a built-in
 * "customize" mode. The chosen order + hidden set persist per-device to localStorage (`beta.hub.layout`,
 * via {@link HubLayoutStore}) — no backend, fully isolated to the beta section.
 *
 * Normal mode: an immersive header ("Beta" + tagline + a live count) over a grid of rich entry tiles, each
 * carrying its destination's OWN signature accent gradient on an icon chip + glow + accent edge, a title,
 * a one-line description, and the "experimental" treatment. Depth, a staggered spring entrance, press
 * feedback, and pull-to-refresh give it a native-app feel.
 *
 * Customize mode: the grid becomes a vertical, drag-reorderable list (Angular CDK drag-drop — works on
 * touch + mouse via a dedicated handle so it never fights page scroll), each row offering hide + arrow
 * nudges; hidden tiles drop into a "Hidden — tap to show" tray below. Accessibility: every action runs
 * through page methods that announce via an `aria-live` status region; the arrow buttons are the
 * keyboard-operable reorder fallback (kept focusable at the ends, no-op rather than disabled); focus is
 * shepherded across the customize↔done DOM swap; Reset is a guarded two-tap. The {@link ViewportService}
 * tailors the hint copy (touch vs pointer) and disables pull-to-refresh while dragging.
 *
 * Gating is UNCHANGED: the visible set is still filtered by per-card permission, so a card only appears if
 * its own feature flag is granted. ISOLATED + gated by `beta.access`: nothing here touches the global
 * --tech-* tokens or any live page.
 */
@Component({
  selector: 'app-beta-hub',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './beta-hub.page.scss',
  providers: [HubLayoutStore],
  imports: [RouterLink, MatIconModule, BetaPullRefresh, CdkDropList, CdkDrag, CdkDragHandle],
  template: `
    <!-- The scroll column IS the kit pull-to-refresh; it's DISABLED while customizing so a touch-drag of a
         tile from the top can't trip the pull gesture. -->
    <app-bs-pull-refresh class="bh-ptr" [busy]="refreshing()" [disabled]="layout.reordering()" (refresh)="refresh()">
      <div class="bh-scroll" [class.bh-scroll--edit]="layout.reordering()">

        <!-- Visually-hidden live region — announces reorder / hide / show / reset to screen readers. -->
        <p class="bh-sr-only" aria-live="polite" role="status">{{ status() }}</p>

        <!-- Immersive page header — "Beta" + tagline + customize/count, with an accent bloom behind it. -->
        <header class="bh-head">
          <div class="bh-head__bloom" aria-hidden="true"></div>
          <div class="bh-head__top">
            <div class="bh-head__text">
              <span class="bh-head__eyebrow"><span class="bh-spark" aria-hidden="true"></span> Experimental</span>
              <h1 class="bh-head__title">Beta</h1>
              <p class="bh-head__tag">Early surfaces we're shaping — arrange them your way.</p>
            </div>

            <div class="bh-head__actions">
              @if (layout.reordering()) {
                <button type="button" class="bh-act bh-act--ghost" [class.bh-act--armed]="resetArmed()"
                        (click)="armOrConfirmReset()"
                        [attr.aria-label]="resetArmed()
                          ? 'Confirm reset — restore the default order and show all tiles'
                          : 'Reset all tiles to the default order'">
                  {{ resetArmed() ? 'Tap to confirm' : 'Reset' }}
                </button>
                <button type="button" #doneBtn class="bh-act bh-act--primary" (click)="exitCustomize()">Done</button>
              } @else {
                @if (totalGated()) {
                  <button type="button" #customizeBtn class="bh-act bh-act--icon" (click)="enterCustomize()"
                          aria-label="Customize — reorder or hide tiles">
                    <mat-icon aria-hidden="true">dashboard_customize</mat-icon>
                  </button>
                }
                @if (shown().length) {
                  <div class="bh-count" aria-hidden="true">
                    <span class="bh-count__n">{{ shown().length }}</span>
                    <span class="bh-count__lbl">{{ shown().length === 1 ? 'lab' : 'labs' }}</span>
                  </div>
                }
              }
            </div>
          </div>
        </header>

        @if (layout.reordering()) {
          <p class="bh-hint">
            <mat-icon aria-hidden="true">drag_indicator</mat-icon>
            <span>{{ dragHint() }}</span>
          </p>
        }

        @if (layout.reordering()) {
          <!-- ===== CUSTOMIZE MODE — a vertical, drag-reorderable list with hide controls. ===== -->
          @if (shown().length) {
            <div class="bh-grid bh-grid--edit" cdkDropList (cdkDropListDropped)="onDrop($event)">
              @for (t of shown(); track t.route; let i = $index) {
                <div class="bh-tile bh-tile--edit" cdkDrag cdkDragPreviewContainer="parent"
                     [style.--ta]="t.accentA" [style.--tb]="t.accentB">
                  <button type="button" class="bh-handle" cdkDragHandle aria-label="Drag to reorder">
                    <mat-icon aria-hidden="true">drag_indicator</mat-icon>
                  </button>
                  <span class="bh-tile__icon bh-tile__icon--sm"><mat-icon aria-hidden="true">{{ t.icon }}</mat-icon></span>
                  <span class="bh-tile__title bh-tile__title--edit">{{ t.title }}</span>
                  <div class="bh-editbtns">
                    <button type="button" class="bh-ebtn" [class.bh-ebtn--end]="i === 0"
                            [attr.aria-disabled]="i === 0" (click)="nudgeTile(t, -1)" aria-label="Move earlier">
                      <mat-icon aria-hidden="true">keyboard_arrow_up</mat-icon>
                    </button>
                    <button type="button" class="bh-ebtn" [class.bh-ebtn--end]="i === shown().length - 1"
                            [attr.aria-disabled]="i === shown().length - 1" (click)="nudgeTile(t, 1)" aria-label="Move later">
                      <mat-icon aria-hidden="true">keyboard_arrow_down</mat-icon>
                    </button>
                    <button type="button" class="bh-ebtn bh-ebtn--off" (click)="hideTile(t)" aria-label="Hide tile">
                      <mat-icon aria-hidden="true">visibility_off</mat-icon>
                    </button>
                  </div>
                </div>
              }
            </div>
          } @else {
            <div class="bh-empty bh-empty--edit">
              <span class="bh-empty__ic" aria-hidden="true"><mat-icon>visibility_off</mat-icon></span>
              <p class="bh-empty__msg">Every tile is hidden. Tap one below to bring it back.</p>
            </div>
          }

          @if (hiddenTiles().length) {
            <div class="bh-hidden">
              <span class="bh-hidden__label">Hidden — tap to show</span>
              <div class="bh-hidden__list">
                @for (t of hiddenTiles(); track t.route) {
                  <button type="button" class="bh-chip" [style.--ta]="t.accentA" [style.--tb]="t.accentB"
                          (click)="showTile(t)" [attr.aria-label]="'Show ' + t.title">
                    <span class="bh-chip__ic"><mat-icon aria-hidden="true">{{ t.icon }}</mat-icon></span>
                    <span class="bh-chip__t">{{ t.title }}</span>
                    <mat-icon class="bh-chip__add" aria-hidden="true">add_circle</mat-icon>
                  </button>
                }
              </div>
            </div>
          }

        } @else {
          <!-- ===== NORMAL MODE — the launcher grid (staggered spring entrance). ===== -->
          @if (shown().length) {
            <div class="bh-grid">
              @for (t of shown(); track t.route; let i = $index) {
                <div class="bh-tile-in" [style.--i]="i">
                  <a class="bh-tile" [routerLink]="t.route"
                     [style.--ta]="t.accentA" [style.--tb]="t.accentB"
                     [attr.aria-label]="t.title + ' — ' + t.desc">
                    <div class="bh-tile__top">
                      <span class="bh-tile__icon"><mat-icon aria-hidden="true">{{ t.icon }}</mat-icon></span>
                      <span class="bh-tag"><span class="bh-tag__dot" aria-hidden="true"></span> Beta</span>
                    </div>
                    <div class="bh-tile__body">
                      <span class="bh-tile__title">
                        {{ t.title }}
                        <span class="bh-tile__arrow" aria-hidden="true">→</span>
                      </span>
                      <span class="bh-tile__desc">{{ t.desc }}</span>
                    </div>
                  </a>
                </div>
              }
            </div>
          } @else if (totalGated()) {
            <!-- Gated tiles exist, but the user has hidden them all. -->
            <div class="bh-empty">
              <span class="bh-empty__ic" aria-hidden="true"><mat-icon>dashboard_customize</mat-icon></span>
              <p class="bh-empty__msg">You've hidden all your Beta tiles. Open <b>Customize</b> to bring some back.</p>
              <button type="button" class="bh-empty__btn" (click)="enterCustomize()">Customize</button>
            </div>
          } @else {
            <div class="bh-empty">
              <span class="bh-empty__ic" aria-hidden="true"><mat-icon>science</mat-icon></span>
              <p class="bh-empty__msg">No beta experiments are available to you yet. As features open up,
                they'll land here first.</p>
            </div>
          }
        }
      </div>
    </app-bs-pull-refresh>
  `,
})
export class BetaHubPage {
  private readonly auth = inject(AuthService);

  /** Per-device tile order + show/hide + customize mode. Provided at the component → beta-only, never global. */
  readonly layout = inject(HubLayoutStore);

  /** Runtime viewport detection — tailors the customize hint (touch vs pointer) and is available app-wide. */
  readonly viewport = inject(ViewportService);

  /** True while a (visual) pull-to-refresh settles — there's no live data here, so it's a brief reflow. */
  readonly refreshing = signal(false);

  /** Screen-reader status line (aria-live) — set after every reorder / hide / show / reset. */
  readonly status = signal('');

  /** Reset is destructive (wipes the whole layout), so it takes a confirming second tap. */
  readonly resetArmed = signal(false);
  private resetTimer?: ReturnType<typeof setTimeout>;

  /** Refs for shepherding focus across the customize ↔ done DOM swap. */
  private readonly doneBtn = viewChild<ElementRef<HTMLButtonElement>>('doneBtn');
  private readonly customizeBtn = viewChild<ElementRef<HTMLButtonElement>>('customizeBtn');

  /** All experiments the session may SEE, keyed by route, each with its signature accent. Gating only. */
  private readonly gated = computed<Map<string, HubTile>>(() => {
    this.auth.permissions(); // re-run when permissions change
    const map = new Map<string, HubTile>();
    for (const x of BETA_EXPERIMENTS) {
      if (!canSeeExperiment(x, p => this.auth.hasPermission(p))) continue;
      const sig = SURFACE_ACCENTS[x.route];
      map.set(x.route, {
        ...x,
        accentA: sig?.a ?? 'var(--accent-a)',
        accentB: sig?.b ?? 'var(--accent-b)',
        desc: sig?.desc ?? x.blurb,
      });
    }
    return map;
  });

  /** The ordered, gated, NOT-hidden tiles the grid renders. */
  readonly shown = computed<HubTile[]>(() => {
    const g = this.gated();
    return this.layout.visibleOrder()
      .map(r => g.get(r))
      .filter((t): t is HubTile => !!t);
  });

  /** Just the routes of {@link shown} — handed to the store for a drag/nudge reorder. */
  readonly shownRoutes = computed<string[]>(() => this.shown().map(t => t.route));

  /** Gated tiles the user has hidden (the customize-mode "Hidden" tray). */
  readonly hiddenTiles = computed<HubTile[]>(() => {
    const g = this.gated();
    return this.layout.order()
      .filter(r => !this.layout.isOn(r) && g.has(r))
      .map(r => g.get(r))
      .filter((t): t is HubTile => !!t);
  });

  /** How many tiles the session may see at all (gated). Drives the customize button + empty-state copy. */
  readonly totalGated = computed(() => this.gated().size);

  /** Customize hint copy — touch users grab a handle; pointer users drag/click. */
  readonly dragHint = computed(() =>
    this.viewport.isTouch()
      ? 'Hold a tile’s handle to drag it; tap the eye to hide. Build your own Beta hub.'
      : 'Drag a tile’s handle to reorder; click the eye to hide. Build your own Beta hub.');

  /** Enter customize mode and park focus on the Done button (so keyboard users keep their place). */
  enterCustomize(): void {
    this.layout.setReorder(true);
    this.focusSoon(() => this.doneBtn()?.nativeElement);
  }

  /** Leave customize mode, disarm any pending Reset, and return focus to the Customize button. */
  exitCustomize(): void {
    this.layout.setReorder(false);
    this.disarmReset();
    this.focusSoon(() => this.customizeBtn()?.nativeElement);
  }

  /** A drag finished — translate the shown-list move back onto the persisted full order, then announce. */
  onDrop(event: CdkDragDrop<HubTile[]>): void {
    const routes = this.shownRoutes();
    const moved = this.gated().get(routes[event.previousIndex]);
    this.layout.reorderShown(routes, event.previousIndex, event.currentIndex);
    if (moved) this.status.set(`${moved.title} moved to position ${event.currentIndex + 1} of ${routes.length}.`);
  }

  /** Arrow-nudge a tile (the keyboard-operable reorder). No-op at the ends — never disabled, so focus holds. */
  nudgeTile(t: HubTile, delta: -1 | 1): void {
    const routes = this.shownRoutes();
    const from = routes.indexOf(t.route);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= routes.length) return;
    this.layout.nudge(routes, t.route, delta);
    this.status.set(`${t.title} moved to position ${to + 1} of ${routes.length}.`);
  }

  hideTile(t: HubTile): void {
    this.layout.toggle(t.route);
    this.status.set(`${t.title} hidden. ${this.shown().length} tiles showing.`);
  }

  showTile(t: HubTile): void {
    this.layout.toggle(t.route);
    this.status.set(`${t.title} shown. ${this.shown().length} tiles showing.`);
  }

  /** Two-tap guard on the destructive Reset: first tap arms (auto-disarms after 4s), second tap resets. */
  armOrConfirmReset(): void {
    if (this.resetArmed()) {
      this.disarmReset();
      this.layout.reset();
      this.status.set('Tiles reset to the default order; all shown.');
      return;
    }
    this.resetArmed.set(true);
    this.resetTimer = setTimeout(() => this.resetArmed.set(false), 4000);
  }

  private disarmReset(): void {
    this.resetArmed.set(false);
    if (this.resetTimer) { clearTimeout(this.resetTimer); this.resetTimer = undefined; }
  }

  /** Focus a target once the post-toggle DOM swap has rendered (the @if-swapped buttons mount next tick). */
  private focusSoon(get: () => HTMLElement | undefined): void {
    setTimeout(() => get()?.focus(), 0);
  }

  /**
   * Pull-to-refresh: the hub is a static index (the visible set is derived from the session's permissions),
   * so this just re-asserts the permission read and flips the spinner briefly for the native-feel gesture.
   */
  refresh(): void {
    this.refreshing.set(true);
    this.auth.permissions(); // re-read (cheap); the computed recomputes on any change
    setTimeout(() => this.refreshing.set(false), 450);
  }
}
