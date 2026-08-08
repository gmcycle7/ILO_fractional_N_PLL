/**
 * Generic per-cycle debug table with mandatory CSV export.
 *
 * CSV uses column KEYS as the header and RAW values (full float precision) so
 * an exported table can be diffed against Python golden model output; `fmt`
 * only affects on-screen display.
 */

import { useCallback } from 'react';
import { trimNumber } from '../lib/format';

export interface DebugColumn {
  key: string;
  label: string;
  /** display formatter (screen only; CSV always exports raw values) */
  fmt?: (value: unknown, row: Record<string, unknown>) => string;
}

export interface DebugTableProps {
  columns: DebugColumn[];
  rows: Record<string, unknown>[];
  /** scroll container max height in px, default 320 */
  maxHeight?: number;
  /** CSV download filename, default 'debug_table.csv' */
  exportName?: string;
}

function defaultFmt(value: unknown): string {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : trimNumber(value, 6);
  }
  if (value === null || value === undefined) return '';
  return String(value);
}

function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export default function DebugTable({
  columns,
  rows,
  maxHeight = 320,
  exportName = 'debug_table.csv',
}: DebugTableProps) {
  const exportCsv = useCallback(() => {
    const header = columns.map((c) => csvCell(c.key)).join(',');
    const lines = rows.map((row) => columns.map((c) => csvCell(row[c.key])).join(','));
    const csv = '\ufeff' + `${header}\n${lines.join('\n')}\n`;
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = exportName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [columns, rows, exportName]);

  return (
    <div className="debug-table">
      <div className="debug-table-bar">
        <span className="debug-table-count">{rows.length} rows</span>
        <button type="button" className="debug-export" onClick={exportCsv}>
          匯出 CSV
        </button>
      </div>
      <div className="debug-table-scroll" style={{ maxHeight }}>
        <table className="data-table">
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.key}>{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, ri) => (
              <tr key={ri}>
                {columns.map((c) => (
                  <td key={c.key}>{c.fmt ? c.fmt(row[c.key], row) : defaultFmt(row[c.key])}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
