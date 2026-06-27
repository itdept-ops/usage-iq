import {
  ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject,
  input, model, signal,
} from '@angular/core';

import { TrackerDayDto } from '../../../core/models';
import { group, remaining } from '../util/units';

/** Which face the hero is showing. `rings` = the triple-ring glance; `macros` = the macro-detail face. */
export type HeroFace = 'rings' | 'macros';

/**
 * Strata HERO — the single glanceable SVG triple concentric ring + count-up ticker.
 *
 *   outer ring = protein  (pro  gradient, cyan→green)  — value proteinG / proteinGoalG
 *   mid   ring = carbs    (carb gradient, cal-b→cal-a) — value carbG    / carbGoalG
 *   inner ring = fat      (fat  gradient, move-b→move-a) — value fatG    / fatGoalG
 *
 * The three rings are the three MACROS; CALORIES are the center number (the big count-up ticker + its
 * over-goal warm/--warn coloring). Steps/move have their own move-card elsewhere and leave the ring.
 *
 * Center: a live ticker numeral "1,240 / 2,000" (denominator at 40% size, --ink-dim) with a caption
 * "kcal · 760 left" (GRAFT Daylight: abundance framing — shows what's LEFT, not just consumed). When the
 * caller goes OVER the calorie goal the outer ring + numeral flip to warm --warn amber (NEVER red) with a
 * soft pulse. The numeral counts UP 600ms on every change (collapses to instant under reduced-motion).
 *
 * Below the rings, a tappable macro chip row [P 92g][C 140g][F 38g]; tapping a chip view-transitions the
 * hero to a macro-detail face (calls startViewTransition when available + reduced-motion off, else swaps
 * instantly) and emits (faceChange). Tapping the rings face's "back" returns to the rings.
 *
 * Fully self-styled with var(--*) Strata tokens (no global --tech-*). The whole hero carries a single
 * aria-label text equivalent ("1,240 of 2,000 kcal, 760 remaining. Protein 92 of 140 grams. …") so the
 * SVG is announced as one readable summary; the chips are real buttons with their own labels.
 *
 * Contract:
 *   selector: app-hero-ring
 *   inputs:   day (TrackerDayDto | null, required) — the active day; reads totals + goals off it
 *             face (HeroFace model, two-way, default 'rings'; its implicit faceChange output fires on swap)
 *
 * Usage: `<app-hero-ring [day]="opt.day()" [(face)]="heroFace" />`
 *    or: `<app-hero-ring [day]="opt.day()" (faceChange)="onFace($event)" />`
 */
