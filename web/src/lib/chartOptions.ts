/**
 * Shared ECharts option builders — every chapter chart should go through
 * makeLineOption() (or at least baseAxis/baseTooltip) so the whole site keeps
 * one consistent chart style: crosshair tooltip, x dataZoom (inside + slider),
 * toolbox with dataZoom/restore/saveAsImage, restrained axis styling.
 *
 * All colors come from lib/theme.ts tokens (NOT CSS variables — the canvas
 * cannot resolve them). Rebuild options on theme change with useChartTheme().
 */

import type { EChartsOption } from 'echarts';
import { getChartTheme, type ChartTheme } from './theme';

export interface LineSeriesSpec {
  name: string;
  /** y values, or [x, y] pairs */
  data: (number | null)[] | [number, number][];
  /** defaults to theme series palette by index */
  color?: string;
  type?: 'line' | 'scatter' | 'bar';
  /** staircase rendering, typical for per-cycle digital sequences */
  step?: 'start' | 'middle' | 'end';
  showSymbol?: boolean;
  symbolSize?: number;
  width?: number;
  dashed?: boolean;
  /** subtle area fill under the line */
  area?: boolean;
  yAxisIndex?: number;
}

export interface MakeLineOptionArgs {
  title?: string;
  xLabel?: string;
  yLabel?: string;
  series: LineSeriesSpec[];
  /** 'value' (default) or 'category' with `categories` */
  xType?: 'value' | 'category';
  categories?: string[];
  xTickFormatter?: (v: number) => string;
  yTickFormatter?: (v: number) => string;
  /** x dataZoom inside+slider; default true */
  zoom?: boolean;
  /** toolbox (dataZoom / restore / saveAsImage); default true */
  toolbox?: boolean;
  /** default: series.length > 1 */
  legend?: boolean;
  xMin?: number | 'dataMin';
  xMax?: number | 'dataMax';
  yMin?: number | 'dataMin';
  yMax?: number | 'dataMax';
  /** extra top-level option entries, shallow-merged last (escape hatch) */
  extra?: Record<string, unknown>;
}

/** Consistent axis styling. Exported for custom (non-line) charts. */
export function baseAxis(
  t: ChartTheme,
  name?: string,
  formatter?: (v: number) => string,
): Record<string, unknown> {
  return {
    ...(name ? { name, nameLocation: 'middle', nameGap: 28 } : {}),
    nameTextStyle: { color: t.textSubtle, fontSize: 12 },
    axisLine: { show: true, lineStyle: { color: t.axisLine } },
    axisTick: { lineStyle: { color: t.axisLine } },
    axisLabel: { color: t.textSubtle, fontSize: 11, ...(formatter ? { formatter } : {}) },
    splitLine: { show: true, lineStyle: { color: t.splitLine } },
  };
}

/** Consistent crosshair tooltip. Exported for custom charts. */
export function baseTooltip(t: ChartTheme): Record<string, unknown> {
  return {
    trigger: 'axis',
    axisPointer: { type: 'cross', label: { backgroundColor: t.accent } },
    backgroundColor: t.tooltipBg,
    borderColor: t.tooltipBorder,
    textStyle: { color: t.tooltipText, fontSize: 12 },
  };
}

