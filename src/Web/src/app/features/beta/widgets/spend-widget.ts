import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { catchError, of } from 'rxjs';

import { Api } from '../../../core/api';
import { AuthService } from '../../../core/auth';
import { FinanceSummary, PERM } from '../../../core/models';
import { AtriumWidgetShell, WidgetPhase } from './widget-shell';
import { ReorderableWidget } from './reorderable';

/**
 * Atrium "Spend this month" widget — a big Clash Display month total, a 12-month SVG SPARKLINE of the
 * rolling spend trend (a real mini chart with an accent gradient stroke + soft area fill, never flat),
 * and the top-3 spending categories as mini-bars. Best-effort own subscription to
 * {@link Api.financeSummary} (catch → null). Gated on {@link PERM.familyFinance}; the endpoint 403s
 * without it, so the page auto-hides the card when the perm is missing.
 */
@Component({
  selector: 'atr-spend-widget',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AtriumWidgetShell],
  template: `
    <atr-widget-shell
      title="Spend this month" route="/beta/dashboard"
      accentA="#fb7185" accentB="#f0a35a"
      [phase]="phase()" emptyText="No spending recorded this month." emptyIcon="savings"
      [reordering]="reordering()"
      (retry)="reload()" (moveUp)="moveUp.emit()" (moveDown)="moveDown.emit()" (hide)="hide.emit()">

      @if (summary(); as s) {
        <div body class="sp">
          <div class="sp__top">
            <div class="sp__head">
              <span class="sp__total">{{ money(s.totalSpent) }}</span>
              <span class="sp__sub">{{ monthLabel(s.month) }}</span>
            </div>
            @if (spark(); as pts) {
              <svg class="sp__spark" viewBox="0 0 100 36" preserveAspectRatio="none"
                   role="img" aria-label="Monthly spend trend">
                <defs>
                  <linearGradient [attr.id]="gradId" x1="0" y1="0" x2="1" y2="0">
                    <stop offset="0" stop-color="#fb7185" />
                    <stop offset="1" stop-color="#f0a35a" />
                  </linearGradient>
                  <linearGradient [attr.id]="fillId" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" stop-color="#fb7185" stop-opacity="0.28" />
                    <stop offset="1" stop-color="#fb7185" stop-opacity="0" />
                  </linearGradient>
                </defs>
                <path [attr.d]="pts.area" [attr.fill]="'url(#' + fillId + ')'" />
                <path [attr.d]="pts.line" fill="none" [attr.stroke]="'url(#' + gradId + ')'"
                      stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
                <circle [attr.cx]="pts.lastX" [attr.cy]="pts.lastY" r="2.6" fill="#fb7185" />
              </svg>
            }
          </div>

          @if (topCategories().length) {
            <div class="sp__cats">
              @for (c of topCategories(); track c.category) {
                <div class="sp__cat">
                  <span class="sp__cat-name">{{ c.category }}</span>
                  <span class="sp__cat-bar"><i [style.width.%]="barPct(c.amount)"></i></span>
                  <span class="sp__cat-amt">{{ money(c.amount) }}</span>
                </div>
              }
            </div>
          }
        </div>
      }
    </atr-widget-shell>
  `,
  styles: [`
    .sp { display: flex; flex-direction: column; gap: 14px; }
    .sp__top { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; }
    .sp__head { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
    .sp__total {
      font-family: var(--font-display); font-variant-numeric: tabular-nums;
      font-weight: 600; font-size: 32px; letter-spacing: -.03em; color: var(--ink); line-height: 1;
    }
    .sp__sub { font-size: 11px; font-weight: 600; letter-spacing: .03em; text-transform: uppercase; color: var(--ink-dim); }
    .sp__spark { width: 108px; height: 38px; flex: 0 0 auto; }

    .sp__cats { display: flex; flex-direction: column; gap: 9px; }
    .sp__cat { display: grid; grid-template-columns: 84px 1fr auto; align-items: center; gap: 10px; }
    .sp__cat-name { font-size: 12px; font-weight: 600; color: var(--ink-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sp__cat-bar { height: 7px; border-radius: var(--r-pill); background: color-mix(in srgb, var(--ink) 8%, transparent); overflow: hidden; }
    .sp__cat-bar > i {
      display: block; height: 100%; border-radius: var(--r-pill);
      background: linear-gradient(90deg, #fb7185, #f0a35a);
      transition: width 600ms var(--ease-spring);
    }
    .sp__cat-amt { font-size: 12px; font-weight: 700; color: var(--ink); font-variant-numeric: tabular-nums; }
  `],
})
export class SpendWidget extends ReorderableWidget {
  private readonly api = inject(Api);
  private readonly auth = inject(AuthService);
  private readonly destroyRef = inject(DestroyRef);

