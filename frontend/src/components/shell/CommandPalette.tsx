import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useActionStore } from "../../stores/actionStore";
import { goWorkspaceHome, navigateToFeature, navigateToSshManagement } from "../../lib/workspaceNavigation";
import { MODULE_PATHS } from "../../lib/paths";
import { isModuleOpen, useAppModuleStore } from "../../stores/appModuleStore";
import { useI18n } from "../../i18n";
import { TextInput } from "../ui/form/TextInput";
import {
  getShortcutKeys,
  matchesShortcut,
  useShortcutsStore,
  type KeyBinding,
} from "../../stores/shortcutsStore";
import {
  useCommandRegistry,
  useRecentCommands,
  getCommandShortcutLabel,
  type CommandItem,
} from "../../stores/commandRegistry";
import { useDoubleShiftTrigger } from "../../hooks/useGlobalShortcuts";
import { commands, type SearchEverywhereHit } from "../../ipc/bindings";
import { unwrapCommand } from "../../ipc/result";
import { useKnowledgeStore } from "../../stores/knowledgeStore";
import { useTagUiStore } from "../../modules/tags/tagStore";

/**
 * 把硬编码的命令定义转成 CommandItem 注册到 registry。
 * 这样命令面板、Ctrl+E、快捷键调度器共用同一命令源。
 */
function useRegisterBuiltinCommands() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const registerAll = useCommandRegistry((s) => s.registerAll);
  const modules = useAppModuleStore((s) => s.modules);
  const recordUse = useRecentCommands((s) => s.recordUse);

  const commands = useMemo(() => {
    const nav = t("shell.commandPalette.categories.nav");
    const action = t("shell.commandPalette.categories.action");
    const ai = t("shell.commandPalette.categories.ai");

    return [
      { id: "workspace", label: t("shell.commandPalette.commands.workspace"), shortcutLabel: "⌘1", category: nav, run: () => goWorkspaceHome(), source: "builtin" },
      { id: "terminal", label: t("shell.commandPalette.commands.terminal"), shortcutLabel: "⌘2", category: nav, run: () => navigateToFeature(MODULE_PATHS.terminal, navigate), source: "builtin" },
      { id: "database", label: t("shell.commandPalette.commands.database"), shortcutLabel: "⌘3", category: nav, run: () => navigateToFeature(MODULE_PATHS.database, navigate), source: "builtin" },
      { id: "ssh", label: t("shell.commandPalette.commands.ssh"), shortcutLabel: "⌘4", category: nav, run: () => navigateToSshManagement(navigate), source: "builtin" },
      { id: "docker", label: t("shell.commandPalette.commands.docker"), shortcutLabel: "⌘5", category: nav, run: () => navigateToFeature(MODULE_PATHS.docker, navigate), source: "builtin" },
      { id: "server", label: t("shell.commandPalette.commands.server"), category: nav, run: () => navigateToFeature(MODULE_PATHS.server, navigate), source: "builtin" },
      { id: "protocol", label: t("shell.commandPalette.commands.protocol"), category: nav, run: () => navigateToFeature(MODULE_PATHS.protocol, navigate), source: "builtin" },
      { id: "workflow", label: t("shell.commandPalette.commands.workflow"), category: nav, run: () => navigateToFeature(MODULE_PATHS.workflow, navigate), source: "builtin" },
      { id: "knowledge", label: t("shell.commandPalette.commands.knowledge"), category: nav, run: () => navigateToFeature(MODULE_PATHS.knowledge, navigate), source: "builtin" },
      { id: "settings", label: t("shell.commandPalette.commands.settings"), shortcutId: "open-settings", category: nav, run: () => useSettingsUiOpen(), source: "builtin" },
      { id: "new-terminal", label: t("shell.commandPalette.commands.newTerminal"), shortcutId: "new-terminal", category: action, run: () => useNewTerminal(), source: "builtin" },
      { id: "new-ssh", label: t("shell.commandPalette.commands.newSsh"), shortcutId: "new-ssh", category: action, run: () => navigateToSshManagement(navigate), source: "builtin" },
      { id: "new-query", label: t("shell.commandPalette.commands.newQuery"), category: action, run: () => navigateToFeature(MODULE_PATHS.database, navigate), source: "builtin" },
      { id: "open-ai", label: t("shell.commandPalette.commands.openAi"), shortcutId: "toggle-ai", category: ai, run: () => useAiOpen(), source: "builtin" },
      { id: "new-ai-conv", label: t("shell.commandPalette.commands.newAiConv"), category: ai, run: () => useAiNewConv(), source: "builtin" },
    ] satisfies CommandItem[];
  }, [t, navigate]);

  // 注册到 registry
  useEffect(() => {
    registerAll(commands);
  }, [registerAll, commands]);

  // 按模块开放状态过滤
  const visibleCommands = useMemo(() => {
    return commands.filter((cmd) => {
      if (!(cmd.id in MODULE_PATHS)) return true;
      return isModuleOpen(cmd.id as keyof typeof MODULE_PATHS);
    });
  }, [commands, modules]);

  return { visibleCommands, recordUse };
}

