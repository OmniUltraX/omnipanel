/**
 * 最近项目面板（Ctrl+E）—— 混合展示最近切换的 Tab + 最近关闭的面板 + 最近操作/命令。
 *
 * 数据源：
 * 1. 最近切换的 Tab（useRecentTabs）
 * 2. 最近关闭的数据库面板（useDbWorkspaceSessionStore.recentClosedPanels）
 * 3. 最近关闭的 HTTP 请求（useProtocolHttpDockStore.recentClosed）
 * 4. 最近关闭的工作区 dock 面板（useWorkspaceBottomDockStore.recentClosedByWorkspace）
 * 5. 最近使用的命令（useRecentCommands）
 */

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useI18n } from "../../i18n";
import { TextInput } from "../ui/form/TextInput";
import { matchesShortcut, getShortcutKeys } from "../../stores/shortcutsStore";
import {
  useRecentCommands,
  useCommandRegistry,
  getCommandShortcutLabel,
  type CommandItem,
} from "../../stores/commandRegistry";
import { useRecentTabs, type ActiveTabEntry } from "../../stores/recentTabs";
import { useDbWorkspaceSessionStore } from "../../stores/dbWorkspaceSessionStore";
import { useProtocolHttpDockStore } from "../../stores/protocolHttpDockStore";
import { useWorkspaceBottomDockStore } from "../../stores/workspaceBottomDockStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { navigateToFeature } from "../../lib/workspaceNavigation";
import { MODULE_PATHS, DASHBOARD_PATH } from "../../lib/paths";
import type { DbTabSnapshot } from "../../stores/workspaceTabStore";

const DEFAULT_RECENT_ITEMS_KEYS = ["Mod", "KeyE"];

/** 统一的项目条目（混合多源数据） */
interface UnifiedItem {
  id: string;
  kind: "tab" | "closed-panel" | "command";
  title: string;
  subtitle?: string;
  sourceLabel: string;
  shortcut?: string;
  icon: "tab" | "closed" | "command";
  /** closed-panel 的关闭时间相对描述（如"已关闭 5 分钟前"） */
  closedAgoLabel?: string;
  run: () => void;
}

