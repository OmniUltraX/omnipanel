import { useCallback, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useAiStore } from "../../stores/aiStore";
import { useTerminalStore } from "../../stores/terminalStore";
import type { AiMessage, ToolCallState } from "../../stores/aiStore";
import { IconRobot } from "../ui/Icons";
import { SubWindow } from "../ui/SubWindow";
import { CommandSuggestion, isShellLanguage } from "./CommandSuggestion";
import { useI18n } from "../../i18n";
import { formatShortcut, useShortcutsStore } from "../../stores/shortcutsStore";
import { KnowledgeReferences } from "./KnowledgeReferences";
import { ReasoningBlock } from "./ReasoningBlock";
import { useAiChat } from "./useAiChat";
import { AiMcpConnections } from "./AiMcpConnections";
import { AiModelSelect } from "./AiModelSelect";
import { AiReasoningEffortSelect } from "./AiReasoningEffortSelect";

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
    <div className={`ai-tool-call${expanded ? " is-expanded" : ""}`}>
      <button
        type="button"
        className="ai-tool-call-header"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="ai-tool-call-status">{statusIcon}</span>
        <span className="ai-tool-call-name">{tc.name}</span>
        <span className="ai-tool-call-args">
          {tc.arguments.slice(0, 60)}
          {tc.arguments.length > 60 ? "..." : ""}
        </span>
        <span className="ai-tool-call-chevron">{expanded ? "▾" : "▸"}</span>
      </button>
      {expanded && (
        <div className="ai-tool-call-body">
          <div className="ai-tool-call-label">参数：</div>
          <pre className="ai-tool-call-pre">{tc.arguments}</pre>
          {tc.result && (
            <>
              <div className="ai-tool-call-label">结果：</div>
              <pre className="ai-tool-call-pre">{tc.result}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Message Bubble ───

function StreamingCursor() {
  return <span className="ai-stream-cursor" aria-hidden />;
}

function MessageBubble({ msg, isLast }: { msg: AiMessage; isLast?: boolean }) {
  const isUser = msg.role === "user";
  const isAssistant = msg.role === "assistant";
  const isActiveStream = Boolean(isAssistant && msg.isStreaming && isLast);
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

  const showTyping =
    isActiveStream &&
    !msg.content &&
    !msg.reasoningContent &&
    !msg.isReasoningStreaming;

  return (
    <div
      className={`ai-msg ${isUser ? "ai-msg--user" : "ai-msg--assistant"}${isActiveStream ? " ai-msg--streaming" : ""}`}
    >
      <div
        className={`ai-msg-avatar${isAssistant ? " ai-msg-avatar--bot" : " ai-msg-avatar--user"}${isActiveStream ? " ai-msg-avatar--live" : ""}`}
      >
        {isAssistant ? <IconRobot size={15} /> : <span>U</span>}
        {isActiveStream && <span className="ai-msg-avatar-ring" aria-hidden />}
      </div>

      <div className="ai-msg-body">
        <div
          className={`ai-msg-bubble${isUser ? " ai-msg-bubble--user" : " ai-msg-bubble--assistant"}${isActiveStream ? " ai-msg-bubble--live" : ""}`}
        >
          {isUser ? (
            <span className="ai-msg-user-text">{msg.content}</span>
          ) : (
            <>
              {(msg.reasoningContent || msg.isReasoningStreaming || (isActiveStream && !msg.content)) && (
                <ReasoningBlock
                  content={msg.reasoningContent ?? ""}
                  isStreaming={Boolean(msg.isReasoningStreaming || (isActiveStream && !msg.content && !msg.reasoningContent))}
                  hasAnswer={Boolean(msg.content)}
                />
              )}
              {showTyping ? (
                <div className="ai-typing-indicator" aria-label="正在生成">
                  <span />
                  <span />
                  <span />
                </div>
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
                    {msg.content}
                  </ReactMarkdown>
                  {isActiveStream && msg.content && <StreamingCursor />}
                </div>
              )}
            </>
          )}
        </div>

        {msg.toolCalls && msg.toolCalls.length > 0 && (
          <div className="ai-msg-tools">
            {msg.toolCalls.map((tc) => (
              <ToolCallView key={tc.id} tc={tc} />
            ))}
          </div>
        )}

        {msg.toolCalls
          ?.filter((tc) => tc.name === "search_knowledge" && tc.result && tc.status === "completed")
          .map((tc) => (
            <KnowledgeReferences key={`ref-${tc.id}`} result={tc.result!} />
          ))}
      </div>
    </div>
  );
}

// ─── Shared: useAiChat hook（LangChain 流式对话） ───

export function AiPanelBody() {
  const { t } = useI18n();
  const {
    input,
    setInput,
    messagesEndRef,
    textareaRef,
    activeConversation,
    isGenerating,
    handleSend,
    handleKeyDown,
    addContext,
    removeContext,
  } = useAiChat();
  const aiKeysOverride = useShortcutsStore((s) => s.overrides["toggle-ai"]);
  const aiShortcutLabel = useMemo(
    () => formatShortcut(aiKeysOverride ?? ["Mod", "`"]),
    [aiKeysOverride]
  );

  return (
    <div className={`ai-chat-pane${isGenerating ? " is-generating" : ""}`}>
      <div className="ai-message-list">
        <div className="ai-message-list-bg" aria-hidden />
        {!activeConversation || activeConversation.messages.length === 0 ? (
          <div className="ai-empty-state">
            <div className="ai-empty-orbs" aria-hidden>
              <span className="ai-empty-orb ai-empty-orb--1" />
              <span className="ai-empty-orb ai-empty-orb--2" />
              <span className="ai-empty-orb ai-empty-orb--3" />
            </div>
            <div className="ai-empty-icon-wrap">
              <IconRobot size={36} className="ai-empty-icon" />
            </div>
            <p className="ai-empty-title">{t("ai.emptyTitle")}</p>
            <p className="ai-empty-hint">{t("ai.emptyHint")}</p>
          </div>
        ) : (
          activeConversation.messages.map((msg, i, arr) => (
            <MessageBubble
              key={msg.id}
              msg={msg}
              isLast={i === arr.length - 1}
            />
          ))
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Context Chips */}
      <div className="ai-context-chip-bar">
        {(activeConversation?.context || []).map((ctx) => (
          <span key={ctx.type} className="ai-context-chip">
            {ctx.label}
            <button
              onClick={() => activeConversation && removeContext(activeConversation.id, ctx.type)}
              className="ai-context-chip-remove"
              type="button"
              aria-label="移除"
            >
              &times;
            </button>
          </span>
        ))}
        <button
          type="button"
          onClick={() => {
            if (activeConversation) {
              addContext(activeConversation.id, { type: "terminal", label: "Terminal" });
            }
          }}
          className="ai-context-chip-add"
        >
          {t("ai.addContext")}
        </button>
      </div>

      <div className="ai-input-shell">
        <div className={`ai-input-shell-inner${isGenerating ? " is-busy" : ""}`}>
          {isGenerating && <span className="ai-input-glow" aria-hidden />}
          <div className="ai-input-toolbar">
            <AiReasoningEffortSelect disabled={isGenerating} />
          </div>
          <div className="ai-input-body">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={t("ai.inputPlaceholder")}
              rows={1}
              className="ai-input-textarea"
              disabled={isGenerating}
            />
            <button
              type="button"
              onClick={handleSend}
              disabled={!input.trim() || isGenerating}
              className={`ai-input-send${input.trim() && !isGenerating ? " is-ready" : ""}`}
              aria-label={t("ai.send")}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M22 2L11 13M22 2l-7 20-4-9-9-4z" />
              </svg>
            </button>
          </div>
        </div>
        <div className="ai-input-hint-row">
          <span className="ai-input-hint">Shift+Enter 换行</span>
          <span className="ai-input-hint">
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
  const isGenerating = useAiStore((s) => s.isGenerating);

  return (
    <SubWindow
      open={drawerOpen}
      title={t("ai.title")}
      onClose={closeDrawer}
      className="ai-subwindow"
      widthRatio={0.82}
      heightRatio={0.85}
      headerExtra={
        <div className="ai-subwindow-header-extra">
          <AiMcpConnections />
          <div className="ai-subwindow-model">
            <span className="ai-subwindow-model-label">{t("ai.modelSelect.label")}</span>
            <AiModelSelect disabled={isGenerating} className="ai-subwindow-model-select" />
          </div>
        </div>
      }
    >
      <div className="ai-subwindow-content">
        <AiPanelBody />
      </div>
    </SubWindow>
  );
}
