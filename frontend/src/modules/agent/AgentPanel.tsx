import { useCallback, useEffect, useRef, useState } from "react";

import { useI18n } from "../../i18n";

import { Button } from "../../components/ui/Button";

import { SidebarWorkspace } from "../../components/ui/SidebarWorkspace";

import { AiModelSelect } from "../../components/ai/AiModelSelect";

import {

  firstModelSelectionId,

  resolveModelSelection,

  useAiModelsStore,

} from "../../stores/aiModelsStore";

import { useAiStore } from "../../stores/aiStore";



interface Message {

  id: string;

  role: "user" | "assistant";

  content: string;

  timestamp: number;

  isStreaming?: boolean;

}



interface Conversation {

  id: string;

  title: string;

  messages: Message[];

}



let idCounter = 0;

function genId() {

  return `agent-${Date.now()}-${++idCounter}`;

}



function isTauriRuntime(): boolean {

  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

}



export function AgentPanel() {

  const { t } = useI18n();

  const providers = useAiModelsStore((s) => s.providers);

  const currentModelSelectionId = useAiStore((s) => s.currentModelSelectionId);

  const setCurrentModelSelectionId = useAiStore((s) => s.setCurrentModelSelectionId);

  const [conversations, setConversations] = useState<Conversation[]>([]);

  const [activeId, setActiveId] = useState<string | null>(null);

  const [input, setInput] = useState("");

  const [isRunning, setIsRunning] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);



  const activeConv = conversations.find((c) => c.id === activeId);



  useEffect(() => {

    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });

  }, [activeConv?.messages.length]);



  useEffect(() => {

    if (currentModelSelectionId) return;

    const first = firstModelSelectionId(providers);

    if (first) setCurrentModelSelectionId(first);

  }, [currentModelSelectionId, providers, setCurrentModelSelectionId]);



  const handleNewConversation = useCallback(() => {

    const id = genId();

    const conv: Conversation = { id, title: "New Chat", messages: [] };

    setConversations((prev) => [conv, ...prev]);

    setActiveId(id);

  }, []);



  const handleSend = useCallback(async () => {

    const trimmed = input.trim();

    if (!trimmed || !activeId || isRunning) return;



    const selectionId =

      currentModelSelectionId && resolveModelSelection(providers, currentModelSelectionId)

        ? currentModelSelectionId

        : firstModelSelectionId(providers);

    const modelConfig = selectionId ? resolveModelSelection(providers, selectionId) : null;



    const userMsg: Message = {

      id: genId(),

      role: "user",

      content: trimmed,

      timestamp: Date.now(),

    };

    const assistantMsgId = genId();

    const assistantMsg: Message = {

      id: assistantMsgId,

      role: "assistant",

      content: "",

      timestamp: Date.now(),

      isStreaming: true,

    };



    const conv = conversations.find((c) => c.id === activeId);

    const history = [...(conv?.messages ?? []), userMsg].slice(-20).map((m) => ({

      role: m.role,

      content: m.content,

    }));



    setConversations((prev) =>

      prev.map((c) =>

        c.id === activeId

          ? {

              ...c,

              title: c.messages.length === 0 ? trimmed.slice(0, 40) : c.title,

              messages: [...c.messages, userMsg, assistantMsg],

            }

          : c,

      ),

    );

    setInput("");

    setIsRunning(true);



    const updateAssistant = (updater: (msg: Message) => Message) => {

      setConversations((prev) =>

        prev.map((c) =>

          c.id === activeId

            ? {

                ...c,

                messages: c.messages.map((m) => (m.id === assistantMsgId ? updater(m) : m)),

              }

            : c,

        ),

      );

    };



    if (!isTauriRuntime() || !modelConfig) {

      updateAssistant((m) => ({

        ...m,

        content: !isTauriRuntime()

          ? "AI 助手需要在 Tauri 环境中运行。"

          : "请先在设置 → AI 模型 中配置并启用模型。",

        isStreaming: false,

      }));

      setIsRunning(false);

      return;

    }



    try {

      const { streamAgentChat } = await import("../../components/ai/langchain/streamAgentChat");

      await streamAgentChat(modelConfig, history, activeId, {

        onTextDelta: (text) => {

          updateAssistant((m) => ({ ...m, content: m.content + text }));

        },

        onError: (message) => {

          updateAssistant((m) => ({

            ...m,

            content: `${m.content}\n\n错误：${message}`,

            isStreaming: false,

          }));

        },

        onDone: () => {

          updateAssistant((m) => ({ ...m, isStreaming: false }));

        },

      });

    } catch (err) {

      updateAssistant((m) => ({

        ...m,

        content: `发送失败：${err instanceof Error ? err.message : String(err)}`,

        isStreaming: false,

      }));

    } finally {

      setIsRunning(false);

    }

  }, [input, activeId, isRunning, conversations, providers, currentModelSelectionId]);



  const handleDelete = useCallback(

    (id: string) => {

      setConversations((prev) => prev.filter((c) => c.id !== id));

      if (activeId === id) {

        setActiveId(conversations.find((c) => c.id !== id)?.id ?? null);

      }

    },

    [activeId, conversations],

  );



  const sidebar = (

    <aside className="proto-sidebar">

      <div className="proto-sidebar-header">

        <span className="proto-sidebar-title">{t("agent.conversations")}</span>

        <button type="button" className="proto-sidebar-new" onClick={handleNewConversation} title={t("agent.newChat")}>

          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" width="14" height="14">

            <line x1="8" y1="3" x2="8" y2="13" />

            <line x1="3" y1="8" x2="13" y2="8" />

          </svg>

        </button>

      </div>

      <div style={{ flex: 1, overflow: "auto" }}>

        {conversations.length === 0 && (

          <div className="proto-empty">{t("agent.noConversations")}</div>

        )}

        {conversations.map((conv) => (

          <div

            key={conv.id}

            className={`proto-context-item${conv.id === activeId ? " is-active" : ""}`}

            onClick={() => setActiveId(conv.id)}

            style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}

          >

            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>

              {conv.title}

            </span>

            <span

              className="proto-delete-btn"

              onClick={(e) => {

                e.stopPropagation();

                handleDelete(conv.id);

              }}

            >

              ✕

            </span>

          </div>

        ))}

      </div>

    </aside>

  );



  return (

    <SidebarWorkspace sidebar={sidebar} className="agent-panel" sidebarSizePx={220} sidebarMinPx={180}>

      <div style={{ flex: 1, display: "flex", flexDirection: "column", height: "100%" }}>

        <div style={{ flex: 1, overflow: "auto", padding: "var(--sp-3)" }}>

          {!activeConv ? (

            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--meta)" }}>

              <div style={{ fontSize: "32px", marginBottom: "var(--sp-2)" }}>🤖</div>

              <div style={{ fontSize: "13px", marginBottom: "var(--sp-1)" }}>{t("agent.title")}</div>

              <div style={{ fontSize: "12px" }}>{t("agent.description")}</div>

            </div>

          ) : activeConv.messages.length === 0 ? (

            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--meta)" }}>

              <div style={{ fontSize: "12px" }}>{t("agent.startPrompt")}</div>

            </div>

          ) : (

            activeConv.messages.map((msg) => (

              <div

                key={msg.id}

                style={{

                  display: "flex",

                  justifyContent: msg.role === "user" ? "flex-end" : "flex-start",

                  marginBottom: "var(--sp-2)",

                }}

              >

                <div

                  style={{

                    maxWidth: "80%",

                    padding: "var(--sp-2) var(--sp-3)",

                    borderRadius: "var(--r-md)",

                    fontSize: "13px",

                    lineHeight: "1.5",

                    whiteSpace: "pre-wrap",

                    background: msg.role === "user" ? "var(--accent)" : "var(--surface)",

                    color: msg.role === "user" ? "#fff" : "var(--fg)",

                    border: msg.role === "user" ? "none" : "1px solid var(--border)",

                  }}

                >

                  {msg.content || (msg.isStreaming ? "..." : "")}

                </div>

              </div>

            ))

          )}

          <div ref={messagesEndRef} />

        </div>



        {activeConv && (

          <div style={{ borderTop: "1px solid var(--border)", padding: "var(--sp-2) var(--sp-3)" }}>

            <div

              style={{

                display: "flex",

                alignItems: "center",

                gap: "var(--sp-2)",

                marginBottom: "var(--sp-2)",

              }}

            >

              <span style={{ fontSize: "10px", color: "var(--meta)", flexShrink: 0 }}>

                {t("ai.modelSelect.label")}

              </span>

              <AiModelSelect disabled={isRunning} />

            </div>

            <div style={{ display: "flex", gap: "var(--sp-2)" }}>

            <textarea

              value={input}

              onChange={(e) => setInput(e.target.value)}

              onKeyDown={(e) => {

                if (e.key === "Enter" && !e.shiftKey) {

                  e.preventDefault();

                  void handleSend();

                }

              }}

              placeholder={t("agent.inputPlaceholder")}

              disabled={isRunning}

              style={{

                flex: 1,

                resize: "none",

                minHeight: "36px",

                maxHeight: "120px",

                padding: "var(--sp-2)",

                fontSize: "13px",

                background: "var(--bg-deeper)",

                border: "1px solid var(--border)",

                borderRadius: "var(--r-md)",

                color: "var(--fg)",

                outline: "none",

              }}

            />

            <Button variant="primary" size="sm" onClick={() => void handleSend()} disabled={!input.trim() || isRunning}>

              {isRunning ? t("agent.running") : t("agent.send")}

            </Button>

            </div>

          </div>

        )}

      </div>

    </SidebarWorkspace>

  );

}


