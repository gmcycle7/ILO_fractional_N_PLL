/**
 * Monospace code block with a copy button. No syntax highlighting dependency
 * (professional plain rendering; `language` is shown as a label only).
 */

import { useCallback, useState } from 'react';

export interface CodeBlockProps {
  code: string;
  language?: string;
  /** optional label shown in the header bar instead of language */
  title?: string;
}

export default function CodeBlock({ code, language, title }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(() => {
    if (!navigator.clipboard) return;
    navigator.clipboard
      .writeText(code)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => undefined);
  }, [code]);

  return (
    <div className="codeblock">
      <div className="codeblock-bar">
        <span className="codeblock-lang">{title ?? language ?? 'code'}</span>
        <button type="button" className="codeblock-copy" onClick={copy}>
          {copied ? '已複製' : '複製 copy'}
        </button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}
