import { CommonModule } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import type { EChartsOption } from 'echarts';

import { MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';

import { Api } from '../../core/api';
import { SessionDetail } from '../../core/models';
import { ChartComponent } from '../../shared/chart';
import { CompactPipe } from '../../shared/format';

@Component({
  selector: 'app-session-dialog',
  imports: [CommonModule, MatDialogModule, MatButtonModule, MatProgressBarModule, MatSnackBarModule, ChartComponent, CompactPipe],
  templateUrl: './session-dialog.html',
  styleUrl: './session-dialog.scss',
})
export class SessionDialog {
  private api = inject(Api);
  private snack = inject(MatSnackBar);
  readonly id = inject<{ sessionId: string }>(MAT_DIALOG_DATA).sessionId;

  readonly data = signal<SessionDetail | null>(null);
  readonly loading = signal(true);

  constructor() {
    this.api.session(this.id).subscribe({
      next: d => { this.data.set(d); this.loading.set(false); },
      // On error, leave data() null + loading() false so the template's @else error
      // block renders; the snackbar adds an explicit notice.
      error: () => {
        this.loading.set(false);
        this.snack.open('Could not load session detail.', 'Dismiss', { duration: 4000 });
      },
    });
  }

  durationMin(): number {
    const d = this.data();
    if (!d) return 0;
    return Math.round((new Date(d.endUtc).getTime() - new Date(d.startUtc).getTime()) / 60000);
  }

  readonly chart = computed<EChartsOption>(() => {
    const d = this.data();
    if (!d || !d.items.length) return {};
    let cum = 0;
    const points = d.items.map(m => { cum += m.cost; return [m.timestampUtc, +cum.toFixed(4)] as [string, number]; });
    return {
      tooltip: { trigger: 'axis', valueFormatter: v => '$' + Number(v).toFixed(2) },
      grid: { left: 60, right: 20, top: 16, bottom: 36 },
      xAxis: { type: 'time' },
      yAxis: { type: 'value', name: 'Cumulative $', axisLabel: { formatter: '${value}' } },
      series: [{
        type: 'line', step: 'end', symbol: 'none', data: points,
        areaStyle: { opacity: 0.14 }, itemStyle: { color: '#f472b6' }, lineStyle: { color: '#f472b6', width: 2 },
      }],
    };
  });
}
