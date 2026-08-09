/**
 * Chapter render smoke test.
 *
 * Renders every chapter component from the registry with
 * react-dom/server renderToString in a plain node environment (no jsdom).
 * Chapters must be SSR-safe: any window/document access must live inside
 * useEffect (effects do not run during renderToString).
 */

import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CHAPTERS } from '../index';

describe('chapter render smoke (SSR, node environment)', () => {
  expect(CHAPTERS.length).toBe(23);

  for (const meta of CHAPTERS) {
    it(`Chapter ${String(meta.id).padStart(2, '0')} (${meta.slug}) renders without throwing`, async () => {
      const mod = await meta.load();
      expect(typeof mod.default).toBe('function');
      const html = renderToString(createElement(mod.default));
      expect(html.length).toBeGreaterThan(0);
    });
  }
});
