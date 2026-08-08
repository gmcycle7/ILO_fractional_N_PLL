/**
 * Minimal hash router. Routes look like `#/<chapter-slug>`.
 * No external routing dependency: window.location.hash is the single source
 * of truth, navigation is plain <a href="#/slug"> links.
 */

import { useEffect, useState } from 'react';

/** '#/reverse-injection-geometry?x=1' -> 'reverse-injection-geometry' */
export function parseHashSlug(hash: string): string {
  const stripped = hash.replace(/^#\/?/, '');
  const slug = stripped.split('?')[0].replace(/\/+$/, '');
  try {
    return decodeURIComponent(slug);
  } catch {
    return slug;
  }
}

export function chapterHref(slug: string): string {
  return `#/${slug}`;
}

export function navigateToChapter(slug: string): void {
  window.location.hash = chapterHref(slug).slice(1);
}

/** Current chapter slug ('' when the hash is empty). */
export function useHashRoute(): string {
  const [slug, setSlug] = useState<string>(() => parseHashSlug(window.location.hash));
  useEffect(() => {
    const onHashChange = () => setSlug(parseHashSlug(window.location.hash));
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);
  return slug;
}
