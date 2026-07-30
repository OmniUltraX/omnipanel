import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { TextInput } from "../ui/form/TextInput";
import { useI18n } from "../../i18n";
import { initConnections } from "../../stores/connectionStore";
import { useConnectionStore } from "../../stores/connectionStore";
import { MODULE_PATHS } from "../../lib/paths";
import {
  emitQuickLauncherAction,
  hideQuickLauncher,
  listenQuickLauncherShown,
  setQuickLauncherHeight,
  type QuickLauncherAction,
} from "../../lib/quickLauncher";
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
 * 托盘态快捷启动窗：单行搜索 + 底部匹配列表。
 * 独立于主窗口 Bootstrap，仅轻量初始化连接列表。
 */
export function QuickLauncherRoot() {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [ready, setReady] = useState(false);
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
        await initConnections();
      } catch (e) {
        console.warn("[quickLauncher] initConnections failed", e);
      }
      if (!cancelled) setReady(true);
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
    const height = 56 + listH;
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