@Component({
  selector: 'app-hero-ring',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'tb-hero-ring' },
  template: `
    <div class="hr-stage" [class.is-macros]="face() === 'macros'"
         role="group" [attr.aria-label]="ariaLabel()">

      <!-- ───────── RINGS FACE ───────── -->
      @if (face() === 'rings') {
        <div class="hr-face hr-rings" style="view-transition-name: hr-face">
          <div class="hr-ringbox">
            <svg class="hr-svg" [attr.viewBox]="'0 0 ' + BOX + ' ' + BOX" aria-hidden="true"
                 [class.over]="calOver()">
              <defs>
                <linearGradient id="hr-cal" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0" stop-color="var(--cal-a)" />
                  <stop offset="1" stop-color="var(--cal-b)" />
                </linearGradient>
                <linearGradient id="hr-pro" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0" stop-color="var(--pro-a)" />
                  <stop offset="1" stop-color="var(--pro-b)" />
                </linearGradient>
                <linearGradient id="hr-carb" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0" stop-color="var(--cal-b)" />
                  <stop offset="1" stop-color="var(--cal-a)" />
                </linearGradient>
                <linearGradient id="hr-fat" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0" stop-color="var(--move-b)" />
                  <stop offset="1" stop-color="var(--move-a)" />
                </linearGradient>
                <linearGradient id="hr-warn" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0" stop-color="var(--warn)" />
                  <stop offset="1" stop-color="var(--warn)" />
                </linearGradient>
              </defs>

              <!-- rings: rotate -90° so each starts at 12 o'clock -->
              <g [attr.transform]="'rotate(-90 ' + CTR + ' ' + CTR + ')'">
                @for (r of rings(); track r.key) {
                  <circle class="hr-track" [attr.cx]="CTR" [attr.cy]="CTR" [attr.r]="r.radius"
                          [attr.stroke-width]="STROKE" fill="none" />
                  <circle class="hr-arc" [class.pulse]="r.over"
                          [attr.cx]="CTR" [attr.cy]="CTR" [attr.r]="r.radius"
                          [attr.stroke]="'url(#' + r.grad + ')'"
                          [attr.stroke-width]="STROKE" fill="none" stroke-linecap="round"
                          [attr.stroke-dasharray]="r.circ"
                          [attr.stroke-dashoffset]="r.offset" />
                }
              </g>
            </svg>

            <!-- center ticker numeral -->
            <div class="hr-center" [class.over]="calOver()" aria-hidden="true">
              <div class="hr-num">
                <span class="hr-cur">{{ calCurText() }}</span>
                @if (calGoal() != null) {
                  <span class="hr-den">/ {{ groupFn(calGoal()!) }}</span>
                }
              </div>
              <div class="hr-cap">
                <span class="hr-unit">kcal</span>
                @if (calLeft() != null) {
                  <span class="hr-dot">·</span>
                  <span class="hr-left" [class.over]="calOver()">
                    {{ calOver() ? groupFn(calOverBy()) + ' over' : groupFn(calLeft()!) + ' left' }}
                  </span>
                }
              </div>
            </div>
          </div>

          <!-- tappable macro chips -->
          <div class="hr-chips" role="group" aria-label="Macros — tap for detail">
            @for (m of macros(); track m.key) {
              <button type="button" class="hr-chip" [style.--ca]="m.a" [style.--cb]="m.b"
                      [attr.aria-label]="m.aria"
                      (click)="showMacros()">
                <span class="hr-chip-k">{{ m.key }}</span>
                <span class="hr-chip-v">{{ m.grams }}g</span>
              </button>
            }
          </div>
        </div>
      }

      <!-- ───────── MACRO-DETAIL FACE ───────── -->
      @if (face() === 'macros') {
        <div class="hr-face hr-macros" style="view-transition-name: hr-face">
          <div class="hr-mac-head">
            <button type="button" class="hr-back" aria-label="Back to rings" (click)="showRings()">
              <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                <path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2"
                      stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </button>
            <span class="hr-mac-title">Macros</span>
          </div>

          <ul class="hr-mac-list">
            @for (m of macros(); track m.key) {
              <li class="hr-mac-row" [style.--ca]="m.a" [style.--cb]="m.b">
                <div class="hr-mac-line">
                  <span class="hr-mac-name">{{ m.name }}</span>
                  <span class="hr-mac-val">
                    {{ m.grams }}@if (m.goal != null) {<span class="hr-mac-goal"> / {{ m.goal }}</span>}<span class="hr-mac-u">g</span>
                  </span>
                </div>
                <div class="hr-mac-bar" [attr.aria-hidden]="true">
                  <span class="hr-mac-fill" [style.width.%]="m.pct"></span>
                </div>
                @if (m.goal != null) {
                  <span class="hr-mac-sub">{{ macroLeftText(m.grams, m.goal) }}</span>
                }
              </li>
            }
          </ul>
        </div>
      }
    </div>
  `,
  styles: [`
    :host { display: block; width: 100%; }

    .hr-stage {
      display: flex; flex-direction: column; align-items: center;
      width: 100%;
    }

    .hr-face {
      display: flex; flex-direction: column; align-items: center;
      width: 100%;
    }

    /* ── rings ── */
    /* Sized off the hero's inner width so the ring fills the card (it no longer floats in a tall
       near-empty box). Capped so it stays glanceable on big phones / small tablets. */
    .hr-ringbox {
      position: relative;
      width: min(72vw, 260px);
      aspect-ratio: 1 / 1;
      display: grid; place-items: center;
    }
    .hr-svg { width: 100%; height: 100%; display: block; overflow: visible; }

    .hr-track { stroke: var(--hairline); }
    .hr-arc {
      transition: stroke-dashoffset 700ms var(--ease-spring);
    }
    .hr-arc.pulse { animation: hr-pulse 2.4s var(--ease-out) infinite; }
    @keyframes hr-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: .58; }
    }

    /* center ticker */
    .hr-center {
      position: absolute; inset: 0;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: 2px; pointer-events: none; text-align: center;
    }
    .hr-num {
      display: flex; align-items: baseline; gap: 5px;
      font-family: var(--font-display);
      font-variant-numeric: tabular-nums;
      line-height: 1;
    }
    .hr-cur {
      font-size: clamp(40px, 13vw, 60px); font-weight: 600;
      letter-spacing: -.025em; color: var(--ink);
    }
    .hr-center.over .hr-cur { color: var(--warn); }
    .hr-den {
      font-size: clamp(16px, 5.2vw, 24px); font-weight: 600;
      letter-spacing: -.02em; color: var(--ink-dim);
    }
    .hr-cap {
      display: flex; align-items: center; gap: 5px;
      font-family: var(--font-ui);
      font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase;
      color: var(--ink-dim);
    }
    .hr-dot { color: var(--ink-faint); }
    .hr-left { color: var(--signal); }
    .hr-left.over { color: var(--warn); }

    /* ── macro chips ── */
    .hr-chips {
      display: flex; gap: 8px; margin-top: 14px; flex-wrap: wrap; justify-content: center;
    }
    .hr-chip {
      display: inline-flex; align-items: center; gap: 6px;
      min-height: 44px; padding: 8px 14px;
      border: 1px solid var(--glass-edge); border-radius: var(--r-pill);
      background: var(--bg-rise); color: var(--ink);
      box-shadow: var(--lift-1);
      cursor: pointer; touch-action: manipulation; -webkit-tap-highlight-color: transparent;
      font-family: var(--font-ui);
      transition: transform 120ms var(--ease-out), box-shadow 120ms var(--ease-out);
    }
    .hr-chip:active { transform: scale(.97) translateY(1px); box-shadow: var(--press); }
    .hr-chip:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
    .hr-chip-k {
      display: grid; place-items: center;
      width: 20px; height: 20px; border-radius: 50%;
      font-size: 12px; font-weight: 800; color: #fff;
      background: linear-gradient(135deg, var(--ca), var(--cb));
    }
    .hr-chip-v {
      font-size: 14px; font-weight: 700; font-variant-numeric: tabular-nums;
      letter-spacing: -.01em; color: var(--ink);
    }

    /* ── macro-detail face ── */
    .hr-macros { padding: 4px 6px 8px; }
    .hr-mac-head {
      display: flex; align-items: center; gap: 8px; width: 100%;
      margin-bottom: 14px;
    }
    .hr-back {
      display: grid; place-items: center;
      width: 44px; height: 44px; margin-left: -10px;
      border: none; background: transparent; color: var(--ink-dim);
      border-radius: var(--r-pill); cursor: pointer;
      touch-action: manipulation; -webkit-tap-highlight-color: transparent;
    }
    .hr-back:active { color: var(--ink); }
    .hr-back:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
    .hr-mac-title {
      font-family: var(--font-ui); font-size: 13px; font-weight: 700;
      letter-spacing: .02em; color: var(--ink);
    }
    .hr-mac-list { list-style: none; margin: 0; padding: 0; width: 100%;
      display: flex; flex-direction: column; gap: 16px; }
    .hr-mac-row { display: flex; flex-direction: column; gap: 6px; }
    .hr-mac-line { display: flex; align-items: baseline; justify-content: space-between; }
    .hr-mac-name {
      font-family: var(--font-ui); font-size: 14px; font-weight: 600; color: var(--ink);
    }
    .hr-mac-val {
      font-family: var(--font-display); font-variant-numeric: tabular-nums;
      font-size: 18px; font-weight: 600; letter-spacing: -.02em; color: var(--ink);
    }
    .hr-mac-goal { color: var(--ink-dim); }
    .hr-mac-u { font-size: 12px; color: var(--ink-dim); margin-left: 1px; }
    .hr-mac-bar {
      height: 7px; border-radius: var(--r-pill); overflow: hidden;
      background: var(--hairline);
    }
    .hr-mac-fill {
      display: block; height: 100%; border-radius: inherit;
      background: linear-gradient(90deg, var(--ca), var(--cb));
      transition: width 700ms var(--ease-spring);
    }
    .hr-mac-sub {
      font-family: var(--font-ui); font-size: 11px; font-weight: 600;
      letter-spacing: .04em; text-transform: uppercase; color: var(--ink-faint);
    }

    /* view-transition cross-fade between faces (gated by host reduced-motion killswitch) */
    ::view-transition-old(hr-face),
    ::view-transition-new(hr-face) {
      animation-duration: 280ms; animation-timing-function: var(--ease-out);
    }

    /* reduced-motion killswitch — also reachable via the page host, doubled here for isolation */
    @media (prefers-reduced-motion: reduce) {
      .hr-arc, .hr-mac-fill { transition: none; }
      .hr-arc.pulse { animation: none; }
    }
  `],
})
export class HeroRing {
  private destroyRef = inject(DestroyRef);

