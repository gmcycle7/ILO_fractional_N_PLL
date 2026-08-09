/**
 * Generic per-cycle debug table with mandatory CSV export.
 *
 * CSV uses column KEYS as the header and RAW values (full float precision) so
 * an exported table can be diffed against Python golden model output; `fmt`
 * only affects on-screen display.
 *
 * The header row is sticky inside the scroll container, and columns can be
 * shown/hidden via the 欄位 dropdown (display only — CSV always exports ALL
 * columns regardless of visibility).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
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
  // Column visibility (default: all on). Missing key = visible.
  const [hidden, setHidden] = useState<Record<string, boolean>>({});
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const shownColumns = columns.filter((c) => hidden[c.key] !== true);
  const hiddenCount = columns.length - shownColumns.length;

  // Close the column menu on outside click / Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (menuRef.current && e.target instanceof Node && !menuRef.current.contains(e.target)) {
        setMenuOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  // CSV always exports ALL columns (full precision), independent of visibility.
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
        <span className="debug-table-count">
          {rows.length} rows
          {hiddenCount > 0 ? `(隱藏 ${hiddenCount} 欄)` : ''}
        </span>
        <div className="debug-table-actions">
          <div className="debug-columns" ref={menuRef}>
            <button
              type="button"
              className="debug-export"
              aria-haspopup="true"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((v) => !v)}
            >
              欄位
            </button>
            {menuOpen && (
              <div className="debug-columns-menu" role="menu">
                <div className="debug-columns-menu-bar">
                  <button
                    type="button"
                    className="debug-export"
                    onClick={() => setHidden({})}
                    disabled={hiddenCount === 0}
                  >
                    全部顯示
                  </button>
                </div>
                {columns.map((c) => (
                  <label key={c.key} className="debug-columns-item">
                    <input
                      type="checkbox"
                      checked={hidden[c.key] !== true}
                      onChange={(e) =>
                        setHidden((prev) => ({ ...prev, [c.key]: !e.target.checked }))
                      }
                    />
                    <span>{c.label}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
          <button type="button" className="debug-export" onClick={exportCsv}>
            匯出 CSV
          </button>
        </div>
      </div>
      <div className="debug-table-scroll" style={{ maxHeight }}>
        <table className="data-table">
          <thead>
            <tr>
              {shownColumns.map((c) => (
                <th key={c.key}>{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, ri) => (
              <tr key={ri}>
                {shownColumns.map((c) => (
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
