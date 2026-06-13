import { Component, ElementRef, OnDestroy, afterNextRender, effect, input, viewChild } from '@angular/core';
import * as echarts from 'echarts';
import type { EChartsOption } from 'echarts';

/**
 * AXON dark/neon ECharts base theme — applied as defaults to every chart so the
 * canvas reads as part of the dark observability console (transparent bg, mono
 * axes, dark glassy tooltip, neon categorical palette: Claude blue → Codex violet).
 * Per-series colors set by callers are preserved; this only fills in chrome.
 */
const AXON_CHART_BASE: EChartsOption = {
  backgroundColor: 'transparent',
  // Claude blue, Codex violet, then data accents (cyan, success, warn, error, lit blue/violet).
  color: ['#3d8bff', '#8b7cff', '#3fd8d0', '#3dd68c', '#f2b340', '#ff5c6c', '#5ba3ff', '#a99bff'],
  textStyle: { fontFamily: 'Inter, system-ui, sans-serif', color: '#9ba9bd' },
  title: { textStyle: { color: '#e6edf6', fontFamily: 'Inter, system-ui, sans-serif' } },
  legend: {
    textStyle: { color: '#9ba9bd', fontFamily: 'Inter, system-ui, sans-serif', fontSize: 12 },
    icon: 'roundRect',
    itemWidth: 10,
    itemHeight: 10,
    inactiveColor: '#5e6c82',
  },
  tooltip: {
    backgroundColor: 'rgba(16,21,32,0.86)',
    borderColor: '#33425a',
    borderWidth: 1,
    textStyle: { color: '#e6edf6', fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: 12 },
    extraCssText:
      'border-radius:8px; backdrop-filter:blur(14px); box-shadow:0 24px 60px -20px rgba(0,0,0,.8);',
    axisPointer: { type: 'line', lineStyle: { color: 'rgba(61,139,255,0.5)', type: 'dashed' } },
  },
};

/** Per-axis dark styling merged into every category/value axis on the chart. */
const AXON_AXIS = {
  axisLine: { lineStyle: { color: '#26303f' } },
  axisTick: { show: false },
  axisLabel: { color: '#5e6c82', fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: 11 },
  splitLine: { lineStyle: { color: 'rgba(28,37,51,0.7)', type: 'dashed' } },
} as const;

/** Deep-merge AXON dark defaults under the caller's option (caller wins on conflicts). */
function withAxonTheme(option: EChartsOption): EChartsOption {
  const themeAxis = (axis: unknown): unknown => {
    if (Array.isArray(axis)) return axis.map(a => ({ ...AXON_AXIS, ...(a as object) }));
    if (axis && typeof axis === 'object') return { ...AXON_AXIS, ...(axis as object) };
    return axis;
  };
  const merged: EChartsOption = {
    ...AXON_CHART_BASE,
    ...option,
    title: { ...AXON_CHART_BASE.title, ...(option.title as object) },
    legend: { ...AXON_CHART_BASE.legend, ...(option.legend as object) },
    tooltip: { ...AXON_CHART_BASE.tooltip, ...(option.tooltip as object) },
  };
  if (option.color) merged.color = option.color;
  if ('xAxis' in option && option.xAxis) merged.xAxis = themeAxis(option.xAxis) as EChartsOption['xAxis'];
  if ('yAxis' in option && option.yAxis) merged.yAxis = themeAxis(option.yAxis) as EChartsOption['yAxis'];
  return merged;
}

/** Thin wrapper around echarts.init — pass an [option] and it (re)renders + auto-resizes. */
@Component({
  selector: 'app-chart',
  standalone: true,
  template: `<div #host class="chart-host"></div>`,
  styles: `.chart-host { display: block; width: 100%; height: 100%; min-height: 300px; }`,
})
export class ChartComponent implements OnDestroy {
  readonly option = input.required<EChartsOption>();
  private host = viewChild.required<ElementRef<HTMLDivElement>>('host');
  private chart?: echarts.ECharts;
  private ro?: ResizeObserver;
  private rafId = 0;

  constructor() {
    afterNextRender(() => {
      this.chart = echarts.init(this.host().nativeElement, undefined, { renderer: 'canvas' });
      this.chart.setOption(withAxonTheme(this.option()));
      // Defer resize to the next frame so echarts' own layout change doesn't
      // re-trigger the observer synchronously ("ResizeObserver loop" errors).
      this.ro = new ResizeObserver(() => {
        if (this.rafId) cancelAnimationFrame(this.rafId);
        this.rafId = requestAnimationFrame(() => this.chart?.resize());
      });
      this.ro.observe(this.host().nativeElement);
    });

    effect(() => {
      const opt = this.option();
      this.chart?.setOption(withAxonTheme(opt), true);
    });
  }

  ngOnDestroy(): void {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.ro?.disconnect();
    this.chart?.dispose();
  }
}
