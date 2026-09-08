/**
 * 快捷启动页内 AI 回答：复用 assistant-ui 消息渲染（Markdown / 代码块 / 复制），
 * 与侧栏 AI 助手、终端内嵌 AI 保持一致。
 */
import {
  AssistantRuntimeProvider,
  type ExternalStoreAdapter,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { useDeferredValue, useMemo, useRef } from "react";

import { ThreadMessagesOnly } from "../assistant-ui/thread";
import { aiMessagesToThreadMessages } from "../ai/assistant-ui/messageBridge";
import { useI18n } from "../../i18n";
import { useFollowOutputScroll } from "../../modules/terminal/useFollowOutputScroll";
import { normalizeAiMessage } from "../../stores/aiStore";

export type QuickLauncherAiAnswerProps = {
  prompt: string;
  answer: string;
  status: "streaming" | "done" | "error";
  errorMessage?: string;
  onBack: () => void;
};

function QuickLauncherAiThread({
  answer,
  isStreaming,
}: {
  answer: string;
  isStreaming: boolean;
}) {
  const messages = useMemo(() => {
    if (!answer.trim() && !isStreaming) return [];
    return aiMessagesToThreadMessages([
      normalizeAiMessage({
        id: "quick-launcher-assistant",
        role: "assistant",
        content: answer,
        parts: answer ? [{ type: "text", text: answer }] : [],
        timestamp: Date.now(),
        isStreaming,
      }),
    ]);
  }, [answer, isStreaming]);

  const deferredMessages = useDeferredValue(messages);

  const adapter = useMemo<ExternalStoreAdapter>(
    () => ({
      messages: deferredMessages,
      isRunning: isStreaming,
      onNew: async () => {},
      setMessages: () => {},
      onReload: async () => {},
      onCancel: async () => {},
    }),
    [deferredMessages, isStreaming],
  );

  const runtime = useExternalStoreRuntime(adapter);

  if (messages.length === 0) return null;

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadMessagesOnly />
    </AssistantRuntimeProvider>
  );
}

/** 页内询问 AI：Markdown 流式回答 + 贴底滚动 */
export function QuickLauncherAiAnswer({
  prompt,
  answer,
  status,
  errorMessage,
  onBack,
}: QuickLauncherAiAnswerProps) {
  const { t } = useI18n();
  const scrollRef = useRef<HTMLDivElement>(null);
  const isStreaming = status === "streaming";
  const isError = status === "error";

  useFollowOutputScroll(scrollRef, {
    enabled: isStreaming,
    contentSignature: `${status}:${answer.length}:${answer.slice(-48)}`,
    settleFrames: 1,
  });

  return (
    <div className="quick-launcher__ai" role="region" aria-live="polite">
      <div className="quick-launcher__ai-meta">
        <span className="quick-launcher__ai-tag">
          {t("shell.quickLauncher.ai.title")}
        </span>
        <span className="quick-launcher__ai-status">
          {isStreaming
            ? t("shell.quickLauncher.ai.streaming")
            : isError
              ? t("shell.quickLauncher.ai.failed")
              : t("shell.quickLauncher.ai.done")}
        </span>
        <button
          type="button"
          className="quick-launcher__ai-close"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onBack}
        >
          {t("shell.quickLauncher.ai.back")}
        </button>
      </div>
      <div className="quick-launcher__ai-prompt" title={prompt}>
        {prompt.replace(/\s+/g, " ").slice(0, 160)}
      </div>
      <div ref={scrollRef} className="quick-launcher__ai-answer">
        {isError ? (
          <p className="quick-launcher__ai-error">
            {errorMessage === "no-provider"
              ? t("shell.quickLauncher.ai.noProvider")
              : t("shell.quickLauncher.ai.error", {
                  message: errorMessage || "unknown",
                })}
          </p>
        ) : answer.trim() ? (
          <div className="quick-launcher__ai-markdown">
            <QuickLauncherAiThread answer={answer} isStreaming={isStreaming} />
          </div>
        ) : (
          <p className="quick-launcher__ai-placeholder">
            {t("shell.quickLauncher.ai.waiting")}
          </p>
        )}
      </div>
    </div>
  );
}
