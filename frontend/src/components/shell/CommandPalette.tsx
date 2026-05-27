import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useAiStore } from "../../stores/aiStore";

interface CommandItem {
  id: string;
  label: string;
  shortcut?: string;
  path?: string;
  action?: () => void;
  category: string;
}

const commands: CommandItem[] = [
  { id: "workspace", label: "Go to Workspace", shortcut: "⌘1", path: "/", category: "Navigation" },
  { id: "terminal", label: "Go to Terminal", shortcut: "⌘2", path: "/terminal", category: "Navigation" },
  { id: "ssh", label: "Go to SSH Manager", shortcut: "⌘3", path: "/ssh", category: "Navigation" },
  { id: "database", label: "Go to Database", shortcut: "⌘4", path: "/database", category: "Navigation" },
  { id: "docker", label: "Go to Docker", shortcut: "⌘5", path: "/docker", category: "Navigation" },
  { id: "server", label: "Go to Server", shortcut: "⌘6", path: "/server", category: "Navigation" },
  { id: "protocol", label: "Go to Protocol Lab", path: "/protocol", category: "Navigation" },
  { id: "workflow", label: "Go to Workflow", path: "/workflow", category: "Navigation" },
  { id: "knowledge", label: "Go to Knowledge Base", path: "/knowledge", category: "Navigation" },
  { id: "tasks", label: "Go to Tasks", path: "/tasks", category: "Navigation" },
  { id: "settings", label: "Open Settings", shortcut: "⌘,", path: "/settings", category: "Navigation" },
  { id: "new-terminal", label: "New Terminal", shortcut: "⌘T", category: "Actions" },
  { id: "new-ssh", label: "New SSH Connection", category: "Actions" },
  { id: "new-query", label: "New SQL Query", category: "Actions" },
  { id: "toggle-theme", label: "Toggle Theme", category: "Actions" },
  { id: "clear-cache", label: "Clear Cache", category: "Actions" },
  { id: "open-ai", label: "Open AI Chat", shortcut: "⌘L", action: () => useAiStore.getState().openDrawer(), category: "AI" },
  { id: "new-ai-conv", label: "New AI Conversation", action: () => { useAiStore.getState().createConversation(); useAiStore.getState().openDrawer(); }, category: "AI" },
];

export function CommandPalette() {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  const filtered = commands.filter((cmd) =>
    cmd.label.toLowerCase().includes(query.toLowerCase())
  );

  const grouped = filtered.reduce<Record<string, CommandItem[]>>((acc, cmd) => {
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
      // Don't intercept shortcuts when typing in terminal
      const target = e.target as HTMLElement;
      if (target?.closest?.(".xterm")) {
        if (e.key === "Escape" && isOpen) {
          setIsOpen(false);
        }
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
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
  }, [isOpen, toggle]);

  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isOpen]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const execute = (cmd: CommandItem) => {
    if (cmd.path) {
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
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh]" onClick={() => setIsOpen(false)}>
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div
        className="relative w-[520px] bg-bg-deeper border border-border rounded-xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search Input */}
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
            placeholder="Type a command or search..."
            className="flex-1 bg-transparent text-sm text-fg placeholder:text-muted outline-none"
          />
          <kbd className="px-1.5 py-0.5 text-[10px] text-meta bg-surface border border-border rounded font-mono">ESC</kbd>
        </div>

        {/* Results */}
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
              No commands found
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-2 border-t border-border text-[11px] text-meta">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1">
              <kbd className="px-1 py-0.5 bg-surface border border-border rounded font-mono">↑↓</kbd>
              navigate
            </span>
            <span className="flex items-center gap-1">
              <kbd className="px-1 py-0.5 bg-surface border border-border rounded font-mono">↵</kbd>
              select
            </span>
            <span className="flex items-center gap-1">
              <kbd className="px-1 py-0.5 bg-surface border border-border rounded font-mono">esc</kbd>
              close
            </span>
          </div>
          <span>{filtered.length} results</span>
        </div>
      </div>
    </div>
  );
}