  private readonly data = signal<FinanceSummary | null>(null);
  private readonly failed = signal(false);
  private readonly loadingState = signal(true);

  /** Unique gradient ids so this card's sparkline strokes/fills don't collide with another instance. */
  protected readonly gradId = `sp-line-${Math.random().toString(36).slice(2, 8)}`;
  protected readonly fillId = `sp-fill-${Math.random().toString(36).slice(2, 8)}`;

  /** Auto-hide unless the user holds family.finance. */
  readonly visible = computed(() => {
    this.auth.permissions();
    return this.auth.hasPermission(PERM.familyFinance);
  });

  readonly summary = this.data.asReadonly();

  /** Top-3 categories by amount desc. */
  readonly topCategories = computed(() =>
    [...(this.data()?.byCategory ?? [])].sort((a, b) => b.amount - a.amount).slice(0, 3));

  private readonly maxAmount = computed(() =>
    Math.max(1, ...this.topCategories().map(c => c.amount)));

  /** Build the sparkline path data from the rolling monthly-spend trend (≥2 points needed). */
  readonly spark = computed<{ line: string; area: string; lastX: number; lastY: number } | null>(() => {
    const trend = this.data()?.monthlyTrend ?? [];
    if (trend.length < 2) return null;
    const vals = trend.map(t => t.spent);
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const span = max - min || 1;
    const W = 100, H = 36, PAD = 3;
    const n = vals.length;
    const pts = vals.map((v, i) => {
      const x = n === 1 ? W / 2 : (i / (n - 1)) * W;
      const y = PAD + (1 - (v - min) / span) * (H - PAD * 2);
      return { x, y };
    });
    const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' ');
    const area = `${line} L${W} ${H} L0 ${H} Z`;
    const last = pts[pts.length - 1];
    return { line, area, lastX: last.x, lastY: last.y };
  });

  readonly phase = computed<WidgetPhase>(() => {
    if (this.loadingState()) return 'loading';
    if (this.failed()) return 'failed';
    const s = this.data();
    return s && (s.totalSpent > 0 || s.byCategory.length) ? 'ready' : 'empty';
  });

  barPct(amount: number): number {
    return Math.max(2, Math.round((amount / this.maxAmount()) * 100));
  }

  money(n: number): string {
    return n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  }

  /** "yyyy-MM" → "June 2026" for the subtitle. */
  monthLabel(month: string): string {
    const [y, m] = (month ?? '').split('-').map(Number);
    if (!y || !m) return 'This month';
    const d = new Date(y, m - 1, 1);
    return Number.isNaN(d.getTime()) ? 'This month'
      : d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  }

  constructor() {
    super();
    this.reload();
  }

  reload(): void {
    // Don't even hit the endpoint without the perm (it would 403); the page hides us anyway.
    if (!this.auth.hasPermission(PERM.familyFinance)) { this.loadingState.set(false); return; }
    this.loadingState.set(true);
    this.failed.set(false);
    this.api.financeSummary()
      .pipe(catchError(() => { this.failed.set(true); return of<FinanceSummary | null>(null); }), takeUntilDestroyed(this.destroyRef))
      .subscribe(s => {
        if (s) this.data.set(s);
        this.loadingState.set(false);
      });
  }
}
