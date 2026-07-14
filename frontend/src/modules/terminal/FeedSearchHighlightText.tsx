import { useMemo, type ReactNode } from "react";
import { substringHighlightIndices } from "./feedSearchHighlight";

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
        <mark key={i} className="term-feed-search__mark">
          {chunk}
        </mark>
      ) : (
        chunk
      ),
    );
    i = j;
  }

  return nodes;
}

type FeedSearchHighlightTextProps = {
  text: string;
  query: string;
  className?: string;
};

export function FeedSearchHighlightText({ text, query, className }: FeedSearchHighlightTextProps) {
  const indices = useMemo(() => substringHighlightIndices(text, query), [query, text]);

  if (!query.trim() || indices.size === 0) {
    return className ? <span className={className}>{text}</span> : <>{text}</>;
  }

  return <span className={className}>{renderHighlighted(text, indices)}</span>;
}
