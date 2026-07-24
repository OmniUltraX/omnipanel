import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { ModuleSegmentDock } from "../../components/dock";
import { ModuleModeIconRail, ModuleWorkspaceLayout } from "../../components/workspace";
import { WorkspaceEmptyPage } from "../../components/ui/workspace/WorkspaceEmptyPage";
import { usePersistedModuleTab } from "../../hooks/usePersistedModuleTab";
import { useUiFollowConsumer } from "../../lib/ai/uiFollow";
import { useI18n } from "../../i18n";
import { useKnowledgeStore } from "../../stores/knowledgeStore";
import { useKnowledgeWorkspaceStore } from "../../stores/knowledgeWorkspaceStore";
import { KnowledgeDocumentPanel } from "./KnowledgeDocumentPanel";
import { KnowledgeChunksPanel } from "./KnowledgeChunksPanel";
import { KnowledgeSidebar } from "./KnowledgeSidebar";
import { KnowledgeTodosView } from "./KnowledgeTodosView";
import { isKnowledgeImported } from "./knowledgeTree";
import { useKnowledgeOpenEntry } from "./useKnowledgeOpenEntry";

type KnowledgeModuleTab = "library" | "todos";
const KNOWLEDGE_TABS: KnowledgeModuleTab[] = ["library", "todos"];

/** AI 工具完成事件 payload（与 AiRuntimeProvider 派发端对齐） */
interface AiKnowledgeToolPayload {
  toolName: string;
  args: string;
  result: string | null;
  ts: number;
}

const PENDING_REFRESH_KEY = "omnipanel:pending-knowledge-refresh";
const KNOWLEDGE_TOOL_EVENT = "omnipanel:ai-knowledge-tool-completed";

/** 从 create_document 的 result/args 解析新建文档 id（result 优先） */
function resolveCreatedEntryId(payload: AiKnowledgeToolPayload): string | null {
  if (payload.result) {
    try {
      const parsed = JSON.parse(payload.result) as { id?: string };
      if (typeof parsed.id === "string" && parsed.id.trim()) return parsed.id;
    } catch {
      // ignore
    }
  }
  // fallback：从 args.title 反查（需调用方在 entries 已 reload 后查找）
  return null;
}

/** 从 args 解析 title，用于在 reload 后按标题反查 id */
function resolveCreatedTitle(payload: AiKnowledgeToolPayload): string | null {
  try {
    const parsed = JSON.parse(payload.args || "{}") as { title?: string };
    if (typeof parsed.title === "string" && parsed.title.trim()) return parsed.title;
  } catch {
    // ignore
  }
  return null;
}

/** 从 remove_document 的 result 解析被删除文档 id */
function resolveRemovedEntryId(payload: AiKnowledgeToolPayload): string | null {
  if (payload.result) {
    try {
      const parsed = JSON.parse(payload.result) as { id?: string };
      if (typeof parsed.id === "string" && parsed.id.trim()) return parsed.id;
    } catch {
      // ignore
    }
  }
  try {
    const parsed = JSON.parse(payload.args || "{}") as { id?: string };
    if (typeof parsed.id === "string" && parsed.id.trim()) return parsed.id;
  } catch {
    // ignore
  }
  return null;
}

