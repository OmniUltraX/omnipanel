import { useState, useRef, useEffect, useCallback, type KeyboardEvent } from "react";
import { useWorkspaceStore, type WorkspaceInfo } from "../../stores/workspaceStore";
import { useBottomPanelStore } from "../../stores/bottomPanelStore";
import { AppLogo } from "../../components/ui/AppLogo";
import { useI18n } from "../../i18n";

function currentEnvOfWorkspace(_ws: WorkspaceInfo) {
  return "dev";
}

export function Dashboard() {
  const { t } = useI18n();
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.workspace.id);
  const switchWorkspace = useWorkspaceStore((s) => s.switchWorkspace);
  const requestExpand = useBottomPanelStore((s) => s.requestExpand);

  const [draft, setDraft] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 180) + "px";
  }, [draft]);

  const handleSend = useCallback(() => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
  }, [draft]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSend();
    }
  };

  const openWorkspace = (ws: WorkspaceInfo) => {
    switchWorkspace(ws.id);
    requestExpand();
  };

  return (
    <div className="dashboard dashboard-home">
      <div className="dashboard-home-inner">
        <div className="dashboard-logo">
          <AppLogo size={56} />
          <div className="dashboard-logo-name">OmniPanel</div>
        </div>

        <div className="dashboard-input-shell">
          <textarea
            ref={textareaRef}
            className="dashboard-input"
            placeholder={t("dashboard.inputPlaceholder")}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
            spellCheck={false}
          />
          <button
            type="button"
            className="dashboard-send"
            onClick={handleSend}
            disabled={draft.trim().length === 0}
            aria-label={t("dashboard.send")}
            title={t("dashboard.send")}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12l14-7-4 7 4 7-14-7z" />
              <path d="M9 12h6" />
            </svg>
          </button>
        </div>

        <div className="dashboard-workspace-list">
          {workspaces.map((ws) => {
            const active = ws.id === activeWorkspaceId;
            return (
              <button
                key={ws.id}
                type="button"
                className={"workspace-pill" + (active ? " is-active" : "")}
                onClick={() => openWorkspace(ws)}
              >
                <span className="workspace-pill-dot" />
                <span className="workspace-pill-name">{ws.name}</span>
                <span className="workspace-pill-env">{currentEnvOfWorkspace(ws)}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
