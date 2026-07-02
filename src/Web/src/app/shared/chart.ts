import {
  Component,
  ElementRef,
  OnDestroy,
  afterNextRender,
  effect,
  inject,
  input,
  viewChild,
  ChangeDetectionStrategy,
} from '@angular/core';
import * as echarts from 'echarts/core';
import type { EChartsOption } from 'echarts';
import { LineChart, BarChart, PieChart, ScatterChart, HeatmapChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  TitleComponent,
  VisualMapComponent,
  CalendarComponent,
  MarkLineComponent,
  MarkPointComponent,
  MarkAreaComponent,
  DatasetComponent,
  DataZoomComponent,
  ToolboxComponent,
  GraphicComponent,
  AriaComponent,
} from 'echarts/components';
import { LabelLayout, UniversalTransition } from 'echarts/features';
import { CanvasRenderer } from 'echarts/renderers';

import { ThemeService } from '../core/theme';

// Tree-shaken ECharts registration (replaces the whole-library `import * as echarts from 'echarts'`).
// EXHAUSTIVE list of what the app's chart options actually use, enumerated from a full grep of
// src/app for every series `type:` and every component-mapping option key. Series: line, bar, pie,
// scatter, heatmap. Components: grid (xAxis/yAxis), tooltip, legend, title, visualMap, calendar,
// markLine. The rest (markPoint/markArea/dataset/dataZoom/toolbox/graphic/aria + label/transition
// features) are included defensively — each costs ~1KB but a MISSING one breaks a chart silently at
// runtime. If a NEW chart introduces a series/component not listed here, add it or that chart renders blank.
echarts.use([
  LineChart,
  BarChart,
  PieChart,
  ScatterChart,
  HeatmapChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  TitleComponent,
  VisualMapComponent,
  CalendarComponent,
  MarkLineComponent,
  MarkPointComponent,
  MarkAreaComponent,
  DatasetComponent,
  DataZoomComponent,
  ToolboxComponent,
  GraphicComponent,
  AriaComponent,
  LabelLayout,
  UniversalTransition,
  CanvasRenderer,
]);

/**
 * The categorical series palette — FiMobile-flavored: accent blue, violet, cyan, green, amber, red,
 * then lit blue/teal. These saturated hues read on BOTH the dark console and a light canvas, so the
 * palette is shared; only the chrome (axes, labels, tooltip, grid) flips with the theme below.
 * The FIRST two entries are overridden at render time with the live scheme accent (see seriesColors()),
 * so charts recolor with the active FiMobile color scheme.
 */
const SERIES_COLORS = ['#5b8cff', '#9b7bff', '#57bdff', '#34d399', '#ffc24d', '#ff5b78', '#f472b6', '#2ec5d3'];

