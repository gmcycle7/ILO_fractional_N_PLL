/**
 * Chapter registry. The sidebar, top bar and router all derive from this
 * single list. Each chapter is lazily loaded (React.lazy in App.tsx).
 *
 * Content agents: replace the ChapterNN.tsx stub bodies, keep the default
 * export a React component and DO NOT change ids/slugs (they are URLs).
 */

import type { ComponentType } from 'react';

export interface ChapterMeta {
  id: number;
  slug: string;
  titleZh: string;
  titleEn: string;
  load: () => Promise<{ default: ComponentType }>;
}

export const CHAPTERS: ChapterMeta[] = [
  { id: 0, slug: 'executive-overview', titleZh: '執行摘要', titleEn: 'Executive Overview', load: () => import('./Chapter00') },
  { id: 1, slug: 'system-architecture', titleZh: '系統架構', titleEn: 'System Architecture', load: () => import('./Chapter01') },
  { id: 2, slug: 'timing-sign-convention', titleZh: '時序與符號慣例', titleEn: 'Timing and Sign Convention', load: () => import('./Chapter02') },
  { id: 3, slug: 'ideal-fractional-trajectory', titleZh: '理想分數相位軌跡', titleEn: 'Ideal Fractional Phase Trajectory', load: () => import('./Chapter03') },
  { id: 4, slug: 'div34-pmux', titleZh: '/3-/4 除頻與 4-phase PMUX 運作', titleEn: '/3-/4 + 4-phase PMUX Operation', load: () => import('./Chapter04') },
  { id: 5, slug: 'feedback-dtc', titleZh: '6-bit Feedback DTC', titleEn: '6-bit Feedback DTC', load: () => import('./Chapter05') },
  { id: 6, slug: 'reverse-injection-geometry', titleZh: '反向注入幾何', titleEn: 'Reverse Injection Geometry', load: () => import('./Chapter06') },
  { id: 7, slug: 'injection-tap-mapping', titleZh: '8-phase Injection Tap 對應', titleEn: '8-phase Injection Tap Mapping', load: () => import('./Chapter07') },
  { id: 8, slug: 'shared-phase-state', titleZh: '共享相位狀態', titleEn: 'Shared Phase State', load: () => import('./Chapter08') },
  { id: 9, slug: 'dsm-output-insufficient', titleZh: '為何只看 DSM 輸出不夠', titleEn: 'Why DSM Output Alone Is Insufficient', load: () => import('./Chapter09') },
  { id: 10, slug: 'sub-lsb-quantization', titleZh: 'Sub-LSB 量化', titleEn: 'Sub-LSB Quantization', load: () => import('./Chapter10') },
  { id: 11, slug: 'rounding-vs-phase-dsm', titleZh: '固定捨入與 Phase DSM 之比較', titleEn: 'Fixed Rounding versus Phase DSM', load: () => import('./Chapter11') },
  { id: 12, slug: 'latency-look-ahead', titleZh: '管線延遲與 Look-Ahead', titleEn: 'Pipeline Latency and Look-Ahead', load: () => import('./Chapter12') },
  { id: 13, slug: 'vco-injection-dynamics', titleZh: '實際 VCO 注入動態', titleEn: 'Actual VCO Injection Dynamics', load: () => import('./Chapter13') },
  { id: 14, slug: 'zero-crossing-miss', titleZh: 'Zero-Crossing 偏失與 Shorting 能量', titleEn: 'Zero-Crossing Miss and Shorting Energy', load: () => import('./Chapter14') },
  { id: 15, slug: 'analog-mismatch', titleZh: '類比失配', titleEn: 'Analog Mismatch', load: () => import('./Chapter15') },
  { id: 16, slug: 'spur-phase-noise', titleZh: 'Spur 與相位雜訊分析', titleEn: 'Spur and Phase-Noise Analysis', load: () => import('./Chapter16') },
  { id: 17, slug: 'architecture-comparisons', titleZh: '互動式架構比較', titleEn: 'Interactive Architecture Comparisons', load: () => import('./Chapter17') },
  { id: 18, slug: 'python-golden-model', titleZh: 'Python Golden Model', titleEn: 'Python Golden Model', load: () => import('./Chapter18') },
  { id: 19, slug: 'verilog-a-model', titleZh: 'Verilog-A Model', titleEn: 'Verilog-A Model', load: () => import('./Chapter19') },
  { id: 20, slug: 'design-rules-conclusions', titleZh: '設計準則與結論', titleEn: 'Design Rules and Conclusions', load: () => import('./Chapter20') },
  { id: 21, slug: 'pd-input-error-anatomy', titleZh: 'PD 輸入端誤差逐級解析', titleEn: 'PD-Input Phase Error Anatomy', load: () => import('./Chapter21') },
  { id: 22, slug: 'dsm-residual-injection-lock', titleZh: 'DSM 殘餘誤差與失鎖邊界', titleEn: 'DSM Residuals and Injection Lock Margin', load: () => import('./Chapter22') },
];

export function chapterBySlug(slug: string): ChapterMeta | undefined {
  return CHAPTERS.find((c) => c.slug === slug);
}

export function chapterById(id: number): ChapterMeta | undefined {
  return CHAPTERS.find((c) => c.id === id);
}
