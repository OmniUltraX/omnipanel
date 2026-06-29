import {
  AssistantRuntimeProvider,
  type ExternalStoreAdapter,
  type ToolCallMessagePartComponent,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { useMemo, useRef } from "react";
import { ToolFallback } from "../../components/assistant-ui/tool-fallback";
import { ThreadMessagesOnly } from "../../components/assistant-ui/thread";
import {
  useBlocksStore,
  type TerminalBlock,
} from "../../stores/blocksStore";
import { aiThreadToThreadMessages, getResolvedAiThread } from "./aiThreadBridge";
import { cancelAiGeneration } from "../../lib/ai/cancelAiGeneration";
import { useFollowOutputScroll } from "./useFollowOutputScroll";

const EMPTY_MESSAGES: ReturnType<typeof aiThreadToThreadMessages> = [];

type TerminalAiThreadRuntimeProps = {
  block: TerminalBlock;
};

function TerminalAiThreadRuntime({ block }: TerminalAiThreadRuntimeProps) {
  const thread = getResolvedAiThread(block);
  const isRunning = block.status === "running";

  const messages = useMemo(
    () =>
      thread.length > 0
        ? aiThreadToThreadMessages(thread, { isStreaming: isRunning })
        : EMPTY_MESSAGES,
    [thread, isRunning],
  );

  const toolFallback = useMemo<ToolCallMessagePartComponent>(
    () => ToolFallback,
    [],
  );

  const adapter = useMemo<ExternalStoreAdapter>(
    () => ({
      messages,
      isRunning,
      onNew: async () => {},
      setMessages: () => {},
      onReload: async () => {},
      onCancel: async () => {
        cancelAiGeneration();
      },
    }),
    [messages, isRunning],
  );

  const runtime = useExternalStoreRuntime(adapter);

  if (messages.length === 0 && isRunning) {
    return <div className="term-warp-block__pending">思考中…</div>;
  }

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadMessagesOnly
        components={{
          ToolFallback: toolFallback,
        }}
      />
    </AssistantRuntimeProvider>
  );
}

type TerminalAiThreadViewProps = {
  blockId: string;
  /** 吸顶展开态：内容在卡片内滚动，需跟随最新输出 */
  dockedAutoScroll?: boolean;
};

/** 终端 AI 卡片内容：复用侧栏 assistant-ui 消息渲染 */
export function TerminalAiThreadView({
  blockId,
  dockedAutoScroll = false,
}: TerminalAiThreadViewProps) {
  const threadRef = useRef<HTMLDivElement>(null);
  const block = useBlocksStore((state) => state.findBlockById(blockId));

  const threadSignature = useMemo(() => {
    if (!block || block.kind !== "ai") return "";
    const thread = getResolvedAiThread(block);
    return thread
      .map((item) => {
        if (item.kind === "message") {
          return `m:${item.id}:${item.content.length}:${item.reasoning?.length ?? 0}`;
        }
        return `t:${item.id}:${item.status}:${item.result?.length ?? 0}`;
      })
      .join("|");
  }, [block]);

  useFollowOutputScroll(threadRef, {
    enabled: dockedAutoScroll,
    contentSignature: threadSignature,
    settleFrames: 1,
  });

  if (!block || block.kind !== "ai") return null;

  return (
    <div className="term-warp-ai-thread" ref={threadRef}>
      <TerminalAiThreadRuntime block={block} />
    </div>
  );
}
