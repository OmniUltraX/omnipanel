import { save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { commands } from "../../ipc/bindings";
import { unwrapCommand } from "../../ipc/result";

/** 生成安全文件名（去掉路径非法字符）。 */
export function sanitizeKnowledgeFilename(title: string, fallback = "document"): string {
  const trimmed = title.trim() || fallback;
  return trimmed
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .slice(0, 120);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * 轻量 Markdown → HTML（导出 PDF 用）。
 * 覆盖知识库常见块：标题、段落、列表、代码、引用、表格、粗斜体、链接。
 */
export function knowledgeMarkdownToHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const html: string[] = [];
  let i = 0;
  let inCode = false;
  let codeLang = "";
  let codeBuf: string[] = [];
  let inUl = false;
  let inOl = false;
  let inBq = false;
  let tableRows: string[][] = [];

  const closeLists = () => {
    if (inUl) {
      html.push("</ul>");
      inUl = false;
    }
    if (inOl) {
      html.push("</ol>");
      inOl = false;
    }
  };

  const closeBq = () => {
    if (inBq) {
      html.push("</blockquote>");
      inBq = false;
    }
  };

  const flushTable = () => {
    if (tableRows.length === 0) return;
    const [header, ...body] = tableRows;
    const isSep = (row: string[]) => row.every((cell) => /^:?-+:?$/.test(cell.trim()));
    const rows = body.filter((row) => !isSep(row));
    html.push('<div class="kb-export-table-wrap"><table>');
    if (header) {
      html.push(
        `<thead><tr>${header.map((c) => `<th>${inlineMd(c.trim())}</th>`).join("")}</tr></thead>`,
      );
    }
    if (rows.length > 0) {
      html.push("<tbody>");
      for (const row of rows) {
        html.push(`<tr>${row.map((c) => `<td>${inlineMd(c.trim())}</td>`).join("")}</tr>`);
      }
      html.push("</tbody>");
    }
    html.push("</table></div>");
    tableRows = [];
  };

  const inlineMd = (text: string): string => {
    let out = escapeHtml(text);
    out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
    out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, "$1<em>$2</em>");
    out = out.replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      '<a href="$2" target="_blank" rel="noreferrer">$1</a>',
    );
    return out;
  };

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith("```")) {
      flushTable();
      closeLists();
      closeBq();
      if (!inCode) {
        inCode = true;
        codeLang = line.slice(3).trim();
        codeBuf = [];
      } else {
        html.push(
          `<pre class="kb-export-code"${codeLang ? ` data-lang="${escapeHtml(codeLang)}"` : ""}><code>${escapeHtml(codeBuf.join("\n"))}</code></pre>`,
        );
        inCode = false;
        codeLang = "";
        codeBuf = [];
      }
      i += 1;
      continue;
    }

    if (inCode) {
      codeBuf.push(line);
      i += 1;
      continue;
    }

    if (/^\s*\|/.test(line) && line.includes("|")) {
      closeLists();
      closeBq();
      const cells = line
        .replace(/^\s*\|/, "")
        .replace(/\|\s*$/, "")
        .split("|");
      tableRows.push(cells);
      i += 1;
      continue;
    }
    if (tableRows.length > 0) {
      flushTable();
    }

    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      closeLists();
      closeBq();
      const level = heading[1].length;
      html.push(`<h${level}>${inlineMd(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }

    if (/^---+$/.test(line.trim()) || /^\*\*\*+$/.test(line.trim())) {
      closeLists();
      closeBq();
      html.push("<hr />");
      i += 1;
      continue;
    }

    if (/^>\s?/.test(line)) {
      closeLists();
      if (!inBq) {
        html.push("<blockquote>");
        inBq = true;
      }
      html.push(`<p>${inlineMd(line.replace(/^>\s?/, ""))}</p>`);
      i += 1;
      continue;
    }
    closeBq();

    const ul = /^[-*+]\s+(.+)$/.exec(line);
    if (ul) {
      if (inOl) {
        html.push("</ol>");
        inOl = false;
      }
      if (!inUl) {
        html.push("<ul>");
        inUl = true;
      }
      html.push(`<li>${inlineMd(ul[1])}</li>`);
      i += 1;
      continue;
    }

    const ol = /^\d+\.\s+(.+)$/.exec(line);
    if (ol) {
      if (inUl) {
        html.push("</ul>");
        inUl = false;
      }
      if (!inOl) {
        html.push("<ol>");
        inOl = true;
      }
      html.push(`<li>${inlineMd(ol[1])}</li>`);
      i += 1;
      continue;
    }

    closeLists();

    if (line.trim() === "") {
      i += 1;
      continue;
    }

    html.push(`<p>${inlineMd(line)}</p>`);
    i += 1;
  }

  if (inCode) {
    html.push(`<pre class="kb-export-code"><code>${escapeHtml(codeBuf.join("\n"))}</code></pre>`);
  }
  flushTable();
  closeLists();
  closeBq();

  return html.join("\n");
}

function buildPrintDocument(title: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
  <style>
    @page { margin: 18mm 16mm; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: #1a1a1a;
      font: 14px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
        "Microsoft YaHei", sans-serif;
      background: #fff;
    }
    .kb-export {
      max-width: 860px;
      margin: 0 auto;
      padding: 8px 4px 24px;
    }
    h1.doc-title {
      margin: 0 0 8px;
      font-size: 24px;
      font-weight: 700;
      line-height: 1.3;
      border-bottom: 1px solid #e5e7eb;
      padding-bottom: 12px;
    }
    .doc-meta {
      margin: 0 0 20px;
      font-size: 12px;
      color: #6b7280;
    }
    h1, h2, h3, h4, h5, h6 {
      margin: 1.4em 0 0.5em;
      line-height: 1.35;
      page-break-after: avoid;
    }
    h1 { font-size: 22px; }
    h2 { font-size: 18px; }
    h3 { font-size: 16px; }
    p { margin: 0 0 0.75em; }
    ul, ol { margin: 0 0 0.85em; padding-left: 1.4em; }
    li { margin: 0.2em 0; }
    blockquote {
      margin: 0 0 0.85em;
      padding: 6px 12px;
      border-left: 3px solid #94a3b8;
      color: #475569;
      background: #f8fafc;
    }
    code {
      font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
      font-size: 0.92em;
      background: #f1f5f9;
      padding: 1px 5px;
      border-radius: 4px;
    }
    pre.kb-export-code {
      margin: 0 0 1em;
      padding: 12px 14px;
      background: #0f172a;
      color: #e2e8f0;
      border-radius: 8px;
      overflow: auto;
      font-size: 12px;
      line-height: 1.5;
      page-break-inside: avoid;
    }
    pre.kb-export-code code {
      background: transparent;
      padding: 0;
      color: inherit;
    }
    hr {
      border: none;
      border-top: 1px solid #e5e7eb;
      margin: 1.2em 0;
    }
    a { color: #2563eb; text-decoration: none; }
    .kb-export-table-wrap {
      width: 100%;
      overflow-x: auto;
      margin: 0 0 1em;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    table {
      border-collapse: collapse;
      width: max-content;
      min-width: 100%;
      font-size: 12px;
    }
    th, td {
      border: 1px solid #cbd5e1;
      padding: 6px 10px;
      text-align: left;
      vertical-align: top;
      white-space: nowrap;
      max-width: 280px;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    th {
      background: #f1f5f9;
      font-weight: 600;
    }
    @media print {
      th, td { white-space: normal; max-width: none; word-break: break-word; }
      table { width: 100%; }
    }
  </style>
</head>
<body>
  <article class="kb-export">
    <h1 class="doc-title">${escapeHtml(title)}</h1>
    <p class="doc-meta">Exported from OmniPanel · ${new Date().toLocaleString()}</p>
    ${bodyHtml}
  </article>
</body>
</html>`;
}

