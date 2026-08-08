import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { CHAPTERS } from './chapters/index';
import Sidebar from './components/Sidebar';
import TopBar from './components/TopBar';
import { UnitProvider } from './components/UnitSwitch';
import { SimStatusProvider } from './SimStatusContext';
import { useHashRoute } from './lib/router';

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

  return (
    <SimStatusProvider>
      <UnitProvider>
        <div className="app">
          <Sidebar activeId={meta.id} open={navOpen} onNavigate={() => setNavOpen(false)} />
          <div className="main-col">
            <TopBar chapter={meta} onToggleNav={() => setNavOpen((v) => !v)} />
            <main className="content" ref={contentRef}>
              <Suspense fallback={<div className="chapter-loading">載入中…</div>}>
                <Component />
              </Suspense>
            </main>
          </div>
        </div>
      </UnitProvider>
    </SimStatusProvider>
  );
}
