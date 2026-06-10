import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useAiStore } from "../../stores/aiStore";
import { useTerminalStore } from "../../stores/terminalStore";
import { useActionStore } from "../../stores/actionStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { getResourceById } from "../../lib/resourceRegistry";
import type { AiConversation, AiMessage, ToolCallState } from "../../stores/aiStore";
import { IconRobot } from "../ui/Icons";
import { SubWindow } from "../ui/SubWindow";
import { SidebarWorkspace } from "../ui/SidebarWorkspace";
import { CommandSuggestion, isShellLanguage } from "./CommandSuggestion";
import { useI18n } from "../../i18n";
import { formatShortcut, useShortcutsStore } from "../../stores/shortcutsStore";
import { KnowledgeReferences } from "./KnowledgeReferences";

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

        {/* Knowledge References: extract search_knowledge results */}
        {msg.toolCalls
          ?.filter((tc) => tc.name === "search_knowledge" && tc.result && tc.status === "completed")
          .map((tc) => (
            <KnowledgeReferences key={`ref-${tc.id}`} result={tc.result!} />
          ))}
      </div>
    </div>
  );
}

// ─── Session List (sidebar) ───

function formatRelativeShort(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  return new Date(ts).toLocaleDateString();
}

export function AiSessionList({ rail = "left" }: { rail?: "left" | "right" }) {
  const { t } = useI18n();
  const conversations = useAiStore((s) => s.conversations);
  const activeId = useAiStore((s) => s.activeConversationId);
  const setActive = useAiStore((s) => s.setActiveConversation);
  const createConversation = useAiStore((s) => s.createConversation);
  const deleteConversation = useAiStore((s) => s.deleteConversation);

  const handleCreate = () => {
    createConversation();
  };

  return (
    <aside
      className={`ai-session-list${rail === "right" ? " ai-session-list--right" : ""}`}
    >
      <div className="ai-session-list-header">
        <span className="ai-session-list-title">{t("ai.sessionList.title")}</span>
        <button
          type="button"
          className="ai-session-list-add"
          title={t("ai.newConversation")}
          aria-label={t("ai.newConversation")}
          onClick={handleCreate}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      </div>

      <div className="ai-session-list-body">
        {conversations.length === 0 ? (
          <div className="ai-session-list-empty">{t("ai.noConversation")}</div>
        ) : (
          conversations.map((c) => (
            <SessionRow
              key={c.id}
              conv={c}
              active={c.id === activeId}
              onSelect={() => setActive(c.id)}
              onDelete={() => deleteConversation(c.id)}
              deleteTitle={t("ai.sessionList.delete")}
              emptyLabel={t("ai.sessionList.empty")}
            />
          ))
        )}
      </div>
    </aside>
  );
}

function SessionRow({
  conv,
  active,
  onSelect,
  onDelete,
  deleteTitle,
  emptyLabel,
}: {
  conv: AiConversation;
  active: boolean;
  onSelect: () => void;
  onDelete: () => void;
  deleteTitle: string;
  emptyLabel: string;
}) {
  return (
    <div
      className={`ai-session-row ${active ? "active" : ""}`}
      onClick={onSelect}
      title={conv.title}
    >
      <div className="ai-session-row-main">
        <span className="ai-session-row-title">{conv.title}</span>
        <span className="ai-session-row-meta">
          {conv.messages.length > 0 ? `${conv.messages.length} msgs` : emptyLabel}
          <span className="ai-session-row-dot">·</span>
          {formatRelativeShort(conv.updatedAt)}
        </span>
      </div>
      <button
        type="button"
        className="ai-session-row-delete"
        title={deleteTitle}
        aria-label={deleteTitle}
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
        </svg>
      </button>
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

        // Collect conversation history (all messages except the current empty
        // assistant placeholder) so the LLM sees the full multi-turn context.
        // Limit to the last 20 messages to avoid blowing token limits.
        const MAX_HISTORY = 20;
        const convState = useAiStore.getState().conversations.find((c) => c.id === convId);
        const historyMessages = convState?.messages ?? [];
        // Drop the last entry which is the empty assistant placeholder we just added
        const priorMessages = historyMessages.slice(0, -1);
        const historySlice = priorMessages.slice(-MAX_HISTORY).map((m) => ({
          role: m.role,
          content: m.content,
        }));

        await invoke("ai_send_message", {
          conversationId: convId,
          content: trimmed,
          history: historySlice,
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

export function AiPanelBody() {
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
  const aiKeysOverride = useShortcutsStore((s) => s.overrides["toggle-ai"]);
  const aiShortcutLabel = useMemo(
    () => formatShortcut(aiKeysOverride ?? ["Mod", "`"]),
    [aiKeysOverride]
  );

  return (
    <div className="ai-chat-pane">
      <div className="ai-context-strip">
        <div className="ai-context-row">
          <span className="ai-context-label">{t("ai.currentContext")}</span>
          <span className={`env-badge env-${environment}`}>
            {t(`env.${environment}`)}
          </span>
        </div>
        <div className="ai-context-main">
          <span>{activeResource ? activeResource.name : workspace.name}</span>
          {activeResource && (
            <span className="text-meta">
              {t(`resourceType.${activeResource.type}`)} · {activeResource.subtitle}
            </span>
          )}
        </div>
        {recentActions.length > 0 && (
          <div className="ai-action-preview">
            {recentActions.map((action) => (
              <span key={action.id} className={`action-chip action-${action.status}`}>
                {action.title}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="ai-message-list">
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
      <div className="ai-context-chip-bar">
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

      <div className="ai-input-shell">
        <div className="ai-input-shell-inner">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="询问当前资源、命令、SQL 或排障流程..."
            rows={1}
            className="ai-input-textarea"
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
          <span className="text-[10px] text-meta">
            {t("ai.toggleHint", { shortcut: aiShortcutLabel })}
          </span>
        </div>
      </div>
    </div>
  );
}

// ─── Exported: AiDrawer (SubWindow) ───

export function AiDrawer() {
  const { t } = useI18n();
  const drawerOpen = useAiStore((s) => s.drawerOpen);
  const closeDrawer = useAiStore((s) => s.closeDrawer);
  const currentModel = useAiStore((s) => s.currentModel);
  const activeConversation = useAiStore((s) =>
    s.conversations.find((c) => c.id === s.activeConversationId) ?? null
  );

  const title = activeConversation
    ? `${t("ai.title")} · ${activeConversation.title}`
    : `${t("ai.title")} · ${currentModel}`;

  return (
    <SubWindow
      open={drawerOpen}
      title={title}
      onClose={closeDrawer}
      className="ai-subwindow"
      widthRatio={0.82}
      heightRatio={0.85}
    >
      <SidebarWorkspace
        preset="ai"
        className="ai-subwindow-content"
        sidebar={<AiSessionList />}
      >
        <AiPanelBody />
      </SidebarWorkspace>
    </SubWindow>
  );
}