/** Read a CSS custom property off <html> at render time (empty string if unavailable / SSR). */
function cssVar(name: string): string {
  if (typeof document === 'undefined' || typeof getComputedStyle === 'undefined') return '';
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/**
 * The series palette with entries 0/1 swapped for the LIVE scheme accent + secondary, so every chart's
 * primary series follows the active FiMobile color scheme. Falls back to the static hues off-DOM.
 */
function seriesColors(): string[] {
  const accent = cssVar('--tech-accent');
  const accent2 = cssVar('--tech-accent-2');
  const palette = [...SERIES_COLORS];
  if (accent) palette[0] = accent;
  if (accent2) palette[1] = accent2;
  return palette;
}

/** Per-theme chrome colors (everything that must contrast with the surface, not the series). */
interface ChartChrome {
  text: string; // legend / general text
  title: string; // chart title
  inactive: string; // dimmed legend item
  axisLine: string;
  axisLabel: string;
  splitLine: string;
  tooltipBg: string;
  tooltipBorder: string;
  tooltipText: string;
  tooltipShadow: string;
  pointer: string;
}

const DARK_CHROME: ChartChrome = {
  text: '#9fb0cc',
  title: '#e9eefb',
  inactive: '#5d6c88',
  axisLine: 'rgba(255,255,255,0.14)',
  axisLabel: '#7d8ea8',
  splitLine: 'rgba(255,255,255,0.07)',
  tooltipBg: 'rgba(14,28,56,0.9)',
  tooltipBorder: 'rgba(127,165,255,0.4)',
  tooltipText: '#e9eefb',
  tooltipShadow: '0 24px 60px -20px rgba(0,0,0,.72)',
  pointer: 'rgba(91,140,255,0.5)',
};

const LIGHT_CHROME: ChartChrome = {
  text: '#4a5a76',
  title: '#0e1830',
  inactive: '#9aa7be',
  axisLine: '#dadff6',
  axisLabel: '#66748f',
  splitLine: 'rgba(9,24,64,0.08)',
  tooltipBg: 'rgba(255,255,255,0.94)',
  tooltipBorder: '#c7d0ea',
  tooltipText: '#0e1830',
  tooltipShadow: '0 24px 56px -22px rgba(20,40,90,.28)',
  pointer: 'rgba(42,79,214,0.45)',
};

/** Read the live theme off <html data-theme> (set by the no-flash bootstrap + ThemeService). */
function currentChrome(): ChartChrome {
  const t =
    typeof document !== 'undefined' ? document.documentElement.dataset['theme'] : undefined;
  return t === 'light' ? LIGHT_CHROME : DARK_CHROME;
}

/** Build the base option (legend/tooltip/title chrome) for the given theme. */
function chartBase(c: ChartChrome): EChartsOption {
  return {
    backgroundColor: 'transparent',
    color: seriesColors(),
    textStyle: { fontFamily: 'Inter, system-ui, sans-serif', color: c.text },
    title: { textStyle: { color: c.title, fontFamily: 'Inter, system-ui, sans-serif' } },
    legend: {
      textStyle: { color: c.text, fontFamily: 'Inter, system-ui, sans-serif', fontSize: 12 },
      icon: 'roundRect',
      itemWidth: 10,
      itemHeight: 10,
      inactiveColor: c.inactive,
    },
    tooltip: {
      backgroundColor: c.tooltipBg,
      borderColor: c.tooltipBorder,
      borderWidth: 1,
      textStyle: {
        color: c.tooltipText,
        fontFamily: 'JetBrains Mono, ui-monospace, monospace',
        fontSize: 12,
      },
      extraCssText: `border-radius:8px; backdrop-filter:blur(14px); box-shadow:${c.tooltipShadow};`,
      axisPointer: { type: 'line', lineStyle: { color: c.pointer, type: 'dashed' } },
    },
  };
}

/** Per-axis styling merged into every category/value axis, themed by the active chrome. */
function chartAxis(c: ChartChrome) {
  return {
    axisLine: { lineStyle: { color: c.axisLine } },
    axisTick: { show: false },
    axisLabel: {
      color: c.axisLabel,
      fontFamily: 'JetBrains Mono, ui-monospace, monospace',
      fontSize: 11,
    },
    splitLine: { lineStyle: { color: c.splitLine, type: 'dashed' } },
  };
}

/** Deep-merge AXON theme defaults (resolved for the CURRENT theme) under the caller's option. */
function withAxonTheme(option: EChartsOption): EChartsOption {
  const c = currentChrome();
  const base = chartBase(c);
  const axisDefaults = chartAxis(c);
  const themeAxis = (axis: unknown): unknown => {
    if (Array.isArray(axis)) return axis.map((a) => ({ ...axisDefaults, ...(a as object) }));
    if (axis && typeof axis === 'object') return { ...axisDefaults, ...(axis as object) };
    return axis;
  };
  const merged: EChartsOption = {
    ...base,
    ...option,
    title: { ...base.title, ...(option.title as object) },
    legend: { ...base.legend, ...(option.legend as object) },
    tooltip: { ...base.tooltip, ...(option.tooltip as object) },
  };
  if (option.color) merged.color = option.color;
  if ('xAxis' in option && option.xAxis)
    merged.xAxis = themeAxis(option.xAxis) as EChartsOption['xAxis'];
  if ('yAxis' in option && option.yAxis)
    merged.yAxis = themeAxis(option.yAxis) as EChartsOption['yAxis'];
  return merged;
}

/** Thin wrapper around echarts.init — pass an [option] and it (re)renders + auto-resizes. */
@Component({
  selector: 'app-chart',
  standalone: true,
  template: `<div #host class="chart-host"></div>`,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: `
    .chart-host {
      display: block;
      width: 100%;
      height: 100%;
      min-height: 300px;
    }
  `,
})
export class ChartComponent implements OnDestroy {
  readonly option = input.required<EChartsOption>();
  private host = viewChild.required<ElementRef<HTMLDivElement>>('host');
  private chart?: echarts.ECharts;
  private ro?: ResizeObserver;
  private rafId = 0;
  private lastOption?: EChartsOption;
  private readonly theme = inject(ThemeService);

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

    // Re-apply on either a new [option] OR a live theme switch: reading theme.resolved()/scheme()
    // registers the effect as a dependency, so toggling light/dark or picking a scheme re-themes every
    // mounted chart's axes/tooltip/labels. A pure theme/scheme change only touches chrome + the two
    // accent series colors, so it merges (notMerge=false) a cheap recolor instead of tearing down and
    // rebuilding the full option; a genuine [option] input change still does the notMerge=true replace.
    effect(() => {
      const opt = this.option();
      this.theme.resolved();
      this.theme.scheme();
      const optionChanged = opt !== this.lastOption;
      this.lastOption = opt;
      this.chart?.setOption(withAxonTheme(opt), optionChanged);
    });
  }

  ngOnDestroy(): void {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.ro?.disconnect();
    this.chart?.dispose();
  }
}
