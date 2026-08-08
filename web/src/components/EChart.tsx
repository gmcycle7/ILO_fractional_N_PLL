/**
 * ECharts wrapper. Handles: init/dispose lifecycle, resize (ResizeObserver),
 * light/dark theme switching (re-init with a registered echarts theme on
 * data-theme change), group sync via echarts.connect, event binding.
 *
 * Build `option` with makeLineOption() from lib/chartOptions.ts and rebuild
 * it on theme change with useChartTheme() so explicit colors track the theme.
 */

import { useEffect, useRef } from 'react';
import * as echarts from 'echarts';
import { CHART_THEMES, getThemeMode, subscribeTheme, type ChartTheme } from '../lib/theme';
import type { EChartsOption } from 'echarts';

type EChartsInstance = ReturnType<typeof echarts.init>;

export interface EChartProps {
  option: EChartsOption;
  /** px number or CSS height string; default 320 */
  height?: number | string;
  /** echarts.connect group id for synchronized zoom/tooltip across charts */
  group?: string;
  /** event name -> handler, e.g. { click: (params) => ... } */
  onEvents?: Record<string, (params: unknown) => void>;
  className?: string;
}

function toEChartsThemeSpec(t: ChartTheme): Record<string, unknown> {
  return {
    color: t.series,
    backgroundColor: t.background,
    textStyle: { color: t.text },
    title: { textStyle: { color: t.text }, subtextStyle: { color: t.textSubtle } },
    legend: { textStyle: { color: t.text } },
  };
}

let themesRegistered = false;
function ensureThemesRegistered(): void {
  if (themesRegistered) return;
  echarts.registerTheme('ilo-light', toEChartsThemeSpec(CHART_THEMES.light));
  echarts.registerTheme('ilo-dark', toEChartsThemeSpec(CHART_THEMES.dark));
  themesRegistered = true;
}

export default function EChart({ option, height = 320, group, onEvents, className }: EChartProps) {
  const holderRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<EChartsInstance | null>(null);
  const optionRef = useRef(option);
  const eventsRef = useRef(onEvents);
  const groupRef = useRef(group);
  optionRef.current = option;
  eventsRef.current = onEvents;
  groupRef.current = group;

  // Mount: init chart; re-init on theme change; resize observer; dispose on unmount.
  useEffect(() => {
    const el = holderRef.current;
    if (!el) return;
    ensureThemesRegistered();

    const bindEvents = (chart: EChartsInstance) => {
      const events = eventsRef.current;
      if (!events) return;
      for (const [name, handler] of Object.entries(events)) {
        chart.on(name, handler as (params: unknown) => void);
      }
    };

    const create = (): EChartsInstance => {
      const chart = echarts.init(el, `ilo-${getThemeMode()}`);
      const g = groupRef.current;
      if (g) {
        chart.group = g;
        echarts.connect(g);
      }
      chart.setOption(optionRef.current, true);
      return chart;
    };

    chartRef.current = create();

    const resizeObserver = new ResizeObserver(() => {
      const chart = chartRef.current;
      if (chart && !chart.isDisposed()) chart.resize();
    });
    resizeObserver.observe(el);

    const unsubscribeTheme = subscribeTheme(() => {
      chartRef.current?.dispose();
      const chart = create();
      bindEvents(chart);
      chartRef.current = chart;
    });

    return () => {
      unsubscribeTheme();
      resizeObserver.disconnect();
      chartRef.current?.dispose();
      chartRef.current = null;
    };
  }, []);

  // Option updates (notMerge so removed series disappear deterministically).
  useEffect(() => {
    const chart = chartRef.current;
    if (chart && !chart.isDisposed()) chart.setOption(option, true);
  }, [option]);

  // Group updates.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || chart.isDisposed()) return;
    chart.group = group ?? '';
    if (group) echarts.connect(group);
  }, [group]);

  // Event binding (also covers initial mount; theme re-init rebinds itself).
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || chart.isDisposed() || !onEvents) return;
    for (const [name, handler] of Object.entries(onEvents)) {
      chart.on(name, handler as (params: unknown) => void);
    }
    return () => {
      const current = chartRef.current;
      if (!current || current.isDisposed()) return;
      for (const name of Object.keys(onEvents)) current.off(name);
    };
  }, [onEvents]);

  return (
    <div
      ref={holderRef}
      className={className ?? 'echart'}
      style={{ width: '100%', height }}
    />
  );
}
