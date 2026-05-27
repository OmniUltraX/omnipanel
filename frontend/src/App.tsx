import { BrowserRouter, Routes, Route, useLocation } from "react-router-dom";
import { Sidebar } from "./components/shell/Sidebar";
import { Topbar } from "./components/shell/Topbar";
import { StatusBar } from "./components/shell/StatusBar";
import { CommandPalette } from "./components/shell/CommandPalette";
import { NotificationDrawer } from "./components/shell/NotificationDrawer";
import { AiDrawer, AiPinnedPanel } from "./components/ai/AiDrawer";
import { Dashboard } from "./components/panels/Dashboard";
import { TerminalPanel } from "./components/panels/TerminalPanel";
import { SshManager } from "./components/panels/SshManager";
import { DatabasePanel } from "./components/panels/DatabasePanel";
import { DockerPanel } from "./components/panels/DockerPanel";
import { ServerPanel } from "./components/panels/ServerPanel";
import { ProtocolPanel } from "./components/panels/ProtocolPanel";
import { WorkflowPanel } from "./components/panels/WorkflowPanel";
import { KnowledgePanel } from "./components/panels/KnowledgePanel";
import { TasksPanel } from "./components/panels/TasksPanel";
import { SettingsPanel } from "./components/panels/SettingsPanel";
import { useAiStore } from "./stores/aiStore";

const routeTitles: Record<string, string> = {
  "/": "Workspace",
  "/terminal": "Terminal",
  "/ssh": "SSH Manager",
  "/database": "Database",
  "/docker": "Docker",
  "/server": "Server",
  "/protocol": "Protocol Lab",
  "/workflow": "Workflows",
  "/knowledge": "Knowledge Base",
  "/tasks": "Task Center",
  "/settings": "Settings",
};

function AppShell() {
  const location = useLocation();
  const title = routeTitles[location.pathname] || "OmniPanel";
  const isTerminal = location.pathname === "/terminal";
  const drawerOpen = useAiStore((s) => s.drawerOpen);
  const drawerMode = useAiStore((s) => s.drawerMode);
  const isPinned = drawerOpen && drawerMode === "pinned";

  return (
    <div className="app">
      <Sidebar />
      <div className="main-content">
        <Topbar title={title} />
        <div className="content-area">
          <div className="content-routes">
            {/* TerminalPanel stays mounted to preserve PTY state */}
            <div style={{
              display: isTerminal ? "flex" : "none",
              flex: 1,
              flexDirection: "column",
              minHeight: 0,
              minWidth: 0,
            }}>
              <TerminalPanel />
            </div>
            {!isTerminal && (
              <Routes>
                <Route path="/" element={<Dashboard />} />
                <Route path="/ssh" element={<SshManager />} />
                <Route path="/database" element={<DatabasePanel />} />
                <Route path="/docker" element={<DockerPanel />} />
                <Route path="/server" element={<ServerPanel />} />
                <Route path="/protocol" element={<ProtocolPanel />} />
                <Route path="/workflow" element={<WorkflowPanel />} />
                <Route path="/knowledge" element={<KnowledgePanel />} />
                <Route path="/tasks" element={<TasksPanel />} />
                <Route path="/settings" element={<SettingsPanel />} />
              </Routes>
            )}
          </div>
          {isPinned && <AiPinnedPanel />}
        </div>
        <StatusBar />
      </div>
      <AiDrawer />
      <CommandPalette />
      <NotificationDrawer />
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppShell />
    </BrowserRouter>
  );
}
