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
import { type ModuleKey } from "../../lib/paths";
import {
  emitQuickLauncherAction,
  hideQuickLauncher,
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
  quickLaunchRecentKey,
  useQuickLauncherRecentStore,
  type QuickLaunchRecentTarget,
} from "../../stores/quickLauncherRecentStore";
import { listConnections as listDbConnections } from "../../modules/database/api";
import type { Connection } from "../../ipc/bindings";
import { openModuleWindow } from "../../lib/moduleWindow";
import { dismissHtmlBootSplash } from "../../lib/dismissBootSplash";
import { isTauriRuntime } from "../../lib/isTauriRuntime";
import { initSettings, useSettingsStore } from "../../stores/settingsStore";

/** 等待 settings persist 水合，确保主题与主窗设置一致。 */
async function waitSettingsHydrated(timeoutMs = 400): Promise<void> {
  const store = useSettingsStore;
  if (store.persist.hasHydrated()) return;
  await new Promise<void>((resolve) => {
    const unsub = store.persist.onFinishHydration(() => {
      unsub();
      resolve();
    });
    window.setTimeout(() => {
      unsub();
      resolve();
    }, timeoutMs);
  });
}

/** 从 localStorage 重新拉取设置并应用到文档（跨 WebView 同步主题）。 */
async function syncSettingsThemeFromStorage(): Promise<void> {
  try {
    await useSettingsStore.persist.rehydrate();
  } catch {
    /* ignore */
  }
  initSettings();
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
  }
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

/**
 * 托盘态快捷启动窗：顶部模块图标 + 单行搜索 + 底部匹配列表。
 * 独立于主窗口 Bootstrap，仅轻量初始化连接列表。
 */
