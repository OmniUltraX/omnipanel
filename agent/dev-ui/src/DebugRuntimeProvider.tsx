import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type AppendMessage,
  type ExternalStoreAdapter,
  type ThreadMessage,
} from "@assistant-ui/react";

import { cancelDebugPrompt, runDebugPrompt } from "./api";
import {
  debugMessagesToThreadMessages,
  type DebugMessage,
} from "./messageBridge";

const EMPTY_MESSAGES: ThreadMessage[] = [];

function createId(): string {
  return crypto.randomUUID();
}

function extractAppendText(message: AppendMessage): string {
  for (const part of message.content) {
    if (part.type === "text") return part.text;
  }
  return "";
}

export function DebugRuntimeProvider({ children }: { children: ReactNode }) {
  const [messages, setMessages] = useState<DebugMessage[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const threadMessages = useMemo(
    () => debugMessagesToThreadMessages(messages),
    [messages],
  );

  const runGeneration = useCallback(async (userText: string) => {
    if (!userText.trim() || isRunning) return;

    const userId = createId();
    const assistantId = createId();

    setMessages((prev) => [
      ...prev,
      { id: userId, role: "user", content: userText, timestamp: Date.now() },
      {
        id: assistantId,
        role: "assistant",
        content: "",
        reasoningContent: "",
        timestamp: Date.now(),
        toolCalls: [],
        isStreaming: true,
      },
    ]);

    setIsRunning(true);
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    const signal = abortRef.current.signal;

    const appendText = (chunk: string) => {
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === assistantId ? { ...msg, content: msg.content + chunk } : msg,
        ),
      );
    };

    const appendReasoning = (chunk: string) => {
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === assistantId
            ? { ...msg, reasoningContent: (msg.reasoningContent ?? "") + chunk }
            : msg,
        ),
      );
    };

    const upsertToolCall = (id: string, name: string, args: string) => {
      setMessages((prev) =>
        prev.map((msg) => {
          if (msg.id !== assistantId) return msg;
          const toolCalls = [...(msg.toolCalls ?? [])];
          if (!toolCalls.some((tc) => tc.id === id)) {
            toolCalls.push({ id, name, arguments: args, status: "running" });
          }
          return { ...msg, toolCalls };
        }),
      );
    };

    const updateToolCall = (id: string, status: "completed" | "failed", result?: string) => {
      setMessages((prev) =>
        prev.map((msg) => {
          if (msg.id !== assistantId) return msg;
          return {
            ...msg,
            toolCalls: (msg.toolCalls ?? []).map((tc) =>
              tc.id === id ? { ...tc, status, result } : tc,
            ),
          };
        }),
      );
    };

    try {
      await runDebugPrompt(
        userText,
        (event) => {
          if (signal.aborted) return;
          switch (event.type) {
            case "content_delta":
              appendText(event.text);
              break;
            case "reasoning_delta":
              appendReasoning(event.text);
              break;
            case "tool_call":
              upsertToolCall(event.id, event.name, event.arguments);
              break;
            case "tool_call_update":
              updateToolCall(event.id, event.status, event.result);
              break;
            case "error":
              appendText(`\n\n错误: ${event.message}`);
              break;
            case "done":
              break;
          }
        },
        signal,
      );
    } catch (error) {
      if (!signal.aborted) {
        const message = error instanceof Error ? error.message : String(error);
        appendText(`\n\n错误: ${message}`);
      }
    } finally {
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === assistantId ? { ...msg, isStreaming: false } : msg,
        ),
      );
      setIsRunning(false);
      abortRef.current = null;
    }
  }, [isRunning]);

  const onNewRef = useRef<(message: AppendMessage) => Promise<void>>(undefined);
  onNewRef.current = async (message) => {
    await runGeneration(extractAppendText(message));
  };

  const handleCancel = useCallback(async () => {
    abortRef.current?.abort();
    await cancelDebugPrompt();
    setIsRunning(false);
  }, []);

  const adapter = useMemo<ExternalStoreAdapter>(
    () => ({
      messages: threadMessages.length > 0 ? threadMessages : EMPTY_MESSAGES,
      isRunning,
      onNew: (msg) => onNewRef.current!(msg),
      setMessages: () => {},
      onCancel: handleCancel,
    }),
    [threadMessages, isRunning, handleCancel],
  );

  const runtime = useExternalStoreRuntime(adapter);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {children}
    </AssistantRuntimeProvider>
  );
}

export function useDebugMessagesReset(onReset: () => void) {
  return onReset;
}