/** 将时间戳格式化为相对时间字符串（刚刚 / N 分钟前 / N 小时前 / N 天前）。 */
function formatRelativeTime(closedAt: number, t: (k: string, p?: Record<string, string | number>) => string): string {
  const diff = Date.now() - closedAt;
  if (diff < 60_000) return t("knowledge.time.justNow");
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return t("knowledge.time.minutesAgo", { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("knowledge.time.hoursAgo", { n: hours });
  const days = Math.floor(hours / 24);
  return t("knowledge.time.daysAgo", { n: days });
}

/** 构造"已关闭 {time} · 来源"副标题。 */
function buildClosedSubtitle(
  closedAt: number,
  sourceLabel: string,
  t: (k: string, p?: Record<string, string | number>) => string,
): string {
  const time = formatRelativeTime(closedAt, t);
  return `${t("shell.recentItems.closedAgo", { time })} · ${sourceLabel}`;
}

export function RecentItemsPanel() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // 数据源订阅
  const recentTabs = useRecentTabs((s) => s.tabs);
  const dbRecentClosed = useDbWorkspaceSessionStore((s) => s.recentClosedPanels);
  const httpRecentClosed = useProtocolHttpDockStore((s) => s.recentClosed);
  const bottomRecentClosedByWs = useWorkspaceBottomDockStore((s) => s.recentClosedByWorkspace);
  const activeWorkspace = useWorkspaceStore((s) => s.workspace);
  const recentCommandIds = useRecentCommands((s) => s.recentIds);
  const registryCommands = useCommandRegistry((s) => s.commands);

  // 聚合所有数据源为统一条目
  const items = useMemo<UnifiedItem[]>(() => {
    const out: UnifiedItem[] = [];

    // 1. 最近切换的 Tab
    for (const tab of recentTabs) {
      if (!tab.activate) continue;
      out.push({
        id: `tab:${tab.id}`,
        kind: "tab",
        title: tab.title,
        subtitle: tab.subtitle,
        sourceLabel: sourceLabel(tab.source, t),
        icon: "tab",
        run: () => tab.activate?.(),
      });
    }

    // 2. 最近关闭的数据库面板
    for (const entry of dbRecentClosed) {
      const sourceL = t("shell.recentItems.sourceDatabase");
      out.push({
        id: `db-closed:${entry.tab.id}:${entry.closedAt}`,
        kind: "closed-panel",
        title: entry.tab.label,
        subtitle: buildClosedSubtitle(entry.closedAt, sourceL, t),
        sourceLabel: sourceL,
        icon: "closed",
        closedAgoLabel: formatRelativeTime(entry.closedAt, t),
        run: () => {
          // 先导航到数据库模块，再派发 restore 事件，由 DatabasePanel 内部恢复 tab + 移除 recentClosed 条目
          navigateToFeature(MODULE_PATHS.database, navigate);
          const snapshot: DbTabSnapshot = {
            module: "database",
            id: entry.tab.id,
            label: entry.tab.label,
            tab: entry.tab,
          };
          const dispatchRestore = () => {
            window.dispatchEvent(
              new CustomEvent("omnipanel:restore-db-workspace-tab", { detail: { snapshot } }),
            );
          };
          // 立即派发一次（组件已挂载时生效），延迟再派发一次（覆盖跨模块懒加载挂载延迟）
          dispatchRestore();
          requestAnimationFrame(() => {
            setTimeout(dispatchRestore, 200);
          });
        },
      });
    }

    // 3. 最近关闭的 HTTP 请求
    for (const entry of httpRecentClosed) {
      const sourceL = t("shell.recentItems.sourceProtocol");
      out.push({
        id: `http-closed:${entry.requestId}`,
        kind: "closed-panel",
        title: entry.requestId,
        subtitle: buildClosedSubtitle(entry.closedAt, sourceL, t),
        sourceLabel: sourceL,
        icon: "closed",
        closedAgoLabel: formatRelativeTime(entry.closedAt, t),
        run: () => {
          useProtocolHttpDockStore.getState().reopenTab(entry.requestId);
          navigateToFeature(MODULE_PATHS.protocol, navigate);
        },
      });
    }

    // 4. 最近关闭的工作区 dock 面板
    const wsId = activeWorkspace?.id;
    if (wsId) {
      const wsClosed = bottomRecentClosedByWs[wsId] ?? [];
      for (const entry of wsClosed) {
        const sourceL = t("shell.recentItems.sourceWorkspace");
        out.push({
          id: `ws-closed:${wsId}:${entry.closedAt}`,
          kind: "closed-panel",
          title: entry.tab.label,
          subtitle: buildClosedSubtitle(entry.closedAt, sourceL, t),
          sourceLabel: sourceL,
          icon: "closed",
          closedAgoLabel: formatRelativeTime(entry.closedAt, t),
          run: () => {
            // 恢复 tab 到当前工作区 dock + 移除 recentClosed 条目 + 导航到看板
            const ws = useWorkspaceStore.getState().workspace;
            useWorkspaceBottomDockStore.getState().addMirroredTab(wsId, ws, entry.tab);
            useWorkspaceBottomDockStore.getState().removeRecentClosedTab(wsId, entry.closedAt);
            navigateToFeature(DASHBOARD_PATH, navigate);
          },
        });
      }
    }

    // 5. 最近使用的命令
    for (const id of recentCommandIds) {
      const cmd = registryCommands[id];
      if (!cmd) continue;
      out.push({
        id: `cmd:${id}`,
        kind: "command",
        title: cmd.label,
        sourceLabel: cmd.category,
        icon: "command",
        shortcut: getCommandShortcutLabel(cmd),
        run: () => cmd.run(),
      });
    }

    return out;
  }, [recentTabs, dbRecentClosed, httpRecentClosed, bottomRecentClosedByWs, activeWorkspace, recentCommandIds, registryCommands, t, navigate]);

  // 搜索过滤
  const filtered = useMemo(() => {
    if (!query.trim()) return items;
    const q = query.toLowerCase();
    return items.filter(
      (item) =>
        item.title.toLowerCase().includes(q) ||
        item.subtitle?.toLowerCase().includes(q) ||
        item.sourceLabel.toLowerCase().includes(q),
    );
  }, [items, query]);

  // 分组
  const grouped = useMemo(() => {
    const groups: Record<string, UnifiedItem[]> = {};
    const tabLabel = t("shell.recentItems.groupTabs");
    const closedLabel = t("shell.recentItems.groupClosed");
    const cmdLabel = t("shell.recentItems.groupCommands");

    for (const item of filtered) {
      let group: string;
      if (item.kind === "tab") group = tabLabel;
      else if (item.kind === "closed-panel") group = closedLabel;
      else group = cmdLabel;
      if (!groups[group]) groups[group] = [];
      groups[group].push(item);
    }
    return groups;
  }, [filtered, t]);

  const flatList = useMemo(() => Object.values(grouped).flat(), [grouped]);

  const toggle = useCallback(() => {
    setIsOpen((prev) => !prev);
    setQuery("");
    setSelectedIndex(0);
  }, []);

  // Ctrl+E 触发
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target?.closest?.(".xterm")) {
        if (e.key === "Escape" && isOpen) setIsOpen(false);
        return;
      }
      if (matchesShortcut(e, getShortcutKeys("recent-items") ?? DEFAULT_RECENT_ITEMS_KEYS)) {
        e.preventDefault();
        toggle();
      }
      if (e.key === "Escape" && isOpen) setIsOpen(false);
    };
    const toggleHandler = () => toggle();
    window.addEventListener("keydown", handler);
    window.addEventListener("toggle-recent-items", toggleHandler);
    return () => {
      window.removeEventListener("keydown", handler);
      window.removeEventListener("toggle-recent-items", toggleHandler);
    };
  }, [isOpen, toggle]);

  useEffect(() => {
    if (isOpen && inputRef.current) inputRef.current.focus();
  }, [isOpen]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const execute = useCallback((item: UnifiedItem) => {
    item.run();
    setIsOpen(false);
    setQuery("");
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => Math.min(prev + 1, flatList.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => Math.max(prev - 1, 0));
    } else if (e.key === "Enter" && flatList[selectedIndex]) {
      execute(flatList[selectedIndex]);
    }
  };

  if (!isOpen) return null;

  let flatIndex = 0;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh]">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div
        className="relative w-[480px] bg-bg-deeper border border-border rounded-xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 h-12 border-b border-border">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-muted shrink-0">
            <path d="M3 12a9 9 0 1 0 3-6.7" />
            <path d="M3 4v5h5" />
          </svg>
          <div className="flex-1 min-w-0">
            <TextInput
              ref={inputRef}
              clearable={false}
              copyable={false}
              value={query}
              onChange={setQuery}
              onKeyDown={handleKeyDown}
              placeholder={t("shell.recentItems.placeholder")}
              className="flex-1 bg-transparent text-sm text-fg placeholder:text-muted outline-none border-0 shadow-none"
              style={{ height: "auto", padding: 0, background: "transparent", border: "none" }}
            />
          </div>
          <kbd className="px-1.5 py-0.5 text-[10px] text-meta bg-surface border border-border rounded font-mono">ESC</kbd>
        </div>

        <div className="max-h-[360px] overflow-y-auto py-2">
          {Object.entries(grouped).map(([group, groupItems]) => (
            <div key={group}>
              <div className="px-4 py-1.5 text-[11px] font-medium text-meta uppercase tracking-wider">
                {group}
              </div>
              {groupItems.map((item) => {
                const currentIndex = flatIndex++;
                const isSelected = currentIndex === selectedIndex;
                return (
                  <button
                    key={item.id}
                    className={`w-full flex items-center gap-3 px-4 py-2 text-sm transition-colors ${
                      isSelected ? "bg-accent/10 text-accent" : "text-fg-2 hover:bg-surface-hover"
                    }`}
                    onClick={() => execute(item)}
                    onMouseEnter={() => setSelectedIndex(currentIndex)}
                  >
                    <ItemIcon kind={item.icon} />
                    <div className="flex-1 min-w-0 text-left">
                      <div className="truncate">{item.title}</div>
                      {item.subtitle && (
                        <div className="text-[11px] text-meta truncate">{item.subtitle}</div>
                      )}
                    </div>
                    {item.shortcut && (
                      <kbd className="px-1.5 py-0.5 text-[10px] text-meta bg-surface border border-border rounded font-mono shrink-0">
                        {item.shortcut}
                      </kbd>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
          {flatList.length === 0 && (
            <div className="px-4 py-8 text-center text-sm text-muted">
              {t("shell.recentItems.noResults")}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between px-4 py-2 border-t border-border text-[11px] text-meta">
          <span>{t("shell.recentItems.hint")}</span>
        </div>
      </div>
    </div>
  );
}

function sourceLabel(source: ActiveTabEntry["source"], t: (k: string) => string): string {
  switch (source) {
    case "database": return t("shell.recentItems.sourceDatabase");
    case "terminal": return t("shell.recentItems.sourceTerminal");
    case "ssh": return t("shell.recentItems.sourceSsh");
    case "protocol": return t("shell.recentItems.sourceProtocol");
    case "workspace-dock":
    case "workspace-bottom": return t("shell.recentItems.sourceWorkspace");
    default: return source;
  }
}

function ItemIcon({ kind }: { kind: UnifiedItem["icon"] }) {
  if (kind === "tab") {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="text-muted shrink-0">
        <rect x="3" y="6" width="18" height="14" rx="2" />
        <path d="M3 10h18" />
      </svg>
    );
  }
  if (kind === "closed") {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="text-muted shrink-0">
        <path d="M3 12a9 9 0 1 0 3-6.7" />
        <path d="M3 4v5h5" />
      </svg>
    );
  }
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="text-muted shrink-0">
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  );
}
