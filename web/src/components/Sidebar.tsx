/**
 * Fixed left navigation: the 21 chapters (0-20) from the registry.
 * On narrow viewports it becomes an overlay toggled from the top bar.
 */

import { CHAPTERS } from '../chapters/index';
import { chapterHref } from '../lib/router';

export interface SidebarProps {
  activeId: number;
  open: boolean;
  onNavigate: () => void;
}

export default function Sidebar({ activeId, open, onNavigate }: SidebarProps) {
  return (
    <aside className={`sidebar${open ? ' sidebar-open' : ''}`}>
      <div className="sidebar-header">
        <div className="sidebar-title">ILO Fractional-N PLL</div>
        <div className="sidebar-subtitle">Reverse Edge Injection 互動教材</div>
      </div>
      <nav className="sidebar-nav" aria-label="chapters">
        {CHAPTERS.map((c) => (
          <a
            key={c.id}
            href={chapterHref(c.slug)}
            className={`nav-item${c.id === activeId ? ' nav-item-active' : ''}`}
            onClick={onNavigate}
            aria-current={c.id === activeId ? 'page' : undefined}
          >
            <span className="nav-num">{c.id}</span>
            <span className="nav-titles">
              <span className="nav-zh">{c.titleZh}</span>
              <span className="nav-en">{c.titleEn}</span>
            </span>
          </a>
        ))}
      </nav>
    </aside>
  );
}
