import { useState, useRef, useEffect, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useAgentStore } from "./agentStore";
import { useAiModelsStore } from "../../stores/aiModelsStore";
import { useAgentChat } from "./useAgentChat";
import type { AgentMessage, AgentToolCall } from "./agentStore";
import type { AiModelConfig } from "../../stores/aiModelsStore";

// ─── Tool Call Card ───────────────────────────────────────────

function ToolCallCard({ tc }: { tc: AgentToolCall }) {
  const [expanded, setExpanded] = useState(false);
  const statusLabel = {
    pending: "待处理",
    running: "执行中…",
    completed: "✓ 完成",
    failed: "✗ 失败",
  }[tc.status];

  return (
    <div className="border border-border rounded-md overflow-hidden my-1.5">
      <button
        className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-fg-2 hover:bg-surface-hover transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <span
          className={`text-[10px] font-medium ${
            tc.status === "completed"
              ? "text-green-400"
              : tc.status === "failed"
                ? "text-red-400"
                : tc.status === "running"
                  ? "text-amber-400"
                  : "text-meta"
          }`}
        >
          {statusLabel}
        </span>
        <span className="font-mono text-accent">{tc.name}</span>
        <span className="text-muted truncate flex-1 text-left">
          {tc.arguments.slice(0, 80)}
          {tc.arguments.length > 80 ? "…" : ""}
        </span>
        <span className="text-muted">{expanded ? "▾" : "▸"}</span>
      </button>
      {expanded && (
        <div className="border-t border-border px-3 py-2 text-xs space-y-2">
          <div>
            <div className="text-meta mb-1">参数</div>
            <pre className="bg-bg-deeper rounded p-2 overflow-x-auto text-fg-2 whitespace-pre-wrap break-all">
              {tc.arguments}
            </pre>
          </div>
          {tc.result && (
            <div>
              <div className="text-meta mb-1">结果</div>
              <pre className="bg-bg-deeper rounded p-2 overflow-x-auto text-fg-2 whitespace-pre-wrap break-all max-h-48 overflow-y-auto">
                {tc.result}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Message Bubble ──────────────────────────────────────────

function MessageBubble({ msg }: { msg: AgentMessage }) {
  const isUser = msg.role === "user";

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"} mb-3`}>
      <div
        className={`max-w-[80%] rounded-lg px-4 py-2.5 text-sm leading-relaxed ${
          isUser
            ? "bg-accent text-white"
            : "bg-surface border border-border text-fg-1"
        }`}
      >
        {/* Tool calls */}
        {msg.toolCalls && msg.toolCalls.length > 0 && (
          <div className="mb-2">
            {msg.toolCalls.map((tc) => (
              <ToolCallCard key={tc.id} tc={tc} />
            ))}
          </div>
        )}

        {/* Content */}
        {isUser ? (
          <p className="whitespace-pre-wrap">{msg.content}</p>
        ) : msg.content ? (
          <div className="prose prose-sm prose-invert max-w-none">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {msg.content}
            </ReactMarkdown>
          </div>
        ) : msg.isStreaming ? (
          <span className="inline-block w-2 h-4 bg-accent animate-pulse rounded-sm" />
        ) : null}

        {/* Streaming cursor */}
        {msg.isStreaming && msg.content && (
          <span className="inline-block w-2 h-4 ml-0.5 bg-accent animate-pulse rounded-sm align-text-bottom" />
        )}
      </div>
    </div>
  );
}

// ─── Model Selector ──────────────────────────────────────────

function ModelSelector({
  value,
  onChange,
}: {
  value: string;
  onChange: (id: string) => void;
}) {
  const models = useAiModelsStore((s) => s.models);

  if (models.length === 0) {
    return (
      <span className="text-xs text-muted">请先在设置中添加 AI 模型</span>
    );
  }

  return (
    <select
      className="text-xs bg-surface border border-border rounded px-2 py-1 text-fg-1 outline-none focus:border-accent"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {models.map((m) => (
        <option key={m.id} value={m.id}>
          {m.name} ({m.apiStandard === "anthropic" ? "Anthropic" : "OpenAI"})
        </option>
      ))}
    </select>
  );
}

// ─── Conversation List Item ──────────────────────────────────

function ConversationItem({
  conv,
  isActive,
  onSelect,
  onDelete,
  onRename,
}: {
  conv: { id: string; title: string; updatedAt: number };
  isActive: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onRename: (title: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(conv.title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const commitRename = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== conv.title) onRename(trimmed);
    setEditing(false);
  };

  return (
    <div
      className={`group flex items-center gap-1.5 px-2 py-1.5 rounded cursor-pointer text-xs transition-colors ${
        isActive
          ? "bg-accent/15 text-accent"
          : "text-fg-2 hover:bg-surface-hover"
      }`}
      onClick={onSelect}
    >
      {editing ? (
        <input
          ref={inputRef}
          className="flex-1 bg-transparent border-b border-accent outline-none text-fg-1 px-0.5 min-w-0"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") setEditing(false);
          }}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span
          className="flex-1 truncate"
          onDoubleClick={(e) => {
            e.stopPropagation();
            setDraft(conv.title);
            setEditing(true);
          }}
        >
          {conv.title}
        </span>
      )}
      <button
        className="opacity-0 group-hover:opacity-100 text-muted hover:text-red-400 transition-opacity shrink-0"
        title="删除"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
      >
        ✕
      </button>
    </div>
  );
}

// ─── Main Panel ──────────────────────────────────────────────

export default function AiAgentPanel() {
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const {
    conversations,
    activeId,
    createConversation,
    setActive,
    deleteConversation,
    renameConversation,
  } = useAgentStore();

  const { sendMessage, stopGeneration, isGenerating } = useAgentChat();
  const models = useAiModelsStore((s) => s.models);

  const activeConv = conversations.find((c) => c.id === activeId);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [activeConv?.messages.length, activeConv?.messages.at(-1)?.content]);

  // Auto-focus input
  useEffect(() => {
    if (!isGenerating) inputRef.current?.focus();
  }, [isGenerating, activeId]);

  const handleNewChat = useCallback(() => {
    const firstModel = models[0];
    if (!firstModel) return;
    createConversation(firstModel.id);
    setInput("");
  }, [models, createConversation]);

  const handleSend = useCallback(async () => {
    if (!input.trim() || isGenerating) return;
    const text = input;
    setInput("");
    await sendMessage(text);
  }, [input, isGenerating, sendMessage]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  const handleModelChange = useCallback(
    (modelConfigId: string) => {
      if (!activeId) return;
      // Update the conversation's model by recreating store logic
      useAgentStore.setState((s) => ({
        conversations: s.conversations.map((c) =>
          c.id === activeId ? { ...c, modelConfigId } : c
        ),
      }));
    },
    [activeId]
  );

  return (
    <div className="flex h-full">
      {/* ─── Sidebar: Conversation List ─── */}
      <div className="w-56 shrink-0 border-r border-border flex flex-col bg-bg-deep">
        <div className="p-2 border-b border-border">
          <button
            className="w-full text-xs px-3 py-1.5 rounded bg-accent text-white hover:bg-accent/80 transition-colors disabled:opacity-50"
            onClick={handleNewChat}
            disabled={models.length === 0}
          >
            + 新对话
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-1.5 space-y-0.5">
          {conversations.length === 0 && (
            <p className="text-xs text-muted text-center mt-8 px-4">
              {models.length === 0
                ? "请先在设置中添加 AI 模型"
                : "点击上方按钮开始新对话"}
            </p>
          )}
          {conversations.map((conv) => (
            <ConversationItem
              key={conv.id}
              conv={conv}
              isActive={conv.id === activeId}
              onSelect={() => setActive(conv.id)}
              onDelete={() => deleteConversation(conv.id)}
              onRename={(title) => renameConversation(conv.id, title)}
            />
          ))}
        </div>
      </div>

      {/* ─── Main Chat Area ─── */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-border shrink-0">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-medium text-fg-1">
              {activeConv?.title ?? "AI 智能体"}
            </h2>
            {activeConv && (
              <ModelSelector
                value={activeConv.modelConfigId}
                onChange={handleModelChange}
              />
            )}
          </div>
          {isGenerating && (
            <button
              className="text-xs px-3 py-1 rounded border border-red-400/30 text-red-400 hover:bg-red-400/10 transition-colors"
              onClick={stopGeneration}
            >
              ■ 停止
            </button>
          )}
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-4 py-4">
          {!activeConv ? (
            <div className="flex flex-col items-center justify-center h-full text-muted">
              <div className="text-4xl mb-4">🤖</div>
              <p className="text-sm mb-2">AI 智能体</p>
              <p className="text-xs">
                {models.length === 0
                  ? "请先在「设置」中配置 AI 模型"
                  : "选择一个对话或创建新对话开始"}
              </p>
            </div>
          ) : activeConv.messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-muted">
              <div className="text-4xl mb-4">💬</div>
              <p className="text-xs">发送消息开始与智能体对话</p>
            </div>
          ) : (
            <>
              {activeConv.messages.map((msg) => (
                <MessageBubble key={msg.id} msg={msg} />
              ))}
              <div ref={messagesEndRef} />
            </>
          )}
        </div>

        {/* Input */}
        {activeConv && (
          <div className="border-t border-border px-4 py-3 shrink-0">
            <div className="flex gap-2 items-end">
              <textarea
                ref={inputRef}
                className="flex-1 resize-none bg-surface border border-border rounded-lg px-3 py-2 text-sm text-fg-1 outline-none focus:border-accent placeholder:text-muted min-h-[36px] max-h-32"
                rows={1}
                placeholder={
                  isGenerating
                    ? "智能体正在思考…"
                    : "输入消息… (Enter 发送, Shift+Enter 换行)"
                }
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  // Auto-resize
                  e.target.style.height = "auto";
                  e.target.style.height =
                    Math.min(e.target.scrollHeight, 128) + "px";
                }}
                onKeyDown={handleKeyDown}
                disabled={isGenerating}
              />
              <button
                className="px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:bg-accent/80 transition-colors disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
                onClick={handleSend}
                disabled={!input.trim() || isGenerating}
              >
                发送
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
