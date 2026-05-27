import { useEffect, useRef, useState, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useAiStore } from "../../stores/aiStore";
import { useTerminalStore } from "../../stores/terminalStore";
import type { AiMessage, ToolCallState } from "../../stores/aiStore";
import { IconRobot } from "../ui/Icons";
import { CommandSuggestion, isShellLanguage } from "./CommandSuggestion";

function extractText(node: unknown): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (!node || typeof node !== "object") return "";
  if (Array.isArray(node)) return node.map(extractText).join("");
  const el = node as { props?: { children?: unknown } };
  if (el.props?.children) return extractText(el.props.children);
  return "";
}

// ─── Tool Call Display ───

function ToolCallView({ tc }: { tc: ToolCallState }) {
  const [expanded, setExpanded] = useState(false);

  const statusIcon = {
    pending: "⏳",
    running: "▶️",
    completed: "✅",
    failed: "❌",
  }[tc.status];

  return (
    <div className="border border-border rounded-md overflow-hidden my-1">
      <button
        className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-fg-2 hover:bg-surface-hover transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <span>{statusIcon}</span>
        <span className="font-mono text-accent">{tc.name}</span>
        <span className="text-muted truncate flex-1 text-left">
          {tc.arguments.slice(0, 60)}
          {tc.arguments.length > 60 ? "..." : ""}
        </span>
        <span className="text-muted">{expanded ? "▾" : "▸"}</span>
      </button>
      {expanded && (
        <div className="border-t border-border px-3 py-2 text-xs">
          <div className="text-meta mb-1">Arguments:</div>
          <pre className="bg-bg-deeper rounded p-2 overflow-x-auto text-fg-2 whitespace-pre-wrap break-all">
            {tc.arguments}
          </pre>
          {tc.result && (
            <>
              <div className="text-meta mt-2 mb-1">Result:</div>
              <pre className="bg-bg-deeper rounded p-2 overflow-x-auto text-fg-2 whitespace-pre-wrap break-all">
                {tc.result}
              </pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Message Bubble ───

function MessageBubble({ msg }: { msg: AiMessage }) {
  const isUser = msg.role === "user";
  const isAssistant = msg.role === "assistant";
  const activeTabId = useTerminalStore((s) => s.activeTabId);
  const tabs = useTerminalStore((s) => s.tabs);

  const handleRunInTerminal = useCallback(
    (command: string) => {
      const tab = tabs.find((t) => t.id === activeTabId);
      if (tab?.terminal) {
        tab.terminal.write(command + "\r");
      }
    },
    [tabs, activeTabId]
  );

  return (
    <div className={`flex gap-2 ${isUser ? "flex-row-reverse" : "flex-row"}`}>
      <div
        className={`w-6 h-6 rounded-md flex items-center justify-center shrink-0 text-xs ${
          isAssistant ? "bg-accent text-white" : "bg-surface text-fg-2"
        }`}
      >
        {isAssistant ? <IconRobot size={14} /> : <span>U</span>}
      </div>

      <div className={`flex-1 min-w-0 ${isUser ? "text-right" : ""}`}>
        <div
          className={`inline-block text-left text-sm leading-relaxed max-w-full ${
            isUser
              ? "bg-accent/15 text-fg rounded-lg px-3 py-2"
              : "text-fg-2"
          }`}
        >
          {isUser ? (
            <span className="whitespace-pre-wrap">{msg.content}</span>
          ) : (
            <div className="prose-ai">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  pre({ children, ...props }) {
                    const codeChild = Array.isArray(children)
                      ? children.find((c: any) => c?.type === "code" || c?.props?.className)
                      : children;
                    const codeProps = (codeChild as any)?.props;
                    const className = codeProps?.className || "";
                    const lang = className.replace(/^language-/, "");
                    const code = extractText(codeProps?.children).replace(/\n$/, "");

                    if (isShellLanguage(lang) && code) {
                      return (
                        <CommandSuggestion
                          code={code}
                          language={lang}
                          onRunInTerminal={handleRunInTerminal}
                        />
                      );
                    }
                    return <pre {...props}>{children}</pre>;
                  },
                  code({ inline, className, children, ...props }) {
                    return (
                      <code className={className} {...props}>
                        {children}
                      </code>
                    );
                  },
                }}
              >
                {msg.content || (msg.isStreaming ? "..." : "")}
              </ReactMarkdown>
              {msg.isStreaming && (
                <span className="inline-block w-1.5 h-4 bg-accent animate-pulse ml-0.5 align-text-bottom" />
              )}
            </div>
          )}
        </div>

        {msg.toolCalls && msg.toolCalls.length > 0 && (
          <div className="mt-1">
            {msg.toolCalls.map((tc) => (
              <ToolCallView key={tc.id} tc={tc} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Conversation Switcher ───

function ConversationSwitcher() {
  const conversations = useAiStore((s) => s.conversations);
  const activeId = useAiStore((s) => s.activeConversationId);
  const setActive = useAiStore((s) => s.setActiveConversation);
  const createConversation = useAiStore((s) => s.createConversation);
  const deleteConversation = useAiStore((s) => s.deleteConversation);

  const [showList, setShowList] = useState(false);

  const active = conversations.find((c) => c.id === activeId);

  return (
    <div className="relative">
      <div className="flex items-center gap-1 px-3 py-1.5 border-b border-border">
        <button
          className="flex-1 flex items-center gap-2 text-xs text-fg-2 hover:text-fg transition-colors truncate"
          onClick={() => setShowList(!showList)}
        >
          <span className="truncate">{active?.title || "No conversation"}</span>
          <span className="text-muted">{showList ? "▾" : "▸"}</span>
        </button>
        <button
          className="w-6 h-6 flex items-center justify-center rounded text-muted hover:text-fg hover:bg-surface-hover transition-colors"
          title="New conversation"
          onClick={() => createConversation()}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      </div>

      {showList && (
        <div className="absolute top-full left-0 right-0 z-50 bg-bg-deeper border border-border rounded-b-md shadow-lg max-h-48 overflow-y-auto">
          {conversations.length === 0 ? (
            <div className="px-3 py-2 text-xs text-muted">No conversations</div>
          ) : (
            conversations.map((c) => (
              <div
                key={c.id}
                className={`flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer transition-colors ${
                  c.id === activeId
                    ? "bg-accent/10 text-accent"
                    : "text-fg-2 hover:bg-surface-hover"
                }`}
                onClick={() => {
                  setActive(c.id);
                  setShowList(false);
                }}
              >
                <span className="flex-1 truncate">{c.title}</span>
                <span className="text-muted text-[10px]">
                  {new Date(c.updatedAt).toLocaleDateString()}
                </span>
                <button
                  className="w-4 h-4 flex items-center justify-center text-muted hover:text-danger"
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteConversation(c.id);
                  }}
                  title="Delete"
                >
                  &times;
                </button>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ─── Shared: useAiChat hook ───

function useAiChat() {
  const conversations = useAiStore((s) => s.conversations);
  const activeConversationId = useAiStore((s) => s.activeConversationId);
  const isGenerating = useAiStore((s) => s.isGenerating);
  const addMessage = useAiStore((s) => s.addMessage);
  const updateMessage = useAiStore((s) => s.updateMessage);
  const appendStreamContent = useAiStore((s) => s.appendStreamContent);
  const createConversation = useAiStore((s) => s.createConversation);
  const setIsGenerating = useAiStore((s) => s.setIsGenerating);
  const addContext = useAiStore((s) => s.addContext);
  const removeContext = useAiStore((s) => s.removeContext);

  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const activeConversation = conversations.find(
    (c) => c.id === activeConversationId
  );

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [activeConversation?.messages.length, activeConversation?.messages]);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height =
        Math.min(textareaRef.current.scrollHeight, 100) + "px";
    }
  }, [input]);

  const handleSend = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || isGenerating) return;

    let convId = activeConversationId;
    if (!convId) {
      convId = createConversation();
    }

    addMessage(convId, { role: "user", content: trimmed });
    setInput("");

    const assistantMsgId = addMessage(convId, {
      role: "assistant",
      content: "",
      isStreaming: true,
    });

    setIsGenerating(true);

    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const { listen } = await import("@tauri-apps/api/event");

      let unlistenFn: (() => void) | null = null;

      try {
        unlistenFn = await listen<any>(
          `ai-stream-${convId}`,
          (event) => {
            const evt = event.payload;
            switch (evt.type) {
              case "content_delta":
                appendStreamContent(convId!, assistantMsgId, evt.text);
                break;
              case "tool_call": {
                const conv = useAiStore.getState().conversations.find((c) => c.id === convId);
                const msg = conv?.messages.find((m) => m.id === assistantMsgId);
                const existing = msg?.toolCalls || [];
                updateMessage(convId!, assistantMsgId, {
                  toolCalls: [
                    ...existing,
                    {
                      id: evt.id,
                      name: evt.name,
                      arguments: evt.arguments,
                      status: "running" as const,
                    },
                  ],
                });
                break;
              }
              case "tool_call_update": {
                const conv2 = useAiStore.getState().conversations.find((c) => c.id === convId);
                const msg2 = conv2?.messages.find((m) => m.id === assistantMsgId);
                if (msg2?.toolCalls) {
                  updateMessage(convId!, assistantMsgId, {
                    toolCalls: msg2.toolCalls.map((tc) =>
                      tc.id === evt.id
                        ? { ...tc, status: evt.status ?? tc.status, result: evt.result ?? tc.result }
                        : tc
                    ),
                  });
                }
                break;
              }
              case "done":
                updateMessage(convId!, assistantMsgId, { isStreaming: false });
                break;
              case "error":
                appendStreamContent(convId!, assistantMsgId, `\n\n⚠️ Error: ${evt.message}`);
                updateMessage(convId!, assistantMsgId, { isStreaming: false });
                break;
            }
          }
        );

        await invoke("ai_send_message", {
          conversationId: convId,
          content: trimmed,
        });
      } finally {
        unlistenFn?.();
      }
    } catch (err) {
      appendStreamContent(convId, assistantMsgId, `\n\n⚠️ Failed to send message: ${err}`);
      updateMessage(convId, assistantMsgId, { isStreaming: false });
    } finally {
      setIsGenerating(false);
    }
  }, [
    input,
    isGenerating,
    activeConversationId,
    createConversation,
    addMessage,
    appendStreamContent,
    updateMessage,
    setIsGenerating,
  ]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return {
    input,
    setInput,
    messagesEndRef,
    textareaRef,
    activeConversation,
    activeConversationId,
    isGenerating,
    handleSend,
    handleKeyDown,
    addContext,
    removeContext,
  };
}

// ─── Shared: Panel header + content ───

function AiPanelHeader({ onPinToggle, onClose, isPinned }: {
  onPinToggle: () => void;
  onClose: () => void;
  isPinned: boolean;
}) {
  const currentModel = useAiStore((s) => s.currentModel);

  return (
    <div
      className="flex items-center gap-2 px-3 h-10 border-b border-border shrink-0 select-none"
      onDoubleClick={onPinToggle}
    >
      <IconRobot size={16} className="text-accent shrink-0" />
      <span className="text-sm font-medium text-fg flex-1">AI Assistant</span>
      <span className="text-[10px] text-muted bg-surface px-1.5 py-0.5 rounded">
        {currentModel}
      </span>
      <button
        className="w-6 h-6 flex items-center justify-center rounded text-muted hover:text-fg hover:bg-surface-hover transition-colors"
        title={isPinned ? "Unpin (drawer mode)" : "Pin (fixed panel)"}
        onClick={onPinToggle}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill={isPinned ? "currentColor" : "none"}
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M12 17v5 M9 10.76a2 2 0 01-1.11 1.79l-1.78.9A2 2 0 005 15.24V16h14v-.76a2 2 0 00-1.11-1.79l-1.78-.9A2 2 0 0115 10.76V7a1 1 0 011-1 2 2 0 002-2H6a2 2 0 002 2 1 1 0 011 1z" />
        </svg>
      </button>
      <button
        className="w-6 h-6 flex items-center justify-center rounded text-muted hover:text-fg hover:bg-surface-hover transition-colors"
        title="Close (Ctrl+L)"
        onClick={onClose}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}

function AiPanelBody() {
  const {
    input,
    setInput,
    messagesEndRef,
    textareaRef,
    activeConversation,
    activeConversationId,
    isGenerating,
    handleSend,
    handleKeyDown,
    addContext,
    removeContext,
  } = useAiChat();

  return (
    <>
      <ConversationSwitcher />

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3 min-h-0">
        {!activeConversation || activeConversation.messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <IconRobot size={32} className="text-muted mb-3" />
            <p className="text-sm text-muted mb-1">How can I help?</p>
            <p className="text-xs text-meta">
              Ask anything about your project, code, or infrastructure.
            </p>
          </div>
        ) : (
          activeConversation.messages.map((msg) => (
            <MessageBubble key={msg.id} msg={msg} />
          ))
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Context Chips */}
      <div className="flex flex-wrap gap-1 px-3 py-1.5 border-t border-border">
        {(activeConversation?.context || []).map((ctx) => (
          <span
            key={ctx.type}
            className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] bg-surface text-fg-2 rounded-full border border-border"
          >
            {ctx.label}
            <button
              onClick={() => activeConversation && removeContext(activeConversation.id, ctx.type)}
              className="text-meta hover:text-fg ml-0.5"
              style={{ fontSize: 12, lineHeight: 1 }}
            >
              &times;
            </button>
          </span>
        ))}
        <button
          onClick={() => {
            if (activeConversation) {
              addContext(activeConversation.id, { type: "terminal", label: "Terminal" });
            }
          }}
          className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] text-muted hover:text-fg transition-colors"
        >
          + context
        </button>
      </div>

      {/* Input */}
      <div className="px-3 pb-3 pt-1 shrink-0">
        <div className="flex items-end gap-2 bg-surface border border-border rounded-lg px-3 py-2 focus-within:border-accent/50 transition-colors">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask AI anything..."
            rows={1}
            className="flex-1 bg-transparent text-sm text-fg placeholder:text-muted outline-none resize-none min-h-[20px] max-h-[100px]"
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || isGenerating}
            className="w-7 h-7 flex items-center justify-center rounded-md bg-accent text-white disabled:opacity-40 disabled:cursor-not-allowed hover:bg-accent/80 transition-colors shrink-0"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M22 2L11 13M22 2l-7 20-4-9-9-4z" />
            </svg>
          </button>
        </div>
        <div className="flex items-center justify-between mt-1">
          <span className="text-[10px] text-meta">Shift+Enter for new line</span>
          <span className="text-[10px] text-meta">Ctrl+L to toggle</span>
        </div>
      </div>
    </>
  );
}

// ─── Exported: AiDrawer (overlay, drawer mode only) ───

export function AiDrawer() {
  const drawerOpen = useAiStore((s) => s.drawerOpen);
  const drawerMode = useAiStore((s) => s.drawerMode);
  const closeDrawer = useAiStore((s) => s.closeDrawer);
  const setDrawerMode = useAiStore((s) => s.setDrawerMode);

  const isDrawerMode = drawerOpen && drawerMode === "drawer";

  // Skip animation when switching between pinned ↔ drawer (panel is already visible)
  const [noTransition, setNoTransition] = useState(false);
  const prevModeRef = useRef<{ open: boolean; mode: "drawer" | "pinned" }>({
    open: drawerOpen,
    mode: drawerMode,
  });

  useEffect(() => {
    const prev = prevModeRef.current;
    const switchedMode = prev.open && drawerOpen && prev.mode !== drawerMode;
    prevModeRef.current = { open: drawerOpen, mode: drawerMode };
    if (switchedMode) {
      setNoTransition(true);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setNoTransition(false));
      });
    }
  }, [drawerOpen, drawerMode]);

  // Ctrl+L toggle (global)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "l") {
        e.preventDefault();
        useAiStore.getState().toggleDrawer();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Escape to close (only in drawer mode)
  useEffect(() => {
    if (!isDrawerMode) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeDrawer();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isDrawerMode, closeDrawer]);

  return (
    <>
      <div
        className={`ai-drawer-backdrop${isDrawerMode ? " open" : ""}`}
        onClick={closeDrawer}
      />
      <div
        className={`ai-drawer-overlay${isDrawerMode ? " open" : ""}${noTransition ? " notransition" : ""}`}
      >
        <AiPanelHeader
          isPinned={false}
          onPinToggle={() => setDrawerMode("pinned")}
          onClose={closeDrawer}
        />
        <AiPanelBody />
      </div>
    </>
  );
}

// ─── Exported: AiPinnedPanel (inline, inside content area) ───

export function AiPinnedPanel() {
  const setDrawerMode = useAiStore((s) => s.setDrawerMode);

  return (
    <div className="ai-pinned-panel">
      <AiPanelHeader
        isPinned={true}
        onPinToggle={() => setDrawerMode("drawer")}
        onClose={() => useAiStore.getState().closeDrawer()}
      />
      <AiPanelBody />
    </div>
  );
}