  /** The active day (totals + goals). Null while loading; the hero then shows zeros. */
  readonly day = input.required<TrackerDayDto | null>();
  /**
   * Which face is visible (two-way `model`). Setting it emits the implicit `faceChange` output, so the
   * page can bind `[(face)]="heroFace"` and/or listen to `(faceChange)`.
   */
  readonly face = model<HeroFace>('rings');

  // expose util to the template
  protected readonly groupFn = group;

  // ── ring geometry ──────────────────────────────────────────────────────────
  protected readonly BOX = 200;
  protected readonly CTR = 100;
  protected readonly STROKE = 13;
  /** Outer / mid / inner radii (px in the 200-box), gapped by stroke + breathing room. */
  private readonly RADII = [82, 63, 44];

  // ── raw values off the day ──────────────────────────────────────────────────
  private readonly d = this.day;

  protected readonly calCur = computed(() => this.d()?.caloriesIn ?? 0);
  protected readonly calGoal = computed(() => this.d()?.calorieGoal ?? null);
  protected readonly proCur = computed(() => Math.round(this.d()?.proteinG ?? 0));
  protected readonly proGoal = computed(() => {
    const g = this.d()?.profile?.proteinGoalG;
    return g != null && g > 0 ? Math.round(g) : null;
  });
  protected readonly carbCur = computed(() => Math.round(this.d()?.carbG ?? 0));
  protected readonly carbGoal = computed(() => {
    const g = this.d()?.profile?.carbGoalG;
    return g != null && g > 0 ? Math.round(g) : null;
  });
  protected readonly fatCur = computed(() => Math.round(this.d()?.fatG ?? 0));
  protected readonly fatGoal = computed(() => {
    const g = this.d()?.profile?.fatGoalG;
    return g != null && g > 0 ? Math.round(g) : null;
  });
  protected readonly stepCur = computed(() => this.d()?.activity?.steps ?? 0);
  protected readonly stepGoal = computed(() => {
    const g = this.d()?.stepGoal;
    return g != null && g > 0 ? g : null;
  });

