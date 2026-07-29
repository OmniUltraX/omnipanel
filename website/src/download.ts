import "./styles/main.css";
import { setupSiteChrome } from "./site";
import {
  LATEST_JSON_URL,
  VERSIONS_JSON_URL,
  buildDownloadItems,
  detectOsFamily,
  fetchJson,
  formatPubDate,
  resolveVersionList,
  type UpdaterManifest,
  type VersionEntry,
  type VersionsIndex,
} from "./releases";

setupSiteChrome();

const latestRoot = document.querySelector<HTMLElement>("[data-latest]");
const historyRoot = document.querySelector<HTMLElement>("[data-history]");
const statusRoot = document.querySelector<HTMLElement>("[data-status]");

function setStatus(message: string, kind: "info" | "error" = "info") {
  if (!statusRoot) return;
  statusRoot.hidden = !message;
  statusRoot.textContent = message;
  statusRoot.dataset.kind = kind;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderNotes(notes?: string): string {
  if (!notes?.trim()) return "<p class=\"muted\">暂无更新说明。</p>";
  // notes 来自受控发版清单；转义后做极简 markdown 粗体 / 换行
  const safe = escapeHtml(notes.trim())
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\n/g, "<br />");
  return `<div class="release-notes">${safe}</div>`;
}

function renderDownloadButtons(entry: VersionEntry, compact = false): string {
  const items = buildDownloadItems(entry.platforms, detectOsFamily());
  if (!items.length) {
    return `<p class="muted">该版本暂无可用安装包。</p>`;
  }

  return `<div class="dl-grid${compact ? " dl-grid--compact" : ""}">
    ${items
      .map(
        (item) => `
      <a class="dl-card${item.preferred && !compact ? " is-preferred" : ""}" href="${escapeHtml(item.url)}" download>
        <div class="dl-card-top">
          <span class="dl-card-label">${escapeHtml(item.label)}</span>
          ${item.preferred && !compact ? `<span class="dl-badge">推荐</span>` : ""}
        </div>
        <div class="dl-card-hint">${escapeHtml(item.hint)}</div>
        <div class="dl-card-file">${escapeHtml(item.filename)}</div>
      </a>`,
      )
      .join("")}
  </div>`;
}

function renderLatest(entry: VersionEntry) {
  if (!latestRoot) return;
  latestRoot.innerHTML = `
    <p class="eyebrow">Latest Release</p>
    <h1 class="h1">下载 OmniPanel ${escapeHtml(entry.version)}</h1>
    <p class="lead">
      安装包托管于阿里云 OSS，点击即下。当前通道：
      <span class="accent-text">${escapeHtml(entry.tag)}</span>
      · 发布于 ${escapeHtml(formatPubDate(entry.pub_date))}
    </p>
    ${renderDownloadButtons(entry)}
    <div class="release-panel">
      <h2 class="h3">更新说明</h2>
      ${renderNotes(entry.notes)}
    </div>
  `;
  latestRoot.classList.add("is-visible");
}

function renderHistory(versions: VersionEntry[], latestVersion: string) {
  if (!historyRoot) return;

  const others = versions.filter((v) => v.version.replace(/^v/, "") !== latestVersion.replace(/^v/, ""));
  if (!others.length) {
    historyRoot.innerHTML = `
      <p class="eyebrow">Previous Releases</p>
      <h2 class="h2">历史版本</h2>
      <p class="muted">暂无更多版本。发版后会写入 versions.json 并在此列出。</p>
    `;
    historyRoot.classList.add("is-visible");
    return;
  }

  historyRoot.innerHTML = `
    <p class="eyebrow">Previous Releases</p>
    <h2 class="h2">历史版本</h2>
    <div class="version-list">
      ${others
        .map(
          (entry) => `
        <details class="version-item">
          <summary>
            <span class="version-tag">${escapeHtml(entry.tag)}</span>
            <span class="version-date">${escapeHtml(formatPubDate(entry.pub_date))}</span>
          </summary>
          <div class="version-body">
            ${renderDownloadButtons(entry, true)}
            ${entry.notes ? `<div class="version-notes">${renderNotes(entry.notes)}</div>` : ""}
          </div>
        </details>`,
        )
        .join("")}
    </div>
  `;
  historyRoot.classList.add("is-visible");
}

async function boot() {
  setStatus("正在从 OSS 读取版本清单…");

  const [latest, index] = await Promise.all([
    fetchJson<UpdaterManifest>(LATEST_JSON_URL),
    fetchJson<VersionsIndex>(VERSIONS_JSON_URL),
  ]);

  if (!latest && !index) {
    setStatus("无法读取 OSS 版本清单，请稍后重试或前往 GitHub Releases。", "error");
    return;
  }

  const versions = resolveVersionList(latest, index);
  const head = latest ? {
    tag: `v${latest.version.replace(/^v/, "")}`,
    version: latest.version.replace(/^v/, ""),
    notes: latest.notes,
    pub_date: latest.pub_date,
    platforms: latest.platforms ?? {},
  } : versions[0];

  if (!head) {
    setStatus("版本清单为空。", "error");
    return;
  }

  renderLatest(head);
  renderHistory(versions, head.version);

  const source = index?.versions?.length
    ? `已加载 ${versions.length} 个版本（versions.json）`
    : "已加载最新版（versions.json 尚未就绪，仅显示 latest.json）";
  setStatus(source);
}

boot();
