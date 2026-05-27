import { useAiStore } from "../../stores/aiStore";

export function StatusBar() {
  const currentModel = useAiStore((s) => s.currentModel);
  const currentProvider = useAiStore((s) => s.currentProvider);
  const openDrawer = useAiStore((s) => s.openDrawer);

  return (
    <div className="statusbar">
      <span className="statusbar-item"><span className="statusbar-dot green"></span> 6 servers</span>
      <span className="statusbar-item">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12"><rect x="2" y="7" width="6" height="5" rx="1" /><rect x="10" y="7" width="6" height="5" rx="1" /></svg>
        5 containers
      </span>
      <span className="statusbar-item">3 tasks</span>
      <span className="statusbar-item">3 drafts</span>
      <span className="statusbar-spacer"></span>
      <button
        className="statusbar-item cursor-pointer hover:text-accent transition-colors"
        onClick={openDrawer}
        title="Open AI Assistant"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12">
          <path d="M12 2a4 4 0 014 4v1a4 4 0 01-8 0V6a4 4 0 014-4z" />
          <path d="M12 17v4" />
          <path d="M8 21h8" />
        </svg>
        AI: {currentModel}
      </button>
      <span className="statusbar-item" style={{ color: "var(--meta)" }}>Ctrl+K: Command Palette</span>
    </div>
  );
}
