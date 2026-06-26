import { useMemo, useState } from "react";
import type { TerminalBlock } from "../../stores/blocksStore";
import { EMPTY_TERMINAL_BLOCKS, useBlocksStore } from "../../stores/blocksStore";
import { useTerminalHistoryStore } from "../../stores/terminalHistoryStore";
import { useI18n } from "../../i18n";
import { extractCommandOutput } from "./terminalOutputText";
import { appConfirm } from "../../lib/appConfirm";
import { Button } from "../../components/ui/Button";

type HistoryFilter = "all" | "shell" | "ai";

type TerminalHistoryPanelProps = {
  sessionId: string;
  sessionTitle?: string;
  onRunCommand?: (command: string) => void;
};

function blockLabel(block: TerminalBlock): string {
  if (block.kind === "ai") {
    return block.title?.trim() || block.command.trim() || "AI";
  }
  return block.command.trim();
}

function blockOutputPreview(block: TerminalBlock): string {
  if (block.kind === "ai") return "";
  const cleaned = extractCommandOutput(block.output, block.command);
  return (cleaned || block.output).trim();
}

function formatWhen(ts: number): string {
  return new Date(ts).toLocaleString();
}

export function TerminalHistoryPanel({
  sessionId,
  sessionTitle,
  onRunCommand,
}: TerminalHistoryPanelProps) {
  const { t } = useI18n();
  const blocks = useBlocksStore((state) => state.blocks[sessionId] ?? EMPTY_TERMINAL_BLOCKS);
  const removeBlock = useTerminalHistoryStore((state) => state.removeBlock);
  const clearSession = useTerminalHistoryStore((state) => state.clearSession);

  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<HistoryFilter>("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return [...blocks]
      .reverse()
      .filter((block) => {
        if (filter === "shell" && block.kind === "ai") return false;
        if (filter === "ai" && block.kind !== "ai") return false;
        if (!normalized) return true;
        const haystack = `${blockLabel(block)} ${blockOutputPreview(block)}`.toLowerCase();
        return haystack.includes(normalized);
      });
  }, [blocks, filter, query]);

  const handleClearSession = async () => {
    const ok = await appConfirm(
      t("terminal.historyPanel.clearSessionMessage", {
        name: sessionTitle ?? sessionId,
      }),
      t("terminal.historyPanel.clearSessionTitle"),
    );
    if (!ok) return;
    clearSession(sessionId);
    setExpandedId(null);
  };

  return (
    <div className="term-history-panel">
      <header className="term-history-panel__header">
        <div>
          <h3 className="term-history-panel__title">{t("terminal.historyPanel.title")}</h3>
          <p className="term-history-panel__desc">{t("terminal.historyPanel.desc")}</p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={blocks.length === 0}
          onClick={() => void handleClearSession()}
        >
          {t("terminal.historyPanel.clearSession")}
        </Button>
      </header>

      <div className="term-history-panel__toolbar">
        <input
          className="term-history-panel__search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("terminal.historyPanel.search")}
        />
        <div className="term-history-panel__filters" role="tablist" aria-label={t("terminal.historyPanel.filterLabel")}>
          {(["all", "shell", "ai"] as const).map((item) => (
            <button
              key={item}
              type="button"
              role="tab"
              aria-selected={filter === item}
              className={`term-history-panel__filter${filter === item ? " term-history-panel__filter--active" : ""}`}
              onClick={() => setFilter(item)}
            >
              {t(`terminal.historyPanel.filter.${item}`)}
            </button>
          ))}
        </div>
      </div>

      <div className="term-history-panel__meta">
        {t("terminal.historyPanel.count", { count: filtered.length })}
      </div>

      <div className="term-history-panel__list">
        {filtered.length === 0 ? (
          <div className="term-history-panel__empty">{t("terminal.historyPanel.empty")}</div>
        ) : (
          filtered.map((block) => {
            const label = blockLabel(block);
            const output = blockOutputPreview(block);
            const expanded = expandedId === block.id;
            const canRun = block.kind !== "ai" && label.length > 0 && Boolean(onRunCommand);

            return (
              <article key={block.id} className="term-history-panel__item">
                <div className="term-history-panel__item-head">
                  <span
                    className={`term-history-panel__badge${
                      block.kind === "ai" ? " term-history-panel__badge--ai" : ""
                    }`}
                  >
                    {block.kind === "ai"
                      ? t("terminal.command.historyKindAi")
                      : t("terminal.command.historyKindShell")}
                  </span>
                  <time className="term-history-panel__time">{formatWhen(block.timestamp)}</time>
                  {block.status === "failed" || (block.exitCode !== null && block.exitCode !== 0) ? (
                    <span className="term-history-panel__status term-history-panel__status--error">
                      {t("terminal.historyPanel.failed", { code: block.exitCode ?? "?" })}
                    </span>
                  ) : null}
                </div>

                <button
                  type="button"
                  className="term-history-panel__command"
                  onClick={() => setExpandedId(expanded ? null : block.id)}
                >
                  {label}
                </button>

                {expanded && output ? (
                  <pre className="term-history-panel__output">{output}</pre>
                ) : null}

                <div className="term-history-panel__actions">
                  {canRun ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      onClick={() => onRunCommand?.(label)}
                    >
                      {t("terminal.historyPanel.rerun")}
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      if (expandedId === block.id) setExpandedId(null);
                      removeBlock(sessionId, block.id);
                    }}
                  >
                    {t("terminal.historyPanel.delete")}
                  </Button>
                </div>
              </article>
            );
          })
        )}
      </div>
    </div>
  );
}
