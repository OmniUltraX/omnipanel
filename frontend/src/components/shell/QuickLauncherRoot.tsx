import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { TextInput } from "../ui/form/TextInput";
import { AppLogo } from "../ui/layout/AppLogo";
import { useI18n } from "../../i18n";
import { initConnections } from "../../stores/connectionStore";
import { useConnectionStore } from "../../stores/connectionStore";
import { useDbSchemaCacheStore } from "../../stores/dbSchemaCacheStore";
import {
  getNavVisibleModuleKeys,
  initAppModuleStore,
} from "../../stores/appModuleStore";
import {
  initPluginRuntimeStore,
  PLUGIN_ID_EVERYTHING,
  usePluginRuntimeStore,
} from "../../stores/pluginRuntimeStore";
import { useDebouncedEsQuery } from "./useDebouncedEsQuery";
import {
  emitQuickLauncherAction,
  hideQuickLauncher,
  listenQuickLauncherHidden,
  listenQuickLauncherShown,
  setQuickLauncherHeight,
  type QuickLauncherAction,
} from "../../lib/quickLauncher";
import {
  moduleKeyForQuickLauncherAction,
  runQuickLauncherActionInSoloModule,
} from "../../lib/quickLauncherActions";
import {
  buildQuickLaunchMatches,
  buildQuickLaunchRecentRows,
  dbConnectionToQuickLaunchConnection,
  mergeQuickLaunchConnections,
  parseQuickLaunchQuery,
  quickLaunchRowModule,
  rowToInsertQuery,
  type QuickLaunchMatchRow,
} from "../../lib/quickLauncherMatch";
import {
  buildSlashDashboardRows,
  buildSlashModelRows,
  matchSlashCatalog,
  resolveSlashModelCurrentId,
  type SlashCommandId,
} from "../../lib/quickLaunch/slashCommands";
import {
  ensureSystemAppIcons,
  getCachedSystemAppIcon,
  launchSystemApp,
  listSystemApps,
  type SystemAppEntry,
} from "../../lib/quickLaunch/systemApps";
import { broadcastAppearance } from "../../lib/appearanceSync";
import {
  initDashboardCatalogSubscriber,
  requestDashboardCatalog,
  type DashboardCatalogEntry,
} from "../../lib/dashboardCatalogSync";
import {
  quickLaunchRecentKey,
  useQuickLauncherRecentStore,
  type QuickLaunchRecentTarget,
} from "../../stores/quickLauncherRecentStore";
import { listConnections as listDbConnections } from "../../modules/database/api";
import type { Connection } from "../../ipc/bindings";
import { openModuleWindow } from "../../lib/moduleWindow";
import { dismissHtmlBootSplash } from "../../lib/dismissBootSplash";
import { isTauriRuntime } from "../../lib/isTauriRuntime";
import {
  initAppearanceSyncSubscriber,
  requestAppearanceSync,
} from "../../lib/appearanceSync";
import { initSettings, useSettingsStore } from "../../stores/settingsStore";
import { readClipboardText } from "../../lib/quickLaunch/clipboard";
import {
  buildSuggestions,
  primaryEntityKind,
  type SuggestedAction,
} from "../../lib/quickLaunch/buildSuggestions";
import { streamQuickLauncherAskAi } from "../../lib/quickLaunch/streamAskAi";
import { QuickLauncherAiAnswer } from "./QuickLauncherAiAnswer";
import { type EntityKind } from "../../lib/quickLaunch/detectText";
import { isKernelModuleKey, type ModuleKey } from "../../lib/paths";
import { useQuickLauncherActionStatsStore } from "../../stores/quickLauncherActionStatsStore";
import {
  useQuickLauncherAskHistoryStore,
  type QuickLauncherAskHistoryEntry,
} from "../../stores/quickLauncherAskHistoryStore";
import {
  initAiModelsStore,
  resolveModelSelection,
  useAiModelsStore,
  type AiModelProvider,
} from "../../stores/aiModelsStore";
import { resolveScenarioModelSelectionId } from "../../lib/aiScenarioModels";
import { resolveBackendFromSelection } from "../../lib/ai/inferenceBackend";

const CLIPBOARD_PREVIEW_H = 36;
const SUGGESTION_SECTION_LABEL_H = 24;
/** 与 `.quick-launcher__list { max-height }` 保持一致，避免窗体高于列表留下底空白 */
const LIST_MAX_H = 320;
/** 询问 AI 结果区高度（含提问摘要 + Markdown 正文滚动区） */
const AI_ANSWER_PANEL_H = 360;

type AiAskState = {
  prompt: string;
  answer: string;
  status: "streaming" | "done" | "error";
  errorMessage?: string;
};

/** 与页内询问 AI 相同的解析规则，展示当前将使用的模型名 */
function resolveQuickLauncherModelLabel(
  providers: AiModelProvider[],
  configuredId: string | null | undefined,
): { short: string; full: string } | null {
  const selectionId = resolveScenarioModelSelectionId(providers, configuredId);
  if (!selectionId) return null;

  const backend = resolveBackendFromSelection(providers, selectionId);
  if (backend?.kind === "http") {
    const resolved = resolveModelSelection(providers, selectionId);
    const name = resolved?.name
      ?? (backend.backendId.includes("::")
        ? backend.backendId.slice(backend.backendId.lastIndexOf("::") + 2)
        : backend.httpProvider.providerId);
    const provider = providers.find((p) => p.id === backend.httpProvider.providerId);
    const providerName = provider?.providerName?.trim() || backend.httpProvider.providerId;
    return { short: name, full: `${providerName} / ${name}` };
  }
  if (backend?.kind === "cli") {
    const short = backend.modelId || backend.providerId;
    return { short, full: backend.backendId };
  }
  if (backend?.kind === "acp") {
    return { short: backend.agentKind, full: backend.backendId };
  }
  return { short: selectionId, full: selectionId };
}
/** 与侧栏一致的模块图标行（点击打开独立窗） */
const MODULE_ICON_DEFS: Array<{ key: ModuleKey; icon: ReactNode }> = [
  {
    key: "terminal",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M4 17l6-6-6-6" />
        <path d="M12 19h8" />
      </svg>
    ),
  },
  {
    key: "database",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <ellipse cx="12" cy="5" rx="9" ry="3" />
        <path d="M21 12c0 1.66-4.03 3-9 3s-9-1.34-9-3" />
        <path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5" />
      </svg>
    ),
  },
  {
    key: "docker",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <rect x="2" y="7" width="6" height="5" rx="1" />
        <rect x="10" y="7" width="6" height="5" rx="1" />
        <rect x="18" y="7" width="4" height="5" rx="1" />
        <rect x="6" y="2" width="6" height="5" rx="1" />
        <path d="M2 17h20c0 2.76-4.48 5-10 5S2 19.76 2 17z" />
      </svg>
    ),
  },
  {
    key: "server",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <rect x="2" y="2" width="20" height="8" rx="2" />
        <rect x="2" y="14" width="20" height="8" rx="2" />
        <circle cx="6" cy="6" r="1" fill="currentColor" />
        <circle cx="6" cy="18" r="1" fill="currentColor" />
      </svg>
    ),
  },
  {
    key: "files",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
      </svg>
    ),
  },
  {
    key: "protocol",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
      </svg>
    ),
  },
  {
    key: "workflow",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M12 3v18M3 12h18" />
        <circle cx="12" cy="12" r="3" />
      </svg>
    ),
  },
  {
    key: "knowledge",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M4 19.5A2.5 2.5 0 016.5 17H20" />
        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z" />
      </svg>
    ),
  },
  {
    key: "tasks",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M9 11l3 3L22 4" />
        <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
      </svg>
    ),
  },
];