export function KnowledgePanel() {
  const { t } = useI18n();
  const location = useLocation();
  const isActiveRoute = location.pathname === "/module/knowledge";
  const [mode, setMode] = usePersistedModuleTab("knowledge", "library", KNOWLEDGE_TABS);
  const loadEntries = useKnowledgeStore((s) => s.loadEntries);
  const error = useKnowledgeStore((s) => s.error);
  const clearError = useKnowledgeStore((s) => s.clearError);

  const entries = useKnowledgeStore((s) => s.entries);
  const setSelectedEntry = useKnowledgeStore((s) => s.setSelectedEntry);
  const activeTabId = useKnowledgeWorkspaceStore((s) => s.activeTabId);
  const dockLayout = useKnowledgeWorkspaceStore((s) => s.dockLayout);
  const setWorkspaceTabs = useKnowledgeWorkspaceStore((s) => s.setWorkspaceTabs);
  const setDockLayout = useKnowledgeWorkspaceStore((s) => s.setDockLayout);
  const removeTab = useKnowledgeWorkspaceStore((s) => s.removeTab);
  const { activateWorkspaceTab, promotePreviewTab, openEntry, workspaceTabs } =
    useKnowledgeOpenEntry();

  // === AI Follow 消费者注册 ===
  // 处理 openDocument intent：打开指定知识库文档 tab
  // 旧的 CustomEvent + localStorage 机制仍保留兼容（处理 reload + remove 场景），
  // 新的 follow intent 路径直接调 openEntry，更高效
  useUiFollowConsumer("knowledge", useCallback((intent) => {
    switch (intent.type) {
      case "openDocument": {
        if (intent.entryId) {
          void loadEntries().then(() => {
            openEntry(intent.entryId, intent.mode ?? "permanent");
          });
          return true;
        }
        return false;
      }
      case "openResourceProfile": {
        // 资源档案子窗口由 resourceProfileNavStore 管理，此处不处理
        // 让 ResourceProfileSubWindow 的 handler 处理
        return false;
      }
      default:
        return false;
    }
  }, [loadEntries, openEntry]));

  // AI 知识库工具完成后，需要打开/关闭的 entry id（loadEntries 完成后由 effect 消费）
  const [pendingOpenEntryId, setPendingOpenEntryId] = useState<string | null>(null);
  const [pendingOpenTitle, setPendingOpenTitle] = useState<string | null>(null);
  const [pendingRemoveEntryId, setPendingRemoveEntryId] = useState<string | null>(null);

  useEffect(() => {
    if (mode === "library") {
      void loadEntries();
    }
  }, [loadEntries, mode]);

  /**
   * 处理单条 AI 知识库工具完成事件：
   * 1. 总是 reload entries（保证 sidebar/dock 看到最新数据）
   * 2. create_document：尝试解析新建文档 id，等 reload 后 openEntry 自动打开 tab
   * 3. remove_document：尝试解析被删除 id，reload 后从 workspaceTabs 移除对应 tab
   */
  const handleAiKnowledgeToolCompleted = useCallback(
    async (payload: AiKnowledgeToolPayload) => {
      // 仅 library 模式处理（todos 模式无文档视图）
      if (mode !== "library") return;

      await loadEntries();

      if (payload.toolName === "omni_knowledge_create_document") {
        const directId = resolveCreatedEntryId(payload);
        if (directId) {
          // 直接拿 id：等 entries 重新渲染后由 effect 消费
          setPendingOpenTitle(null);
          setPendingOpenEntryId(directId);
        } else {
          // 仅有 title：reload 后在 entries 里反查
          const title = resolveCreatedTitle(payload);
          if (title) {
            setPendingOpenEntryId(null);
            setPendingOpenTitle(title);
          }
        }
      } else if (payload.toolName === "omni_knowledge_remove_document") {
        const removedId = resolveRemovedEntryId(payload);
        if (removedId) {
          setPendingRemoveEntryId(removedId);
        }
      }
    },
    [loadEntries, mode],
  );

  // 监听 AI 工具完成事件（面板已挂载 + 后续完成时）
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as AiKnowledgeToolPayload | undefined;
      if (!detail) return;
      void handleAiKnowledgeToolCompleted(detail);
    };
    window.addEventListener(KNOWLEDGE_TOOL_EVENT, handler);
    return () => window.removeEventListener(KNOWLEDGE_TOOL_EVENT, handler);
  }, [handleAiKnowledgeToolCompleted]);

  // 挂载时消费 localStorage 中遗留的 pending 事件（面板未挂载时由 AiRuntimeProvider 写入）
  useEffect(() => {
    if (mode !== "library") return;
    let pending: AiKnowledgeToolPayload[] = [];
    try {
      pending = JSON.parse(localStorage.getItem(PENDING_REFRESH_KEY) ?? "[]");
      if (!Array.isArray(pending)) pending = [];
    } catch {
      pending = [];
    }
    if (pending.length === 0) return;
    // 清空 localStorage，避免重复消费
    try {
      localStorage.removeItem(PENDING_REFRESH_KEY);
    } catch {
      // ignore
    }
    // 顺序处理（通常只有 1-2 条）
    (async () => {
      for (const payload of pending) {
        await handleAiKnowledgeToolCompleted(payload);
      }
    })();
    // 仅在 mount + mode 切到 library 时消费一次；handleAiKnowledgeToolCompleted 依赖 mode，
    // 但其内部已对 mode 做判断，此处不再列入依赖（避免每次重渲染都重新跑）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // entries 重新加载后，根据 pending 状态执行 openEntry / 关 tab
  useEffect(() => {
    if (pendingOpenEntryId) {
      const entry = entries.find((e) => e.id === pendingOpenEntryId);
      if (entry) {
        openEntry(pendingOpenEntryId, "permanent");
        setPendingOpenEntryId(null);
        setPendingOpenTitle(null);
      }
    } else if (pendingOpenTitle) {
      const found = entries.find((e) => e.title === pendingOpenTitle);
      if (found) {
        openEntry(found.id, "permanent");
        setPendingOpenEntryId(null);
        setPendingOpenTitle(null);
      }
    }
  }, [entries, pendingOpenEntryId, pendingOpenTitle, openEntry]);

  // 删除：reload 后关掉对应 tab（如果开着）
  useEffect(() => {
    if (!pendingRemoveEntryId) return;
    const tab = workspaceTabs.find((t) => t.entryId === pendingRemoveEntryId);
    if (tab) {
      removeTab(tab.id);
    }
    setPendingRemoveEntryId(null);
  }, [pendingRemoveEntryId, removeTab, workspaceTabs]);

  const modeIconItems = useMemo(
    () => [
      { id: "library", label: t("knowledge.tabs.library"), icon: "file-local" as const },
      { id: "todos", label: t("knowledge.tabs.todos"), icon: "table" as const },
    ],
    [t],
  );

  // 布局与 tabs 短暂不一致时，交给 DockableWorkspace.syncTabsToApi 增量补面板；
  // 切勿把 savedLayout 置 null —— 会触发 api.clear()，表现为「单击干掉所有 Tab」。
  const effectiveDockLayout = useMemo(() => {
    if (mode !== "library") {
      return null;
    }
    if (workspaceTabs.length === 0) {
      return null;
    }
    return dockLayout;
  }, [dockLayout, mode, workspaceTabs.length]);

  useEffect(() => {
    if (mode !== "library" || !activeTabId) return;
    const tab = workspaceTabs.find((item) => item.id === activeTabId);
    if (tab) setSelectedEntry(tab.entryId);
  }, [activeTabId, mode, setSelectedEntry, workspaceTabs]);

  useEffect(() => {
    if (mode !== "library") return;
    setWorkspaceTabs((prev) => {
      let changed = false;
      const next = prev.map((tab) => {
        if (tab.kind === "chunks") {
          const entry = entries.find((item) => item.id === tab.entryId);
          if (entry) {
            const label = `${entry.title} · ${t("knowledge.chunks.tabSuffix")}`;
            if (label !== tab.label) {
              changed = true;
              return { ...tab, label };
            }
          }
          return tab;
        }
        const entry = entries.find((item) => item.id === tab.entryId);
        if (entry && entry.title !== tab.label) {
          changed = true;
          return { ...tab, label: entry.title };
        }
        return tab;
      });
      return changed ? next : prev;
    });
  }, [entries, mode, setWorkspaceTabs, t]);

  const dockTabs = useMemo(() => {
    if (mode !== "library") {
      return [{ id: "todos", label: t("knowledge.tabs.todos") }];
    }
    return workspaceTabs.map((tab) => {
      const entry = entries.find((item) => item.id === tab.entryId);
      const imported = entry ? isKnowledgeImported(entry) : false;
      const isChunks = tab.kind === "chunks";
      // 用 nodeType 判定，避免 HMR/循环依赖时 isKnowledgeFolder 短暂 undefined
      const isFolder = entry?.nodeType === "folder";
      return {
        id: tab.id,
        label: tab.label,
        panelType: "knowledge",
        icon: isChunks
          ? ("table" as const)
          : isFolder
            ? ("folder" as const)
            : ("file-local" as const),
        tooltip: tab.label,
        closable: true,
        preview: Boolean(tab.preview),
        ...(!imported && !isChunks && !isFolder ? { type: "file" as const } : {}),
      };
    });
  }, [entries, mode, t, workspaceTabs]);

  const handleDockTabDoubleClick = useCallback(
    (tabId: string) => {
      const tab = workspaceTabs.find((item) => item.id === tabId);
      if (!tab?.preview) return;
      promotePreviewTab(tabId);
      activateWorkspaceTab(tabId);
    },
    [activateWorkspaceTab, promotePreviewTab, workspaceTabs],
  );

  const handleCloseTab = useCallback(
    (tabId: string) => {
      removeTab(tabId);
    },
    [removeTab],
  );

  const renderPanel = useCallback(
    (tabId: string) => {
      if (mode === "todos") {
        return <KnowledgeTodosView />;
      }
      const tab = workspaceTabs.find((item) => item.id === tabId);
      if (!tab) return null;
      if (tab.kind === "chunks") {
        return <KnowledgeChunksPanel entryId={tab.entryId} />;
      }
      return <KnowledgeDocumentPanel entryId={tab.entryId} />;
    },
    [mode, workspaceTabs],
  );

  return (
    <div className="knowledge-panel">
      {error && mode === "library" && (
        <div className="knowledge-error knowledge-error--floating">
          <span>{error}</span>
          <button type="button" onClick={clearError}>×</button>
        </div>
      )}
      <ModuleWorkspaceLayout
        className="knowledge-workspace"
        leftColumnTitle={t("routes.knowledge")}
        leftPreset="schema"
        tagModuleKey={mode === "library" ? "knowledge" : undefined}
        leftIconRail={
          <ModuleModeIconRail
            items={modeIconItems}
            activeId={mode}
            onChange={(id) => setMode(id as KnowledgeModuleTab)}
          />
        }
        leftSidebar={mode === "library" ? <KnowledgeSidebar /> : undefined}
      >
        <ModuleSegmentDock
          className="knowledge-module-dock knowledge-workspace-dock"
          variant={mode === "library" ? "workspace" : "function"}
          dockScope="knowledge"
          moduleTitle={t("routes.knowledge")}
          enabled={isActiveRoute}
          contentSuspended={!isActiveRoute}
          stickyVisit
          windowControl
          showTabBar={mode === "library"}
          tabs={dockTabs}
          activeTabId={mode === "library" ? (activeTabId ?? "") : "todos"}
          onActiveTabChange={mode === "library" ? activateWorkspaceTab : () => {}}
          onCloseTab={mode === "library" ? handleCloseTab : () => {}}
          onTabDoubleClick={mode === "library" ? handleDockTabDoubleClick : undefined}
          savedLayout={mode === "library" ? effectiveDockLayout : null}
          onSavedLayoutChange={mode === "library" ? setDockLayout : undefined}
          renderPanel={renderPanel}
          emptyContent={
            <WorkspaceEmptyPage
              title={t("routes.knowledge")}
              prompt={t("knowledge.selectEntry")}
            />
          }
        />
      </ModuleWorkspaceLayout>
    </div>
  );
}
