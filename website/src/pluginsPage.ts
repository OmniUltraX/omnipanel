import "./styles/main.css";
import { getLocale, t } from "./i18n";
import { setupSiteChrome, siteUrl } from "./site";

setupSiteChrome();
void setupPluginMarketplace();

type PluginArtifact = {
  url?: string;
  sha256?: string;
  size?: number;
};

type PluginVersion = {
  version: string;
  artifact?: PluginArtifact;
};

type RegistryPlugin = {
  id: string;
  kind: string;
  name: string;
  description?: string;
  version?: string;
  versions?: PluginVersion[];
  artifact?: PluginArtifact;
  permissions?: string[];
  distribution?: string;
};

type Registry = {
  schemaVersion?: number;
  plugins: RegistryPlugin[];
};

const KIND_ORDER = [
  "cloud",
  "engine",
  "panel",
  "module",
  "addon",
  "theme",
  "importer",
  "knowledge",
] as const;

function resolveVersion(plugin: RegistryPlugin): string {
  if (plugin.version) return plugin.version;
  const last = plugin.versions?.[plugin.versions.length - 1];
  return last?.version ?? "—";
}

function resolveArtifact(plugin: RegistryPlugin): PluginArtifact | undefined {
  if (plugin.artifact?.url) return plugin.artifact;
  const last = plugin.versions?.[plugin.versions.length - 1];
  return last?.artifact;
}

function formatSize(bytes?: number): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function kindLabel(kind: string): string {
  const key = `plugins.kind.${kind}`;
  const label = t(key);
  return label === key ? kind : label;
}

async function loadRegistry(): Promise<Registry> {
  const url = siteUrl("plugins/registry.json");
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as Registry;
  if (!Array.isArray(data.plugins)) throw new Error("invalid registry");
  return data;
}

function renderFilters(kinds: string[], active: string, root: HTMLElement) {
  root.innerHTML = "";
  const allBtn = document.createElement("button");
  allBtn.type = "button";
  allBtn.className = `plugin-filter${active === "all" ? " is-active" : ""}`;
  allBtn.dataset.kind = "all";
  allBtn.textContent = t("plugins.filterAll");
  root.appendChild(allBtn);

  for (const kind of kinds) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `plugin-filter${active === kind ? " is-active" : ""}`;
    btn.dataset.kind = kind;
    btn.textContent = kindLabel(kind);
    root.appendChild(btn);
  }
}

function renderCards(plugins: RegistryPlugin[], grid: HTMLElement) {
  grid.innerHTML = "";
  if (plugins.length === 0) {
    const empty = document.createElement("p");
    empty.className = "plugin-empty muted";
    empty.textContent = t("plugins.empty");
    grid.appendChild(empty);
    return;
  }

  for (const plugin of plugins) {
    const artifact = resolveArtifact(plugin);
    const card = document.createElement("article");
    card.className = "plugin-card";
    card.dataset.reveal = "";

    const head = document.createElement("div");
    head.className = "plugin-card-head";
    const kind = document.createElement("span");
    kind.className = "tag plugin-kind";
    kind.textContent = kindLabel(plugin.kind);
    const ver = document.createElement("span");
    ver.className = "plugin-version muted";
    ver.textContent = `${t("plugins.version")} ${resolveVersion(plugin)}`;
    head.append(kind, ver);

    const title = document.createElement("h3");
    title.className = "plugin-card-title";
    title.textContent = plugin.name;

    const id = document.createElement("p");
    id.className = "plugin-id";
    id.textContent = plugin.id;

    const desc = document.createElement("p");
    desc.className = "plugin-desc";
    desc.textContent = plugin.description?.trim() || "—";

    const perms = document.createElement("div");
    perms.className = "tag-list";
    const list = plugin.permissions ?? [];
    if (list.length) {
      for (const perm of list.slice(0, 6)) {
        const tag = document.createElement("span");
        tag.className = "tag";
        tag.textContent = perm;
        perms.appendChild(tag);
      }
      if (list.length > 6) {
        const more = document.createElement("span");
        more.className = "tag";
        more.textContent = `+${list.length - 6}`;
        perms.appendChild(more);
      }
    }

    const actions = document.createElement("div");
    actions.className = "plugin-card-actions";
    if (artifact?.url) {
      const a = document.createElement("a");
      a.className = "btn btn-secondary";
      a.href = artifact.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      const size = formatSize(artifact.size);
      a.textContent = size ? `${t("plugins.download")} · ${size}` : t("plugins.download");
      actions.appendChild(a);
    } else {
      const note = document.createElement("span");
      note.className = "muted plugin-bundled";
      note.textContent = t("plugins.bundled");
      actions.appendChild(note);
    }

    card.append(head, title, id, desc, perms, actions);
    grid.appendChild(card);
  }

  // 新插入的 reveal 节点立即可见（市场筛选会反复重绘）
  grid.querySelectorAll<HTMLElement>("[data-reveal]").forEach((el) => {
    el.classList.add("is-visible");
  });
}

