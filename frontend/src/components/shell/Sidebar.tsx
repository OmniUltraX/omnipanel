import { useNavigate, useLocation } from "react-router-dom";
import { useAiStore } from "../../stores/aiStore";

const navItems = [
  { path: "/", label: "Workspace", icon: "M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" },
  { path: "/terminal", label: "Terminal", icon: "M4 17l6-6-6-6 M12 19h8" },
  { path: "/ssh", label: "SSH", icon: "M2 3h20v14H2z M8 21h8 M12 17v4" },
  { path: "/database", label: "Database", icon: "M12 5a9 3 0 110 6 9 3 0 110-6z M3 5v14c0 3 4 5 9 5s9-2 9-5V5" },
  { path: "/docker", label: "Docker", icon: "M2 7h6v5H2z M10 7h6v5h-6z M18 7h4v5h-4z M6 2h6v5H6z M2 17h20" },
  { path: "/server", label: "Server", icon: "M2 2h20v8H2z M2 14h20v8H2z" },
];

const utilItems = [
  { path: "/protocol", label: "Protocol", icon: "M22 12h-4l-3 9L9 3l-3 9H2" },
  { path: "/workflow", label: "Workflow", icon: "M12 3v18 M3 12h18" },
  { path: "/knowledge", label: "Knowledge", icon: "M4 19.5A2.5 2.5 0 016.5 17H20 M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z" },
  { path: "/tasks", label: "Tasks", icon: "M9 11l3 3L22 4 M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" },
];

export function Sidebar() {
  const navigate = useNavigate();
  const location = useLocation();

  const isActive = (path: string) => {
    if (path === "/") return location.pathname === "/";
    return location.pathname.startsWith(path);
  };

  return (
    <aside className="flex flex-col w-14 h-full bg-bg-deeper border-r border-border select-none">
      {/* Logo */}
      <div className="flex items-center justify-center h-14 border-b border-border" title="OmniPanel">
        <svg width="28" height="28" viewBox="0 0 64 64" fill="none">
          <rect width="64" height="64" rx="8" fill="#007aff"/>
          <text x="32" y="44" textAnchor="middle" fontFamily="monospace" fontSize="36" fontWeight="700" fill="#ffffff">O</text>
        </svg>
      </div>

      {/* Navigation Items */}
      <nav className="flex-1 flex flex-col items-center gap-1 py-3">
        {navItems.map((item) => (
          <button
            key={item.path}
            onClick={() => navigate(item.path)}
            className={`relative w-10 h-10 flex items-center justify-center rounded-lg transition-colors group ${
              isActive(item.path)
                ? "bg-surface text-accent"
                : "text-muted hover:text-fg hover:bg-surface-hover"
            }`}
            title={item.label}
          >
            {isActive(item.path) && (
              <div className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-5 bg-accent rounded-r-full" />
            )}
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d={item.icon} />
            </svg>
            <div className="absolute left-full ml-2 px-2 py-1 bg-surface border border-border rounded-md text-xs text-fg whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity z-50">
              {item.label}
            </div>
          </button>
        ))}

        {/* Divider */}
        <div className="w-6 h-px bg-border my-2" />

        {/* Util Items */}
        {utilItems.map((item) => (
          <button
            key={item.path}
            onClick={() => navigate(item.path)}
            className={`relative w-10 h-10 flex items-center justify-center rounded-lg transition-colors group ${
              isActive(item.path)
                ? "bg-surface text-accent"
                : "text-muted hover:text-fg hover:bg-surface-hover"
            }`}
            title={item.label}
          >
            {isActive(item.path) && (
              <div className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-5 bg-accent rounded-r-full" />
            )}
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d={item.icon} />
            </svg>
            <div className="absolute left-full ml-2 px-2 py-1 bg-surface border border-border rounded-md text-xs text-fg whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity z-50">
              {item.label}
            </div>
          </button>
        ))}
      </nav>

      {/* Settings */}
      <div className="flex flex-col items-center gap-1 py-3 border-t border-border">
        {/* AI Button */}
        <button
          onClick={() => useAiStore.getState().toggleDrawer()}
          className={`relative w-10 h-10 flex items-center justify-center rounded-lg transition-colors group ${
            useAiStore.getState().drawerOpen
              ? "bg-surface text-accent"
              : "text-muted hover:text-fg hover:bg-surface-hover"
          }`}
          title="AI Assistant (Ctrl+L)"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2a4 4 0 014 4v1a4 4 0 01-8 0V6a4 4 0 014-4z" />
            <circle cx="18" cy="14" r="0.5" fill="currentColor" />
            <circle cx="6" cy="14" r="0.5" fill="currentColor" />
            <path d="M12 17v4" />
            <path d="M8 21h8" />
          </svg>
          <div className="absolute left-full ml-2 px-2 py-1 bg-surface border border-border rounded-md text-xs text-fg whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity z-50">
            AI Assistant
          </div>
        </button>

        <button
          onClick={() => navigate("/settings")}
          className={`relative w-10 h-10 flex items-center justify-center rounded-lg transition-colors group ${
            isActive("/settings")
              ? "bg-surface text-accent"
              : "text-muted hover:text-fg hover:bg-surface-hover"
          }`}
          title="Settings"
        >
          {isActive("/settings") && (
            <div className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-5 bg-accent rounded-r-full" />
          )}
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12.22 2h-.44a2 2 0 00-2 2v.18a2 2 0 01-1 1.73l-.43.25a2 2 0 01-2 0l-.15-.08a2 2 0 00-2.73.73l-.22.38a2 2 0 00.73 2.73l.15.1a2 2 0 011 1.72v.51a2 2 0 01-1 1.74l-.15.09a2 2 0 00-.73 2.73l.22.38a2 2 0 002.73.73l.15-.08a2 2 0 012 0l.43.25a2 2 0 011 1.73V20a2 2 0 002 2h.44a2 2 0 002-2v-.18a2 2 0 011-1.73l.43-.25a2 2 0 012 0l.15.08a2 2 0 002.73-.73l.22-.39a2 2 0 00-.73-2.73l-.15-.08a2 2 0 01-1-1.74v-.5a2 2 0 011-1.74l.15-.09a2 2 0 00.73-2.73l-.22-.38a2 2 0 00-2.73-.73l-.15.08a2 2 0 01-2 0l-.43-.25a2 2 0 01-1-1.73V4a2 2 0 00-2-2z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
          <div className="absolute left-full ml-2 px-2 py-1 bg-surface border border-border rounded-md text-xs text-fg whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity z-50">
            Settings
          </div>
        </button>
      </div>
    </aside>
  );
}
