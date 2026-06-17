import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useAiStore } from "../../stores/aiStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useActionStore } from "../../stores/actionStore";
import { useSettingsUiStore } from "../../stores/settingsUiStore";
import { openLocalTerminalSession } from "../../lib/terminalSession";
import { useI18n } from "../../i18n";
import {
  formatShortcut,
  matchesShortcut,
  useShortcutsStore,
  type KeyToken,
} from "../../stores/shortcutsStore";

/** 默认组合的稳定引用，避免在 selector 中返回新数组导致无限渲染 */
const DEFAULT_AI_KEYS: KeyToken[] = ["Mod", "`"];
const DEFAULT_COMMAND_PALETTE_KEYS: KeyToken[] = ["Mod", "K"];

interface CommandItem {
  id: string;
  labelKey: string;
  shortcut?: string;
  path?: string;
  action?: () => void;
  categoryKey: string;
}

const COMMAND_DEFS: CommandItem[] = [
  { id: "workspace", labelKey: "shell.commandPalette.commands.workspace", shortcut: "⌘1", path: "/", categoryKey: "shell.commandPalette.categories.nav" },
  { id: "terminal", labelKey: "shell.commandPalette.commands.terminal", shortcut: "⌘2", path: "/terminal", categoryKey: "shell.commandPalette.categories.nav" },
  { id: "database", labelKey: "shell.commandPalette.commands.database", shortcut: "⌘3", path: "/database", categoryKey: "shell.commandPalette.categories.nav" },
  { id: "ssh", labelKey: "shell.commandPalette.commands.ssh", shortcut: "⌘4", path: "/ssh", categoryKey: "shell.commandPalette.categories.nav" },
  { id: "docker", labelKey: "shell.commandPalette.commands.docker", shortcut: "⌘5", path: "/docker", categoryKey: "shell.commandPalette.categories.nav" },
  { id: "server", labelKey: "shell.commandPalette.commands.server", path: "/server", categoryKey: "shell.commandPalette.categories.nav" },
  { id: "protocol", labelKey: "shell.commandPalette.commands.protocol", path: "/protocol", categoryKey: "shell.commandPalette.categories.nav" },
  { id: "workflow", labelKey: "shell.commandPalette.commands.workflow", path: "/workflow", categoryKey: "shell.commandPalette.categories.nav" },
  { id: "knowledge", labelKey: "shell.commandPalette.commands.knowledge", path: "/knowledge", categoryKey: "shell.commandPalette.categories.nav" },
  { id: "settings", labelKey: "shell.commandPalette.commands.settings", shortcut: "⌘,", action: () => useSettingsUiStore.getState().openSettings(), categoryKey: "shell.commandPalette.categories.nav" },
  { id: "new-terminal", labelKey: "shell.commandPalette.commands.newTerminal", shortcut: "⌘T", action: () => openLocalTerminalSession(), categoryKey: "shell.commandPalette.categories.action" },
  {
    id: "new-ssh",
    labelKey: "shell.commandPalette.commands.newSsh",
    path: "/ssh",
    categoryKey: "shell.commandPalette.categories.action",
  },
  { id: "new-query", labelKey: "shell.commandPalette.commands.newQuery", categoryKey: "shell.commandPalette.categories.action" },
  { id: "open-ai", labelKey: "shell.commandPalette.commands.openAi", shortcut: "$mod+`", action: () => useAiStore.getState().openDrawer(), categoryKey: "shell.commandPalette.categories.ai" },
  { id: "new-ai-conv", labelKey: "shell.commandPalette.commands.newAiConv", action: () => { useAiStore.getState().createConversation(); useAiStore.getState().openDrawer(); }, categoryKey: "shell.commandPalette.categories.ai" },
];

