import { useState, useEffect, useCallback } from "react";
import type { Terminal } from "@xterm/xterm";
import type { SearchAddon } from "@xterm/addon-search";
import { TextInput } from "../ui/form/TextInput";

interface Props {
  terminal: Terminal | null;
  searchAddon: SearchAddon | null;
  onClose: () => void;
}

export function TerminalSearch({ terminal: _terminal, searchAddon, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [matchCount, setMatchCount] = useState(0);
  const [currentIndex, setCurrentIndex] = useState(0);

  // Listen for search result changes
  useEffect(() => {
    if (!searchAddon) return;
    const disposable = searchAddon.onDidChangeResults(
      ({ resultIndex, resultCount }: { resultIndex: number; resultCount: number }) => {
        setMatchCount(resultCount);
        setCurrentIndex(resultCount > 0 ? resultIndex + 1 : 0);
      }
    );
    return () => disposable.dispose();
  }, [searchAddon]);

  const doSearch = useCallback(
    (text: string) => {
      if (!searchAddon || !text) {
        setMatchCount(0);
        setCurrentIndex(0);
        return;
      }
      searchAddon.findNext(text, { caseSensitive: false });
    },
    [searchAddon]
  );

  const findNext = useCallback(() => {
    if (!searchAddon || !query) return;
    searchAddon.findNext(query, { caseSensitive: false });
  }, [searchAddon, query]);

  const findPrevious = useCallback(() => {
    if (!searchAddon || !query) return;
    searchAddon.findPrevious(query, { caseSensitive: false });
  }, [searchAddon, query]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      onClose();
    } else if (e.key === "Enter") {
      if (e.shiftKey) {
        findPrevious();
      } else {
        findNext();
      }
    }
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "4px 8px",
        background: "var(--bg-deeper)",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <TextInput
        autoFocus
        copyable={false}
        value={query}
        onChange={(value) => {
          setQuery(value);
          doSearch(value);
        }}
        onKeyDown={handleKeyDown}
        placeholder="搜索终端..."
        style={{
          flex: 1,
          background: "var(--surface)",
          color: "var(--fg)",
          border: "1px solid var(--border)",
          borderRadius: "var(--r-sm)",
          padding: "4px 8px",
          fontSize: 12,
          outline: "none",
        }}
      />
      <span style={{ fontSize: 11, color: "var(--meta)", minWidth: 40 }}>
        {matchCount > 0 ? `${currentIndex}/${matchCount}` : query ? "无结果" : ""}
      </span>
      <button
        onClick={findPrevious}
        disabled={matchCount === 0}
        style={{
          background: "none",
          border: "none",
          color: matchCount === 0 ? "var(--muted)" : "var(--fg-2)",
          cursor: matchCount === 0 ? "default" : "pointer",
          padding: 2,
          opacity: matchCount === 0 ? 0.4 : 1,
        }}
        title="上一个 (Shift+Enter)"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M18 15l-6-6-6 6" />
        </svg>
      </button>
      <button
        onClick={findNext}
        disabled={matchCount === 0}
        style={{
          background: "none",
          border: "none",
          color: matchCount === 0 ? "var(--muted)" : "var(--fg-2)",
          cursor: matchCount === 0 ? "default" : "pointer",
          padding: 2,
          opacity: matchCount === 0 ? 0.4 : 1,
        }}
        title="下一个 (Enter)"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      <button
        onClick={onClose}
        style={{
          background: "none",
          border: "none",
          color: "var(--fg-2)",
          cursor: "pointer",
          padding: 2,
        }}
        title="关闭 (Escape)"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}
