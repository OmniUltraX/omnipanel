#!/usr/bin/env node
/**
 * 从 plugins 目录下各 plugin.json 生成官方目录种子 plugins/registry.json。
 * bundled：随客户端安装的第一方；download-only（见 plugin-download-only.mjs）与
 * plugins-market 产物合并为可下载条目（CI 回填 hash/size）。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DOWNLOAD_ONLY_PLUGIN_DIRS } from "./plugin-download-only.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginsDir = path.join(root, "plugins");
const outPath = path.join(pluginsDir, "registry.json");
const PLUGINS_LATEST =
  "https://github.com/OmniUltraX/omnipanel/releases/download/plugins-latest";

const META = {
  "omni.theme.default": {
    name: "Default theme",
    description: "Built-in color tokens for the OmniPanel shell.",
  },
  "omni.addon.everything": {
    name: "Everything local search",
    description: "Search local file paths via Everything (Windows, metadata only).",
  },
  "omni.cloud.aliyun": {
    name: "Alibaba Cloud",
    description: "Manage ECS, security groups, RDS, metrics, and other Alibaba Cloud resources.",
  },
  "omni.cloud.tencent": {
    name: "Tencent Cloud",
    description: "Manage CVM, Lighthouse, security groups, TencentDB, COS, DNSPod, and other Tencent Cloud resources.",
  },
  "omni.cloud.huawei": {
    name: "Huawei Cloud",
    description: "Manage ECS, Flexus L, VPC, RDS, DCS, OBS, DNS, and other Huawei Cloud resources.",
  },
  "omni.cloud.aws": {
    name: "AWS",
    description: "Manage EC2, EBS, S3, RDS, ElastiCache, and other Amazon Web Services resources.",
  },
  "omni.cloud.azure": {
    name: "Microsoft Azure",
    description: "Manage Azure VMs, disks, storage accounts, SQL, Redis, and other Microsoft Azure resources.",
  },
  "omni.cloud.digitalocean": {
    name: "DigitalOcean",
    description: "Manage Droplets, volumes, load balancers, managed databases, and other DigitalOcean resources.",
  },
  "omni.cloud.gcp": {
    name: "Google Cloud",
    description: "Manage Compute Engine, disks, GCS, Cloud SQL, firewalls, and other Google Cloud resources.",
  },
  "omni.cloud.bandwagon": {
    name: "BandwagonHost",
    description: "Manage BandwagonHost (搬瓦工) KVM VPS via KiwiVM API.",
  },
  "omni.panel.1panel": {
    name: "1Panel",
    description: "Connect to 1Panel hosts for sites, apps, and certificates.",
  },
  "omni.panel.bt": {
    name: "BT Panel",
    description: "Connect to BT (Baota) panel hosts.",
  },
  "omni.panel.hestia": {
    name: "HestiaCP",
    description: "Connect to HestiaCP hosts for sites, databases, certificates, and cron jobs.",
  },
  "omni.engine.qdrant": {
    name: "Qdrant",
    description: "First-party Qdrant vector database engine.",
  },
  "omni.engine.clickhouse": {
    name: "ClickHouse",
    description: "First-party ClickHouse engine (sidecar).",
  },
  "omni.engine.mongodb": {
    name: "MongoDB",
    description: "First-party MongoDB engine (sidecar).",
  },
  "omni.engine.mysql": {
    name: "MySQL",
    description: "First-party MySQL / MariaDB engine.",
  },
  "omni.engine.postgres": {
    name: "PostgreSQL",
    description: "First-party PostgreSQL engine.",
  },
  "omni.engine.redis": {
    name: "Redis",
    description: "First-party Redis engine.",
  },
  "omni.engine.sqlite": {
    name: "SQLite",
    description: "First-party SQLite engine.",
  },
  "omni.engine.sqlserver": {
    name: "SQL Server",
    description: "First-party SQL Server engine (sidecar).",
  },
  "omni.module.nacos": {
    name: "Nacos",
    description: "Nacos console workbench (namespaces, configs, discovery). Install from the plugin market.",
  },
  "omni.importer.warpgate": {
    name: "Warpgate import",
    description: "Import SSH and database targets from a Warpgate bastion.",
  },
  "omni.importer.docker-db": {
    name: "Docker database scan",
    description: "Scan published database ports on existing Docker engines.",
  },
};

function gitIso(args) {
  try {
    const out = execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/** 用 plugin.json 的首次提交作创建时间、最近提交作更新时间。 */
