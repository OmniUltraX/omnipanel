#!/usr/bin/env node
/**
 * 将 plugins/cloud-* 拆成独立仓并挂回宿主 submodule（对齐 Nacos）。
 *
 * 前置：
 *   1. `gh auth login`（需 org OmniUltraX 的 repo 创建权限）
 *   2. 或事先在 OmniUltraX 下建好空仓 omni-plugin-cloud-<vendor>
 *
 * 用法（在 monorepo 根目录）：
 *   node scripts/split-cloud-plugin-repos.mjs           # 创建仓 + 推送 + 改 submodule（需确认）
 *   node scripts/split-cloud-plugin-repos.mjs --dry-run # 只打印将要做的事
 *   node scripts/split-cloud-plugin-repos.mjs --push-only # 仓已存在，只推送内容并挂 submodule
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dryRun = process.argv.includes("--dry-run");
const pushOnly = process.argv.includes("--push-only");
const org = "OmniUltraX";

const VENDORS = [
  { dir: "cloud-aliyun", repo: "omni-plugin-cloud-aliyun", title: "Alibaba Cloud" },
  { dir: "cloud-tencent", repo: "omni-plugin-cloud-tencent", title: "Tencent Cloud" },
  { dir: "cloud-huawei", repo: "omni-plugin-cloud-huawei", title: "Huawei Cloud" },
  { dir: "cloud-aws", repo: "omni-plugin-cloud-aws", title: "AWS" },
  { dir: "cloud-azure", repo: "omni-plugin-cloud-azure", title: "Microsoft Azure" },
  { dir: "cloud-digitalocean", repo: "omni-plugin-cloud-digitalocean", title: "DigitalOcean" },
  { dir: "cloud-gcp", repo: "omni-plugin-cloud-gcp", title: "Google Cloud" },
  { dir: "cloud-bandwagon", repo: "omni-plugin-cloud-bandwagon", title: "BandwagonHost" },
];

const GITIGNORE = `# OS / editor
.DS_Store
Thumbs.db
*.swp
.idea/
.vscode/

# Build / pack artifacts
*.omni-plugin
dist/
node_modules/
*.log
`;

function sh(cmd, args, opts = {}) {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  if (dryRun) return;
  execFileSync(cmd, args, { cwd: opts.cwd || root, stdio: "inherit", ...opts });
}

function shCapture(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd || root,
    encoding: "utf8",
    ...opts,
  });
  return { code: r.status ?? 1, out: (r.stdout || "") + (r.stderr || "") };
}

function repoExists(repo) {
  const r = shCapture("git", ["ls-remote", `git@github.com:${org}/${repo}.git`]);
  // 空仓也算存在（ls-remote 成功但无 ref）
  if (r.code === 0) return true;
  return !r.out.includes("Repository not found");
}

function ensureGh() {
  const r = shCapture("gh", ["auth", "status"]);
  if (r.code !== 0) {
    throw new Error("请先执行 `gh auth login`（需要创建 OmniUltraX 组织仓库的权限）");
  }
}

function createRepo(v) {
  if (dryRun) {
    console.log(`[dry-run] gh repo create ${org}/${v.repo} --public`);
    return;
  }
  const probe = shCapture("gh", ["repo", "view", `${org}/${v.repo}`, "--json", "name", "-q", ".name"]);
  if (probe.code === 0 && probe.out.trim() === v.repo) {
    console.log(`[skip-create] ${org}/${v.repo} 已存在`);
    return;
  }
  if (pushOnly) {
    throw new Error(`缺少仓库 ${org}/${v.repo}；请先创建或去掉 --push-only`);
  }
  ensureGh();
  sh("gh", [
    "repo",
    "create",
    `${org}/${v.repo}`,
    "--public",
    "--description",
    `OmniPanel download-only cloud plugin: ${v.title}`,
  ]);
}

function copyTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    if (name === ".git") continue;
    const from = path.join(src, name);
    const to = path.join(dest, name);
    const st = fs.statSync(from);
    if (st.isDirectory()) copyTree(from, to);
    else fs.copyFileSync(from, to);
  }
}

function pushPluginContent(v) {
  const src = path.join(root, "plugins", v.dir);
  if (!fs.existsSync(path.join(src, "plugin.json"))) {
    throw new Error(`缺少 ${src}/plugin.json`);
  }
  const work = path.join(root, ".tmp-cloud-repos", v.repo);
  fs.rmSync(work, { recursive: true, force: true });
  copyTree(src, work);
  fs.writeFileSync(path.join(work, ".gitignore"), GITIGNORE);

  if (dryRun) {
    console.log(`[dry-run] 将推送 ${src} → ${org}/${v.repo}`);
    return;
  }

  sh("git", ["init", "-b", "main"], { cwd: work });
  sh("git", ["add", "-A"], { cwd: work });
  sh(
    "git",
    ["-c", "user.name=OmniPanel Bot", "-c", "user.email=bot@omnipanel.local", "commit", "-m", `chore: 初始导入 ${v.dir} 插件`],
    { cwd: work },
  );
  sh("git", ["remote", "add", "origin", `git@github.com:${org}/${v.repo}.git`], {
    cwd: work,
  });
  // 首次导入：空仓或覆盖占位内容
  sh("git", ["push", "-u", "origin", "main", "--force"], { cwd: work });
}

function attachSubmodule(v) {
  const rel = path.join("plugins", v.dir).replace(/\\/g, "/");
  const url = `git@github.com:${org}/${v.repo}.git`;

  if (dryRun) {
    console.log(`[dry-run] submodule add ${url} ${rel}`);
    return;
  }

  // 从宿主索引移除原目录，但先备份已推送内容
  const cached = path.join(root, ".tmp-cloud-repos", `${v.repo}-host-backup`);
  fs.rmSync(cached, { recursive: true, force: true });
  copyTree(path.join(root, "plugins", v.dir), cached);

  sh("git", ["rm", "-rf", rel]);
  // git rm 会删工作树；用 submodule add 重新拉
  // 若 .gitmodules 已有条目则先清理
  const gm = path.join(root, ".gitmodules");
  if (fs.existsSync(gm)) {
    const text = fs.readFileSync(gm, "utf8");
    if (text.includes(`path = ${rel}`)) {
      sh("git", ["submodule", "deinit", "-f", rel]);
      sh("git", ["rm", "-f", rel]);
      const conf = path.join(root, ".git", "modules", rel);
      fs.rmSync(conf, { recursive: true, force: true });
    }
  }

  fs.rmSync(path.join(root, "plugins", v.dir), { recursive: true, force: true });
  sh("git", ["submodule", "add", url, rel]);
}

function main() {
  console.log(`拆分 ${VENDORS.length} 个云插件 → ${org}/omni-plugin-cloud-*`);
  for (const v of VENDORS) {
    console.log(`\n=== ${v.dir} ===`);
    createRepo(v);
    pushPluginContent(v);
  }
  console.log("\n=== 宿主挂 submodule ===");
  for (const v of VENDORS) {
    attachSubmodule(v);
  }
  console.log(
    dryRun
      ? "\n[dry-run] 完成（未改动）"
      : "\n完成。请检查 `git status`，确认后提交并推送宿主（含 .gitmodules 与 submodule 指针）。",
  );
}

main();
