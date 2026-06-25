import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { AiThreadToolCall } from "../../stores/blocksStore";
import {
  approveInlineTerminalTool,
  rejectInlineTerminalTool,
} from "./inlineToolBridge";
import { useCommandBarDraftStore } from "./commandBarDraftStore";

type ToolCallBarProps = {
  blockId: string;
  sessionId: string;
  item: AiThreadToolCall;
  variant?: "inline" | "dock";
};

function statusIcon(status: AiThreadToolCall["status"]): string {
  if (status === "running") return "";
  if (status === "completed") return "✓";
  if (status === "rejected") return "⊘";
  if (status === "failed") return "✕";
  return "›";
}

export function ToolCallBar({
  blockId,
  sessionId,
  item,
  variant = "inline",
}: ToolCallBarProps) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.command ?? "");
  const barRef = useRef<HTMLDivElement>(null);
  const setDraftForSession = useCommandBarDraftStore((s) => s.setDraft);
  const isDock = variant === "dock";

  const command = item.command?.trim() || item.toolName;
  const isPending = item.status === "pending";
  const isRunning = item.status === "running";
  const risk = item.riskLevel;
  const needsConfirm = risk === "high" || risk === "critical";

  useEffect(() => {
    if (!isPending || !isDock) return;
    const el = barRef.current;
    if (!el) return;
    el.focus();
  }, [isDock, isPending]);

  const approve = (cmd?: string) => {
    void approveInlineTerminalTool(blockId, item.id, cmd);
  };

  const reject = () => {
    rejectInlineTerminalTool(blockId, item.id);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!isPending) return;
    if (event.key === "Enter" && !editing) {
      event.preventDefault();
      approve(editing ? draft : undefined);
    } else if (event.key === "Escape" || (event.key === "c" && event.ctrlKey)) {
      event.preventDefault();
      reject();
    }
  };

  const fillCommandBar = () => {
    setDraftForSession(sessionId, draft || command);
  };

  const actionButtons = isPending ? (
  <>
    <button
      type="button"
      className="term-warp-toolcall__run"
      onClick={() => approve(editing ? draft : undefined)}
    >
      执行
    </button>
    <button type="button" className="term-warp-toolcall__edit-btn" onClick={fillCommandBar}>
      编辑
    </button>
    <button type="button" className="term-warp-toolcall__reject" onClick={reject}>
      拒绝
    </button>
  </>
) : null;

  return (
    <div
      ref={barRef}
      className={`term-warp-toolcall term-warp-toolcall--${item.status}${
        isDock ? " term-warp-toolcall--dock" : ""
      }`}
      tabIndex={isPending && isDock ? 0 : -1}
      onKeyDown={onKeyDown}
      data-tool-call-id={item.id}
    >
      <div className="term-warp-toolcall__row">
        {isDock ? (
          <span className="term-warp-toolcall__label">AI 命令</span>
        ) : (
          <span
            className={`term-warp-toolcall__status${
              isRunning ? " term-warp-toolcall__status--running" : ""
            }`}
            aria-hidden
          >
            {isRunning ? "" : statusIcon(item.status)}
          </span>
        )}
        {editing ? (
          <input
            className="term-warp-toolcall__edit"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                setEditing(false);
                approve(draft);
              } else if (e.key === "Escape") {
                setEditing(false);
                setDraft(command);
              }
            }}
            autoFocus
          />
        ) : (
          <button
            type="button"
            className="term-warp-toolcall__command"
            onClick={() => {
              if (isPending) setEditing(true);
              else setExpanded((v) => !v);
            }}
          >
            {command}
          </button>
        )}
        {isDock && isRunning ? (
          <span className="term-warp-toolcall__running">执行中…</span>
        ) : null}
        {isDock && isPending ? (
          <div className="term-warp-toolcall__actions">{actionButtons}</div>
        ) : null}
        {!isDock ? (
          <button
            type="button"
            className="term-warp-toolcall__chevron"
            onClick={() => setExpanded((v) => !v)}
            aria-label="展开详情"
          >
            ›
          </button>
        ) : null}
      </div>

      {needsConfirm && isPending ? (
        <p className="term-warp-toolcall__risk">高风险命令，请确认后执行</p>
      ) : null}

      {!isDock && isPending ? (
        <div className="term-warp-toolcall__actions">{actionButtons}</div>
      ) : null}

      {expanded && item.result ? (
        <pre className="term-warp-toolcall__result">{item.result}</pre>
      ) : null}
    </div>
  );
}
