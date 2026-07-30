import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { TextInput } from "../ui/form/TextInput";
import { useI18n } from "../../i18n";
import { initConnections } from "../../stores/connectionStore";
import { useConnectionStore } from "../../stores/connectionStore";
import {
  getNavVisibleModuleKeys,
  initAppModuleStore,
} from "../../stores/appModuleStore";
import { MODULE_PATHS, type ModuleKey } from "../../lib/paths";
import {
  emitQuickLauncherAction,
  hideQuickLauncher,
  listenQuickLauncherShown,
  setQuickLauncherHeight,
  type QuickLauncherAction,
} from "../../lib/quickLauncher";
import { openModuleWindow } from "../../lib/moduleWindow";
import { dismissHtmlBootSplash } from "../../lib/dismissBootSplash";
import { isTauriRuntime } from "../../lib/isTauriRuntime";

type LauncherRow =
  | { type: "command"; id: string; label: string; subtitle: string }
  | { type: "connection"; id: string; label: string; subtitle: string };

const COMMAND_DEFS: Array<{
  id: string;
  labelKey: string;
  keywords: string[];
  path?: string;
}> = [
  { id: "workspace", labelKey: "shell.commandPalette.commands.workspace", keywords: ["workspace", "工作区"] },
  { id: "terminal", labelKey: "shell.commandPalette.commands.terminal", keywords: ["terminal", "终端"], path: MODULE_PATHS.terminal },
  { id: "database", labelKey: "shell.commandPalette.commands.database", keywords: ["database", "数据库", "db"], path: MODULE_PATHS.database },
  { id: "ssh", labelKey: "shell.commandPalette.commands.ssh", keywords: ["ssh"], path: MODULE_PATHS.ssh },
  { id: "docker", labelKey: "shell.commandPalette.commands.docker", keywords: ["docker", "容器"], path: MODULE_PATHS.docker },
  { id: "server", labelKey: "shell.commandPalette.commands.server", keywords: ["server", "面板"], path: MODULE_PATHS.server },
  { id: "protocol", labelKey: "shell.commandPalette.commands.protocol", keywords: ["protocol", "协议"], path: MODULE_PATHS.protocol },
  { id: "workflow", labelKey: "shell.commandPalette.commands.workflow", keywords: ["workflow", "工作流"], path: MODULE_PATHS.workflow },
  { id: "knowledge", labelKey: "shell.commandPalette.commands.knowledge", keywords: ["knowledge", "知识库"], path: MODULE_PATHS.knowledge },
  { id: "settings", labelKey: "shell.commandPalette.commands.settings", keywords: ["settings", "设置"] },
  { id: "new-terminal", labelKey: "shell.commandPalette.commands.newTerminal", keywords: ["new terminal", "新建终端"] },
  { id: "open-ai", labelKey: "shell.commandPalette.commands.openAi", keywords: ["ai", "助手"] },
];

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

