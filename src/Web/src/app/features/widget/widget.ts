import { CommonModule } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { timer, switchMap, catchError, of } from 'rxjs';

import { Api } from '../../core/api';
import { SummaryResponse } from '../../core/models';
import { timeAgo } from '../../shared/format';

/**
 * Compact, chrome-less stats widget for one source (company), meant to be opened in a small
 * pop-out window and screen-shared/captured. Shows a per-model card (cost, IN/OUT, calls) and
 * refreshes whenever a sync lands.
 */
@Component({
  selector: 'app-widget',
  imports: [CommonModule],
  templateUrl: './widget.html',
  styleUrl: './widget.scss',
})
export class Widget {
  private api = inject(Api);
  private route = inject(ActivatedRoute);

  readonly source = signal('');
  readonly summary = signal<SummaryResponse | null>(null);
  readonly loading = signal(true);
  readonly error = signal(false);
  readonly lastSync = signal<string | null>(null);
  private readonly now = signal(Date.now());
  private lastSeen: string | null | undefined;

  readonly models = computed(() =>
    (this.summary()?.buckets ?? [])
      .filter(b => b.totalTokens > 0 || b.costUsd > 0)
      .sort((a, b) => b.costUsd - a.costUsd));

  readonly total = computed(() => this.summary()?.total ?? null);

  readonly label = computed(() => {
    const s = this.source().toLowerCase();
    if (s.includes('claude')) return 'Claude';
    if (s.includes('codex')) return 'Codex';
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : '—';
  });

  readonly companyColor = computed(() => this.source().toLowerCase().includes('codex') ? '#3dd68c' : '#3d8bff');

  readonly syncLabel = computed(() => {
    const ls = this.lastSync();
    return ls ? `synced ${timeAgo(ls, this.now())}` : 'not synced yet';
  });

  constructor() {
    this.route.paramMap.pipe(takeUntilDestroyed()).subscribe(p => {
      this.source.set(p.get('source') ?? '');
      this.reload();
    });

    // Refresh on each sync: poll the (log-excluded) status endpoint and reload when it changes.
    timer(0, 15000)
      .pipe(switchMap(() => this.api.syncStatus().pipe(catchError(() => of(null)))), takeUntilDestroyed())
      .subscribe(s => {
        this.now.set(Date.now());
        if (s && s.lastSyncUtc !== this.lastSeen) {
          this.lastSeen = s.lastSyncUtc;
          this.lastSync.set(s.lastSyncUtc);
          this.reload();
        }
      });
  }

  private reload(): void {
    const src = this.source();
    if (!src) return;
    this.api
      .summary({ from: null, to: null, projectIds: [], models: [], sources: [src], machine: [], includeSidechain: true }, 'model')
      .subscribe({
        next: r => { this.summary.set(r); this.error.set(false); this.loading.set(false); },
        error: () => { this.error.set(true); this.loading.set(false); },
      });
  }

  /** input-side tokens (everything that isn't output) — matches the big "IN" figure people expect. */
  inTokens(b: { totalTokens: number; outputTokens: number }): number {
    return Math.max(0, b.totalTokens - b.outputTokens);
  }

  modelColor(model: string): string {
    const m = model.toLowerCase();
    if (m.includes('opus')) return '#f2b340';
    if (m.includes('sonnet')) return '#8b7cff';
    if (m.includes('haiku')) return '#5aa9ff';
    if (m.includes('fable')) return '#f472b6';
    if (m.includes('codex') || m.includes('gpt')) return '#3dd68c';
    return '#3fd8d0';
  }

  prettyModel(model: string): string {
    if (model.startsWith('<')) return model.replace(/[<>]/g, '');
    const noDate = model.replace(/-\d{8}$/, '');           // strip date suffix
    const p = noDate.split('-');
    const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
    if (p[0] === 'claude') {
      const fam = cap(p[1] ?? '');
      const ver = p.slice(2).join('.');
      return ver ? `${fam} ${ver}` : fam;
    }
    if (p[0] === 'gpt') {
      const ver = p[1] ?? '';
      const extra = p.slice(2).map(cap).join(' ');
      return `GPT-${ver}${extra ? ' ' + extra : ''}`;
    }
    return p.map(cap).join(' ');
  }
}
