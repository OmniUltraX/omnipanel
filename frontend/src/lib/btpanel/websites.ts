import type { BtPanelClient } from "./client";
import type { BtJavaProject, BtSite, BtWebsiteListParams } from "./types";

// 注意：仅类型依赖 client，避免与 client 形成运行时循环引用。

function javaProjectName(project: BtJavaProject): string {
  return String(project.name ?? project.project_name ?? "").trim();
}

/** pid_info 为空 → 未启动；有内容 → 已启动。 */
export function isPidInfoPresent(pidInfo: unknown): boolean {
  if (pidInfo == null) return false;
  if (typeof pidInfo === "string") return pidInfo.trim() !== "";
  if (typeof pidInfo === "number") return Number.isFinite(pidInfo) && pidInfo > 0;
  if (typeof pidInfo === "boolean") return pidInfo;
  if (Array.isArray(pidInfo)) return pidInfo.length > 0;
  if (typeof pidInfo === "object") return Object.keys(pidInfo as object).length > 0;
  return String(pidInfo).trim() !== "";
}

/** 将 Java project_list 运行态规范为宝塔 sites.status 常用的 0/1（优先 pid_info）。 */
export function javaProjectRunStatus(project: BtJavaProject): string | null {
  if ("pid_info" in project) {
    return isPidInfoPresent(project.pid_info) ? "1" : "0";
  }
  if (typeof project.run === "boolean") return project.run ? "1" : "0";
  if (typeof project.status === "boolean") return project.status ? "1" : "0";
  if (project.run_status != null && String(project.run_status).trim() !== "") {
    return String(project.run_status);
  }
  if (project.status != null && String(project.status).trim() !== "") {
    return String(project.status);
  }
  return null;
}

function isJavaishProjectType(value: unknown): boolean {
  const t = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
  if (!t) return false;
  return (
    t === "java" ||
    t.includes("java") ||
    t === "springboot" ||
    t.includes("spring") ||
    t === "tomcat" ||
    t.includes("tomcat")
  );
}

function siteMatchKey(row: Record<string, unknown>): string {
  return String(row.name ?? row.rname ?? row.site_name ?? "")
    .trim()
    .toLowerCase();
}

/**
 * 用官方 Java `project_list` 补全 / 覆盖 sites 中 Java 项目的进程运行状态；
 * sites 未收录的 Java 项目追加为列表项（统一 project_type=Java）。
 */
export function mergeBtSitesWithJavaProjects(
  sites: Array<BtSite | Record<string, unknown>>,
  projects: BtJavaProject[],
): Record<string, unknown>[] {
  const list = (Array.isArray(sites) ? sites : []).map((row) => ({
    ...(row as Record<string, unknown>),
  }));
  const byName = new Map<string, number>();
  for (let i = 0; i < list.length; i++) {
    const key = siteMatchKey(list[i]!);
    if (key) byName.set(key, i);
  }

  for (const project of Array.isArray(projects) ? projects : []) {
    const name = javaProjectName(project);
    if (!name) continue;
    const key = name.toLowerCase();
    const runStatus = javaProjectRunStatus(project);
    const path =
      String(project.path ?? project.project_path ?? project.project_cwd ?? "").trim() ||
      undefined;
    const ps = String(project.ps ?? project.project_ps ?? "").trim() || undefined;
    const existingIdx = byName.get(key);
    if (existingIdx != null) {
      const existing = list[existingIdx]!;
      list[existingIdx] = {
        ...existing,
        ...("pid_info" in project ? { pid_info: project.pid_info } : {}),
        ...(runStatus != null ? { status: runStatus } : {}),
        ...(path && !existing.path ? { path } : {}),
        ...(ps && !existing.ps ? { ps } : {}),
        project_type: isJavaishProjectType(existing.project_type)
          ? "Java"
          : (existing.project_type ?? "Java"),
        _bt_java_project: true,
      };
      continue;
    }
    list.push({
      id: project.id ?? `java:${name}`,
      name,
      ...("pid_info" in project ? { pid_info: project.pid_info } : {}),
      status: runStatus ?? "0",
      path,
      ps,
      project_type: "Java",
      port: project.port,
      pid: project.pid,
      _bt_java_project: true,
    });
  }

  return list;
}

/**
 * 宝塔网站列表：`sites` + 官方 Java `project_list` 合并。
 * Java 接口失败不阻断站点列表（模块未安装等）。
 */
export async function fetchBtMergedWebsiteList(
  client: BtPanelClient,
  params: BtWebsiteListParams = {},
): Promise<Record<string, unknown>[]> {
  const site = await client.getWebsiteList(params);
  const sites = Array.isArray(site.data)
    ? (site.data as unknown as Record<string, unknown>[])
    : [];
  let projects: BtJavaProject[] = [];
  try {
    const java = await client.getJavaProjectList({
      p: params.p,
      limit: params.limit ?? 200,
      search: params.search,
    });
    projects = Array.isArray(java.data) ? java.data : [];
  } catch {
    // Java 项目模块未装或接口不可用时仍返回 sites
  }
  return mergeBtSitesWithJavaProjects(sites, projects);
}