export function CommandPalette() {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const setActivePath = useWorkspaceStore((s) => s.setActivePath);
  const blockedCount = useActionStore((s) => s.actions.filter((a) => a.status === "blocked").length);
  const shortcutsOverrides = useShortcutsStore((s) => s.overrides);
  const aiShortcutLabel = useMemo(
    () => formatShortcut(shortcutsOverrides["toggle-ai"] ?? DEFAULT_AI_KEYS),
    [shortcutsOverrides]
  );
  const commandPaletteKeys = useMemo<KeyToken[]>(
    () => shortcutsOverrides["command-palette"] ?? DEFAULT_COMMAND_PALETTE_KEYS,
    [shortcutsOverrides]
  );

  const commands = useMemo(
    () =>
      COMMAND_DEFS.map((cmd) => ({
        ...cmd,
        label: t(cmd.labelKey),
        category: t(cmd.categoryKey),
        shortcut:
          cmd.shortcut === "$mod+`" ? aiShortcutLabel : cmd.shortcut,
      })),
    [t, aiShortcutLabel]
  );

  const filtered = commands.filter((cmd) =>
    cmd.label.toLowerCase().includes(query.toLowerCase())
  );

  const grouped = filtered.reduce<Record<string, typeof filtered>>((acc, cmd) => {
    if (!acc[cmd.category]) acc[cmd.category] = [];
    acc[cmd.category].push(cmd);
    return acc;
  }, {});

  const toggle = useCallback(() => {
    setIsOpen((prev) => !prev);
    setQuery("");
    setSelectedIndex(0);
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target?.closest?.(".xterm")) {
        if (e.key === "Escape" && isOpen) {
          setIsOpen(false);
        }
        return;
      }
      if (matchesShortcut(e, commandPaletteKeys)) {
        e.preventDefault();
        toggle();
      }
      if (e.key === "Escape" && isOpen) {
        setIsOpen(false);
      }
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
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isOpen]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const execute = (cmd: (typeof commands)[number]) => {
    if (cmd.path) {
      setActivePath(cmd.path);
      navigate(cmd.path);
    }
    if (cmd.action) {
      cmd.action();
    }
    setIsOpen(false);
    setQuery("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => Math.min(prev + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => Math.max(prev - 1, 0));
    } else if (e.key === "Enter" && filtered[selectedIndex]) {
      execute(filtered[selectedIndex]);
    }
  };

  if (!isOpen) return null;

  let flatIndex = 0;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh]">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div
        className="relative w-[520px] bg-bg-deeper border border-border rounded-xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 h-12 border-b border-border">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-muted shrink-0">
            <circle cx="11" cy="11" r="8" />
            <path d="M21 21l-4.35-4.35" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t("shell.commandPalette.placeholder")}
            className="flex-1 bg-transparent text-sm text-fg placeholder:text-muted outline-none"
          />
          <kbd className="px-1.5 py-0.5 text-[10px] text-meta bg-surface border border-border rounded font-mono">ESC</kbd>
        </div>

        <div className="max-h-[320px] overflow-y-auto py-2">
          {Object.entries(grouped).map(([category, items]) => (
            <div key={category}>
              <div className="px-4 py-1.5 text-[11px] font-medium text-meta uppercase tracking-wider">
                {category}
              </div>
              {items.map((cmd) => {
                const currentIndex = flatIndex++;
                const isSelected = currentIndex === selectedIndex;
                return (
                  <button
                    key={cmd.id}
                    className={`w-full flex items-center justify-between px-4 py-2 text-sm transition-colors ${
                      isSelected ? "bg-accent/10 text-accent" : "text-fg-2 hover:bg-surface-hover"
                    }`}
                    onClick={() => execute(cmd)}
                    onMouseEnter={() => setSelectedIndex(currentIndex)}
                  >
                    <span>{cmd.label}</span>
                    {cmd.shortcut && (
                      <kbd className="px-1.5 py-0.5 text-[10px] text-meta bg-surface border border-border rounded font-mono">
                        {cmd.shortcut}
                      </kbd>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
          {filtered.length === 0 && (
            <div className="px-4 py-8 text-center text-sm text-muted">
              {t("shell.commandPalette.noResults")}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between px-4 py-2 border-t border-border text-[11px] text-meta">
          <span>{t("shell.commandPalette.hint")}</span>
          <span>{t("shell.commandPalette.pendingActions", { count: blockedCount })}</span>
        </div>
      </div>
    </div>
  );
}