// 避免循环依赖的懒加载入口
function useSettingsUiOpen() {
  import("../../stores/settingsUiStore").then(({ useSettingsUiStore }) =>
    useSettingsUiStore.getState().openSettings(),
  );
}
function useNewTerminal() {
  import("../../lib/terminalSession").then(({ openLocalTerminalSession }) =>
    openLocalTerminalSession(),
  );
}
function useAiOpen() {
  import("../../stores/aiStore").then(({ useAiStore }) =>
    useAiStore.getState().openDrawer(),
  );
}
function useAiNewConv() {
  import("../../stores/aiStore").then(({ useAiStore }) => {
    useAiStore.getState().createConversation();
    useAiStore.getState().openDrawer();
  });
}

export function CommandPalette() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [showRecent, setShowRecent] = useState(true);
  const [matchMode, setMatchMode] = useState<"and" | "or">("and");
  const [resourceHits, setResourceHits] = useState<SearchEverywhereHit[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const blockedCount = useActionStore((s) => s.actions.filter((a) => a.status === "blocked").length);
  const shortcutsOverrides = useShortcutsStore((s) => s.overrides);
  const commandPaletteKeys = useMemo<KeyBinding[]>(
    () => getShortcutKeys("command-palette"),
    [shortcutsOverrides],
  );

  const { visibleCommands, recordUse } = useRegisterBuiltinCommands();

  // 从 registry 拉取所有已注册命令（含模块自注册的）
  const registryCommands = useCommandRegistry((s) => s.commands);
  const allCommands = useMemo(() => {
    // 合并内置命令 + registry 中的命令（registry 优先，模块自注册可覆盖）
    const map = new Map<string, CommandItem>();
    for (const cmd of visibleCommands) map.set(cmd.id, cmd);
    for (const [id, cmd] of Object.entries(registryCommands)) {
      if (!map.has(id)) map.set(id, cmd);
    }
    return Array.from(map.values());
  }, [visibleCommands, registryCommands]);

  // 最近使用的命令
  const recentIds = useRecentCommands((s) => s.recentIds);
  const recentCommands = useMemo(() => {
    return recentIds
      .map((id) => allCommands.find((c) => c.id === id))
      .filter((c): c is CommandItem => !!c)
      .slice(0, 5);
  }, [recentIds, allCommands]);

  // 解析 #标签 与文本，拉取多源资源
  useEffect(() => {
    if (!isOpen) return;
    const raw = query.trim();
    if (!raw && resourceHits.length === 0) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const tagPaths = [...raw.matchAll(/#([^\s#]+)/g)].map((m) => m[1]);
          const textQuery = raw.replace(/#[^\s#]+/g, " ").trim();
          const tagIds: string[] = [];
          for (const path of tagPaths) {
            const suggestions = await unwrapCommand(commands.tagSuggest(path, 8));
            const exact =
              suggestions.find((s) => s.path.toLowerCase() === path.toLowerCase()) ??
              suggestions[0];
            if (exact) tagIds.push(exact.id);
          }
          if (!textQuery && tagIds.length === 0) {
            if (!cancelled) setResourceHits([]);
            return;
          }
          const hits = await unwrapCommand(
            commands.searchEverywhere(
              textQuery,
              tagIds.length > 0 ? tagIds : null,
              matchMode,
              30,
            ),
          );
          if (!cancelled) setResourceHits(hits);
        } catch {
          if (!cancelled) setResourceHits([]);
        }
      })();
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅在打开与查询变化时搜索
  }, [query, isOpen, matchMode]);

  // 搜索过滤命令（#token 不参与命令匹配）
  const commandQuery = useMemo(
    () => query.replace(/#[^\s#]+/g, " ").trim().toLowerCase(),
    [query],
  );
  const filtered = useMemo(() => {
    if (!commandQuery) return allCommands;
    return allCommands.filter(
      (cmd) =>
        cmd.label.toLowerCase().includes(commandQuery) ||
        cmd.keywords?.some((k) => k.toLowerCase().includes(commandQuery)),
    );
  }, [allCommands, commandQuery]);

  type PaletteRow =
    | { type: "command"; cmd: CommandItem }
    | { type: "resource"; hit: SearchEverywhereHit };

  // 分组：无搜索词时最近使用置顶；有查询时命令 + 资源
  const grouped = useMemo(() => {
    const groups: Record<string, PaletteRow[]> = {};
    if (showRecent && !query.trim() && recentCommands.length > 0) {
      groups[t("shell.commandPalette.categories.recent")] = recentCommands.map((cmd) => ({
        type: "command" as const,
        cmd,
      }));
    }
    for (const cmd of filtered) {
      if (!groups[cmd.category]) groups[cmd.category] = [];
      groups[cmd.category].push({ type: "command", cmd });
    }
    if (resourceHits.length > 0) {
      groups[t("shell.commandPalette.categories.resources")] = resourceHits.map((hit) => ({
        type: "resource" as const,
        hit,
      }));
    }
    return groups;
  }, [filtered, showRecent, recentCommands, query, t, resourceHits]);

  // 扁平化用于上下键导航
  const flatList = useMemo(() => {
    return Object.values(grouped).flat();
  }, [grouped]);

  const toggle = useCallback(() => {
    setIsOpen((prev) => !prev);
    setQuery("");
    setSelectedIndex(0);
    setShowRecent(true);
    setResourceHits([]);
  }, []);

  // 双 Shift 触发
  useDoubleShiftTrigger(() => {
    if (!isOpen) {
      setIsOpen(true);
      setQuery("");
      setSelectedIndex(0);
      setShowRecent(false); // 双 Shift 专注搜索，不显示最近
      setResourceHits([]);
    }
  });

  // Mod+K 触发
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target?.closest?.(".xterm")) {
        if (e.key === "Escape" && isOpen) setIsOpen(false);
        return;
      }
      if (matchesShortcut(e, commandPaletteKeys)) {
        e.preventDefault();
        toggle();
      }
      if (e.key === "Escape" && isOpen) setIsOpen(false);
    };
    const toggleHandler = () => toggle();
    window.addEventListener("keydown", handler);
    window.addEventListener("toggle-cmd-palette", toggleHandler);
    return () => {
      window.removeEventListener("keydown", handler);
      window.removeEventListener("toggle-cmd-palette", toggleHandler);
    };
  }, [isOpen, toggle, commandPaletteKeys]);

  useEffect(() => {
    if (isOpen && inputRef.current) inputRef.current.focus();
  }, [isOpen]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query, resourceHits]);

  const openResourceHit = useCallback(
    (hit: SearchEverywhereHit) => {
      if (hit.kind === "knowledge") {
        navigateToFeature(MODULE_PATHS.knowledge, navigate);
        useKnowledgeStore.getState().setSelectedEntry(hit.id);
      } else if (hit.kind === "connection") {
        const sub = hit.subtitle ?? "ssh";
        if (sub === "database") navigateToFeature(MODULE_PATHS.database, navigate);
        else if (sub === "docker") navigateToFeature(MODULE_PATHS.docker, navigate);
        else if (sub === "file") navigateToFeature(MODULE_PATHS.files, navigate);
        else if (sub === "panel") navigateToFeature(MODULE_PATHS.server, navigate);
        else if (sub === "protocol") navigateToFeature(MODULE_PATHS.protocol, navigate);
        else navigateToSshManagement(navigate);
      } else if (hit.kind === "workflow") {
        navigateToFeature(MODULE_PATHS.workflow, navigate);
      } else if (hit.kind === "tag") {
        useTagUiStore.getState().setSelected("knowledge", [hit.id]);
        useTagUiStore.getState().focusTagPanel("knowledge");
        navigateToFeature(MODULE_PATHS.knowledge, navigate);
      }
      setIsOpen(false);
      setQuery("");
    },
    [navigate],
  );

  const execute = useCallback(
    (cmd: CommandItem) => {
      recordUse(cmd.id);
      cmd.run();
      setIsOpen(false);
      setQuery("");
    },
    [recordUse],
  );

  const activateRow = useCallback(
    (row: PaletteRow) => {
      if (row.type === "command") execute(row.cmd);
      else openResourceHit(row.hit);
    },
    [execute, openResourceHit],
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => Math.min(prev + 1, flatList.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => Math.max(prev - 1, 0));
    } else if (e.key === "Enter" && flatList[selectedIndex]) {
      activateRow(flatList[selectedIndex]);
    }
  };

  if (!isOpen) return null;

  let flatIndex = 0;
  const recentLabel = t("shell.commandPalette.categories.recent");

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh]">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setIsOpen(false)} />
      <div
        className="relative w-[520px] bg-bg-deeper border border-border rounded-xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 h-12 border-b border-border">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-muted shrink-0">
            <circle cx="11" cy="11" r="8" />
            <path d="M21 21l-4.35-4.35" />
          </svg>
          <div className="flex-1 min-w-0">
            <TextInput
              ref={inputRef}
              clearable={false}
              copyable={false}
              value={query}
              onChange={setQuery}
              onKeyDown={handleKeyDown}
              placeholder={t("shell.commandPalette.placeholderSearch")}
              className="flex-1 bg-transparent text-sm text-fg placeholder:text-muted outline-none border-0 shadow-none"
              style={{ height: "auto", padding: 0, background: "transparent", border: "none" }}
            />
          </div>
          <div className="tag-tree-panel__modes command-palette-modes">
            <button
              type="button"
              className={matchMode === "and" ? "active" : ""}
              onClick={() => setMatchMode("and")}
            >
              AND
            </button>
            <button
              type="button"
              className={matchMode === "or" ? "active" : ""}
              onClick={() => setMatchMode("or")}
            >
              OR
            </button>
          </div>
          <kbd className="px-1.5 py-0.5 text-[10px] text-meta bg-surface border border-border rounded font-mono">ESC</kbd>
        </div>

        <div className="max-h-[320px] overflow-y-auto py-2">
          {Object.entries(grouped).map(([category, items]) => {
            const isRecentGroup = category === recentLabel;
            return (
              <div key={category}>
                <div className="px-4 py-1.5 text-[11px] font-medium text-meta uppercase tracking-wider">
                  {category}
                </div>
                {items.map((row) => {
                  const currentIndex = flatIndex++;
                  const isSelected = currentIndex === selectedIndex;
                  if (row.type === "command") {
                    const cmd = row.cmd;
                    const shortcut = getCommandShortcutLabel(cmd);
                    return (
                      <button
                        key={`${category}-${cmd.id}`}
                        className={`w-full flex items-center justify-between px-4 py-2 text-sm transition-colors ${
                          isSelected ? "bg-accent/10 text-accent" : "text-fg-2 hover:bg-surface-hover"
                        }`}
                        onClick={() => activateRow(row)}
                        onMouseEnter={() => setSelectedIndex(currentIndex)}
                      >
                        <span className={isRecentGroup ? "flex items-center gap-2" : ""}>
                          {isRecentGroup && (
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-muted shrink-0">
                              <circle cx="12" cy="12" r="9" />
                              <polyline points="12 7 12 12 15 14" />
                            </svg>
                          )}
                          {cmd.label}
                        </span>
                        {shortcut && (
                          <kbd className="px-1.5 py-0.5 text-[10px] text-meta bg-surface border border-border rounded font-mono">
                            {shortcut}
                          </kbd>
                        )}
                      </button>
                    );
                  }
                  const hit = row.hit;
                  return (
                    <button
                      key={`${category}-${hit.kind}-${hit.id}`}
                      className={`w-full flex items-center justify-between px-4 py-2 text-sm transition-colors ${
                        isSelected ? "bg-accent/10 text-accent" : "text-fg-2 hover:bg-surface-hover"
                      }`}
                      onClick={() => activateRow(row)}
                      onMouseEnter={() => setSelectedIndex(currentIndex)}
                    >
                      <span className="flex items-center gap-2 min-w-0">
                        <span className="text-meta shrink-0">{hit.kind === "tag" ? "#" : hit.kind}</span>
                        <span className="truncate">{hit.title}</span>
                      </span>
                      {hit.subtitle ? (
                        <span className="text-[11px] text-meta shrink-0 ml-2">{hit.subtitle}</span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            );
          })}
          {flatList.length === 0 && (
            <div className="px-4 py-8 text-center text-sm text-muted">
              {t("shell.commandPalette.noResults")}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between px-4 py-2 border-t border-border text-[11px] text-meta">
          <span>{t("shell.commandPalette.hintSearch")}</span>
          <span>{t("shell.commandPalette.pendingActions", { count: blockedCount })}</span>
        </div>
      </div>
    </div>
  );
}
