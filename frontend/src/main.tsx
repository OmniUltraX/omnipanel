import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/global.css";
import { initProductionDiagnostics } from "./lib/productionDiagnostics";
import { Bootstrap } from "./Bootstrap";

initProductionDiagnostics();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Bootstrap />
  </StrictMode>,
);
