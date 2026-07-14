import { useMemo, type ReactNode } from "react";
import { fuzzyHighlightIndices } from "./fuzzyMatch";

function renderHighlighted(text: string, indices: ReadonlySet<number>): ReactNode {
  const nodes: ReactNode[] = [];
  let i = 0;
  while (i < text.length) {
    const highlighted = indices.has(i);
    let j = i + 1;
    while (j < text.length && indices.has(j) === highlighted) j += 1;
    const chunk = text.slice(i, j);
    nodes.push(
      highlighted ? (
        <mark key={i} className="term-cmd-picker__mark">
          {chunk}
        </mark>
      ) : (
        <span key={i}>{chunk}</span>
      ),
    );
    i = j;
  }
  return nodes;
}

type FuzzyHighlightTextProps = {
  text: string;
  query: string;
  className?: string;
};

export function FuzzyHighlightText({ text, query, className }: FuzzyHighlightTextProps) {
  const indices = useMemo(() => {
    const matched = fuzzyHighlightIndices(query, text);
    return new Set(matched);
  }, [query, text]);

  if (!query.trim() || indices.size === 0) {
    return <span className={className}>{text}</span>;
  }

  return <span className={className}>{renderHighlighted(text, indices)}</span>;
}