const MODULE_BAR_H = 48;
const INPUT_ROW_H = 56;
const SOLO_MODE_LS_KEY = "omnipanel.quickLauncher.soloMode";

function readSoloMode(): boolean {
  try {
    const raw = window.localStorage.getItem(SOLO_MODE_LS_KEY);
    // 默认开启：点击图标打开单模块窗
    if (raw == null) return true;
    return raw === "1" || raw === "true";
  } catch {
    return true;
  }
}

function writeSoloMode(on: boolean): void {
  try {
    window.localStorage.setItem(SOLO_MODE_LS_KEY, on ? "1" : "0");
  } catch {
    /* ignore */
  }
}

function rowToAction(row: QuickLaunchMatchRow): QuickLauncherAction {
  switch (row.type) {
    case "ssh-connection":
      return { kind: "ssh-connection", connectionId: row.connectionId };
    case "db-connection":
      return { kind: "db-connection", connectionId: row.connectionId };
    case "db-database":
      return {
        kind: "db-database",
        connectionId: row.connectionId,
        database: row.database,
      };
    case "db-table":
      return {
        kind: "db-table",
        connectionId: row.connectionId,
        database: row.database,
        table: row.table,
      };
    case "everything-path":
      return { kind: "open-path", path: row.path };
    case "system-app":
      return { kind: "launch-app", appId: row.appId, name: row.label };
    case "module-service":
      return {
        kind: "module-service",
        connectionId: row.connectionId,
        moduleKey: row.moduleKey,
      };
  }
}

type ListItem =
  | { kind: "match"; id: string; row: QuickLaunchMatchRow }
  | { kind: "suggestion"; id: string; suggestion: SuggestedAction }
  | { kind: "history"; id: string; entry: QuickLauncherAskHistoryEntry }
  | {
      kind: "slash-command";
      id: string;
      commandId: SlashCommandId;
      insertQuery: string;
      label: string;
      subtitle: string;
    }
  | {
      kind: "slash-model";
      id: string;
      selectionId: string;
      label: string;
      subtitle: string;
      current: boolean;
    }
  | {
      kind: "slash-dashboard";
      id: string;
      tabId: string;
      label: string;
      subtitle: string;
      current: boolean;
    };

function entityLabel(
  kind: EntityKind,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  const key = `shell.quickLauncher.entity.${kind}`;
  const label = t(key);
  return label === key ? kind : label;
}

function rowToRecentTarget(row: QuickLaunchMatchRow): QuickLaunchRecentTarget {
  switch (row.type) {
    case "ssh-connection":
      return { type: "ssh-connection", connectionId: row.connectionId };
    case "db-connection":
      return { type: "db-connection", connectionId: row.connectionId };
    case "db-database":
      return {
        type: "db-database",
        connectionId: row.connectionId,
        database: row.database,
      };
    case "db-table":
      return {
        type: "db-table",
        connectionId: row.connectionId,
        database: row.database,
        table: row.table,
      };
    case "everything-path":
      return { type: "ssh-connection", connectionId: "" };
    case "system-app":
      return { type: "ssh-connection", connectionId: "" };
    case "module-service":
      return { type: "ssh-connection", connectionId: "" };
  }
}