/** 导出 Markdown 到用户选择的路径。取消选择时返回 null。 */
export async function exportKnowledgeMarkdown(
  title: string,
  content: string,
  options?: { dialogTitle?: string },
): Promise<string | null> {
  const filename = `${sanitizeKnowledgeFilename(title)}.md`;
  const path = await saveFileDialog({
    title: options?.dialogTitle ?? "Export Markdown",
    defaultPath: filename,
    filters: [{ name: "Markdown", extensions: ["md"] }],
  });
  if (typeof path !== "string" || !path) return null;
  await unwrapCommand(commands.writeTextFile(path, content ?? ""));
  return path;
}

/**
 * 导出 PDF：渲染打印页并调起系统打印对话框（可选「另存为 PDF」）。
 * 返回 true 表示已调起打印；取消选择打印仍可能为 true（由系统对话框决定）。
 */
export async function exportKnowledgePdf(title: string, markdown: string): Promise<boolean> {
  const bodyHtml = knowledgeMarkdownToHtml(markdown || "");
  const doc = buildPrintDocument(title, bodyHtml);
  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.cssText =
    "position:fixed;right:0;bottom:0;width:0;height:0;border:0;opacity:0;pointer-events:none;";
  document.body.appendChild(iframe);

  const frameDoc = iframe.contentDocument;
  const frameWin = iframe.contentWindow;
  if (!frameDoc || !frameWin) {
    iframe.remove();
    throw new Error("无法创建打印预览");
  }

  frameDoc.open();
  frameDoc.write(doc);
  frameDoc.close();

  await new Promise<void>((resolve) => {
    const done = () => resolve();
    iframe.onload = () => done();
    // 部分 WebView 对 srcdoc/write 不触发 onload
    window.setTimeout(done, 120);
  });

  try {
    frameWin.focus();
    frameWin.print();
    return true;
  } finally {
    window.setTimeout(() => iframe.remove(), 1000);
  }
}

/** 统计 Markdown 大致字数（去掉代码围栏后按字符计）。 */
export function countKnowledgeChars(markdown: string): number {
  const withoutCode = markdown.replace(/```[\s\S]*?```/g, " ");
  return withoutCode.replace(/\s+/g, "").length;
}
