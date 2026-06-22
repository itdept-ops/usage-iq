import { Component, computed, inject, input, signal } from '@angular/core';
import type { EChartsOption } from 'echarts';
import { firstValueFrom } from 'rxjs';

import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar } from '@angular/material/snack-bar';

import { Api } from '../../core/api';
import { AuthService } from '../../core/auth';
import { PERM, WeightPointDto } from '../../core/models';
import { ChartComponent } from '../../shared/chart';
import { kgToLb, weightUnit } from './units';

/**
 * Weight-over-time trend (ECharts line) for the tracker dashboard. Points come from
 * GET /api/tracker/weight (metric kg, oldest-first); the chart converts to the chosen display unit and
 * draws an optional goal-weight reference line. Shows an empty state when there are no entries.
 */
@Component({
  selector: 'app-weight-trend',
  imports: [ChartComponent, MatButtonModule, MatIconModule, MatProgressSpinnerModule],
  template: `
    @if (points().length > 0) {
      <div class="wt-chart-host" role="img" [attr.aria-label]="ariaLabel()">
        <app-chart class="wt-chart" [option]="option()" />
      </div>

      <!-- ✨ AI weight insight — hidden unless the user holds tracker.ai. -->
      @if (showAi) {
        <div class="wt-ai">
          @if (insight(); as ins) {
            <div class="wt-ai-card" role="group" aria-label="AI weight insight">
              <p class="wt-ai-trend"><mat-icon aria-hidden="true">{{ trendIcon() }}</mat-icon> {{ ins.trend }}</p>
              <p class="wt-ai-text">{{ ins.insight }}</p>
            </div>
          } @else {
            <button mat-stroked-button type="button" class="wt-ai-btn"
                    [disabled]="insightLoading()" (click)="loadInsight()"
                    aria-label="Get an AI insight on your weight trend">
              @if (insightLoading()) {
                <mat-progress-spinner mode="indeterminate" diameter="18" aria-hidden="true" />
                Reading your trend…
              } @else {
                <span class="wt-ai-btn-label"><mat-icon aria-hidden="true">auto_awesome</mat-icon> Weight insight</span>
              }
            </button>
          }
          <span class="wt-sr-status" role="status" aria-live="polite">{{ aiAnnounce() }}</span>
        </div>
      }
    } @else {
      <div class="wt-empty">
        <p>No weight logged yet.</p>
        <p class="wt-empty-sub">Use “Log weight” to start your trend.</p>
      </div>
    }
  `,
  styles: `
    .wt-chart-host { display: block; width: 100%; height: 240px; min-height: 240px; overflow: hidden; }
    .wt-chart { display: block; width: 100%; height: 100%; min-height: 240px; }
    /* The shared chart's inner host floors at 300px; override it so the canvas fits the 240px we allot. */
    .wt-chart ::ng-deep .chart-host { min-height: 0 !important; }
    .wt-empty { display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: 2px; min-height: 180px; color: var(--tech-text-tertiary); }
    .wt-empty p { margin: 0; font-size: var(--tech-fs-body); }
    .wt-empty-sub { font-size: var(--tech-fs-label) !important; }

    .wt-ai { position: relative; margin-top: var(--tech-space-2); }
    .wt-ai-btn {
      min-height: 44px; border-radius: var(--tech-r-control); font-weight: 600;
      display: inline-flex; align-items: center; gap: 6px;
      mat-icon { color: var(--tech-accent); font-size: 18px; width: 18px; height: 18px; }
      mat-progress-spinner { display: inline-block; }
      .wt-ai-btn-label { display: inline-flex; align-items: center; gap: 6px; }
    }
    .wt-ai-card {
      display: flex; flex-direction: column; gap: 2px;
      padding: var(--tech-space-3); border: 1px solid var(--tech-border);
      border-radius: var(--tech-r-control); background: var(--tech-bg-sunken);
    }
    .wt-ai-trend {
      display: flex; align-items: center; gap: 6px; margin: 0;
      font-weight: 700; font-size: var(--tech-fs-body); color: var(--tech-text);
      mat-icon { color: var(--tech-accent); font-size: 18px; width: 18px; height: 18px; }
    }
    .wt-ai-text { margin: 0; font-size: var(--tech-fs-label); color: var(--tech-text-secondary); }
    .wt-sr-status {
      position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; border: 0;
      overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap;
    }
  `,
})
export class WeightTrend {
  private api = inject(Api);
  private auth = inject(AuthService);
  private snack = inject(MatSnackBar);

  readonly points = input.required<WeightPointDto[]>();
  /** Goal weight in kg (metric), or null for no reference line. */
  readonly goalWeightKg = input<number | null | undefined>(null);
  readonly imperial = input<boolean>(false);

  /** Gate: the AI weight-insight affordance is hidden unless the user holds tracker.ai. */
  readonly showAi = this.auth.hasPermission(PERM.trackerAi);

  // ---- AI weight insight (GET /api/ai/weight-insight; reads the caller's own weight stats) ----
  /** The fetched insight (read of the morning/evening delta + trend), or null until loaded. */
  readonly insight = signal<{ insight: string; trend: string } | null>(null);
  /** True while weight-insight is in flight. */
  readonly insightLoading = signal(false);
  /** Polite sr-only announcement of the insight (or its unavailability). */
  readonly aiAnnounce = signal('');

