import { Component, useEffect, useMemo, useState, type ErrorInfo, type ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { WinControls } from "./components/shell/WinControls";
import { WorkspacePanel } from "./components/workspace/WorkspacePanel";
import { AppDialogHost } from "./components/ui/overlay/AppDialogHost";
import { ToastHost } from "./components/ui/feedback/ToastHost";
import { QuickInputHost } from "./components/ui/form/QuickInputHost";
import { initSettings, useSettingsStore } from "./stores/settingsStore";
import { initConnections } from "./stores/connectionStore";
import { initConnectionPool } from "./stores/connectionPoolStore";
import { initAppModuleStore } from "./stores/appModuleStore";
import { useBottomPanelStore } from "./stores/bottomPanelStore";
import { useWorkspaceStore, DEFAULT_WORKSPACE, type WorkspaceInfo } from "./stores/workspaceStore";
import { useWorkspaceBottomDockStore } from "./stores/workspaceBottomDockStore";
import { useTerminalStore } from "./stores/terminalStore";
import { syncAppWindowTitle } from "./lib/appWindowTitle";
import { initWorkspaceWindowLifecycle, workspaceWindowDebugLog } from "./lib/workspaceWindow";
import { hydrateWorkspaceWindowFromHandoff } from "./lib/workspaceWindowHandoff";
import { initCrossWindowDockTransfer } from "./lib/crossWindowDockTransfer";
import { initModuleToWorkspaceDragBridge } from "./lib/moduleToWorkspaceDragBridge";
import { initWorkspaceAddSnapshotListener } from "./lib/workspaceSnapshotDelivery";
import { initCrossWindowDragVisual } from "./lib/crossWindowDragVisual";
import { CrossWindowDragVisualLayer } from "./components/shell/CrossWindowDragVisualLayer";
import { dismissHtmlBootSplash } from "./lib/dismissBootSplash";
import { relayoutDockviewInstances } from "./lib/dockviewRegistry";
import { useI18n } from "./i18n";

interface WorkspaceWindowRootProps {
  workspaceId: string;
}

async function waitPersistHydrated(
  store: {
    persist: {
      hasHydrated: () => boolean;
      onFinishHydration: (fn: () => void) => () => void;
    };
  },
): Promise<void> {
  if (store.persist.hasHydrated()) return;
  await new Promise<void>((resolve) => {
    const unsub = store.persist.onFinishHydration(() => {
      unsub();
      resolve();
    });
    window.setTimeout(() => {
      unsub();
      resolve();
    }, 1500);
  });
}

class WorkspaceWindowErrorBoundary extends Component<
  { children: ReactNode },
  { error: string | null }
> {
  state: { error: string | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error: error?.stack || error?.message || String(error) };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[workspaceWindow] render crash", error, info);
    void workspaceWindowDebugLog(
      `child ErrorBoundary: ${error?.stack || error?.message || String(error)} | ${info.componentStack ?? ""}`,
    );
  }

  render() {
    if (this.state.error) {
      return (
        <div className="workspace-window-root workspace-window-root--error">
          <pre className="workspace-window-error">{this.state.error}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

/**
 * 工作区独立窗口：复用 WorkspacePanel 全屏布局，无 Bootstrap 启动页。
 */
export function WorkspaceWindowRoot({ workspaceId }: WorkspaceWindowRootProps) {
  return (
    <WorkspaceWindowErrorBoundary>
      <WorkspaceWindowBoot workspaceId={workspaceId} />
    </WorkspaceWindowErrorBoundary>
  );
}

function WorkspaceWindowBoot({ workspaceId }: WorkspaceWindowRootProps) {
  const [ready, setReady] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);
  const workspaces = useWorkspaceStore((state) => state.workspaces);

  useEffect(() => {
    dismissHtmlBootSplash();
    useBottomPanelStore.setState({
      workspaceMode: "fullscreen",
      isFullscreen: true,
      isOpen: true,
      embeddedMode: "off",
    });
  }, []);

  const workspace = useMemo<WorkspaceInfo>(() => {
    const found = workspaces.find((ws) => ws.id === workspaceId);
    if (found) return found;
    return { ...DEFAULT_WORKSPACE, id: workspaceId, name: DEFAULT_WORKSPACE.name };
  }, [workspaces, workspaceId]);

  useEffect(() => {
    syncAppWindowTitle(workspace.name || `工作区 ${workspaceId}`);
  }, [workspace.name, workspaceId]);

  useEffect(() => {
    let cleanup: (() => void) | null = null;
    void initWorkspaceWindowLifecycle(workspaceId).then((fn) => {
      cleanup = fn;
    });
    return () => cleanup?.();
  }, [workspaceId]);

  useEffect(() => {
    try {
      return initCrossWindowDockTransfer();
    } catch (e) {
      console.warn("[crossWindowDock] init failed", e);
      return () => {};
    }
  }, []);

  useEffect(() => {
    try {
      return initModuleToWorkspaceDragBridge();
    } catch (e) {
      console.warn("[moduleToWorkspaceDrag] init failed", e);
      return () => {};
    }
  }, []);

  useEffect(() => {
    try {
      return initWorkspaceAddSnapshotListener();
    } catch (e) {
      console.warn("[workspaceSnapshotDelivery] init failed", e);
      return () => {};
    }
  }, []);

  useEffect(() => {
    try {
      return initCrossWindowDragVisual();
    } catch (e) {
      console.warn("[crossWindowDragVisual] init failed", e);
      return () => {};
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    const boot = async () => {
      await workspaceWindowDebugLog(`child boot start id=${workspaceId}`);
      try {
        initSettings();
        initConnections();
        initConnectionPool();
        await initAppModuleStore().catch(() => {});
        await import("@xterm/xterm/css/xterm.css").catch(() => {});

        await Promise.all([
          waitPersistHydrated(useWorkspaceBottomDockStore),
          waitPersistHydrated(useTerminalStore),
          waitPersistHydrated(useWorkspaceStore),
          waitPersistHydrated(useSettingsStore),
        ]);

        await hydrateWorkspaceWindowFromHandoff(workspaceId);
        await workspaceWindowDebugLog("child handoff hydrated");

        if (!cancelled) setReady(true);
      } catch (e) {
        console.error("[workspaceWindow] boot failed", e);
        if (!cancelled) {
          setBootError(e instanceof Error ? e.stack || e.message : String(e));
        }
      }
    };

    void boot();
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  useEffect(() => {
    if (!ready) return;
    const relayout = () => {
      const width = window.innerWidth;
      const height = window.innerHeight;
      if (width > 0 && height > 0) {
        relayoutDockviewInstances("workspace-bottom", { width, height });
      }
    };
    relayout();
    window.addEventListener("resize", relayout);
    const raf = requestAnimationFrame(relayout);
    return () => {
      window.removeEventListener("resize", relayout);
      cancelAnimationFrame(raf);
    };
  }, [ready, workspaceId]);

  if (bootError) {
    return (
      <div className="workspace-window-root workspace-window-root--error">
        <pre className="workspace-window-error">{bootError}</pre>
      </div>
    );
  }

  return (
    <MemoryRouter>
      <WorkspaceWindowShell workspace={workspace} ready={ready} />
      <QuickInputHost />
      <AppDialogHost />
      <ToastHost />
      <CrossWindowDragVisualLayer />
    </MemoryRouter>
  );
}

function WorkspaceWindowShell({
  workspace,
  ready,
}: {
  workspace: WorkspaceInfo;
  ready: boolean;
}) {
  useI18n();

  return (
    <div
      className="workspace-window-root workspace-preview workspace-preview--fullscreen workspace-preview--detached"
      data-ready={ready ? "true" : "false"}
    >
      <div className="workspace-preview__bottom-stack">
        <div className="workspace-preview__dock" data-visible="true">
          {ready ? <WorkspacePanel workspace={workspace} detached /> : null}
        </div>
      </div>
    </div>
  );
}