function kindLabel(kind: string, t: (key: string) => string): string {
  switch (kind) {
    case "ssh":
      return t("shell.quickLauncher.kinds.ssh");
    case "database":
      return t("shell.quickLauncher.kinds.database");
    case "docker":
      return t("shell.quickLauncher.kinds.docker");
    case "file":
      return t("shell.quickLauncher.kinds.file");
    case "panel":
      return t("shell.quickLauncher.kinds.panel");
    default:
      return kind;
  }
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
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const connections = useConnectionStore((s) => s.connections);

  useEffect(() => {
    dismissHtmlBootSplash();
    document.documentElement.classList.add("quick-launcher-root");
    document.body.classList.add("quick-launcher-body");
    let cancelled = false;
    void (async () => {
      try {
        await Promise.all([initConnections(), initAppModuleStore().catch(() => {})]);
      } catch (e) {
        console.warn("[quickLauncher] init failed", e);
      }
      if (!cancelled) {
        setVisibleModuleKeys(getNavVisibleModuleKeys());
        setReady(true);
      }
    })();
    return () => {
      cancelled = true;
      document.documentElement.classList.remove("quick-launcher-root");
      document.body.classList.remove("quick-launcher-body");
    };
  }, []);

  const ignoreBlurUntilRef = useRef(0);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listenQuickLauncherShown(() => {
      ignoreBlurUntilRef.current = Date.now() + 250;
      setQuery("");
      setSelectedIndex(0);
      setVisibleModuleKeys(getNavVisibleModuleKeys());
      requestAnimationFrame(() => inputRef.current?.focus());
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

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
        if (!focused && Date.now() >= ignoreBlurUntilRef.current) {
          void hideQuickLauncher();
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

  const rows = useMemo<LauncherRow[]>(() => {
    const q = query.trim().toLowerCase();
    const commandRows: LauncherRow[] = COMMAND_DEFS.filter((cmd) => {
      if (!q) return true;
      const label = t(cmd.labelKey).toLowerCase();
      return (
        label.includes(q) ||
        cmd.id.includes(q) ||
        cmd.keywords.some((k) => k.toLowerCase().includes(q))
      );
    }).map((cmd) => ({
      type: "command" as const,
      id: cmd.id,
      label: t(cmd.labelKey),
      subtitle: t("shell.quickLauncher.kinds.command"),
    }));

    const connectionRows: LauncherRow[] = connections
      .filter((conn) => {
        if (!q) return true;
        return (
          conn.name.toLowerCase().includes(q) ||
          conn.kind.toLowerCase().includes(q) ||
          (conn.config ?? "").toLowerCase().includes(q) ||
          (conn.group ?? "").toLowerCase().includes(q)
        );
      })
      .slice(0, 20)
      .map((conn) => ({
        type: "connection" as const,
        id: conn.id,
        label: conn.name,
        subtitle: kindLabel(conn.kind, t),
      }));

    // 有查询时连接优先靠前一点；无查询时命令在前、连接在后
    if (q) {
      return [...connectionRows, ...commandRows].slice(0, 12);
    }
    return [...commandRows, ...connectionRows].slice(0, 12);
  }, [query, connections, t]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query, rows.length]);

  useEffect(() => {
    const listH = rows.length > 0 ? Math.min(rows.length, 8) * 40 + 8 : 0;
    const height = MODULE_BAR_H + INPUT_ROW_H + listH;
    void setQuickLauncherHeight(height);
  }, [rows.length]);

  const activate = useCallback(async (row: LauncherRow) => {
    const action: QuickLauncherAction =
      row.type === "command"
        ? { kind: "command", id: row.id }
        : { kind: "connection", id: row.id };
    await emitQuickLauncherAction(action);
    await hideQuickLauncher();
  }, []);

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
    if (e.key === "Enter" && rows[selectedIndex]) {
      e.preventDefault();
      void activate(rows[selectedIndex]!);
    }
  };

  return (
    <div ref={rootRef} className="quick-launcher" data-ready={ready ? "1" : "0"}>
      <div className="quick-launcher__modules" role="toolbar" aria-label={t("shell.quickLauncher.modulesAria")}>
        <div className="quick-launcher__modules-icons">
          {moduleButtons.map((item) => (
            <button
              key={item.key}
              type="button"
              className="quick-launcher__module-btn"
              title={t(`shell.nav.${item.key}`)}
              aria-label={t(`shell.nav.${item.key}`)}
              // 防止 mousedown 夺走输入框焦点触发失焦关闭
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => void openModuleFromIcon(item.key)}
            >
              {item.icon}
            </button>
          ))}
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
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className="quick-launcher__icon"
          aria-hidden
        >
          <circle cx="11" cy="11" r="8" />
          <path d="M21 21l-4.35-4.35" />
        </svg>
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
          {rows.map((row, index) => (
            <li key={`${row.type}-${row.id}`}>
              <button
                type="button"
                role="option"
                aria-selected={index === selectedIndex}
                className={`quick-launcher__item${index === selectedIndex ? " is-selected" : ""}`}
                onClick={() => void activate(row)}
                onMouseEnter={() => setSelectedIndex(index)}
              >
                <span className="quick-launcher__item-label">{row.label}</span>
                <span className="quick-launcher__item-sub">{row.subtitle}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : query.trim() ? (
        <div className="quick-launcher__empty">{t("shell.quickLauncher.noResults")}</div>
      ) : null}
    </div>
  );
}