  /** A trend-appropriate icon from the model's free-text trend label (best-effort). */
  readonly trendIcon = computed(() => {
    const t = (this.insight()?.trend ?? '').toLowerCase();
    if (t.includes('up') || t.includes('gain') || t.includes('ris')) return 'trending_up';
    if (t.includes('down') || t.includes('loss') || t.includes('los') || t.includes('fall')) return 'trending_down';
    return 'trending_flat';
  });

  /**
   * Fetch the AI read of the caller's weight trend (morning/evening delta + trend) and show it as a small
   * card. A 503/unavailable leaves the card hidden and shows a snackbar — the chart stays fully usable.
   */
  async loadInsight(): Promise<void> {
    if (this.insightLoading()) return;
    this.insightLoading.set(true);
    this.aiAnnounce.set('Reading your weight trend with AI…');
    try {
      const res = await firstValueFrom(this.api.weightInsight());
      this.insight.set({ insight: res.insight, trend: res.trend });
      this.aiAnnounce.set(`Weight trend: ${res.trend}. ${res.insight}`);
    } catch {
      this.insight.set(null);
      this.aiAnnounce.set('AI weight insight unavailable.');
      this.snack.open('AI insight unavailable — try again later', 'OK', { duration: 4000 });
    } finally {
      this.insightLoading.set(false);
    }
  }

  private readonly unit = computed(() => (this.imperial() ? 'lb' : 'kg'));

  /** Honor the OS "reduce motion" setting — disable chart animation/curve easing when set. */
  private readonly reduceMotion =
    typeof window !== 'undefined' &&
    !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  private toDisp(kg: number): number {
    return this.imperial() ? Math.round(kgToLb(kg) * 10) / 10 : Math.round(kg * 10) / 10;
  }

  /**
   * Visually-hidden text equivalent of the populated chart for screen readers: latest weight, the
   * change across the window, the entry count, and the goal weight (which also covers the goal
   * reference line conveyed only by colour/position in the canvas). Mirrors the user's display units.
   */
  readonly ariaLabel = computed(() => {
    const pts = this.points();
    const unit = weightUnit(this.imperial());
    const n = pts.length;
    const latest = this.toDisp(pts[n - 1].weightKg);
    const first = this.toDisp(pts[0].weightKg);
    const delta = Math.round((latest - first) * 10) / 10;
    const days = pts.length > 1 ? this.spanDays(pts[0].date, pts[n - 1].date) : 0;

    const parts = [`Weight trend. Latest ${latest} ${unit}.`];
    if (n > 1) {
      const dir = delta > 0 ? 'up' : delta < 0 ? 'down' : 'no change';
      const mag = Math.abs(delta);
      const change = delta === 0 ? 'no change' : `${dir} ${mag} ${unit}`;
      const over = days > 0 ? ` over ${days} day${days === 1 ? '' : 's'}` : '';
      parts.push(`${change}${over}.`);
    }
    parts.push(`${n} entr${n === 1 ? 'y' : 'ies'}.`);

    const goal = this.goalWeightKg();
    if (goal != null && goal > 0) parts.push(`Goal ${this.toDisp(goal)} ${unit}.`);

    return parts.join(' ');
  });

  /** Whole days between two `yyyy-MM-dd` dates (oldest → newest). */
  private spanDays(from: string, to: string): number {
    const a = new Date(from + 'T00:00:00').getTime();
    const b = new Date(to + 'T00:00:00').getTime();
    return Math.max(0, Math.round((b - a) / 86_400_000));
  }

  readonly option = computed<EChartsOption>(() => {
    const pts = this.points();
    const unit = this.unit();
    const dates = pts.map(p => p.date);
    const values = pts.map(p => this.toDisp(p.weightKg));
    const goal = this.goalWeightKg();
    const goalDisp = goal != null && goal > 0 ? this.toDisp(goal) : null;

    const reduceMotion = this.reduceMotion;

    return {
      animation: !reduceMotion,
      grid: { left: 48, right: 16, top: 16, bottom: 28 },
      tooltip: {
        trigger: 'axis',
        valueFormatter: (v) => (typeof v === 'number' ? `${v} ${unit}` : String(v)),
      },
      xAxis: {
        type: 'category',
        data: dates,
        boundaryGap: false,
        axisLabel: {
          formatter: (d: string) => {
            const dt = new Date(d + 'T00:00:00');
            return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
          },
        },
      },
      yAxis: {
        type: 'value',
        scale: true,
        axisLabel: { formatter: (v: number) => `${v}` },
      },
      series: [
        {
          type: 'line',
          name: `Weight (${unit})`,
          data: values,
          smooth: !reduceMotion,
          showSymbol: pts.length <= 60,
          symbolSize: 6,
          lineStyle: { width: 2 },
          areaStyle: { opacity: 0.12 },
          ...(goalDisp != null
            ? {
                markLine: {
                  silent: true,
                  symbol: 'none',
                  lineStyle: { color: '#3dd68c', type: 'dashed', width: 1.5 },
                  label: { formatter: `Goal ${goalDisp} ${unit}`, color: '#3dd68c', position: 'insideEndTop' },
                  data: [{ yAxis: goalDisp }],
                },
              }
            : {}),
        },
      ],
    };
  });
}
