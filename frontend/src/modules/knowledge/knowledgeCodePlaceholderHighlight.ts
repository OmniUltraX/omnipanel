import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

let registered = false;

function ensureHljs() {
  if (registered) return;
  registered = true;
  hljs.registerLanguage("bash", bash);
  hljs.registerLanguage("shell", bash);
  hljs.registerLanguage("sh", bash);
  hljs.registerLanguage("css", css);
  hljs.registerLanguage("dockerfile", dockerfile);
  hljs.registerLanguage("docker", dockerfile);
  hljs.registerLanguage("go", go);
  hljs.registerLanguage("java", java);
  hljs.registerLanguage("javascript", javascript);
  hljs.registerLanguage("js", javascript);
  hljs.registerLanguage("json", json);
  hljs.registerLanguage("markdown", markdown);
  hljs.registerLanguage("md", markdown);
  hljs.registerLanguage("python", python);
  hljs.registerLanguage("py", python);
  hljs.registerLanguage("rust", rust);
  hljs.registerLanguage("sql", sql);
  hljs.registerLanguage("typescript", typescript);
  hljs.registerLanguage("ts", typescript);
  hljs.registerLanguage("tsx", typescript);
  hljs.registerLanguage("xml", xml);
  hljs.registerLanguage("html", xml);
  hljs.registerLanguage("yaml", yaml);
  hljs.registerLanguage("yml", yaml);
}

function normalizeLang(raw: string): string {
  const lang = raw.trim().toLowerCase();
  if (!lang) return "";
  if (lang === "shellscript" || lang === "zsh" || lang === "powershell" || lang === "ps1") {
    return "bash";
  }
  return lang;
}

/** 给尚未挂上 CodeMirror 的占位代码块上色（轻量，可一屏多块）。 */
export function paintKnowledgeCodePlaceholders(root: ParentNode): void {
  ensureHljs();
  const nodes = root.querySelectorAll<HTMLElement>(
    ".milkdown-code-block-placeholder code:not([data-omni-hl])",
  );
  for (const code of nodes) {
    const pre = code.parentElement;
    const lang = normalizeLang(pre?.dataset.language ?? "");
    const source = code.textContent ?? "";
    try {
      if (lang && hljs.getLanguage(lang)) {
        code.innerHTML = hljs.highlight(source, { language: lang, ignoreIllegals: true }).value;
      } else {
        code.innerHTML = hljs.highlightAuto(source).value;
      }
      code.dataset.omniHl = "1";
    } catch {
      // 高亮失败保留纯文本
      code.dataset.omniHl = "0";
    }
  }
}

/** 监听编辑器 DOM，占位块出现时立即上色。 */
export function bindKnowledgeCodePlaceholderHighlight(root: HTMLElement): () => void {
  paintKnowledgeCodePlaceholders(root);

  const onCustom = () => {
    paintKnowledgeCodePlaceholders(root);
  };
  root.addEventListener("omni-knowledge-code-placeholder", onCustom);

  const observer = new MutationObserver(() => {
    paintKnowledgeCodePlaceholders(root);
  });
  observer.observe(root, { childList: true, subtree: true });

  return () => {
    root.removeEventListener("omni-knowledge-code-placeholder", onCustom);
    observer.disconnect();
  };
}
