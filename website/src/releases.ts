/** OSS 发版清单（与 scripts/publish-updater-to-aliyun-oss.mjs 约定一致） */

import { t } from "./i18n";

export const OSS_RELEASES_BASE =
  "https://omnipanel.oss-cn-beijing.aliyuncs.com/omnipanel/releases";

export const LATEST_JSON_URL = `${OSS_RELEASES_BASE}/latest.json`;
export const VERSIONS_JSON_URL = `${OSS_RELEASES_BASE}/versions.json`;

/** 同域镜像（构建时 sync-releases 写入），规避 OSS 未配 CORS 时浏览器拦截 */
function siteReleaseUrl(name: string): string {
  const base = import.meta.env.BASE_URL || "/";
  const prefix = base.endsWith("/") ? base : `${base}/`;
  return `${prefix}releases/${name}`;
}

export function latestJsonCandidates(): string[] {
  return [LATEST_JSON_URL, siteReleaseUrl("latest.json")];
}

export function versionsJsonCandidates(): string[] {
  return [VERSIONS_JSON_URL, siteReleaseUrl("versions.json")];
}

export type PlatformAsset = {
  url: string;
  signature?: string;
};

export type UpdaterManifest = {
  version: string;
  notes?: string;
  pub_date?: string;
  platforms: Record<string, PlatformAsset>;
};

export type VersionEntry = {
  tag: string;
  version: string;
  notes?: string;
  pub_date?: string;
  platforms: Record<string, PlatformAsset>;
};

export type VersionsIndex = {
  updatedAt?: string;
  versions: VersionEntry[];
};

export type DownloadItem = {
  id: string;
  label: string;
  hint: string;
  url: string;
  filename: string;
  preferred: boolean;
};

const PLATFORM_META: Record<string, { labelKey: string; hintKey: string; order: number }> = {
  "windows-x86_64-nsis": { labelKey: "plat.win", hintKey: "plat.winHint", order: 10 },
  "windows-x86_64": { labelKey: "plat.win", hintKey: "plat.winHintAlt", order: 11 },
  "windows-x86_64-msi": { labelKey: "plat.msi", hintKey: "plat.msiHint", order: 20 },
  "darwin-aarch64": { labelKey: "plat.mac", hintKey: "plat.macArm", order: 30 },
  "darwin-aarch64-app": { labelKey: "plat.mac", hintKey: "plat.macArmApp", order: 31 },
  "darwin-x86_64": { labelKey: "plat.mac", hintKey: "plat.macIntel", order: 40 },
  "darwin-x86_64-app": { labelKey: "plat.mac", hintKey: "plat.macIntelApp", order: 41 },
  "linux-x86_64": { labelKey: "plat.linux", hintKey: "plat.linuxX64", order: 50 },
  "linux-aarch64": { labelKey: "plat.linux", hintKey: "plat.linuxArm", order: 60 },
};

/** 同一文件只展示一次；优先保留更具体的 platform key */
const SKIP_IF_SAME_URL_AS: Record<string, string> = {
  "windows-x86_64": "windows-x86_64-nsis",
  "darwin-aarch64-app": "darwin-aarch64",
  "darwin-x86_64-app": "darwin-x86_64",
};

export function detectOsFamily(): "windows" | "macos" | "linux" | "unknown" {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("windows")) return "windows";
  if (ua.includes("mac")) return "macos";
  if (ua.includes("linux")) return "linux";
  return "unknown";
}

function filenameFromUrl(url: string): string {
  try {
    const path = new URL(url).pathname;
    const name = path.split("/").filter(Boolean).pop();
    return name ? decodeURIComponent(name) : url;
  } catch {
    return url;
  }
}

function isPreferredForOs(platformKey: string, os: ReturnType<typeof detectOsFamily>): boolean {
  if (os === "windows") return platformKey.startsWith("windows-");
  if (os === "macos") return platformKey.startsWith("darwin-");
  if (os === "linux") return platformKey.startsWith("linux-");
  return false;
}

export function buildDownloadItems(
  platforms: Record<string, PlatformAsset> | undefined,
  os: ReturnType<typeof detectOsFamily> = detectOsFamily(),
): DownloadItem[] {
  if (!platforms) return [];

  const items: DownloadItem[] = [];
  for (const [key, asset] of Object.entries(platforms)) {
    if (!asset?.url) continue;
    const skipSibling = SKIP_IF_SAME_URL_AS[key];
    if (skipSibling && platforms[skipSibling]?.url === asset.url) continue;

    const meta = PLATFORM_META[key];

    items.push({
      id: key,
      label: meta ? t(meta.labelKey) : key,
      hint: meta ? t(meta.hintKey) : t("plat.generic"),
      url: asset.url,
      filename: filenameFromUrl(asset.url),
      preferred: isPreferredForOs(key, os),
    });
  }

  items.sort((a, b) => {
    if (a.preferred !== b.preferred) return a.preferred ? -1 : 1;
    const ao = PLATFORM_META[a.id]?.order ?? 100;
    const bo = PLATFORM_META[b.id]?.order ?? 100;
    return ao - bo;
  });

  return items;
}

export function tagFromVersion(version: string): string {
  const v = version.trim();
  return v.startsWith("v") ? v : `v${v}`;
}

export function formatPubDate(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

export async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** 按候选 URL 依次尝试（OSS 可能因 CORS 失败，再回退同域镜像） */
export async function fetchJsonFirst<T>(urls: string[]): Promise<T | null> {
  for (const url of urls) {
    const data = await fetchJson<T>(url);
    if (data != null) return data;
  }
  return null;
}

export function manifestToVersionEntry(manifest: UpdaterManifest): VersionEntry {
  return {
    tag: tagFromVersion(manifest.version),
    version: manifest.version.replace(/^v/, ""),
    notes: manifest.notes,
    pub_date: manifest.pub_date,
    platforms: manifest.platforms ?? {},
  };
}

/** versions.json 缺失时，用 latest 拼出单版本列表 */
export function resolveVersionList(
  latest: UpdaterManifest | null,
  index: VersionsIndex | null,
): VersionEntry[] {
  const fromIndex = index?.versions?.filter((v) => v?.version && v.platforms) ?? [];
  if (fromIndex.length > 0) {
    return [...fromIndex].sort((a, b) => compareVersionDesc(a.version, b.version));
  }
  if (latest) return [manifestToVersionEntry(latest)];
  return [];
}

function compareVersionDesc(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.replace(/^v/, "").split(".").map((x) => Number.parseInt(x, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i += 1) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return db - da;
  }
  return 0;
}
