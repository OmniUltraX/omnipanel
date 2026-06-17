import { useState, useRef, useEffect, useCallback, useMemo, type KeyboardEvent } from "react";
import { useLocation } from "react-router-dom";
import { ModuleSegmentDock } from "../../components/dock";
import { WorkspaceSwitcher } from "../../components/shell/WorkspaceSwitcher";
import { AppLogo } from "../../components/ui/AppLogo";
import { useI18n } from "../../i18n";
import { usePersistedModuleTab } from "../../hooks/usePersistedModuleTab";

type DashboardTab = "home";
const DASHBOARD_TABS: DashboardTab[] = ["home"];

export function DashboardHomeView() {
  const { t } = useI18n();
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
      </div>
    </div>
  );
}

export function Dashboard() {
  const { t } = useI18n();
  const location = useLocation();
  const isActiveRoute = location.pathname === "/";
  const [tab, setTab] = usePersistedModuleTab("dashboard", "home", DASHBOARD_TABS);

  const segmentTabs = useMemo(
    () => [{ id: "home", label: t("dashboard.tabs.home") }],
    [t],
  );

  const renderPanel = useCallback((tabId: string) => {
    if (tabId === "home") {
      return <DashboardHomeView />;
    }
    return null;
  }, []);

  const preActions = useMemo(() => <WorkspaceSwitcher placement="below" />, []);

  return (
    <ModuleSegmentDock
      className="dashboard-module-dock"
      tabs={segmentTabs}
      activeTabId={tab}
      onActiveTabChange={(id) => setTab(id as DashboardTab)}
      enabled={isActiveRoute}
      renderPanel={renderPanel}
      preActions={preActions}
    />
  );
}
