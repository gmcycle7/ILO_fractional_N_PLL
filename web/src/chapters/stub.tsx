/**
 * Placeholder body shared by all not-yet-written chapters.
 * Content agents: delete the <ChapterStub> usage in ChapterNN.tsx and write
 * the real chapter following web/ARCHITECTURE.md (11-section structure).
 */

import { ChapterShell } from '../components/ChapterShell';
import Callout from '../components/Callout';
import { chapterById } from './index';

export default function ChapterStub({ id }: { id: number }) {
  const meta = chapterById(id);
  return (
    <ChapterShell
      chapter={id}
      titleZh={meta?.titleZh ?? `Chapter ${id}`}
      titleEn={meta?.titleEn ?? ''}
    >
      <Callout type="note" title="章節尚未完成 (stub)">
        <p>
          本章內容尚未撰寫。實際內容將依 <code>web/ARCHITECTURE.md</code> 定義的 11
          段固定結構(問題、物理直覺、完整數學、數值例子、互動圖、行為程式碼、逐行解說、
          圖上應觀察什麼、常見誤解、設計要點、模型限制)填入,並以{' '}
          <code>MODEL_SPEC.md</code> 為唯一數學依據。
        </p>
      </Callout>
    </ChapterShell>
  );
}