function fileDates(relPath) {
  const updatedAt = gitIso(["log", "-1", "--format=%cI", "--", relPath]);
  const createdLog = gitIso([
    "log",
    "--diff-filter=A",
    "--follow",
    "--format=%cI",
    "--",
    relPath,
  ]);
  const createdAt = createdLog
    ? createdLog.split(/\r?\n/).filter(Boolean).at(-1)
    : updatedAt;
  return { createdAt: createdAt || undefined, updatedAt: updatedAt || undefined };
}

const dirs = fs
  .readdirSync(pluginsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

const plugins = [];
for (const dir of dirs) {
  if (DOWNLOAD_ONLY_PLUGIN_DIRS.has(dir)) continue;
  const file = path.join(pluginsDir, dir, "plugin.json");
  if (!fs.existsSync(file)) continue;
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const meta = META[raw.id] ?? { name: raw.id, description: "" };
  const dates = fileDates(path.posix.join("plugins", dir, "plugin.json"));
  plugins.push({
    id: raw.id,
    kind: raw.kind,
    name: meta.name,
    description: meta.description,
    versions: [
      {
        version: raw.version,
        ...(raw.minHostApi ? { minHostApi: raw.minHostApi } : {}),
        ...(Array.isArray(raw.dependencies) && raw.dependencies.length
          ? { dependencies: raw.dependencies }
          : {}),
      },
    ],
    permissions: Array.isArray(raw.permissions) ? raw.permissions : [],
    ...dates,
  });
}

function prevDownloadArtifact(prevPlugins, id) {
  const prev = (prevPlugins ?? []).find((p) => p && p.id === id);
  if (!prev) return null;
  if (prev.artifact?.url) return prev.artifact;
  const fromVersion = Array.isArray(prev.versions)
    ? prev.versions.find((v) => v?.artifact?.url)?.artifact
    : null;
  return fromVersion ?? null;
}

let prevPlugins = [];
try {
  prevPlugins = JSON.parse(fs.readFileSync(outPath, "utf8")).plugins ?? [];
} catch {
  prevPlugins = [];
}

// download-only：源码在 plugins/<dir>，发行走 plugins-latest 资产
for (const dir of [...DOWNLOAD_ONLY_PLUGIN_DIRS].sort()) {
  const file = path.join(pluginsDir, dir, "plugin.json");
  if (!fs.existsSync(file)) {
    console.warn(`[plugin-registry] skip missing download-only plugins/${dir}`);
    continue;
  }
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const meta = META[raw.id] ?? { name: raw.id, description: "" };
  const dates = fileDates(path.posix.join("plugins", dir, "plugin.json"));
  const asset = `${String(raw.id).replace(/\./g, "-")}-${raw.version}.omni-plugin`;
  const prevArt = prevDownloadArtifact(prevPlugins, raw.id);
  const artifact = {
    url: prevArt?.url || `${PLUGINS_LATEST}/${asset}`,
    sha256: typeof prevArt?.sha256 === "string" ? prevArt.sha256 : "",
    // size 必须 >0，否则前端会把 downloadSize=0 误判为 bundled
    size: Number(prevArt?.size) > 0 ? Number(prevArt.size) : 8234,
  };
  // 必须写真 v2 `versions[]`：自称 schemaVersion:2 却用扁平 version/artifact
  // 时，市场 parse 会得到空 versions，刷新后 download-only 插件整条消失。
  plugins.push({
    id: raw.id,
    kind: raw.kind,
    name: meta.name,
    description: meta.description,
    versions: [
      {
        version: raw.version,
        artifact,
      },
    ],
    permissions: Array.isArray(raw.permissions) ? raw.permissions : [],
    ...dates,
  });
}

// download 条目（如 plugins-market 产出的市场插件）不在 plugins/ 目录里，
// 全量重写会抹掉它们：从旧文件里按 id 合并回来（以旧文件为准，CI 再回填 hash）。
const scannedIds = new Set(plugins.map((p) => p.id));
for (const p of prevPlugins) {
  if (!p || typeof p.id !== "string" || scannedIds.has(p.id)) continue;
  const v1Download = p.distribution === "download" && p.artifact?.url;
  const v2Download =
    Array.isArray(p.versions) && p.versions.some((v) => v?.artifact?.url);
  if (v1Download || v2Download) plugins.push(p);
}

plugins.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));

const registry = { schemaVersion: 2, plugins };
fs.writeFileSync(outPath, `${JSON.stringify(registry, null, 2)}\n`);
console.log(`[plugin-registry] wrote ${plugins.length} plugins (v2) → ${path.relative(root, outPath)}`);
