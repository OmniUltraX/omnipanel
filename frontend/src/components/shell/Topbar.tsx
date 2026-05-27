import { getCurrentWindow } from "@tauri-apps/api/window";
import { useAiStore } from "../../stores/aiStore";

interface Tab {
  id: string;
  label: string;
  active?: boolean;
}

interface TopbarProps {
  title: string;
  tabs?: Tab[];
  children?: React.ReactNode;
  onTabClose?: (id: string) => void;
}

export function Topbar({ title, tabs, children, onTabClose }: TopbarProps) {
  const handleMinimize = async () => {
    await getCurrentWindow().minimize();
  };

  const handleMaximize = async () => {
    await getCurrentWindow().toggleMaximize();
  };

  const handleClose = async () => {
    await getCurrentWindow().close();
  };

  const handleSearch = () => {
    window.dispatchEvent(new CustomEvent("toggle-cmd-palette"));
  };

  const handleNotifications = () => {
    window.dispatchEvent(new CustomEvent("toggle-notif-drawer"));
  };

  const handleAi = () => {
    useAiStore.getState().toggleDrawer();
  };

  const aiDrawerOpen = useAiStore((s) => s.drawerOpen);

  return (
    <div className="topbar" data-tauri-drag-region>
      <span className="topbar-title">{title}</span>

      {/* Tabs (e.g. terminal) */}
      {tabs && tabs.length > 0 && (
        <div className="topbar-tabs">
          {tabs.map((tab) => (
            <div key={tab.id} className={`topbar-tab${tab.active ? " active" : ""}`}>
              <span>{tab.label}</span>
              {onTabClose && (
                <span
                  className="close"
                  onClick={(e) => {
                    e.stopPropagation();
                    onTabClose(tab.id);
                  }}
                >
                  &times;
                </span>
              )}
            </div>
          ))}
          <button className="btn-icon" title="New Tab" style={{ marginLeft: 4 }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14" /></svg>
          </button>
        </div>
      )}

      {/* Draggable spacer */}
      <div className="topbar-spacer" data-tauri-drag-region />

      {/* Actions — NOT draggable */}
      <div className="topbar-actions" data-tauri-drag-region="false">
        {children && (
          <div className="topbar-page-actions">
            {children}
          </div>
        )}

        <button className={`topbar-btn${aiDrawerOpen ? " active" : ""}`} title="AI Assistant (Ctrl+L)" onClick={handleAi}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 2a4 4 0 014 4v1a4 4 0 01-8 0V6a4 4 0 014-4z" /><circle cx="18" cy="14" r="0.5" fill="currentColor" /><circle cx="6" cy="14" r="0.5" fill="currentColor" /><path d="M12 17v4" /><path d="M8 21h8" /></svg>
        </button>
        <button className="topbar-btn" title="Notifications" onClick={handleNotifications}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 01-3.46 0" /></svg>
          <span className="notif-badge">3</span>
        </button>
        <button className="topbar-btn" title="Search (Ctrl+K)" onClick={handleSearch}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></svg>
        </button>

        {/* Window Controls */}
        <div className="win-controls">
          <button className="win-btn minimize" title="Minimize" onClick={handleMinimize}>
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M0 5h10" stroke="currentColor" strokeWidth="1.2"/></svg>
          </button>
          <button className="win-btn maximize" title="Maximize" onClick={handleMaximize}>
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" strokeWidth="1.2"/></svg>
          </button>
          <button className="win-btn close" title="Close" onClick={handleClose}>
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1.2"/></svg>
          </button>
        </div>
      </div>
    </div>
  );
}
