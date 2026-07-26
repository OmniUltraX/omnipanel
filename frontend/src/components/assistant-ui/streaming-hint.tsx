"use client";

import { useAuiState } from "@assistant-ui/react";
import { useEffect, useState, type FC } from "react";
import { useI18n } from "../../i18n";

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${Math.round(ms / 100) / 10}s`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * 首包到达前的等待提示（对齐 Cursor / Claude 的「思考中」体感）。
 */
export const AssistantStreamingHint: FC = () => {
  const { t } = useI18n();
  const running = useAuiState((s) => s.message.status?.type === "running");
  const hasVisibleContent = useAuiState((s) =>
    s.message.content.some((part) => {
      if (part.type === "text") return Boolean(part.text?.trim());
      if (part.type === "reasoning") return Boolean(part.text?.trim());
      if (part.type === "tool-call") return true;
      return false;
    }),
  );
  const streamStart = useAuiState(
    (s) =>
      (s.message.role === "assistant"
        ? s.message.metadata?.timing?.streamStartTime
        : undefined) ?? null,
  );

  const [now, setNow] = useState(() => performance.now());

  useEffect(() => {
    if (!running || hasVisibleContent) return;
    const id = window.setInterval(() => setNow(performance.now()), 100);
    return () => window.clearInterval(id);
  }, [running, hasVisibleContent]);

  if (!running || hasVisibleContent) return null;

  const elapsed =
    streamStart != null ? Math.max(0, now - streamStart) : 0;

  return (
    <div
      data-slot="aui_assistant-streaming-hint"
      className="aui-assistant-streaming-hint text-muted-foreground flex items-center gap-2 px-2 py-1 text-sm"
      aria-live="polite"
    >
      <span className="relative flex size-2">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-[var(--accent)] opacity-40" />
        <span className="relative inline-flex size-2 rounded-full bg-[var(--accent)]" />
      </span>
      <span>{t("ai.composer.assistantWorking")}</span>
      {elapsed > 0 ? (
        <span className="font-mono text-xs tabular-nums opacity-70">
          {formatElapsed(elapsed)}
        </span>
      ) : null}
    </div>
  );
};
