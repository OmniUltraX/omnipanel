#!/usr/bin/env node
/**
 * 扫描 plugin-submission 且 closed-as-completed 的 issue，
 * 校验 registry v2 片段后合进 plugins/registry.json。
 *
 *   node scripts/ingest-plugin-submissions.mjs --self-test
 *   node scripts/ingest-plugin-submissions.mjs --dry-run
 *   node scripts/ingest-plugin-submissions.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const registryPath = path.join(root, "plugins", "registry.json");
const MARK = "<!-- omnipanel-plugin-fragment -->";
const DANGEROUS = new Set(["ssh:exec"]);
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

export function extractFragment(body) {
  if (!body || !body.includes(MARK)) return null;
  const after = body.slice(body.indexOf(MARK) + MARK.length);
  const fence = after.match(/```json\s*([\s\S]*?)```/);
  if (!fence) return null;
  try {
    return JSON.parse(fence[1]);
  } catch {
    return null;
  }
}

export function extractPermissions(body) {
  const out = [];
  const section = String(body || "").split("### Permissions")[1] || "";
  for (const line of section.split(/\r?\n/)) {
    const m = line.match(/^-\s+`([^`]+)`/);
    if (m) out.push(m[1]);
  }
  return out;
}

export function dangerousPermissions(permissions) {
  return permissions.filter((p) => DANGEROUS.has(p));
}

export function validateFragment(plugin) {
  if (!plugin || typeof plugin !== "object") return "片段不是对象";
  if (!plugin.id || typeof plugin.id !== "string") return "缺少 id";
  const versions = Array.isArray(plugin.versions) ? plugin.versions : [];
  if (versions.length === 0) return "缺少 versions";
  const ver = versions[0];
  if (!ver.version || !SEMVER.test(String(ver.version))) return `版本号非法: ${ver.version}`;
  const artifact = ver.artifact;
  if (!artifact || typeof artifact !== "object") return "缺少 artifact";
  if (!String(artifact.url || "").startsWith("https://")) return "artifact.url 必须是 https://";
  if (!/^[a-f0-9]{64}$/i.test(String(artifact.sha256 || ""))) return "artifact.sha256 非法";
  if (!Number.isFinite(Number(artifact.size)) || Number(artifact.size) <= 0) {
    return "artifact.size 非法";
  }
  return null;
}

export function toV2(registry) {
  const plugins = Array.isArray(registry.plugins) ? registry.plugins : [];
  return {
    schemaVersion: 2,
    plugins: plugins.map((p) => {
      if (Array.isArray(p.versions) && p.versions.length) return p;
      return {
        id: p.id,
        kind: p.kind || "",
        name: p.name || p.id,
        description: p.description || "",
        versions: [
          {
            version: p.version || "0.0.0",
            ...(p.artifact ? { artifact: p.artifact } : {}),
          },
        ],
      };
    }),
  };
}

export function mergePlugin(registry, incoming) {
  const next = toV2(registry);
  const idx = next.plugins.findIndex((p) => p.id === incoming.id);
  if (idx < 0) {
    next.plugins.push(incoming);
    next.plugins.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    return { registry: next, added: true, reason: "new-plugin" };
  }
  const current = next.plugins[idx];
  const version = incoming.versions[0].version;
  if (current.versions.some((v) => v.version === version)) {
    return { registry: next, added: false, reason: "already-present" };
  }
  current.versions.push(incoming.versions[0]);
  current.kind = incoming.kind || current.kind;
  current.name = incoming.name || current.name;
  return { registry: next, added: true, reason: "new-version" };
}

function selfTest() {
  const sample = `## Plugin submission
${MARK}
\`\`\`json
{"id":"omni.sample.x","kind":"addon","name":"X","versions":[{"version":"1.2.3","artifact":{"url":"https://example.com/x.omni-plugin","sha256":"${"a".repeat(64)}","size":12}}]}
\`\`\`
### Permissions
- \`ui:selection\`
- \`ssh:exec\`
`;
  const frag = extractFragment(sample);
  const err = validateFragment(frag);
  if (err) throw new Error(err);
  const perms = extractPermissions(sample);
  if (dangerousPermissions(perms).join() !== "ssh:exec") {
    throw new Error("dangerous flag failed");
  }
  const merged = mergePlugin({ schemaVersion: 1, plugins: [] }, frag);
  if (!merged.added) throw new Error("merge failed");
  const again = mergePlugin(merged.registry, frag);
  if (again.added) throw new Error("duplicate should skip");
  console.log("[ingest] self-test ok");
}

async function ghJson(url, token) {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "omnipanel-plugin-submissions",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`GitHub ${res.status}: ${text.slice(0, 200)}`);
  }
  return JSON.parse(text);
}

async function ingest({ dryRun }) {
  const repo = process.env.GITHUB_REPOSITORY || "OmniUltraX/omnipanel";
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
  const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  let current = registry;
  const report = [];

  if (!token) {
    console.log("[ingest] 无 GITHUB_TOKEN，只做本地校验");
    return report;
  }

  const issues = await ghJson(
    `https://api.github.com/repos/${repo}/issues?state=closed&labels=plugin-submission&per_page=50`,
    token,
  );
  const qualified = (Array.isArray(issues) ? issues : []).filter(
    (issue) => !issue.pull_request && issue.state_reason === "completed",
  );

  for (const issue of qualified) {
    const fragment = extractFragment(issue.body || "");
    const invalid = validateFragment(fragment);
    if (invalid) {
      report.push({ issue: issue.number, skip: invalid });
      continue;
    }
    const danger = dangerousPermissions(extractPermissions(issue.body || ""));
    if (danger.length) {
      report.push({
        issue: issue.number,
        skip: `dangerous:${danger.join(",")}`,
      });
      continue;
    }
    const merged = mergePlugin(current, fragment);
    report.push({
      issue: issue.number,
      id: fragment.id,
      version: fragment.versions[0].version,
      added: merged.added,
      reason: merged.reason,
    });
    current = merged.registry;
  }

  const changed = report.some((row) => row.added);
  if (!dryRun && changed) {
    fs.writeFileSync(registryPath, `${JSON.stringify(current, null, 2)}\n`);
  }
  console.log(JSON.stringify({ dryRun, changed, report }, null, 2));
  return report;
}

const args = process.argv.slice(2);
const thisFile = fileURLToPath(import.meta.url);
const invoked = process.argv[1] && path.resolve(process.argv[1]) === thisFile;
if (invoked) {
  if (args.includes("--self-test")) {
    selfTest();
  } else {
    ingest({ dryRun: args.includes("--dry-run") }).catch((err) => {
      console.error(err);
      process.exit(1);
    });
  }
}