async function setupPluginMarketplace() {
  const status = document.querySelector<HTMLElement>("[data-plugin-status]");
  const countEl = document.querySelector<HTMLElement>("[data-plugin-count]");
  const filtersEl = document.querySelector<HTMLElement>("[data-plugin-filters]");
  const grid = document.querySelector<HTMLElement>("[data-plugin-grid]");
  const search = document.querySelector<HTMLInputElement>("[data-plugin-search]");
  if (!status || !filtersEl || !grid) return;

  status.textContent = t("plugins.loading");
  status.hidden = false;

  let plugins: RegistryPlugin[] = [];
  let kindFilter = "all";
  let query = "";

  const apply = () => {
    const q = query.trim().toLowerCase();
    const filtered = plugins.filter((p) => {
      if (kindFilter !== "all" && p.kind !== kindFilter) return false;
      if (!q) return true;
      const hay = `${p.name} ${p.id} ${p.description ?? ""} ${p.kind}`.toLowerCase();
      return hay.includes(q);
    });
    if (countEl) countEl.textContent = t("plugins.count", { n: filtered.length });
    renderCards(filtered, grid);
  };

  const paintChrome = () => {
    const kinds = KIND_ORDER.filter((k) => plugins.some((p) => p.kind === k));
    const extra = [...new Set(plugins.map((p) => p.kind))]
      .filter((k) => !KIND_ORDER.includes(k as (typeof KIND_ORDER)[number]))
      .sort();
    renderFilters([...kinds, ...extra], kindFilter, filtersEl);
    if (search) search.placeholder = t("plugins.searchPlaceholder");
    apply();
  };

  try {
    const registry = await loadRegistry();
    plugins = [...registry.plugins].sort((a, b) => {
      const ka = KIND_ORDER.indexOf(a.kind as (typeof KIND_ORDER)[number]);
      const kb = KIND_ORDER.indexOf(b.kind as (typeof KIND_ORDER)[number]);
      const oa = ka === -1 ? 99 : ka;
      const ob = kb === -1 ? 99 : kb;
      if (oa !== ob) return oa - ob;
      return a.name.localeCompare(b.name, getLocale() === "zh" ? "zh" : "en");
    });
    status.hidden = true;
    paintChrome();
  } catch {
    status.hidden = false;
    status.textContent = t("plugins.error");
    if (countEl) countEl.textContent = t("plugins.count", { n: 0 });
  }

  filtersEl.addEventListener("click", (event) => {
    const btn = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-kind]");
    if (!btn?.dataset.kind) return;
    kindFilter = btn.dataset.kind;
    paintChrome();
  });

  search?.addEventListener("input", () => {
    query = search.value;
    apply();
  });

  document.addEventListener("omnipanel:locale", () => {
    status.textContent = status.hidden ? status.textContent : t("plugins.error");
    paintChrome();
  });
}