export function QuickLauncherRoot() {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [ready, setReady] = useState(false);
  const [visibleModuleKeys, setVisibleModuleKeys] = useState<ModuleKey[]>(() =>
    getNavVisibleModuleKeys(),
  );
  const [soloMode, setSoloMode] = useState(readSoloMode);
  /** 焦点窗内按住 Ctrl 时显示模块序号角标 */
  const [ctrlHeld, setCtrlHeld] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const moduleButtonsRef = useRef<typeof MODULE_ICON_DEFS>([]);
  const openModuleFromIconRef = useRef<(moduleKey: ModuleKey) => Promise<void>>(
    async () => {},
  );
  const openMainWindowRef = useRef<() => Promise<void>>(async () => {});
  const unifiedConnections = useConnectionStore((s) => s.connections);
  const [dbConnections, setDbConnections] = useState<Connection[]>([]);
  const schemaSnapshot = useDbSchemaCacheStore((s) => s.snapshot);
  const schemaRevision = useDbSchemaCacheStore((s) => s.revision);
  const recentEntries = useQuickLauncherRecentStore((s) => s.entries);
  const recordRecentOpen = useQuickLauncherRecentStore((s) => s.recordOpen);

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
    // 先套一层主题，避免水合前闪错色
    initSettings();
    let cancelled = false;
    void (async () => {
      try {
        await waitSettingsHydrated();
        if (cancelled) return;
        // 水合后再应用：与设置中的主题 / 强调色 / 语言一致
        initSettings();
        await Promise.all([
          initConnections(),
          reloadDbConnections(),
          initAppModuleStore().catch(() => {}),
          useDbSchemaCacheStore.getState().hydrate().catch(() => {}),
        ]);
      } catch (e) {
        console.warn("[quickLauncher] init failed", e);
      }
      if (!cancelled) {
        setVisibleModuleKeys(getNavVisibleModuleKeys());
        setReady(true);
      }
    })();

    // 主窗改主题会写 localStorage；此处监听以便已打开的启动窗同步
    const onStorage = (event: StorageEvent) => {
      if (event.key !== "omnipanel-settings") return;
      void syncSettingsThemeFromStorage();
    };
    window.addEventListener("storage", onStorage);

    return () => {
      cancelled = true;
      window.removeEventListener("storage", onStorage);
      document.documentElement.classList.remove("quick-launcher-root");
      document.body.classList.remove("quick-launcher-body");
    };
  }, [reloadDbConnections]);

  const ignoreBlurUntilRef = useRef(0);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listenQuickLauncherShown((payload) => {
      ignoreBlurUntilRef.current = Date.now() + 250;
      setQuery("");
      setSelectedIndex(0);
      // Ctrl+Space 唤醒时 Ctrl 仍按着，直接显示角标；托盘等其它入口则不显示
      setCtrlHeld(payload.ctrlHeld === true);
      setVisibleModuleKeys(getNavVisibleModuleKeys());
      // 每次显示时从存储重拉主题（主窗可能已改设置）
      void syncSettingsThemeFromStorage();
      // 强制重载 schema / 数据库连接：主窗可能已变更
      void useDbSchemaCacheStore.getState().hydrate({ force: true }).catch(() => {});
      void reloadDbConnections();
      requestAnimationFrame(() => inputRef.current?.focus());
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, [reloadDbConnections]);

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

  const moduleButtons = useMemo(() => {
    const visible = new Set(visibleModuleKeys);
    return MODULE_ICON_DEFS.filter((item) => visible.has(item.key));
  }, [visibleModuleKeys]);

  moduleButtonsRef.current = moduleButtons;

  const parsedQuery = useMemo(() => parseQuickLaunchQuery(query), [query]);
  const isEmptyQuery = query.trim().length === 0;

  const rows = useMemo<QuickLaunchMatchRow[]>(() => {
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
    });
  }, [
    isEmptyQuery,
    recentEntries,
    parsedQuery,
    connections,
    schemaSnapshot,
    schemaRevision,
  ]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query, rows.length]);

  useEffect(() => {
    const listH = rows.length > 0 ? Math.min(rows.length, 8) * 40 + 8 : 0;
    const height = MODULE_BAR_H + INPUT_ROW_H + listH;
    void setQuickLauncherHeight(height);
  }, [rows.length]);

  const activate = useCallback(
    async (row: QuickLaunchMatchRow) => {
      recordRecentOpen(rowToRecentTarget(row), row.label);
      const action = rowToAction(row);
      try {
        if (soloMode) {
          const moduleKey = moduleKeyForQuickLauncherAction(action);
          if (moduleKey) {
            // SOLO：在对应模块独立窗中打开匹配项
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
      } finally {
        await hideQuickLauncher();
      }
    },
    [recordRecentOpen, soloMode, t],
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
      try {
        if (soloMode) {
          await openModuleWindow(moduleKey, t(`shell.nav.${moduleKey}`));
        } else {
          // 关闭 SOLO：唤醒主窗并导航到对应模块
          await emitQuickLauncherAction({ kind: "command", id: moduleKey });
        }
      } finally {
        await hideQuickLauncher();
      }
    },
    [soloMode, t],
  );

  /** 打开主窗口：始终聚焦主窗，不受 SOLO 开关限制 */
  const openMainWindow = useCallback(async () => {
    ignoreBlurUntilRef.current = Date.now() + 800;
    try {
      await emitQuickLauncherAction({ kind: "command", id: "focus-main" });
    } finally {
      await hideQuickLauncher();
    }
  }, []);

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
      void hideQuickLauncher();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, Math.max(rows.length - 1, 0)));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
      return;
    }
    // 右方向键：光标在末尾时，将选中项补全进输入框
    if (e.key === "ArrowRight") {
      const row = rows[selectedIndex];
      const input = inputRef.current;
      if (!row || !input) return;
      const atEnd =
        input.selectionStart === input.value.length &&
        input.selectionEnd === input.value.length;
      if (!atEnd) return;
      e.preventDefault();
      const next = rowToInsertQuery(row, query);
      if (next === query) return;
      setQuery(next);
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (!el) return;
        el.setSelectionRange(next.length, next.length);
      });
      return;
    }
    if (e.key === "Enter" && rows[selectedIndex]) {
      e.preventDefault();
      void activate(rows[selectedIndex]!);
    }
  };

  const showEmptyHint = query.trim().length > 0 && rows.length === 0;
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
        <kbd className="quick-launcher__kbd">ESC</kbd>
      </div>
      {rows.length > 0 ? (
        <ul className="quick-launcher__list" role="listbox">
          {rows.map((row, index) => {
            const moduleKey = quickLaunchRowModule(row);
            const lastUsedAt = recentLastUsedByKey.get(
              quickLaunchRecentKey(rowToRecentTarget(row)),
            );
            return (
              <li key={row.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={index === selectedIndex}
                  className={`quick-launcher__item${index === selectedIndex ? " is-selected" : ""}`}
                  onClick={() => void activate(row)}
                  onMouseEnter={() => setSelectedIndex(index)}
                >
                  <span className="quick-launcher__item-module">
                    {t(`shell.quickLauncher.modules.${moduleKey}`)}
                  </span>
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
            : t("shell.quickLauncher.noResults")}
        </div>
      ) : null}
    </div>
  );
}
