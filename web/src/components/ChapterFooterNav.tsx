/**
 * Footer previous/next chapter navigation, derived from the CHAPTERS
 * registry. Rendered by App below the chapter content. ArrowLeft/ArrowRight
 * keyboard navigation lives in App (global listener).
 */

import { CHAPTERS, type ChapterMeta } from '../chapters/index';
import { chapterHref } from '../lib/router';

export function adjacentChapters(current: ChapterMeta): {
  prev: ChapterMeta | undefined;
  next: ChapterMeta | undefined;
} {
  const i = CHAPTERS.findIndex((c) => c.id === current.id);
  return {
    prev: i > 0 ? CHAPTERS[i - 1] : undefined,
    next: i >= 0 && i < CHAPTERS.length - 1 ? CHAPTERS[i + 1] : undefined,
  };
}

export default function ChapterFooterNav({ current }: { current: ChapterMeta }) {
  const { prev, next } = adjacentChapters(current);
  return (
    <nav className="chapter-footnav" aria-label="chapter previous/next">
      {prev !== undefined ? (
        <a className="footnav-link footnav-prev" href={chapterHref(prev.slug)}>
          <span className="footnav-dir">← 上一章</span>
          <span className="footnav-title">
            Ch {prev.id} {prev.titleZh}
          </span>
          <span className="footnav-en">{prev.titleEn}</span>
        </a>
      ) : (
        <span className="footnav-spacer" />
      )}
      <span className="footnav-hint" aria-hidden="true">
        ← / → 切換章節
      </span>
      {next !== undefined ? (
        <a className="footnav-link footnav-next" href={chapterHref(next.slug)}>
          <span className="footnav-dir">下一章 →</span>
          <span className="footnav-title">
            Ch {next.id} {next.titleZh}
          </span>
          <span className="footnav-en">{next.titleEn}</span>
        </a>
      ) : (
        <span className="footnav-spacer" />
      )}
    </nav>
  );
}