  // ── over-goal / abundance (GRAFT Daylight) ──────────────────────────────────
  protected readonly calOver = computed(() => {
    const g = this.calGoal();
    return g != null && this.calCur() > g;
  });
  protected readonly calLeft = computed(() => remaining(this.calCur(), this.calGoal()));
  protected readonly calOverBy = computed(() => {
    const g = this.calGoal();
    return g != null ? Math.max(0, this.calCur() - g) : 0;
  });

  // ── animated count-up ticker for the calorie numeral ────────────────────────
  /** The displayed (animating) calorie value. */
  private readonly displayCal = signal(0);
  protected readonly calCurText = computed(() => group(this.displayCal()));
  private raf = 0;
  private reduceMotion =
    typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ── ring descriptors (track / arc geometry) ─────────────────────────────────
  protected readonly rings = computed(() => {
    const specs = [
      { key: 'pro', grad: 'hr-pro',
        cur: this.proCur(), goal: this.proGoal(), over: false, radius: this.RADII[0] },
      { key: 'carb', grad: 'hr-carb',
        cur: this.carbCur(), goal: this.carbGoal(), over: false, radius: this.RADII[1] },
      { key: 'fat', grad: 'hr-fat',
        cur: this.fatCur(), goal: this.fatGoal(), over: false, radius: this.RADII[2] },
    ];
    return specs.map(s => {
      const circ = 2 * Math.PI * s.radius;
      // no goal => show a faint hint (5%); else clamp 0..1
      const frac = s.goal != null && s.goal > 0 ? Math.min(1, s.cur / s.goal) : (s.cur > 0 ? 0.05 : 0);
      return { ...s, circ, offset: circ * (1 - frac) };
    });
  });

