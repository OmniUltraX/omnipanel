import { useEffect, useRef, useState, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useAiStore } from "../../stores/aiStore";
import { useTerminalStore } from "../../stores/terminalStore";
import { useActionStore } from "../../stores/actionStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { getResourceById } from "../../lib/resourceRegistry";
import type { AiMessage, ToolCallState } from "../../stores/aiStore";
import { IconRobot } from "../ui/Icons";
import { CommandSuggestion, isShellLanguage } from "./CommandSuggestion";
import { useI18n } from "../../i18n";

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
    pending: "待处理",
    running: "执行中",
    completed: "完成",
    failed: "失败",
  }[tc.status];

  return (
    <div className="border border-border rounded-md overflow-hidden my-1">
      <button
        className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-fg-2 hover:bg-surface-hover transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="text-[10px] text-meta">{statusIcon}</span>
        <span className="font-mono text-accent">{tc.name}</span>
        <span className="text-muted truncate flex-1 text-left">
          {tc.arguments.slice(0, 60)}
          {tc.arguments.length > 60 ? "..." : ""}
        </span>
        <span className="text-muted">{expanded ? "▾" : "▸"}</span>
      </button>
      {expanded && (
        <div className="border-t border-border px-3 py-2 text-xs">
          <div className="text-meta mb-1">参数：</div>
          <pre className="bg-bg-deeper rounded p-2 overflow-x-auto text-fg-2 whitespace-pre-wrap break-all">
            {tc.arguments}
          </pre>
          {tc.result && (
            <>
              <div className="text-meta mt-2 mb-1">结果：</div>
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
      const activePane = tab?.panes.find((pane) => pane.id === tab.activePaneId) ?? tab?.panes[0];
      if (activePane?.terminal) {
        activePane.terminal.write(command + "\r");
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
                      ? // eslint-disable-next-line @typescript-eslint/no-explicit-any -- react-markdown 节点为复杂联合类型，此处互操作
                        children.find((c: any) => c?.type === "code" || c?.props?.className)
                      : children;
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上，react-markdown 节点互操作
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
                  code({ className, children, ...props }) {
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

function ConversationSwitcher({ compact = false }: { compact?: boolean }) {
  const { t } = useI18n();
  const conversations = useAiStore((s) => s.conversations);
  const activeId = useAiStore((s) => s.activeConversationId);
  const setActive = useAiStore((s) => s.setActiveConversation);
  const createConversation = useAiStore((s) => s.createConversation);
  const deleteConversation = useAiStore((s) => s.deleteConversation);

  const [showList, setShowList] = useState(false);

  const active = conversations.find((c) => c.id === activeId);

  return (
    <div className={`ai-conversation-switcher${compact ? " compact" : ""}`}>
      <div className="ai-conversation-switcher-bar">
        <button
          className="ai-conversation-trigger"
          onClick={() => setShowList(!showList)}
        >
          <span className="truncate">{active?.title || t("ai.noConversation")}</span>
          <span className="text-muted">{showList ? "▾" : "▸"}</span>
        </button>
        <button
          className="ai-conversation-add"
          title={t("ai.newConversation")}
          onClick={() => createConversation()}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      </div>

      {showList && (
        <div className="ai-conversation-list">
          {conversations.length === 0 ? (
            <div className="px-3 py-2 text-xs text-muted">{t("ai.noConversation")}</div>
          ) : (
            conversations.map((c) => (
              <div
                key={c.id}
                className={`ai-conversation-row ${c.id === activeId ? "active" : ""}`}
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
                  title="删除"
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
  const draftPrompt = useAiStore((s) => s.draftPrompt);
  const clearDraftPrompt = useAiStore((s) => s.clearDraftPrompt);

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

  useEffect(() => {
    if (!draftPrompt) return;
    setInput(draftPrompt);
    clearDraftPrompt();
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [clearDraftPrompt, draftPrompt]);

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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AI 流式事件 payload 为后端动态联合类型
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
          appendStreamContent(convId!, assistantMsgId, `\n\n错误：${evt.message}`);
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
      appendStreamContent(convId, assistantMsgId, `\n\n发送失败：${err}`);
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

function AiPanelHeader({ onPinToggle, onClose, isPinned, compact = false }: {
  onPinToggle: () => void;
  onClose: () => void;
  isPinned: boolean;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const currentModel = useAiStore((s) => s.currentModel);

  return (
    <div
      className={`ai-shell-header${compact ? " compact" : ""}`}
      onDoubleClick={onPinToggle}
    >
      <IconRobot size={16} className="text-accent shrink-0" />
      <span className="ai-shell-title">{t("ai.title")}</span>
      <span className="ai-shell-model">{currentModel}</span>
      <button
        className="ai-shell-icon-btn"
        title={isPinned ? "取消固定" : "固定到右侧"}
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
        className="ai-shell-icon-btn"
        title="关闭 (Ctrl+L)"
        onClick={onClose}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}

function AiPanelBody({ compact = false }: { compact?: boolean }) {
  const { t } = useI18n();
  const {
    input,
    setInput,
    messagesEndRef,
    textareaRef,
    activeConversation,
    activeConversationId: _activeConversationId,
    isGenerating,
    handleSend,
    handleKeyDown,
    addContext,
    removeContext,
  } = useAiChat();
  const workspace = useWorkspaceStore((s) => s.workspace);
  const activeResourceId = useWorkspaceStore((s) => s.activeResourceId);
  const actions = useActionStore((s) => s.actions);
  const activeResource = getResourceById(activeResourceId);
  const environment = activeResource?.environment ?? "unknown";
  const recentActions = actions.slice(0, 3);

  return (
    <>
      <ConversationSwitcher compact={compact} />

      <div className={`ai-context-strip${compact ? " compact" : ""}`}>
        <div className="ai-context-row">
          <span className="ai-context-label">{t("ai.currentContext")}</span>
          <span className={`env-badge env-${environment}`}>
            {t(`env.${environment}`)}
          </span>
        </div>
        <div className="ai-context-main">
          <span>{activeResource ? activeResource.name : workspace.name}</span>
          {!compact && activeResource && (
            <span className="text-meta">
              {t(`resourceType.${activeResource.type}`)} · {activeResource.subtitle}
            </span>
          )}
        </div>
        {!compact && recentActions.length > 0 && (
          <div className="ai-action-preview">
            {recentActions.map((action) => (
              <span key={action.id} className={`action-chip action-${action.status}`}>
                {action.title}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className={`ai-message-list${compact ? " compact" : ""}`}>
        {!activeConversation || activeConversation.messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <IconRobot size={32} className="text-muted mb-3" />
            <p className="text-sm text-muted mb-1">{t("ai.emptyTitle")}</p>
            <p className="text-xs text-meta">
              {t("ai.emptyHint")}
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
      <div className={`ai-context-chip-bar${compact ? " compact" : ""}`}>
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
          添加上下文
        </button>
      </div>

      <div className={`ai-input-shell${compact ? " compact" : ""}`}>
        <div className="ai-input-shell-inner">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="询问当前资源、命令、SQL 或排障流程..."
            rows={1}
            className={`ai-input-textarea${compact ? " compact" : ""}`}
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || isGenerating}
            className="ai-input-send"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M22 2L11 13M22 2l-7 20-4-9-9-4z" />
            </svg>
          </button>
        </div>
        <div className="ai-input-hint-row">
          <span className="text-[10px] text-meta">Shift+Enter 换行</span>
          <span className="text-[10px] text-meta">Ctrl+L 切换</span>
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
      />
      <div
        className={`ai-drawer-overlay${isDrawerMode ? " open" : ""}${noTransition ? " notransition" : ""}`}
      >
        <AiPanelHeader
          isPinned={false}
          compact={false}
          onPinToggle={() => setDrawerMode("pinned")}
          onClose={closeDrawer}
        />
        <AiPanelBody compact={false} />
      </div>
    </>
  );
}

// ─── Exported: AiPinnedPanel (inline, inside content area) ───

export function AiPinnedPanel() {
  const setDrawerMode = useAiStore((s) => s.setDrawerMode);

  return (
    <div className="ai-pinned-panel ai-pinned-panel--compact">
      <AiPanelHeader
        isPinned={true}
        compact={true}
        onPinToggle={() => setDrawerMode("drawer")}
        onClose={() => useAiStore.getState().closeDrawer()}
      />
      <AiPanelBody compact={true} />
    </div>
  );
}
