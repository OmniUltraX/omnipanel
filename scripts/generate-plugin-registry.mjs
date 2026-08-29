#!/usr/bin/env node
/**
 * 从 plugins 目录下各 plugin.json 生成官方目录种子 plugins/registry.json。
 * 第一方均为 bundled（随客户端安装）；download 条目可手工追加。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginsDir = path.join(root, "plugins");
const outPath = path.join(pluginsDir, "registry.json");

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
    description: "Discover ECS and Simple Application Server resources.",
  },
  "omni.panel.1panel": {
    name: "1Panel",
    description: "Connect to 1Panel hosts for sites, apps, and certificates.",
  },
  "omni.panel.bt": {
    name: "BT Panel",
    description: "Connect to BT (Baota) panel hosts.",
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
    name: "Nacos module shell",
    description: "Host shell for the Nacos console plugin.",
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

const dirs = fs
  .readdirSync(pluginsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

const plugins = [];
for (const dir of dirs) {
  const file = path.join(pluginsDir, dir, "plugin.json");
  if (!fs.existsSync(file)) continue;
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const meta = META[raw.id] ?? { name: raw.id, description: "" };
  plugins.push({
    id: raw.id,
    kind: raw.kind,
    name: meta.name,
    description: meta.description,
    version: raw.version,
    distribution: "bundled",
    permissions: Array.isArray(raw.permissions) ? raw.permissions : [],
  });
}

plugins.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));

const registry = { schemaVersion: 1, plugins };
fs.writeFileSync(outPath, `${JSON.stringify(registry, null, 2)}\n`);
console.log(`[plugin-registry] wrote ${plugins.length} bundled plugins → ${path.relative(root, outPath)}`);
