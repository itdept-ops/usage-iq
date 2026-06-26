import { CommonModule } from '@angular/common';
import { Component, computed, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import type { EChartsOption } from 'echarts';

import { MatCardModule } from '@angular/material/card';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';

import { Api } from '../../core/api';
import {
  CalendarDay,
  HeatmapCell,
  SummaryBucket,
  UsageFilter,
  UsageStats,
} from '../../core/models';
import { ChartComponent } from '../../shared/chart';
import { SessionDialog } from './session-dialog';

type Metric = 'cost' | 'tokens' | 'hours';

@Component({
  selector: 'app-calendar',
  imports: [
    CommonModule,
    MatCardModule,
    MatButtonToggleModule,
    MatProgressBarModule,
    MatIconModule,
    MatButtonModule,
    MatDialogModule,
    ChartComponent,
  ],
  templateUrl: './calendar.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './calendar.scss',
})
export class Calendar {
  private api = inject(Api);
  private dialog = inject(MatDialog);

  readonly days = signal<CalendarDay[]>([]);
  readonly loading = signal(true);
  readonly metric = signal<Metric>('cost');

  readonly metrics = signal<UsageStats | null>(null);
  readonly heat = signal<HeatmapCell[]>([]);
  readonly sessions = signal<SummaryBucket[]>([]);

  private static readonly ALL: UsageFilter = {
    from: null,
    to: null,
    projectIds: [],
    models: [],
    sources: [],
    machine: [],
    includeSidechain: true,
  };

  constructor() {
    this.api.calendar().subscribe({
      next: (d) => {
        this.days.set(d);
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
    this.api.stats().subscribe({
      next: (s) => this.metrics.set(s),
      error: () => {
        /* non-critical */
      },
    });
    this.api.heatmap().subscribe({
      next: (h) => this.heat.set(h),
      error: () => {
        /* non-critical */
      },
    });
    this.api.summary(Calendar.ALL, 'session').subscribe({
      next: (r) => this.sessions.set(r.buckets.slice(0, 12)),
      error: () => {
        /* non-critical */
      },
    });
  }

  openSession(id: string): void {
    this.dialog.open(SessionDialog, {
      data: { sessionId: id },
      width: '680px',
      maxWidth: '94vw',
      maxHeight: '90dvh',
      panelClass: 'uiq-dialog',
      autoFocus: false,
    });
  }

  fmtHour(h: number | null | undefined): string {
    if (h == null || !Number.isFinite(h)) return '—';
    return `${String(h).padStart(2, '0')}:00`;
  }
  shortId(id: string): string {
    return id.length > 18 ? id.slice(0, 8) + '…' + id.slice(-6) : id;
  }

  readonly heatmapChart = computed<EChartsOption>(() => {
    const cells = this.heat();
    if (!cells.length)
      return {
        title: { text: 'No data', left: 'center', top: 'center', textStyle: { color: '#5e6c82' } },
      };
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const hours = Array.from({ length: 24 }, (_, h) => `${h}`);
    const max = Math.max(...cells.map((c) => c.count));
    return {
      tooltip: {
        formatter: (p: any) =>
          `${dayNames[p.value[1]]} ${this.fmtHour(p.value[0])}<br/>${p.value[2]} messages`,
      },
      grid: { left: 44, right: 16, top: 8, bottom: 58 },
      xAxis: {
        type: 'category',
        data: hours,
        splitArea: { show: true },
        axisLabel: {
          interval: 1,
          color: '#5e6c82',
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 10,
        },
      },
      yAxis: {
        type: 'category',
        data: dayNames,
        splitArea: { show: true },
        axisLabel: { color: '#7286a0', fontFamily: 'JetBrains Mono, monospace', fontSize: 11 },
      },
      visualMap: {
        min: 0,
        max,
        calculable: true,
        orient: 'horizontal',
        left: 'center',
        bottom: 6,
        itemWidth: 12,
        itemHeight: 120,
        textStyle: { color: '#7286a0', fontSize: 11 },
        inRange: { color: ['#15233a', '#1d4e7a', '#3d8bff', '#7c8bff', '#f472b6'] },
      },
      series: [
        {
          type: 'heatmap',
          data: cells.map((c) => [c.hour, c.day, c.count]),
          itemStyle: { borderColor: '#0b0f17', borderWidth: 1 },
          label: { show: false },
        },
      ],
    };
  });

  private value(d: CalendarDay, m: Metric): number {
    if (m === 'cost') return +d.costUsd.toFixed(2);
    if (m === 'tokens') return d.tokens;
    return +(d.activeMinutes / 60).toFixed(2);
  }

  // ---- summary stats ----
  readonly stats = computed(() => {
    const ds = this.days();
    const active = ds.filter((d) => d.messages > 0);
    const totalMin = ds.reduce((a, d) => a + d.activeMinutes, 0);
    const totalCost = ds.reduce((a, d) => a + d.costUsd, 0);
    const totalSessions = ds.reduce((a, d) => a + d.sessions, 0);
    const totalMsgs = ds.reduce((a, d) => a + d.messages, 0);
    const m = this.metric();
    const busiest = active.reduce<CalendarDay | null>(
      (b, d) => (!b || this.value(d, m) > this.value(b, m) ? d : b),
      null,
    );
    return {
      totalHours: totalMin / 60,
      activeDays: active.length,
      avgHoursPerDay: active.length ? totalMin / 60 / active.length : 0,
      maxDayHours: active.reduce((mx, d) => Math.max(mx, d.activeMinutes / 60), 0),
      totalSessions,
      totalCost,
      totalMsgs,
      busiest,
    };
  });

  private readonly years = computed(() =>
    [...new Set(this.days().map((d) => d.date.slice(0, 4)))].sort(),
  );

  readonly wrapHeight = computed(() => Math.max(1, this.years().length) * 165 + 70);

  private short(n: number): string {
    if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return `${n}`;
  }

  readonly chart = computed<EChartsOption>(() => {
    const ds = this.days();
    const m = this.metric();
    if (!ds.length)
      return {
        title: { text: 'No data', left: 'center', top: 'center', textStyle: { color: '#5e6c82' } },
      };

    const byDate = new Map(ds.map((d) => [d.date, d]));
    const years = this.years();
    const maxVal = Math.max(...ds.map((d) => this.value(d, m)), 1);

    const calendars = years.map((y, i) => ({
      top: 40 + i * 155,
      left: 60,
      right: 30,
      cellSize: ['auto', 15] as ('auto' | number)[],
      range: y,
      itemStyle: { color: 'transparent', borderColor: '#1c2533', borderWidth: 2 },
      splitLine: { lineStyle: { color: '#33425a', width: 1 } },
      yearLabel: {
        show: true,
        color: '#9ba9bd',
        fontFamily: 'JetBrains Mono, monospace',
        margin: 42,
      },
      monthLabel: { color: '#7286a0', fontFamily: 'JetBrains Mono, monospace' },
      dayLabel: { color: '#5e6c82', fontFamily: 'JetBrains Mono, monospace', firstDay: 0 },
    }));

    const series = years.map((y, i) => ({
      type: 'heatmap' as const,
      coordinateSystem: 'calendar' as const,
      calendarIndex: i,
      data: ds.filter((d) => d.date.startsWith(y)).map((d) => [d.date, this.value(d, m)]),
    }));

    const unit = m === 'cost' ? '$' : m === 'hours' ? 'h' : '';
    return {
      tooltip: {
        formatter: (p: any) => {
          const d = byDate.get(p.value[0]);
          if (!d) return p.value[0];
          return (
            `<b>${d.date}</b><br/>$${d.costUsd.toFixed(2)} · ${this.short(d.tokens)} tokens<br/>` +
            `${(d.activeMinutes / 60).toFixed(1)}h active · ${d.messages} msgs · ${d.sessions} sessions`
          );
        },
      },
      visualMap: {
        min: 0,
        max: +maxVal.toFixed(2),
        calculable: true,
        orient: 'horizontal',
        left: 'center',
        top: 6,
        itemWidth: 12,
        itemHeight: 120,
        text: [
          `${unit}${m === 'tokens' ? this.short(maxVal) : maxVal.toFixed(m === 'cost' ? 0 : 1)}`,
          '0',
        ],
        textStyle: { color: '#7286a0', fontFamily: 'JetBrains Mono, monospace', fontSize: 11 },
        inRange: { color: ['#15233a', '#1d4e7a', '#3d8bff', '#7c8bff', '#f472b6'] },
      },
      calendar: calendars,
      series,
    };
  });
}
