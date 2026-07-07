import {
  AssistantRuntimeProvider,
  type ExternalStoreAdapter,
  type ToolCallMessagePartComponent,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { useCallback, useDeferredValue, useMemo, useRef } from "react";
import { ToolFallback } from "../../components/assistant-ui/tool-fallback";
import { ThreadMessagesOnly } from "../../components/assistant-ui/thread";
import {
  useBlocksStore,
  type TerminalBlock,
} from "../../stores/blocksStore";
import { aiThreadToThreadMessages, getResolvedAiThread } from "./aiThreadBridge";
import { cancelAiGeneration } from "../../lib/ai/cancelAiGeneration";
import { useFollowOutputScroll } from "./useFollowOutputScroll";
import { buildBlockThreadSignature } from "./threadSignature";
import { useI18n } from "../../i18n";
import { cancelInlineAiBlock } from "./warpInlineAi";

const EMPTY_MESSAGES: ReturnType<typeof aiThreadToThreadMessages> = [];

type TerminalAiBlockSlice = {
  id: string;
  status: TerminalBlock["status"];
  aiStalled: boolean;
  threadSignature: string;
  thread: ReturnType<typeof getResolvedAiThread>;
};

type TerminalAiThreadRuntimeProps = {
  blockSlice: TerminalAiBlockSlice;
  sessionId: string;
};

function TerminalAiStalledBanner({
  blockId,
  sessionId,
}: {
  blockId: string;
  sessionId: string;
}) {
  const { t } = useI18n();

  return (
    <div className="term-warp-ai-stalled" role="status">
      <span>{t("terminal.ai.stalled")}</span>
      <div className="term-warp-ai-stalled__actions">
        <button
          type="button"
          className="term-warp-block__toolbar-btn"
          onClick={() => cancelInlineAiBlock(sessionId, blockId)}
        >
          {t("terminal.ai.stop")}
        </button>
        <button
          type="button"
          className="term-warp-block__toolbar-btn"
          onClick={() => {
            useBlocksStore.getState().updateBlock(blockId, { aiStalled: false });
            cancelInlineAiBlock(sessionId, blockId);
          }}
        >
          {t("terminal.ai.retry")}
        </button>
      </div>
    </div>
  );
}

function TerminalAiThreadRuntime({ blockSlice, sessionId }: TerminalAiThreadRuntimeProps) {
  const isRunning = blockSlice.status === "running";

  const messages = useMemo(
    () =>
      blockSlice.thread.length > 0
        ? aiThreadToThreadMessages(blockSlice.thread, { isStreaming: isRunning })
        : EMPTY_MESSAGES,
    [blockSlice.thread, blockSlice.threadSignature, isRunning],
  );

  // 让 markdown 解析 + 渲染走 transition：流式期间 messages 引用每帧都在变，
  // useDeferredValue 把对 useExternalStoreRuntime 的更新降级，主线程不被打断。
  // isRunning 保持非 deferred，stop/cancel 立即生效。
  const deferredMessages = useDeferredValue(messages);

  const toolFallback = useMemo<ToolCallMessagePartComponent>(
    () => ToolFallback,
    [],
  );

  const threadComponents = useMemo(
    () => ({ ToolFallback: toolFallback }),
    [toolFallback],
  );

  const adapter = useMemo<ExternalStoreAdapter>(
    () => ({
      messages: deferredMessages,
      isRunning,
      onNew: async () => {},
      setMessages: () => {},
      onReload: async () => {},
      onCancel: async () => {
        cancelAiGeneration();
      },
    }),
    [deferredMessages, isRunning],
  );

  const runtime = useExternalStoreRuntime(adapter);

  if (messages.length === 0 && isRunning) {
    return <div className="term-warp-block__pending">思考中…</div>;
  }

  return (
    <AssistantRuntimeProvider key={blockSlice.id} runtime={runtime}>
      {blockSlice.aiStalled ? (
        <TerminalAiStalledBanner blockId={blockSlice.id} sessionId={sessionId} />
      ) : null}
      <ThreadMessagesOnly components={threadComponents} />
    </AssistantRuntimeProvider>
  );
}

type TerminalAiThreadViewProps = {
  blockId: string;
  sessionId: string;
  /** 吸顶展开态：内容在卡片内滚动，需跟随最新输出 */
  dockedAutoScroll?: boolean;
};

/** 终端 AI 卡片内容：复用侧栏 assistant-ui 消息渲染 */
export function TerminalAiThreadView({
  blockId,
  sessionId,
  dockedAutoScroll = false,
}: TerminalAiThreadViewProps) {
  const threadRef = useRef<HTMLDivElement>(null);

  const selectThreadSignature = useCallback(
    (state: ReturnType<typeof useBlocksStore.getState>) => {
      const block = state.findBlockById(blockId);
      if (!block || block.kind !== "ai") return "";
      return buildBlockThreadSignature(block);
    },
    [blockId],
  );

  const selectStatus = useCallback(
    (state: ReturnType<typeof useBlocksStore.getState>) => {
      const block = state.findBlockById(blockId);
      if (!block || block.kind !== "ai") return null;
      return block.status;
    },
    [blockId],
  );

  const selectAiStalled = useCallback(
    (state: ReturnType<typeof useBlocksStore.getState>) => {
      const block = state.findBlockById(blockId);
      if (!block || block.kind !== "ai") return false;
      return Boolean(block.aiStalled);
    },
    [blockId],
  );

  const threadSignature = useBlocksStore(selectThreadSignature);
  const status = useBlocksStore(selectStatus);
  const aiStalled = useBlocksStore(selectAiStalled);

  const blockSlice = useMemo((): TerminalAiBlockSlice | null => {
    if (!threadSignature || !status) return null;
    const block = useBlocksStore.getState().findBlockById(blockId);
    if (!block || block.kind !== "ai") return null;
    return {
      id: block.id,
      status,
      aiStalled,
      threadSignature,
      thread: getResolvedAiThread(block),
    };
  }, [blockId, threadSignature, status, aiStalled]);

  useFollowOutputScroll(threadRef, {
    enabled: dockedAutoScroll,
    contentSignature: threadSignature,
    settleFrames: 1,
  });

  if (!blockSlice) return null;

  return (
    <div className="term-warp-ai-thread" ref={threadRef}>
      <TerminalAiThreadRuntime blockSlice={blockSlice} sessionId={sessionId} />
    </div>
  );
}
