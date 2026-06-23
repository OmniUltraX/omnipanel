import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/global.css";
import "./styles/subwindow.css";
import "./styles/modules/terminal.css";
import "./styles/modules/database.css";
import "./styles/modules/docker.css";
import "./styles/modules/files.css";
import "./styles/modules/knowledge.css";
import "./styles/modules/protocol.css";
import "./styles/modules/server.css";
import "./styles/modules/workflow.css";
import { initProductionDiagnostics } from "./lib/productionDiagnostics";
import { installMonacoCancellationHandlers } from "./lib/monacoCancellation";
import { Bootstrap } from "./Bootstrap";

installMonacoCancellationHandlers();
initProductionDiagnostics();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Bootstrap />
  </StrictMode>,
);
