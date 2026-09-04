import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
// CSS 必须静态按序引入：动态 Promise.all 会打乱级联，且 Tailwind v4 入口扫描依赖静态图
import "./styles/global.css";
import "./styles/workbench.css";
import "./styles/react-json-view-lite.css";
import "./styles/subwindow.css";
import "./styles/modules/terminal.css";
import "./styles/modules/database.css";
import "./styles/modules/docker.css";
import "./styles/modules/cloud.css";
import "./styles/modules/files.css";
import "./styles/modules/knowledge.css";
import "./styles/modules/tags.css";
import "./styles/modules/protocol.css";
import "./styles/modules/server.css";
import "./styles/modules/monitoring.css";
import "./styles/modules/home-monitor.css";
import "./styles/modules/workflow.css";
import "react-grid-layout/css/styles.css";
import { initDesktopShell } from "./lib/desktopShell";
import { initProductionDiagnostics } from "./lib/productionDiagnostics";
import { parseWorkspaceWindowParams, workspaceWindowDebugLog } from "./lib/workspaceWindow";
import { parseModuleWindowParams } from "./lib/moduleWindow";
import { isQuickLauncherWindow } from "./lib/quickLauncher";
import { dismissHtmlBootSplash } from "./lib/dismissBootSplash";

initProductionDiagnostics();
initDesktopShell();

function mount(node: ReactNode): void {
  dismissHtmlBootSplash();
  createRoot(document.getElementById("root")!).render(<StrictMode>{node}</StrictMode>);
}

async function boot(): Promise<void> {
  const quickLauncher = isQuickLauncherWindow();
  const moduleWindow = quickLauncher ? null : parseModuleWindowParams();
  const workspaceWindow =
    quickLauncher || moduleWindow ? null : parseWorkspaceWindowParams();

  void workspaceWindowDebugLog(
    `main.tsx boot role=${
      quickLauncher
        ? "quick-launcher"
        : moduleWindow
          ? `module-window:${moduleWindow.moduleKey}`
          : workspaceWindow
            ? "workspace-window"
            : "main"
    } ws=${workspaceWindow?.workspaceId ?? "-"} href=${location.href}`,
  );

  try {
    // 仅拆 JS 入口：模块窗不拉 Bootstrap；CSS 全量静态，保证级联与 Tailwind 扫描
    if (quickLauncher) {
      const { QuickLauncherRoot } = await import("./components/shell/QuickLauncherRoot");
      mount(<QuickLauncherRoot />);
      return;
    }

    if (moduleWindow) {
      const { ModuleWindowRoot } = await import("./ModuleWindowRoot");
      mount(<ModuleWindowRoot moduleKey={moduleWindow.moduleKey} />);
      return;
    }

    if (workspaceWindow) {
      const { WorkspaceWindowRoot } = await import("./WorkspaceWindowRoot");
      mount(<WorkspaceWindowRoot workspaceId={workspaceWindow.workspaceId} />);
      return;
    }

    const { Bootstrap } = await import("./Bootstrap");
    mount(<Bootstrap />);
  } catch (e) {
    console.error("[boot] failed", e);
    dismissHtmlBootSplash();
    const msg = e instanceof Error ? e.stack || e.message : String(e);
    document.body.innerHTML = `<pre style="padding:16px;color:#f88;white-space:pre-wrap">${msg}</pre>`;
  }
}

void boot();
