import { t } from "./i18n";
import {
  buildDownloadItems,
  detectOsFamily,
  fetchJsonFirst,
  formatPubDate,
  latestJsonCandidates,
  resolveVersionList,
  versionsJsonCandidates,
  type UpdaterManifest,
  type VersionEntry,
  type VersionsIndex,
} from "./releases";

let latestRoot: HTMLElement | null = null;
let historyRoot: HTMLElement | null = null;
let statusRoot: HTMLElement | null = null;

let cachedHead: VersionEntry | null = null;
let cachedVersions: VersionEntry[] = [];
let statusKind: "info" | "error" = "info";
let statusKey = "";
let statusVars: Record<string, string | number> | undefined;
let localeBound = false;

function setStatus(key: string, kind: "info" | "error" = "info", vars?: Record<string, string | number>) {
  statusKey = key;
  statusKind = kind;
  statusVars = vars;
  if (!statusRoot) return;
  statusRoot.hidden = !key;
  statusRoot.textContent = key ? t(key, vars) : "";
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
  if (!notes?.trim()) return `<p class="muted">${escapeHtml(t("dl.noNotes"))}</p>`;
  const safe = escapeHtml(notes.trim())
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\n/g, "<br />");
  return `<div class="release-notes">${safe}</div>`;
}

function renderDownloadButtons(entry: VersionEntry, compact = false): string {
  const items = buildDownloadItems(entry.platforms, detectOsFamily());
  if (!items.length) {
    return `<p class="muted">${escapeHtml(t("dl.noAssets"))}</p>`;
  }

  return `<div class="dl-grid${compact ? " dl-grid--compact" : ""}">
    ${items
      .map(
        (item) => `
      <a class="dl-card${item.preferred && !compact ? " is-preferred" : ""}" href="${escapeHtml(item.url)}" download>
        <div class="dl-card-top">
          <span class="dl-card-label">${escapeHtml(item.label)}</span>
          ${item.preferred && !compact ? `<span class="dl-badge">${escapeHtml(t("dl.recommended"))}</span>` : ""}
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
    <p class="lead">
      ${escapeHtml(t("dl.lead"))}
      <span class="accent-text">${escapeHtml(entry.tag)}</span>
      · ${escapeHtml(t("dl.published"))} ${escapeHtml(formatPubDate(entry.pub_date))}
    </p>
    ${renderDownloadButtons(entry)}
    <div class="release-panel">
      <h3 class="h3">${escapeHtml(t("dl.notes"))}</h3>
      ${renderNotes(entry.notes)}
    </div>
  `;
}

function renderHistory(versions: VersionEntry[], latestVersion: string) {
  if (!historyRoot) return;

  const others = versions.filter(
    (v) => v.version.replace(/^v/, "") !== latestVersion.replace(/^v/, ""),
  );
  if (!others.length) {
    historyRoot.innerHTML = `
      <p class="eyebrow">Previous Releases</p>
      <h3 class="h3">${escapeHtml(t("dl.historyTitle"))}</h3>
      <p class="muted">${escapeHtml(t("dl.historyEmpty"))}</p>
    `;
    return;
  }

  historyRoot.innerHTML = `
    <p class="eyebrow">Previous Releases</p>
    <h3 class="h3">${escapeHtml(t("dl.historyTitle"))}</h3>
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
}

function rerender() {
  if (statusKey) setStatus(statusKey, statusKind, statusVars);
  if (cachedHead) {
    renderLatest(cachedHead);
    renderHistory(cachedVersions, cachedHead.version);
  }
}

async function boot() {
  setStatus("dl.statusLoading");

  const [latest, index] = await Promise.all([
    fetchJsonFirst<UpdaterManifest>(latestJsonCandidates()),
    fetchJsonFirst<VersionsIndex>(versionsJsonCandidates()),
  ]);

  if (!latest && !index) {
    setStatus("dl.statusError", "error");
    return;
  }

  const versions = resolveVersionList(latest, index);
  const head = latest
    ? {
        tag: `v${latest.version.replace(/^v/, "")}`,
        version: latest.version.replace(/^v/, ""),
        notes: latest.notes,
        pub_date: latest.pub_date,
        platforms: latest.platforms ?? {},
      }
    : versions[0];

  if (!head) {
    setStatus("dl.statusEmpty", "error");
    return;
  }

  cachedHead = head;
  cachedVersions = versions;
  renderLatest(head);
  renderHistory(versions, head.version);

  const versionLabel = document.querySelector("[data-download-version]");
  if (versionLabel) versionLabel.textContent = head.version;

  if (index?.versions?.length) {
    setStatus("dl.statusVersions", "info", { n: versions.length });
  } else {
    setStatus("dl.statusLatestOnly");
  }
}

/** 首页 #download 区块：拉取 OSS 清单并渲染安装包 */
export function setupDownloadSection() {
  latestRoot = document.querySelector<HTMLElement>("[data-latest]");
  historyRoot = document.querySelector<HTMLElement>("[data-history]");
  statusRoot = document.querySelector<HTMLElement>("[data-status]");
  if (!latestRoot) return;

  if (!localeBound) {
    localeBound = true;
    document.addEventListener("omnipanel:locale", () => rerender());
  }

  void boot();
}