  // ── macro chips / detail rows ───────────────────────────────────────────────
  protected readonly macros = computed(() => {
    const mk = (key: string, name: string, grams: number, goal: number | null, a: string, b: string) => ({
      key, name, grams, goal, a, b,
      pct: goal != null && goal > 0 ? Math.min(100, Math.round((grams / goal) * 100)) : (grams > 0 ? 6 : 0),
      aria: goal != null
        ? `${name} ${grams} of ${goal} grams`
        : `${name} ${grams} grams`,
    });
    return [
      mk('P', 'Protein', this.proCur(), this.proGoal(), 'var(--pro-a)', 'var(--pro-b)'),
      mk('C', 'Carbs', this.carbCur(), this.carbGoal(), 'var(--cal-b)', 'var(--cal-a)'),
      mk('F', 'Fat', this.fatCur(), this.fatGoal(), 'var(--move-b)', 'var(--move-a)'),
    ];
  });

  // ── full aria text equivalent for the whole hero ────────────────────────────
  protected readonly ariaLabel = computed(() => {
    const parts: string[] = [];
    const goal = this.calGoal();
    if (goal != null) {
      parts.push(`${group(this.calCur())} of ${group(goal)} kilocalories`);
      parts.push(this.calOver() ? `${group(this.calOverBy())} over goal` : `${group(this.calLeft() ?? 0)} remaining`);
    } else {
      parts.push(`${group(this.calCur())} kilocalories`);
    }
    // the three rings = the three macros
    const pg = this.proGoal();
    parts.push(pg != null ? `Protein ${this.proCur()} of ${pg} grams` : `Protein ${this.proCur()} grams`);
    const cg = this.carbGoal();
    parts.push(cg != null ? `Carbs ${this.carbCur()} of ${cg} grams` : `Carbs ${this.carbCur()} grams`);
    const fg = this.fatGoal();
    parts.push(fg != null ? `Fat ${this.fatCur()} of ${fg} grams` : `Fat ${this.fatCur()} grams`);
    return parts.join('. ') + '.';
  });

  constructor() {
    // count-up ticker: animate displayCal toward the real caloriesIn whenever it changes.
    effect(() => {
      const target = this.calCur();
      if (this.reduceMotion) { this.displayCal.set(target); return; }
      cancelAnimationFrame(this.raf);
      const from = this.displayCal();
      if (from === target) return;
      const start = performance.now();
      const DUR = 600;
      const tick = (now: number) => {
        const t = Math.min(1, (now - start) / DUR);
        // ease-out cubic
        const e = 1 - Math.pow(1 - t, 3);
        this.displayCal.set(Math.round(from + (target - from) * e));
        if (t < 1) this.raf = requestAnimationFrame(tick);
      };
      this.raf = requestAnimationFrame(tick);
    });
    this.destroyRef.onDestroy(() => cancelAnimationFrame(this.raf));
  }

  // ── face switching (view-transition gated by reduced-motion) ────────────────
  protected showMacros(): void { this.swap('macros'); }
  protected showRings(): void { this.swap('rings'); }

  private swap(next: HeroFace): void {
    if (this.face() === next) return;
    const apply = () => this.face.set(next); // model.set emits the implicit faceChange output
    const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
    if (!this.reduceMotion && typeof doc.startViewTransition === 'function') {
      doc.startViewTransition(() => apply());
    } else {
      apply();
    }
  }

  protected macroLeftText(grams: number, goal: number): string {
    const left = Math.max(0, goal - grams);
    return left > 0 ? `${left}g left` : 'goal met';
  }
}
