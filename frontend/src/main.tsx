import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/global.css";
import "./styles/react-json-view-lite.css";
import "./styles/subwindow.css";
import "./styles/modules/terminal.css";
import "./styles/modules/database.css";
import "./styles/modules/docker.css";
import "./styles/modules/files.css";
import "./styles/modules/knowledge.css";
import "./styles/modules/tags.css";
import "./styles/modules/protocol.css";
import "./styles/modules/server.css";
import "./styles/modules/monitoring.css";
import "./styles/modules/home-monitor.css";
import "./styles/modules/workflow.css";
import { initDesktopShell } from "./lib/desktopShell";
import { initProductionDiagnostics } from "./lib/productionDiagnostics";
import { Bootstrap } from "./Bootstrap";
import { WorkspaceWindowRoot } from "./WorkspaceWindowRoot";
import { parseWorkspaceWindowParams, workspaceWindowDebugLog } from "./lib/workspaceWindow";
import { dismissHtmlBootSplash } from "./lib/dismissBootSplash";
import { isTauriRuntime } from "./lib/isTauriRuntime";

initProductionDiagnostics();
initDesktopShell();

// JS 已执行则立即移除 HTML 占位，避免模块加载失败时永远卡在 boot-splash
dismissHtmlBootSplash();

const workspaceWindow = parseWorkspaceWindowParams();

// 主窗由 Rust 隐藏创建并摆位；首屏 JS 就绪后再 show，避免白框闪主屏。
// 几何勿在此 restore，防止二次改尺寸。
if (!workspaceWindow && isTauriRuntime()) {
  void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
    const win = getCurrentWindow();
    void win.show().then(() => win.setFocus()).catch(() => undefined);
  });
}

void workspaceWindowDebugLog(
  `main.tsx boot role=${workspaceWindow ? "workspace-window" : "main"} ` +
    `ws=${workspaceWindow?.workspaceId ?? "-"} href=${location.href}`,
);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {workspaceWindow ? (
      <WorkspaceWindowRoot workspaceId={workspaceWindow.workspaceId} />
    ) : (
      <Bootstrap />
    )}
  </StrictMode>,
);
