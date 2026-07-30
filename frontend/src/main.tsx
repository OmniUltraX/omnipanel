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
import { QuickLauncherRoot } from "./components/shell/QuickLauncherRoot";
import { parseWorkspaceWindowParams, workspaceWindowDebugLog } from "./lib/workspaceWindow";
import { isQuickLauncherWindow } from "./lib/quickLauncher";
import { dismissHtmlBootSplash } from "./lib/dismissBootSplash";

initProductionDiagnostics();
initDesktopShell();

dismissHtmlBootSplash();

const quickLauncher = isQuickLauncherWindow();
const workspaceWindow = quickLauncher ? null : parseWorkspaceWindowParams();

void workspaceWindowDebugLog(
  `main.tsx boot role=${
    quickLauncher ? "quick-launcher" : workspaceWindow ? "workspace-window" : "main"
  } ws=${workspaceWindow?.workspaceId ?? "-"} href=${location.href}`,
);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {quickLauncher ? (
      <QuickLauncherRoot />
    ) : workspaceWindow ? (
      <WorkspaceWindowRoot workspaceId={workspaceWindow.workspaceId} />
    ) : (
      <Bootstrap />
    )}
  </StrictMode>,
);
