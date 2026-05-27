import { useCallback, useRef, useState, useEffect } from "react";
import { useTerminalStore } from "../../stores/terminalStore";
import { useBlocksStore, type TerminalBlock } from "../../stores/blocksStore";
import { useAiStore } from "../../stores/aiStore";
import { PaneRenderer } from "../terminal/PaneRenderer";
import { TerminalSearch } from "../terminal/TerminalSearch";
import { DangerConfirmDialog } from "../terminal/DangerConfirmDialog";
import { BlockContextMenu } from "../terminal/BlockContextMenu";
import { checkCommand } from "../../lib/commandGuard";
import type { DangerCheckResult } from "../../lib/commandGuard";
import type { SearchAddon } from "@xterm/addon-search";
import type { Terminal } from "@xterm/xterm";

export function TerminalPanel() {
  const { tabs, activeTabId, layout, addTab, removeTab, setActiveTab, splitPane } =
    useTerminalStore();
  const nextId = useRef(1);
  const [showSearch, setShowSearch] = useState(false);
  const [searchAddon, setSearchAddon] = useState<SearchAddon | null>(null);
  const [activeTerminal, setActiveTerminal] = useState<Terminal | null>(null);
  const [pendingDanger, setPendingDanger] = useState<{
    command: string;
    result: DangerCheckResult;
  } | null>(null);
  const pendingCommandRef = useRef<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    block: TerminalBlock;
    position: { x: number; y: number };
  } | null>(null);

  const handleNewTerminal = useCallback(() => {
    const num = nextId.current++;
    const id = `term-${num}`;
    addTab({ id, title: `Terminal ${num}`, type: "local" });
    setActiveTab(id);
  }, [addTab, setActiveTab]);

  const handleSplit = useCallback(
    (direction: "horizontal" | "vertical") => {
      if (!activeTabId) return;
      const num = nextId.current++;
      const id = `term-${num}`;
      addTab({ id, title: `Terminal ${num}`, type: "local" });
      splitPane(activeTabId, direction, id);
      setActiveTab(id);
    },
    [activeTabId, addTab, splitPane, setActiveTab]
  );

  // Auto-create first terminal on mount
  useEffect(() => {
    if (useTerminalStore.getState().tabs.length === 0) {
      handleNewTerminal();
    }
  }, [handleNewTerminal]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target?.closest?.("input, textarea")) return;

      // Ctrl+F — toggle search
      if ((e.ctrlKey || e.metaKey) && e.key === "f") {
        e.preventDefault();
        setShowSearch((v) => !v);
      }
      // Escape — close search
      if (e.key === "Escape" && showSearch) {
        setShowSearch(false);
      }
      // Ctrl+\ — vertical split
      if ((e.ctrlKey || e.metaKey) && e.key === "\\") {
        e.preventDefault();
        handleSplit(e.shiftKey ? "horizontal" : "vertical");
      }
      // Ctrl+Shift+\ — horizontal split
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === "|") {
        e.preventDefault();
        handleSplit("horizontal");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [showSearch, handleSplit]);

  // Send command to active terminal
  const sendToTerminal = useCallback(
    (command: string) => {
      const tab = tabs.find((t) => t.id === activeTabId);
      if (tab?.terminal) {
        tab.terminal.write(command + "\r");
      }
    },
    [tabs, activeTabId]
  );

  // Dangerous command detection callback
  const handleCommand = useCallback((command: string) => {
    const result = checkCommand(command);
    if (!result.safe) {
      pendingCommandRef.current = command;
      setPendingDanger({ command, result });
    }
  }, []);

  const handleDangerConfirm = useCallback(() => {
    const cmd = pendingCommandRef.current;
    if (cmd) sendToTerminal(cmd);
    pendingCommandRef.current = null;
    setPendingDanger(null);
  }, [sendToTerminal]);

  const handleDangerCancel = useCallback(() => {
    pendingCommandRef.current = null;
    setPendingDanger(null);
  }, []);

  const handleBlockRightClick = useCallback(
    (block: TerminalBlock, position: { x: number; y: number }) => {
      setContextMenu({ block, position });
    },
    []
  );

  const handleTerminalReady = useCallback(
    (tabId: string, term: Terminal, sa: SearchAddon) => {
      if (tabId === activeTabId) {
        setActiveTerminal(term);
        setSearchAddon(sa);
      }
    },
    [activeTabId]
  );

  return (
    <div className="term-workspace">
      <div className="term-panes">
        {/* Tab bar */}
        <div
          className="term-pane-header"
          style={{
            display: "flex",
            alignItems: "center",
            gap: "2px",
            padding: "0 4px",
          }}
        >
          {tabs.map((tab) => (
            <button
              key={tab.id}
              className={`topbar-tab ${tab.id === activeTabId ? "active" : ""}`}
              onClick={() => setActiveTab(tab.id)}
              style={{ display: "flex", alignItems: "center", gap: "6px" }}
            >
              {tab.type === "remote" && (
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background:
                      tab.status === "connected"
                        ? "var(--success)"
                        : tab.status === "connecting"
                          ? "var(--warn)"
                          : "var(--muted)",
                  }}
                />
              )}
              <span>{tab.title}</span>
              <span
                className="close"
                onClick={(e) => {
                  e.stopPropagation();
                  removeTab(tab.id);
                }}
                style={{
                  cursor: "pointer",
                  opacity: 0.5,
                  fontSize: "14px",
                  lineHeight: 1,
                }}
              >
                &times;
              </span>
            </button>
          ))}
          <button
            className="btn-icon"
            onClick={handleNewTerminal}
            title="New Terminal (Ctrl+T)"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 28,
              height: 28,
              borderRadius: "var(--r-sm)",
              cursor: "pointer",
              color: "var(--fg-2)",
              marginLeft: 4,
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
        </div>

        {/* Search bar */}
        {showSearch && activeTerminal && searchAddon && (
          <TerminalSearch
            terminal={activeTerminal}
            searchAddon={searchAddon}
            onClose={() => setShowSearch(false)}
          />
        )}

        {/* Terminal panes (split layout) */}
        {layout ? (
          <PaneRenderer
            layout={layout}
            activeTabId={activeTabId}
            onTerminalReady={handleTerminalReady}
            onCommand={handleCommand}
            onBlockRightClick={handleBlockRightClick}
          />
        ) : (
          // Fallback: flat rendering when no layout exists yet
          tabs.map((tab) => null)
        )}
      </div>

      {/* Block context menu */}
      {contextMenu && (
        <BlockContextMenu
          block={contextMenu.block}
          position={contextMenu.position}
          onClose={() => setContextMenu(null)}
          onRunCommand={sendToTerminal}
        />
      )}

      {/* Dangerous command confirmation dialog */}
      {pendingDanger && (
        <DangerConfirmDialog
          command={pendingDanger.command}
          result={pendingDanger.result}
          onConfirm={handleDangerConfirm}
          onCancel={handleDangerCancel}
        />
      )}
    </div>
  );
}