function formatQuickLaunchLastUsed(
  lastUsedAt: number | undefined,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  if (lastUsedAt == null || lastUsedAt <= 0) {
    return t("shell.quickLauncher.neverUsed");
  }
  const diff = Date.now() - lastUsedAt;
  if (diff < 60_000) return t("knowledge.time.justNow");
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return t("knowledge.time.minutesAgo", { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("knowledge.time.hoursAgo", { n: hours });
  const days = Math.floor(hours / 24);
  return t("knowledge.time.daysAgo", { n: days });
}

function AskHistoryStarIcon({ filled }: { filled: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden>
      <path
        d="M12 3.5l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.8 6.8 19.5l1-5.8L3.6 9.6l5.8-.8L12 3.5z"
        fill={filled ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function AskHistoryTrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden>
      <path
        d="M5 7h14M9 7V5h6v2m-8 0l1 12h8l1-12"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * 托盘态快捷启动窗：顶部模块图标 + 单行搜索 + 底部匹配列表。
 * 独立于主窗口 Bootstrap，仅轻量初始化连接列表。
 */
function kernelNavKeys(): ModuleKey[] {
  return getNavVisibleModuleKeys().filter(isKernelModuleKey);
}

export function QuickLauncherRoot() {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [ready, setReady] = useState(false);
  const [visibleModuleKeys, setVisibleModuleKeys] = useState<ModuleKey[]>(() =>
    kernelNavKeys(),
  );
  const [soloMode, setSoloMode] = useState(readSoloMode);
  /** 焦点窗内按住 Ctrl 时显示模块序号角标 */
  const [ctrlHeld, setCtrlHeld] = useState(false);
  const [clipboardText, setClipboardText] = useState("");
  const [clipboardSensitive, setClipboardSensitive] = useState(false);
  const [aiAsk, setAiAsk] = useState<AiAskState | null>(null);
  const [dashboardCatalog, setDashboardCatalog] = useState<DashboardCatalogEntry[]>([]);
  const [dashboardActiveTabId, setDashboardActiveTabId] = useState<string | null>(null);
  const [systemApps, setSystemApps] = useState<SystemAppEntry[]>([]);
  /** 触发系统应用图标重绘（Map 本身不进 state） */
  const [systemAppIconTick, setSystemAppIconTick] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const moduleButtonsRef = useRef<typeof MODULE_ICON_DEFS>([]);
  const openModuleFromIconRef = useRef<(moduleKey: ModuleKey) => Promise<void>>(
    async () => {},
  );
  const openMainWindowRef = useRef<() => Promise<void>>(async () => {});
  const lastClipboardRef = useRef("");
  const aiAbortRef = useRef<AbortController | null>(null);
  /** 页内 AI 进行中：失焦不关窗，避免流式中途被关掉 */
  const aiAskOpenRef = useRef(false);
  const unifiedConnections = useConnectionStore((s) => s.connections);
  const [dbConnections, setDbConnections] = useState<Connection[]>([]);
  const schemaSnapshot = useDbSchemaCacheStore((s) => s.snapshot);
  const schemaRevision = useDbSchemaCacheStore((s) => s.revision);
  const recentEntries = useQuickLauncherRecentStore((s) => s.entries);
  const recordRecentOpen = useQuickLauncherRecentStore((s) => s.recordOpen);
  const actionUseCounts = useQuickLauncherActionStatsStore((s) => s.useCounts);
  const recordActionUse = useQuickLauncherActionStatsStore((s) => s.recordUse);
  const askHistoryEntries = useQuickLauncherAskHistoryStore((s) => s.entries);
  const addAskHistoryEntry = useQuickLauncherAskHistoryStore((s) => s.addEntry);
  const removeAskHistoryEntry = useQuickLauncherAskHistoryStore((s) => s.removeEntry);
  const toggleAskHistoryFavorite = useQuickLauncherAskHistoryStore(
    (s) => s.toggleFavorite,
  );
  const aiProviders = useAiModelsStore((s) => s.providers);
  const assistantModelSelectionId = useSettingsStore(
    (s) => s.aiScenarioAssistantModelSelectionId,
  );
  const setAiScenarioSettings = useSettingsStore((s) => s.setAiScenarioSettings);
  const activeModelLabel = useMemo(
    () => resolveQuickLauncherModelLabel(aiProviders, assistantModelSelectionId),
    [aiProviders, assistantModelSelectionId],
  );

  const refreshClipboard = useCallback(async () => {
    const result = await readClipboardText();
    if (result.text === lastClipboardRef.current) {
      setClipboardSensitive(result.sensitive);
      return;
    }
    lastClipboardRef.current = result.text;
    setClipboardText(result.text);
    setClipboardSensitive(result.sensitive);
  }, []);

  const reloadDbConnections = useCallback(async () => {
    try {
      const list = await listDbConnections();
      setDbConnections(list.map(dbConnectionToQuickLaunchConnection));
    } catch (e) {
      console.warn("[quickLauncher] load db connections failed", e);
    }
  }, []);

  // 数据库连接在独立存储，需与统一 conn_list 合并后才能匹配 db 前缀
  const connections = useMemo(
    () => mergeQuickLaunchConnections(unifiedConnections, dbConnections),
    [unifiedConnections, dbConnections],
  );

  useEffect(() => {
    dismissHtmlBootSplash();
    document.documentElement.classList.add("quick-launcher-root");
    document.body.classList.add("quick-launcher-body");
    // 供 Rust show_launcher 判断：本窗已具备页内 AI，无需为追 HMR 而 reload
    (
      window as Window & { __OMNIPANEL_QL_HAS_INPANEL_AI__?: boolean }
    ).__OMNIPANEL_QL_HAS_INPANEL_AI__ = true;
    // 本窗 localStorage 与主窗隔离；先套默认，再经 appearanceSync 拉主窗配置
    initSettings();
    const unsubAppearance = initAppearanceSyncSubscriber();
    let cancelled = false;
    void (async () => {
      try {
        await Promise.all([
          initConnections(),
          reloadDbConnections(),
          initAppModuleStore().catch(() => {}),
          initPluginRuntimeStore().catch(() => {}),
          initAiModelsStore().catch(() => {}),
          useDbSchemaCacheStore.getState().hydrate().catch(() => {}),
          refreshClipboard(),
          listSystemApps().then((apps) => {
            if (!cancelled) setSystemApps(apps);
          }),
        ]);
      } catch (e) {
        console.warn("[quickLauncher] init failed", e);
      }
      if (!cancelled) {
        setVisibleModuleKeys(kernelNavKeys());
        setReady(true);
      }
    })();

    const unsubDashboardCatalog = initDashboardCatalogSubscriber((payload) => {
      setDashboardCatalog(payload.entries);
      setDashboardActiveTabId(payload.activeTabId ?? null);
    });

    return () => {
      cancelled = true;
      unsubAppearance();
      unsubDashboardCatalog();
      document.documentElement.classList.remove("quick-launcher-root");
      document.body.classList.remove("quick-launcher-body");
    };
  }, [reloadDbConnections, refreshClipboard]);

  const ignoreBlurUntilRef = useRef(0);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listenQuickLauncherShown((payload) => {
      ignoreBlurUntilRef.current = Date.now() + 250;
      setQuery("");
      setSelectedIndex(0);
      // 页内 AI 进行中时不要被重复 shown（或误触）清掉
      if (!aiAskOpenRef.current) {
        aiAbortRef.current?.abort();
        aiAbortRef.current = null;
        setAiAsk(null);
      }
      // Ctrl+Space 唤醒时 Ctrl 仍按着，直接显示角标；托盘等其它入口则不显示
      setCtrlHeld(payload.ctrlHeld === true);
      setVisibleModuleKeys(kernelNavKeys());
      // 每次显示时向主窗请求外观（独立 data_directory 无法读主窗 localStorage）
      void requestAppearanceSync();
      // 强制重载 schema / 数据库连接：主窗可能已变更
      void useDbSchemaCacheStore.getState().hydrate({ force: true }).catch(() => {});
      void reloadDbConnections();
      void refreshClipboard();
      void initAiModelsStore().catch(() => {});
      void requestDashboardCatalog();
      void listSystemApps().then(setSystemApps);
      requestAnimationFrame(() => inputRef.current?.focus());
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, [reloadDbConnections, refreshClipboard]);

  useEffect(() => {
    if (!ready) return;
    ignoreBlurUntilRef.current = Date.now() + 250;
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [ready]);

  // 失焦关闭（刚显示时忽略短暂失焦，避免抢焦点竞态）
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let unlisten: (() => void) | undefined;
    void getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        if (!focused) {
          setCtrlHeld(false);
          if (aiAskOpenRef.current) {
            // 页内 AI 展示中：失焦不关窗。禁止 setFocus 抢回——否则会把已隐藏/屏外窗再度抬起，挡住鼠标
            return;
          }
          if (Date.now() >= ignoreBlurUntilRef.current) {
            void hideQuickLauncher();
          }
        }
      })
      .then((fn) => {
        unlisten = fn;
      });
    return () => unlisten?.();
  }, []);

  // 任意路径隐藏后清掉页内 AI 标记，避免隐藏窗仍被当成「AI 展示中」
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let unlisten: (() => void) | undefined;
    void listenQuickLauncherHidden(() => {
      aiAbortRef.current?.abort();
      aiAbortRef.current = null;
      aiAskOpenRef.current = false;
      setAiAsk(null);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  const moduleButtons = useMemo(() => {
    const visible = new Set(visibleModuleKeys);
    return MODULE_ICON_DEFS.filter((item) => visible.has(item.key));
  }, [visibleModuleKeys]);

  moduleButtonsRef.current = moduleButtons;

  const parsedQuery = useMemo(() => parseQuickLaunchQuery(query), [query]);
  const isEmptyQuery = query.trim().length === 0;

  /** 检测源：有输入用输入；空输入用剪贴板 */
  const detectSourceText = isEmptyQuery ? clipboardText : query.trim();

  const suggestions = useMemo(() => {
    if (!detectSourceText) return [];
    return buildSuggestions(detectSourceText, {
      connections,
      recentEntries,
      actionUseCounts,
      maxSuggestions: 5,
    });
  }, [detectSourceText, connections, recentEntries, actionUseCounts]);

  const matchRows = useMemo<QuickLaunchMatchRow[]>(() => {
    // 无输入：展示最近打开（次数 ↓，同次数时间 ↓）
    if (isEmptyQuery) {
      const sorted = [...recentEntries].sort((a, b) => {
        if (b.useCount !== a.useCount) return b.useCount - a.useCount;
        return b.lastUsedAt - a.lastUsedAt;
      });
      return buildQuickLaunchRecentRows({
        entries: sorted,
        connections,
      });
    }

    // schemaRevision：缓存更新时重算匹配
    void schemaRevision;
    return buildQuickLaunchMatches({
      query: parsedQuery,
      connections,
      schema: schemaSnapshot,
      systemApps,
    });
  }, [
    isEmptyQuery,
    recentEntries,
    parsedQuery,
    connections,
    schemaSnapshot,
    schemaRevision,
    systemApps,
  ]);

  const everythingEnabled = usePluginRuntimeStore((s) =>
    s.items.some((item) => item.id === PLUGIN_ID_EVERYTHING && item.enabled && item.activated),
  );
  const esRows = useDebouncedEsQuery(
    parsedQuery.kind === "es" ? parsedQuery.filter : "",
    parsedQuery.kind === "es" && everythingEnabled,
  );

  const resolvedMatchRows =
    parsedQuery.kind === "es" ? esRows : matchRows;

  // 可见系统应用行：按需拉图标
  useEffect(() => {
    const ids = resolvedMatchRows
      .filter((r): r is Extract<QuickLaunchMatchRow, { type: "system-app" }> => r.type === "system-app")
      .map((r) => r.appId);
    if (ids.length === 0) return;
    let cancelled = false;
    void ensureSystemAppIcons(ids).then(() => {
      if (!cancelled) setSystemAppIconTick((n) => n + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [resolvedMatchRows]);

  const askHistoryForDisplay = useMemo(() => {
    return [...askHistoryEntries].sort((a, b) => {
      if (a.favorited !== b.favorited) return a.favorited ? -1 : 1;
      return b.createdAt - a.createdAt;
    });
  }, [askHistoryEntries]);

  const showAskHistory =
    (isEmptyQuery || parsedQuery.kind === "plain") && askHistoryForDisplay.length > 0;

  const listItems = useMemo<ListItem[]>(() => {
    const items: ListItem[] = [];

    // `/` 斜杠命令：不与建议 / 询问记录混排
    if (parsedQuery.kind === "slash-catalog") {
      for (const entry of matchSlashCatalog(parsedQuery.filter)) {
        items.push({
          kind: "slash-command",
          id: `slash-cmd:${entry.id}`,
          commandId: entry.id,
          insertQuery: entry.insertQuery,
          label: t(`shell.quickLauncher.slash.${entry.id}.label`),
          subtitle: t(`shell.quickLauncher.slash.${entry.id}.desc`),
        });
      }
      return items;
    }

    if (parsedQuery.kind === "slash-model") {
      const currentId = resolveSlashModelCurrentId(
        aiProviders,
        assistantModelSelectionId,
      );
      for (const row of buildSlashModelRows(
        aiProviders,
        parsedQuery.filter,
        currentId,
      )) {
        items.push({
          kind: "slash-model",
          id: row.id,
          selectionId: row.selectionId,
          label: row.label,
          subtitle: row.current
            ? `${row.subtitle} · ${t("shell.quickLauncher.slash.model.current")}`
            : row.subtitle,
          current: row.current,
        });
      }
      return items;
    }

    if (parsedQuery.kind === "slash-dashboard") {
      for (const row of buildSlashDashboardRows(
        dashboardCatalog,
        parsedQuery.filter,
        dashboardActiveTabId,
        (entry) =>
          entry.kind === "builtin"
            ? t("homeWorkspace.tabs.board")
            : (entry.label?.trim() || t("shell.quickLauncher.slash.dash.untitled")),
      )) {
        const baseSub =
          row.kind === "builtin"
            ? t("shell.quickLauncher.slash.dash.builtinSub")
            : t("shell.quickLauncher.slash.dash.customSub", {
                n: row.widgetCount ?? 0,
              });
        items.push({
          kind: "slash-dashboard",
          id: row.id,
          tabId: row.tabId,
          label: row.label,
          subtitle: row.current
            ? `${baseSub} · ${t("shell.quickLauncher.slash.dash.current")}`
            : baseSub,
          current: row.current,
        });
      }
      return items;
    }

    for (const s of suggestions) {
      items.push({ kind: "suggestion", id: `sug:${s.actionKey}`, suggestion: s });
    }
    // 空输入 / plain：建议 → 询问记录 → 最近/匹配
    if (isEmptyQuery || parsedQuery.kind === "plain") {
      if (showAskHistory) {
        for (const entry of askHistoryForDisplay) {
          items.push({ kind: "history", id: `ask:${entry.id}`, entry });
        }
      }
      for (const row of resolvedMatchRows) {
        items.push({ kind: "match", id: row.id, row });
      }
    } else {
      // ssh/db 前缀：匹配结果优先，建议次之（不含询问记录）
      const sugItems = items.splice(0, items.length);
      for (const row of resolvedMatchRows) {
        items.push({ kind: "match", id: row.id, row });
      }
      items.push(...sugItems);
    }
    return items;
  }, [
    suggestions,
    resolvedMatchRows,
    isEmptyQuery,
    parsedQuery,
    showAskHistory,
    askHistoryForDisplay,
    aiProviders,
    assistantModelSelectionId,
    dashboardCatalog,
    dashboardActiveTabId,
    t,
  ]);

  const showEmptyHint = query.trim().length > 0 && listItems.length === 0;

  const clipboardEntityKind = useMemo(
    () => (clipboardText ? primaryEntityKind(clipboardText) : null),
    [clipboardText],
  );

  const showClipboardBar = isEmptyQuery && clipboardText.length > 0;

  useEffect(() => {
    setSelectedIndex(0);
  }, [query, listItems.length, clipboardText]);

  const listLayoutSig = useMemo(() => {
    const suggestionCount = listItems.filter((i) => i.kind === "suggestion").length;
    const historyCount = listItems.filter((i) => i.kind === "history").length;
    const slashCount = listItems.filter(
      (i) =>
        i.kind === "slash-command" ||
        i.kind === "slash-model" ||
        i.kind === "slash-dashboard",
    ).length;
    return {
      suggestionCount,
      historyCount,
      slashCount,
      rowCount: Math.min(listItems.length, 12),
      itemCount: listItems.length,
    };
  }, [listItems]);

  useEffect(() => {
    if (aiAsk) {
      const height = MODULE_BAR_H + INPUT_ROW_H + AI_ANSWER_PANEL_H;
      void setQuickLauncherHeight(height);
      return;
    }
    const sectionLabels =
      (listLayoutSig.suggestionCount > 0 ? 1 : 0) +
      (listLayoutSig.historyCount > 0 ? 1 : 0) +
      (listLayoutSig.slashCount > 0 ? 1 : 0);
    const rawListH =
      listLayoutSig.itemCount > 0
        ? listLayoutSig.rowCount * 40 + 8 + sectionLabels * SUGGESTION_SECTION_LABEL_H
        : showEmptyHint
          ? 48
          : 0;
    // 不得超过列表 CSS max-height，否则窗体比可视列表更高，底部留白
    const listH = Math.min(rawListH, LIST_MAX_H);
    const clipH = showClipboardBar ? CLIPBOARD_PREVIEW_H : 0;
    const height = MODULE_BAR_H + INPUT_ROW_H + clipH + listH;
    void setQuickLauncherHeight(height);
  }, [aiAsk, listLayoutSig, showClipboardBar, showEmptyHint]);

  const clearAiAsk = useCallback(() => {
    aiAbortRef.current?.abort();
    aiAbortRef.current = null;
    aiAskOpenRef.current = false;
    ignoreBlurUntilRef.current = Date.now() + 400;
    setAiAsk(null);
  }, []);

  const startInPanelAskAi = useCallback(async (prompt: string) => {
    const text = prompt.trim();
    if (!text) return;
    aiAbortRef.current?.abort();
    const controller = new AbortController();
    aiAbortRef.current = controller;
    aiAskOpenRef.current = true;
    // 拉长失焦忽略，避免改窗高时 Windows 短暂失焦把启动窗关掉、焦点落到主窗 AI 抽屉
    ignoreBlurUntilRef.current = Date.now() + 120_000;
    setAiAsk({
      prompt: text,
      answer: "",
      status: "streaming",
    });
    try {
      if (isTauriRuntime()) {
        await getCurrentWindow().setFocus();
      }
    } catch {
      /* ignore */
    }
    requestAnimationFrame(() => inputRef.current?.focus());

    const result = await streamQuickLauncherAskAi({
      prompt: text,
      signal: controller.signal,
      onDelta: (answer) => {
        setAiAsk((prev) =>
          prev && prev.status === "streaming" ? { ...prev, answer } : prev,
        );
      },
    });
    if (controller.signal.aborted) {
      return;
    }
    if (aiAbortRef.current === controller) {
      aiAbortRef.current = null;
    }
    // 结束后仍保持页内结果，直到用户 Esc / 返回；继续挡住失焦关窗
    ignoreBlurUntilRef.current = Date.now() + 120_000;
    if (result.ok) {
      setAiAsk((prev) =>
        prev
          ? { ...prev, answer: result.content, status: "done" }
          : prev,
      );
      addAskHistoryEntry(text, result.content);
      return;
    }
    if (result.reason === "aborted") return;
    const message =
      result.reason === "no-provider"
        ? "no-provider"
        : result.message || "request-failed";
    setAiAsk((prev) =>
      prev
        ? {
            ...prev,
            status: "error",
            errorMessage: message,
          }
        : prev,
    );
  }, [addAskHistoryEntry]);

  const openAskHistoryEntry = useCallback((entry: QuickLauncherAskHistoryEntry) => {
    aiAbortRef.current?.abort();
    aiAbortRef.current = null;
    aiAskOpenRef.current = true;
    ignoreBlurUntilRef.current = Date.now() + 120_000;
    setAiAsk({
      prompt: entry.prompt,
      answer: entry.answer,
      status: "done",
    });
    try {
      if (isTauriRuntime()) {
        void getCurrentWindow().setFocus();
      }
    } catch {
      /* ignore */
    }
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  const activateMatch = useCallback(
    async (row: QuickLaunchMatchRow) => {
      clearAiAsk();
      if (row.type === "everything-path") {
        await hideQuickLauncher();
        await emitQuickLauncherAction({ kind: "open-path", path: row.path });
        return;
      }
      if (row.type === "system-app") {
        await hideQuickLauncher();
        try {
          await launchSystemApp(row.appId);
        } catch (e) {
          console.warn("[quickLauncher] launch_system_app failed", e);
        }
        return;
      }
      recordRecentOpen(rowToRecentTarget(row), row.label);
      const action = rowToAction(row);
      // 先隐藏 always_on_top 启动窗，再打开目标，避免隐形窗挡鼠标
      await hideQuickLauncher();
      if (soloMode) {
        const moduleKey = moduleKeyForQuickLauncherAction(action);
        if (moduleKey) {
          await runQuickLauncherActionInSoloModule(
            action,
            t(`shell.nav.${moduleKey}`),
          );
        } else {
          await emitQuickLauncherAction(action);
        }
      } else {
        await emitQuickLauncherAction(action);
      }
    },
    [clearAiAsk, recordRecentOpen, soloMode, t],
  );

  const activateSuggestion = useCallback(
    async (suggestion: SuggestedAction) => {
      recordActionUse(suggestion.actionKey);
      const action = suggestion.action;
      // 询问 AI：留在快捷启动窗内流式展示，不跳转 AI 助手、不 emit、不关窗
      if (action.kind === "ask-ai") {
        void startInPanelAskAi(action.prompt);
        return;
      }
      clearAiAsk();
      await hideQuickLauncher();
      if (soloMode) {
        const moduleKey = moduleKeyForQuickLauncherAction(action);
        if (moduleKey) {
          await runQuickLauncherActionInSoloModule(
            action,
            t(`shell.nav.${moduleKey}`),
          );
        } else {
          await emitQuickLauncherAction(action);
        }
      } else {
        await emitQuickLauncherAction(action);
      }
    },
    [clearAiAsk, recordActionUse, soloMode, startInPanelAskAi, t],
  );

  const activateItem = useCallback(
    async (item: ListItem) => {
      if (item.kind === "slash-command") {
        setQuery(item.insertQuery);
        requestAnimationFrame(() => {
          const el = inputRef.current;
          if (!el) return;
          el.focus();
          el.setSelectionRange(item.insertQuery.length, item.insertQuery.length);
        });
        return;
      }
      if (item.kind === "slash-model") {
        setAiScenarioSettings({
          aiScenarioAssistantModelSelectionId: item.selectionId,
        });
        await broadcastAppearance();
        // 留在面板：清空输入回到初始列表（最近 / 建议 / 询问记录）
        clearAiAsk();
        setQuery("");
        setSelectedIndex(0);
        ignoreBlurUntilRef.current = Date.now() + 400;
        requestAnimationFrame(() => inputRef.current?.focus());
        return;
      }
      if (item.kind === "slash-dashboard") {
        // 先关启动窗（always_on_top），再唤醒主窗打开看板，避免隐形窗挡鼠标
        clearAiAsk();
        await hideQuickLauncher();
        await emitQuickLauncherAction({
          kind: "open-dashboard",
          tabId: item.tabId,
        });
        return;
      }
      if (item.kind === "match") {
        await activateMatch(item.row);
        return;
      }
      if (item.kind === "history") {
        openAskHistoryEntry(item.entry);
        return;
      }
      await activateSuggestion(item.suggestion);
    },
    [activateMatch, activateSuggestion, clearAiAsk, openAskHistoryEntry, setAiScenarioSettings],
  );

  const toggleSoloMode = useCallback(() => {
    setSoloMode((prev) => {
      const next = !prev;
      writeSoloMode(next);
      return next;
    });
  }, []);

  const openModuleFromIcon = useCallback(
    async (moduleKey: ModuleKey) => {
      // 点击图标会抢焦点；延长忽略失焦窗口，避免未打开就关启动窗
      ignoreBlurUntilRef.current = Date.now() + 800;
      clearAiAsk();
      await hideQuickLauncher();
      if (soloMode) {
        await openModuleWindow(moduleKey, t(`shell.nav.${moduleKey}`));
      } else {
        // 关闭 SOLO：唤醒主窗并导航到对应模块
        await emitQuickLauncherAction({ kind: "command", id: moduleKey });
      }
    },
    [clearAiAsk, soloMode, t],
  );

  /** 打开主窗口：始终聚焦主窗，不受 SOLO 开关限制 */
  const openMainWindow = useCallback(async () => {
    ignoreBlurUntilRef.current = Date.now() + 800;
    clearAiAsk();
    await hideQuickLauncher();
    await emitQuickLauncherAction({ kind: "command", id: "focus-main" });
  }, [clearAiAsk]);

  openModuleFromIconRef.current = openModuleFromIcon;
  openMainWindowRef.current = openMainWindow;

  // Ctrl 角标 + Ctrl+` 主窗 / Ctrl+1~9 模块（捕获阶段，避免被输入框吞掉）
  useEffect(() => {
    const digitIndex = (e: KeyboardEvent): number | null => {
      const fromCode = (code: string, prefix: string): number | null => {
        if (!code.startsWith(prefix)) return null;
        const n = Number(code.slice(prefix.length));
        if (!Number.isFinite(n) || n < 1 || n > 9) return null;
        return n - 1;
      };
      return fromCode(e.code, "Digit") ?? fromCode(e.code, "Numpad");
    };

    const onKeyDown = (e: KeyboardEvent) => {
      // 任意按键同步 Ctrl 状态（含唤醒后 Space 的后续事件）
      if (e.key === "Control" || e.ctrlKey) {
        setCtrlHeld(true);
      }
      if (e.key === "Control") return;
      if (!e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
      // Ctrl+`：打开主窗口（不受 SOLO 限制）
      if (e.code === "Backquote" || e.key === "`") {
        e.preventDefault();
        e.stopPropagation();
        setCtrlHeld(false);
        void openMainWindowRef.current();
        return;
      }
      const index = digitIndex(e);
      if (index == null) return;
      const item = moduleButtonsRef.current[index];
      if (!item) return;
      e.preventDefault();
      e.stopPropagation();
      setCtrlHeld(false);
      void openModuleFromIconRef.current(item.key);
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Control" || !e.ctrlKey) {
        setCtrlHeld(false);
      }
    };

    const onWindowBlur = () => setCtrlHeld(false);

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onWindowBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      if (aiAsk) {
        clearAiAsk();
        requestAnimationFrame(() => inputRef.current?.focus());
        return;
      }
      void hideQuickLauncher();
      return;
    }
    if (aiAsk) {
      // AI 结果态：方向键 / Enter 交给输入框，不操作列表
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, Math.max(listItems.length - 1, 0)));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
      return;
    }
    // 右方向键：光标在末尾时，将选中「匹配项」补全进输入框
    if (e.key === "ArrowRight") {
      const item = listItems[selectedIndex];
      const input = inputRef.current;
      if (!item || !input) return;
      const atEnd =
        input.selectionStart === input.value.length &&
        input.selectionEnd === input.value.length;
      if (!atEnd) return;
      let next: string | null = null;
      if (item.kind === "match") {
        next = rowToInsertQuery(item.row, query);
      } else if (item.kind === "slash-command") {
        next = item.insertQuery;
      } else if (item.kind === "slash-model") {
        next = `/model ${item.label}`;
      } else if (item.kind === "slash-dashboard") {
        next = `/dash ${item.label}`;
      } else {
        return;
      }
      if (next === query) return;
      e.preventDefault();
      setQuery(next);
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (!el) return;
        el.setSelectionRange(next!.length, next!.length);
      });
      return;
    }
    if (e.key === "Enter" && listItems[selectedIndex]) {
      e.preventDefault();
      void activateItem(listItems[selectedIndex]!);
    }
  };

  const firstSuggestionIndex = useMemo(
    () => listItems.findIndex((x) => x.kind === "suggestion"),
    [listItems],
  );
  const firstHistoryIndex = useMemo(
    () => listItems.findIndex((x) => x.kind === "history"),
    [listItems],
  );
  const firstSlashIndex = useMemo(
    () =>
      listItems.findIndex(
        (x) =>
          x.kind === "slash-command" ||
          x.kind === "slash-model" ||
          x.kind === "slash-dashboard",
      ),
    [listItems],
  );

  const openMainTitle = `${t("shell.quickLauncher.openMain")} (Ctrl+\`)`;

  const recentLastUsedByKey = useMemo(() => {
    const map = new Map<string, number>();
    for (const entry of recentEntries) {
      map.set(entry.key, entry.lastUsedAt);
    }
    return map;
  }, [recentEntries]);

  return (
    <div ref={rootRef} className="quick-launcher" data-ready={ready ? "1" : "0"}>
      <div className="quick-launcher__modules" role="toolbar" aria-label={t("shell.quickLauncher.modulesAria")}>
        <div className="quick-launcher__modules-icons">
          <button
            type="button"
            className="quick-launcher__module-btn quick-launcher__module-btn--main"
            title={openMainTitle}
            aria-label={openMainTitle}
            // 防止 mousedown 夺走输入框焦点触发失焦关闭
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void openMainWindow()}
          >
            {ctrlHeld ? (
              <span className="quick-launcher__module-badge" aria-hidden>
                `
              </span>
            ) : null}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
              <polyline points="9 22 9 12 15 12 15 22" />
            </svg>
          </button>
          <span className="quick-launcher__modules-sep" aria-hidden />
          {moduleButtons.map((item, index) => {
            const hotkey = index < 9 ? index + 1 : null;
            const title =
              hotkey != null
                ? `${t(`shell.nav.${item.key}`)} (Ctrl+${hotkey})`
                : t(`shell.nav.${item.key}`);
            return (
              <button
                key={item.key}
                type="button"
                className="quick-launcher__module-btn"
                title={title}
                aria-label={title}
                // 防止 mousedown 夺走输入框焦点触发失焦关闭
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => void openModuleFromIcon(item.key)}
              >
                {ctrlHeld && hotkey != null ? (
                  <span className="quick-launcher__module-badge" aria-hidden>
                    {hotkey}
                  </span>
                ) : null}
                {item.icon}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          className={`quick-launcher__solo${soloMode ? " is-on" : ""}`}
          title={soloMode ? t("shell.quickLauncher.soloOnHint") : t("shell.quickLauncher.soloOffHint")}
          aria-pressed={soloMode}
          aria-label={t("shell.quickLauncher.soloAria")}
          onMouseDown={(e) => e.preventDefault()}
          onClick={toggleSoloMode}
        >
          SOLO
        </button>
      </div>
      <div className="quick-launcher__input-row">
        <AppLogo size={22} className="quick-launcher__logo" />
        <TextInput
          ref={inputRef}
          clearable={false}
          copyable={false}
          value={query}
          onChange={setQuery}
          onKeyDown={onKeyDown}
          placeholder={t("shell.quickLauncher.placeholder")}
          className="quick-launcher__input"
          style={{ height: "auto", padding: 0, background: "transparent", border: "none" }}
        />
        <span
          className={`quick-launcher__model${activeModelLabel ? "" : " is-empty"}`}
          title={
            activeModelLabel
              ? activeModelLabel.full
              : t("shell.quickLauncher.ai.noModelHint")
          }
        >
          {activeModelLabel
            ? activeModelLabel.short
            : t("shell.quickLauncher.ai.noModel")}
        </span>
        <kbd className="quick-launcher__kbd">ESC</kbd>
      </div>
      {!aiAsk && showClipboardBar ? (
        <div className="quick-launcher__clipboard" title={clipboardSensitive ? undefined : clipboardText}>
          <span className="quick-launcher__clipboard-tag">
            {clipboardEntityKind
              ? entityLabel(clipboardEntityKind, t)
              : t("shell.quickLauncher.clipboard.label")}
          </span>
          <span className="quick-launcher__clipboard-text">
            {clipboardSensitive
              ? t("shell.quickLauncher.clipboard.sensitive")
              : clipboardText.replace(/\s+/g, " ").slice(0, 80)}
          </span>
        </div>
      ) : null}
      {aiAsk ? (
        <QuickLauncherAiAnswer
          prompt={aiAsk.prompt}
          answer={aiAsk.answer}
          status={aiAsk.status}
          errorMessage={aiAsk.errorMessage}
          onBack={() => {
            clearAiAsk();
            requestAnimationFrame(() => inputRef.current?.focus());
          }}
        />
      ) : listItems.length > 0 ? (
        <ul className="quick-launcher__list" role="listbox">
          {listItems.map((item, index) => {
            const sectionLabel =
              item.kind === "suggestion" && index === firstSuggestionIndex ? (
                <li key="section-suggestions" className="quick-launcher__section-label" aria-hidden>
                  {t("shell.quickLauncher.suggestions.title")}
                </li>
              ) : item.kind === "history" && index === firstHistoryIndex ? (
                <li key="section-ask-history" className="quick-launcher__section-label" aria-hidden>
                  {t("shell.quickLauncher.askHistory.title")}
                </li>
              ) : (item.kind === "slash-command" ||
                  item.kind === "slash-model" ||
                  item.kind === "slash-dashboard") &&
                index === firstSlashIndex ? (
                <li key="section-slash" className="quick-launcher__section-label" aria-hidden>
                  {item.kind === "slash-model"
                    ? t("shell.quickLauncher.slash.model.section")
                    : item.kind === "slash-dashboard"
                      ? t("shell.quickLauncher.slash.dash.section")
                      : t("shell.quickLauncher.slash.commandsSection")}
                </li>
              ) : null;

            if (
              item.kind === "slash-command" ||
              item.kind === "slash-model" ||
              item.kind === "slash-dashboard"
            ) {
              return [
                sectionLabel,
                <li key={item.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={index === selectedIndex}
                    className={`quick-launcher__item${
                      index === selectedIndex ? " is-selected" : ""
                    }${
                      (item.kind === "slash-model" || item.kind === "slash-dashboard") &&
                      item.current
                        ? " is-current"
                        : ""
                    }`}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => void activateItem(item)}
                    onMouseEnter={() => setSelectedIndex(index)}
                  >
                    <span className="quick-launcher__item-module">
                      {item.kind === "slash-model"
                        ? t("shell.quickLauncher.slash.model.tag")
                        : item.kind === "slash-dashboard"
                          ? t("shell.quickLauncher.slash.dash.tag")
                          : t("shell.quickLauncher.slash.tag")}
                    </span>
                    <span className="quick-launcher__item-main">
                      <span className="quick-launcher__item-label">{item.label}</span>
                      {item.subtitle ? (
                        <span className="quick-launcher__item-sub">{item.subtitle}</span>
                      ) : null}
                    </span>
                  </button>
                </li>,
              ];
            }

            if (item.kind === "suggestion") {
              const s = item.suggestion;
              return [
                sectionLabel,
                <li key={item.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={index === selectedIndex}
                    className={`quick-launcher__item quick-launcher__item--suggestion${
                      index === selectedIndex ? " is-selected" : ""
                    }${s.dangerous ? " is-dangerous" : ""}`}
                    onMouseDown={(e) => {
                      // 避免抢焦点关窗；询问 AI 在 pointerdown 即启动，防止旧逻辑漏网
                      e.preventDefault();
                      if (s.action.kind === "ask-ai") {
                        setSelectedIndex(index);
                        void activateItem(item);
                      }
                    }}
                    onClick={() => {
                      if (s.action.kind === "ask-ai") return;
                      void activateItem(item);
                    }}
                    onMouseEnter={() => setSelectedIndex(index)}
                  >
                    <span className="quick-launcher__item-module">
                      {entityLabel(s.entityKind, t)}
                    </span>
                    <span className="quick-launcher__item-main">
                      <span className="quick-launcher__item-label">{s.label}</span>
                      {s.subtitle ? (
                        <span className="quick-launcher__item-sub">{s.subtitle}</span>
                      ) : null}
                    </span>
                  </button>
                </li>,
              ];
            }

            if (item.kind === "history") {
              const entry = item.entry;
              return [
                sectionLabel,
                <li key={item.id}>
                  <div
                    role="option"
                    aria-selected={index === selectedIndex}
                    className={`quick-launcher__item quick-launcher__item--history${
                      index === selectedIndex ? " is-selected" : ""
                    }`}
                    onMouseEnter={() => setSelectedIndex(index)}
                    onClick={() => void activateItem(item)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        void activateItem(item);
                      }
                    }}
                    tabIndex={-1}
                  >
                    <span className="quick-launcher__item-module">
                      {t("shell.quickLauncher.askHistory.tag")}
                    </span>
                    <span className="quick-launcher__item-main">
                      <span className="quick-launcher__item-label">
                        {entry.prompt.replace(/\s+/g, " ").slice(0, 80)}
                      </span>
                      <span className="quick-launcher__item-sub">
                        {formatQuickLaunchLastUsed(entry.createdAt, t)}
                      </span>
                    </span>
                    <span className="quick-launcher__item-actions">
                      <button
                        type="button"
                        className={`quick-launcher__item-action${
                          entry.favorited ? " is-active" : ""
                        }`}
                        title={
                          entry.favorited
                            ? t("shell.quickLauncher.askHistory.unfavorite")
                            : t("shell.quickLauncher.askHistory.favorite")
                        }
                        aria-label={
                          entry.favorited
                            ? t("shell.quickLauncher.askHistory.unfavorite")
                            : t("shell.quickLauncher.askHistory.favorite")
                        }
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleAskHistoryFavorite(entry.id);
                        }}
                      >
                        <AskHistoryStarIcon filled={entry.favorited} />
                      </button>
                      <button
                        type="button"
                        className="quick-launcher__item-action is-danger"
                        title={t("shell.quickLauncher.askHistory.delete")}
                        aria-label={t("shell.quickLauncher.askHistory.delete")}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={(e) => {
                          e.stopPropagation();
                          removeAskHistoryEntry(entry.id);
                        }}
                      >
                        <AskHistoryTrashIcon />
                      </button>
                    </span>
                  </div>
                </li>,
              ];
            }

            const row = item.row;
            const moduleKey = quickLaunchRowModule(row);
            const lastUsedAt = recentLastUsedByKey.get(
              quickLaunchRecentKey(rowToRecentTarget(row)),
            );
            const appIcon =
              row.type === "system-app"
                ? getCachedSystemAppIcon(row.appId) ?? undefined
                : undefined;
            // systemAppIconTick：图标异步到位后强制重读缓存
            void systemAppIconTick;
            return (
              <li key={item.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={index === selectedIndex}
                  className={`quick-launcher__item${index === selectedIndex ? " is-selected" : ""}`}
                  onClick={() => void activateItem(item)}
                  onMouseEnter={() => setSelectedIndex(index)}
                >
                  {row.type === "system-app" && appIcon ? (
                    <img
                      className="quick-launcher__item-app-icon"
                      src={appIcon}
                      alt=""
                      width={20}
                      height={20}
                      draggable={false}
                    />
                  ) : (
                    <span className="quick-launcher__item-module">
                      {t(`shell.quickLauncher.modules.${moduleKey}`)}
                    </span>
                  )}
                  <span className="quick-launcher__item-main">
                    <span className="quick-launcher__item-label">{row.label}</span>
                    {row.subtitle ? (
                      <span className="quick-launcher__item-sub">{row.subtitle}</span>
                    ) : null}
                  </span>
                  <span className="quick-launcher__item-time">
                    {formatQuickLaunchLastUsed(lastUsedAt, t)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : showEmptyHint ? (
        <div className="quick-launcher__empty">
          {parsedQuery.kind === "plain"
            ? t("shell.quickLauncher.plainHint")
            : parsedQuery.kind === "slash-catalog" ||
                parsedQuery.kind === "slash-model" ||
                parsedQuery.kind === "slash-dashboard"
              ? t("shell.quickLauncher.slash.noResults")
              : t("shell.quickLauncher.noResults")}
        </div>
      ) : null}
    </div>
  );
}
