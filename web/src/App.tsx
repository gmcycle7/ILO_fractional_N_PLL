import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { CHAPTERS } from './chapters/index';
import Sidebar from './components/Sidebar';
import TopBar from './components/TopBar';
import ChapterFooterNav, { adjacentChapters } from './components/ChapterFooterNav';
import { UnitProvider } from './components/UnitSwitch';
import { SimStatusProvider } from './SimStatusContext';
import { GlobalParamsProvider } from './lib/globalParams';
import { navigateToChapter, useHashRoute } from './lib/router';

// One lazy component per registry entry, created once at module scope.
const LAZY_CHAPTERS = CHAPTERS.map((meta) => ({ meta, Component: lazy(meta.load) }));

export default function App() {
  const slug = useHashRoute();
  const entry = LAZY_CHAPTERS.find((c) => c.meta.slug === slug) ?? LAZY_CHAPTERS[0];
  const { meta, Component } = entry;

  const [navOpen, setNavOpen] = useState(false);
  const contentRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 });
    document.title = `Ch ${meta.id} ${meta.titleZh} — ILO Fractional-N PLL`;
  }, [meta.id, meta.titleZh]);

  // ArrowLeft / ArrowRight chapter navigation. Ignored while focus is in a
  // form control (sliders, selects, text inputs) or with any modifier held.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const t = e.target;
      if (t instanceof HTMLElement) {
        const tag = t.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable) {
          return;
        }
      }
      const { prev, next } = adjacentChapters(meta);
      const dest = e.key === 'ArrowLeft' ? prev : next;
      if (dest !== undefined) {
        e.preventDefault();
        navigateToChapter(dest.slug);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [meta]);

  return (
    <SimStatusProvider>
      <GlobalParamsProvider>
        <UnitProvider>
          <div className="app">
            <Sidebar activeId={meta.id} open={navOpen} onNavigate={() => setNavOpen(false)} />
            <div className="main-col">
              <TopBar chapter={meta} onToggleNav={() => setNavOpen((v) => !v)} />
              <main className="content" ref={contentRef}>
                <Suspense fallback={<div className="chapter-loading">載入中…</div>}>
                  <Component />
                </Suspense>
                <ChapterFooterNav current={meta} />
              </main>
            </div>
          </div>
        </UnitProvider>
      </GlobalParamsProvider>
    </SimStatusProvider>
  );
}