export function makeLineOption(args: MakeLineOptionArgs): EChartsOption {
  const t = getChartTheme();
  const {
    title,
    xLabel,
    yLabel,
    series,
    xType = 'value',
    categories,
    xTickFormatter,
    yTickFormatter,
    zoom = true,
    toolbox = true,
    legend = series.length > 1,
    xMin,
    xMax,
    yMin,
    yMax,
    extra,
  } = args;

  const option: Record<string, unknown> = {
    animation: false,
    backgroundColor: t.background,
    textStyle: { color: t.text },
    ...(title
      ? { title: { text: title, left: 8, top: 4, textStyle: { color: t.text, fontSize: 13, fontWeight: 600 } } }
      : {}),
    ...(legend
      ? { legend: { top: 4, right: toolbox ? 110 : 8, textStyle: { color: t.text, fontSize: 12 } } }
      : {}),
    grid: {
      left: 60,
      right: 24,
      top: title || legend ? 40 : 20,
      bottom: zoom ? 60 : 40,
    },
    tooltip: baseTooltip(t),
    xAxis: {
      type: xType,
      ...(xType === 'category' && categories ? { data: categories } : {}),
      ...(xMin !== undefined ? { min: xMin } : {}),
      ...(xMax !== undefined ? { max: xMax } : {}),
      ...baseAxis(t, xLabel, xTickFormatter),
    },
    yAxis: {
      type: 'value',
      ...(yMin !== undefined ? { min: yMin } : {}),
      ...(yMax !== undefined ? { max: yMax } : {}),
      ...baseAxis(t, yLabel, yTickFormatter),
      ...(yLabel ? { nameLocation: 'middle', nameGap: 42 } : {}),
    },
    ...(zoom
      ? {
          dataZoom: [
            { type: 'inside', xAxisIndex: 0 },
            {
              type: 'slider',
              xAxisIndex: 0,
              height: 18,
              bottom: 8,
              borderColor: t.splitLine,
              fillerColor:
                t.mode === 'dark' ? 'rgba(110, 163, 232, 0.18)' : 'rgba(44, 95, 168, 0.12)',
              handleStyle: { color: t.accent },
              textStyle: { color: t.textSubtle, fontSize: 10 },
            },
          ],
        }
      : {}),
    ...(toolbox
      ? {
          toolbox: {
            right: 8,
            top: 2,
            itemSize: 13,
            iconStyle: { borderColor: t.textSubtle },
            emphasis: { iconStyle: { borderColor: t.accent } },
            feature: {
              dataZoom: { yAxisIndex: 'none' },
              restore: {},
              saveAsImage: { backgroundColor: t.mode === 'dark' ? '#14171c' : '#ffffff' },
            },
          },
        }
      : {}),
    series: series.map((s, i) => ({
      name: s.name,
      type: s.type ?? 'line',
      data: s.data,
      ...(s.yAxisIndex !== undefined ? { yAxisIndex: s.yAxisIndex } : {}),
      ...(s.step ? { step: s.step } : {}),
      showSymbol: s.showSymbol ?? false,
      ...(s.symbolSize !== undefined ? { symbolSize: s.symbolSize } : {}),
      itemStyle: { color: s.color ?? t.series[i % t.series.length] },
      lineStyle: {
        color: s.color ?? t.series[i % t.series.length],
        width: s.width ?? 1.6,
        ...(s.dashed ? { type: 'dashed' } : {}),
      },
      ...(s.area
        ? { areaStyle: { opacity: 0.08, color: s.color ?? t.series[i % t.series.length] } }
        : {}),
      emphasis: { focus: 'series' },
    })),
    ...(extra ?? {}),
  };

  return option as unknown as EChartsOption;
}

/**
 * Horizontal/vertical reference line helper: returns a markLine config to put
 * on a series (e.g. half-LSB bounds). Usage:
 *   { ...seriesSpec, } then merge via `extra` or post-process the option.
 */
export function makeMarkLine(
  values: { y?: number; x?: number; label?: string; color?: string }[],
): Record<string, unknown> {
  const t = getChartTheme();
  return {
    silent: true,
    symbol: 'none',
    lineStyle: { color: t.textSubtle, type: 'dashed', width: 1 },
    label: { color: t.textSubtle, fontSize: 10, position: 'insideEndTop' },
    data: values.map((v) => ({
      ...(v.y !== undefined ? { yAxis: v.y } : {}),
      ...(v.x !== undefined ? { xAxis: v.x } : {}),
      ...(v.label ? { label: { formatter: v.label } } : {}),
      ...(v.color ? { lineStyle: { color: v.color } } : {}),
    })),
  };
}
