import type { Diagnostic } from "@codemirror/lint";
import type { EditorView } from "@codemirror/view";
import { t } from "../../../../i18n";
import { showToast } from "../../../../stores/toastStore";

async function writeDiagnosticText(text: string): Promise<boolean> {
  const clip = navigator.clipboard;
  if (clip && typeof clip.writeText === "function") {
    try {
      await clip.writeText(text);
      return true;
    } catch {
      // fallback below
    }
  }

  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  return ok;
}

function createCopyIcon(): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.6");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("aria-hidden", "true");

  const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  rect.setAttribute("x", "5");
  rect.setAttribute("y", "5");
  rect.setAttribute("width", "9");
  rect.setAttribute("height", "9");
  rect.setAttribute("rx", "1.5");

  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M3 11V3.5A1.5 1.5 0 0 1 4.5 2H11");

  svg.appendChild(rect);
  svg.appendChild(path);
  return svg;
}

function renderCopyableDiagnosticMessage(message: string) {
  return (_view: EditorView): Node => {
    const wrap = document.createElement("div");
    wrap.className = "db-sql-lint-diagnostic-message";

    const textEl = document.createElement("span");
    textEl.className = "db-sql-lint-diagnostic-message__text";
    textEl.textContent = message;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "db-sql-lint-diagnostic-message__copy btn-icon";
    button.title = t("common.copy");
    button.setAttribute("aria-label", t("common.copy"));
    button.appendChild(createCopyIcon());

    button.addEventListener("mousedown", (event) => {
      event.stopPropagation();
    });
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void writeDiagnosticText(message).then((ok) => {
        if (ok) {
          showToast(t("common.copied"));
        }
      });
    });

    wrap.appendChild(textEl);
    wrap.appendChild(button);
    return wrap;
  };
}

/** 为 Lint 诊断提示增加可复制 UI（波浪线 / gutter 悬停共用）。 */
export function withCopyableDiagnosticMessage(diagnostic: Diagnostic): Diagnostic {
  if (diagnostic.renderMessage) {
    return diagnostic;
  }
  return {
    ...diagnostic,
    renderMessage: renderCopyableDiagnosticMessage(diagnostic.message),
  };
}
