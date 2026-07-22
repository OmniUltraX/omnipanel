import { useEffect, useRef } from "react";
import type { ParsedHeading } from "./metadata/headings";

interface KnowledgeSourceEditorProps {
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
  jumpToLine?: number | null;
  onJumpHandled?: () => void;
  onRequestWikilinkComplete?: (query: string, caret: number) => void;
}

export function KnowledgeSourceEditor({
  value,
  placeholder,
  onChange,
  jumpToLine,
  onJumpHandled,
  onRequestWikilinkComplete,
}: KnowledgeSourceEditorProps) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (jumpToLine == null || !ref.current) return;
    const lines = value.split(/\r?\n/);
    let start = 0;
    for (let i = 0; i < jumpToLine && i < lines.length; i++) {
      start += (lines[i]?.length ?? 0) + 1;
    }
    const end = start + (lines[jumpToLine]?.length ?? 0);
    ref.current.focus();
    ref.current.setSelectionRange(start, end);
    const lineHeight = 20;
    ref.current.scrollTop = Math.max(0, jumpToLine * lineHeight - 40);
    onJumpHandled?.();
  }, [jumpToLine, onJumpHandled, value]);

  return (
    <textarea
      ref={ref}
      className="knowledge-source-editor"
      value={value}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(event) => {
        const next = event.target.value;
        onChange(next);
        const caret = event.target.selectionStart ?? next.length;
        const before = next.slice(0, caret);
        const open = before.lastIndexOf("[[");
        if (open >= 0 && !before.slice(open).includes("]")) {
          const query = before.slice(open + 2);
          if (!query.includes("\n")) {
            onRequestWikilinkComplete?.(query, caret);
            return;
          }
        }
        onRequestWikilinkComplete?.("", -1);
      }}
    />
  );
}

export function jumpSourceToHeading(_content: string, heading: ParsedHeading): number {
  return heading.line;
}
