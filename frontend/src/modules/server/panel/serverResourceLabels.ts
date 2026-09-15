import { isPidInfoPresent } from "../../../lib/btpanel";
import type { ServerEntry } from "./serverConnection";
import type { ServerDetailTab } from "./serverSidebarNav";
import { isBtPanelService, isOnePanelService } from "./panelPlugin";

export function websiteRowId(row: Record<string, unknown>, index: number): string {
  return String(row.id ?? row.webname ?? row.domain ?? index);
}

/** 宝塔 sites.domain 常为数字（域名数量），不可当域名展示。 */
function isLikelyDomainText(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const text = value.trim();
  if (!text || text === "—") return false;
  if (/^\d+$/.test(text)) return false;
  return true;
}

export function websiteRowLabel(row: Record<string, unknown>): string {
  // 宝塔主域名字段是 name；1Panel 是 primaryDomain。勿优先取数字型 domain。
  if (isLikelyDomainText(row.primaryDomain)) return String(row.primaryDomain).trim();
  if (isLikelyDomainText(row.name)) return String(row.name).trim();
  if (isLikelyDomainText(row.webname)) return String(row.webname).trim();
  if (isLikelyDomainText(row.domain)) return String(row.domain).trim();
  if (isLikelyDomainText(row.rname)) return String(row.rname).trim();
  return String(row.id ?? "—");
}

/** 构造可在默认浏览器打开的网站 URL；无有效域名时返回 null（不用 id 兜底） */
export function websiteRowUrl(row: Record<string, unknown>): string | null {
  const raw = websiteRowLabel(row);
  if (!raw || raw === "—") return null;
  if (/^https?:\/\//i.test(raw)) return raw;

  const primary = raw.split(/[\s,;]+/)[0]?.trim() ?? "";
  if (!primary) return null;

  const protocol = String(row.protocol ?? "").toUpperCase();
  const hasSsl =
    protocol.includes("HTTPS") ||
    protocol.includes("SSL") ||
    isWebsiteSslBound(row);
  return `${hasSsl ? "https" : "http"}://${primary}`;
}

export function websiteRowPath(row: Record<string, unknown>): string {
  // 宝塔 path 是站点目录；ps 是备注，不能当路径兜底
  const sitePath = row.sitePath ?? row.path;
  if (typeof sitePath === "string" && sitePath.trim()) return sitePath.trim();
  return "";
}

/** 宝塔多数写接口用域名（siteName / webname），不用数字 domain。 */
export function websiteSiteName(row: Record<string, unknown>): string | null {
  const label = websiteRowLabel(row);
  return label && label !== "—" ? label : null;
}

/** 网站类型原始值（1Panel: static / runtime / deployment / proxy / stream / subsite） */
export function websiteRowType(row: Record<string, unknown>): string {
  const raw = row.type ?? row.websiteType ?? row.project_type ?? "";
  const text = String(raw).trim();
  return text || "—";
}

/** 网站分组名称（1Panel WebsiteDTO.group；宝塔 type_id → type_name/group） */
export function websiteRowGroup(row: Record<string, unknown>): string {
  const direct = row.group ?? row.groupName ?? row.websiteGroup ?? row.type_name ?? row.typeName;
  if (typeof direct === "string" && direct.trim()) {
    return direct.trim();
  }
  if (direct && typeof direct === "object") {
    const name = (direct as Record<string, unknown>).name;
    if (typeof name === "string" && name.trim()) {
      return name.trim();
    }
  }
  return "—";
}

/** 网站分组 ID（1Panel websiteGroupId；宝塔 type_id） */
export function websiteRowGroupId(row: Record<string, unknown>): string | null {
  const raw = row.type_id ?? row.websiteGroupId ?? row.websiteGroupID ?? row.groupId;
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  if (typeof raw === "string" && raw.trim() !== "") return raw.trim();
  return null;
}

/** 是否为已停止状态（优先于运行中判定，避免「未启动」被 includes(启动) 误判） */
export function isWebsiteStopped(status: string): boolean {
  const lower = status.trim().toLowerCase();
  if (!lower || lower === "—" || lower === "-" || lower === "unknown" || lower === "n/a") {
    return false;
  }
  // 中文否定式优先
  if (
    lower === "未启动" ||
    lower === "未运行" ||
    lower === "已停止" ||
    lower === "已关闭" ||
    lower === "已停用" ||
    lower === "停用" ||
    (lower.startsWith("未") && (lower.includes("启动") || lower.includes("运行")))
  ) {
    return true;
  }
  return (
    lower === "stopped" ||
    lower === "stop" ||
    lower === "offline" ||
    lower === "down" ||
    lower === "exited" ||
    lower === "inactive" ||
    lower === "disable" ||
    lower === "disabled" ||
    lower === "0" ||
    lower === "false" ||
    lower === "no" ||
    lower === "off" ||
    lower.includes("停止") ||
    lower.includes("关闭") ||
    lower.includes("禁用") ||
    lower.includes("停用")
  );
}

/** 是否为运行中状态（用于启停按钮） */
export function isWebsiteRunning(status: string): boolean {
  // 停止态优先，防止「未启动」等否定文案命中「启动/运行」子串
  if (isWebsiteStopped(status)) return false;
  const lower = status.trim().toLowerCase();
  return (
    lower === "running" ||
    lower === "normal" || // 1Panel PHP 站点运行态
    lower === "start" ||
    lower === "started" ||
    lower === "active" ||
    lower === "online" ||
    lower === "up" ||
    lower === "healthy" ||
    lower === "enable" ||
    lower === "enabled" ||
    lower === "1" ||
    lower === "true" ||
    lower === "yes" ||
    lower === "on" ||
    lower === "运行" ||
    lower === "运行中" ||
    lower === "已启动" ||
    lower === "启用" ||
    lower.includes("运行") ||
    lower.includes("启动") ||
    lower.includes("启用")
  );
}

export function websiteNumericId(row: Record<string, unknown>): number | null {
  const raw = row.id;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && /^\d+$/.test(raw.trim())) return Number(raw.trim());
  return null;
}

export function certificateNumericId(row: Record<string, unknown>): number | null {
  return websiteNumericId(row);
}

export function cronjobNumericId(row: Record<string, unknown>): number | null {
  return websiteNumericId(row);
}

export function websiteSslId(row: Record<string, unknown>): number | null {
  const ssl = row.websiteSSL ?? row.webSiteSSL ?? row.ssl;
  if (ssl && typeof ssl === "object") {
    const id = (ssl as Record<string, unknown>).id;
    if (typeof id === "number" && Number.isFinite(id) && id > 0) return id;
    if (typeof id === "string" && /^\d+$/.test(id.trim())) {
      const n = Number(id.trim());
      if (n > 0) return n;
    }
  }
  const direct = row.websiteSSLId ?? row.webSiteSSLId ?? row.sslId;
  if (typeof direct === "number" && Number.isFinite(direct) && direct > 0) return direct;
  if (typeof direct === "string" && /^\d+$/.test(direct.trim())) {
    const n = Number(direct.trim());
    if (n > 0) return n;
  }
  return null;
}

/**
 * 规范化网站运行状态展示文案。
 * - 宝塔 sites.status：'1' / '0'（或数字）
 * - 1Panel：Running / Stopped；创建态可能出现 normal / running
 */
export function websiteRowStatus(row: Record<string, unknown>): string {
  // 宝塔 Java project_list：pid_info 为空=未启动，非空=已启动
  if ("pid_info" in row) {
    return isPidInfoPresent(row.pid_info) ? "Running" : "Stopped";
  }
  const raw = row.status ?? row.appStatus ?? row.run_status ?? row.runStatus;
  if (raw == null || raw === "") return "—";
  if (typeof raw === "boolean") return raw ? "Running" : "Stopped";
  if (typeof raw === "number") {
    if (raw === 1) return "Running";
    if (raw === 0) return "Stopped";
  }
  const text = String(raw).trim();
  if (!text) return "—";
  if (isWebsiteStopped(text)) return "Stopped";
  if (isWebsiteRunning(text)) return "Running";
  return text;
}

/** 网站状态 → badge 色调（success / warn / danger / accent / muted） */
export function websiteStatusBadgeClass(status: string): string {
  const lower = status.trim().toLowerCase();
  if (!lower || lower === "—" || lower === "-" || lower === "unknown" || lower === "n/a") {
    return "badge badge-muted";
  }
  // 与 isWebsite* 同一判定顺序，避免「未启动」被当成成功态
  if (isWebsiteStopped(status)) {
    return "badge badge-danger";
  }
  if (isWebsiteRunning(status)) {
    return "badge badge-success";
  }
  if (
    lower === "starting" ||
    lower === "stopping" ||
    lower === "pending" ||
    lower === "busy" ||
    lower === "installing" ||
    lower.includes("等待")
  ) {
    return "badge badge-warn";
  }
  if (lower === "error" || lower === "failed" || lower === "abnormal" || lower.includes("异常") || lower.includes("错误")) {
    return "badge badge-danger";
  }
  return "badge badge-accent";
}

export function certificateRowId(row: Record<string, unknown>, index: number): string {
  return String(row.id ?? row.primaryDomain ?? row.domain ?? row.dns ?? index);
}

export function certificateRowLabel(row: Record<string, unknown>): string {
  // 1Panel SSLDTO 主字段为 primaryDomain；domains 是「其他域名」逗号串，勿优先
  return String(row.primaryDomain ?? row.domain ?? row.dns ?? row.name ?? "—");
}

function certificateExpire(row: Record<string, unknown>): string {
  return String(
    row.expireDate ?? row.endtime ?? row.notAfter ?? row.expiryDate ?? row.edate ?? "",
  ).trim();
}

/** 证书列表行：到期原文 + 剩余天数 */
export function certificateExpiryInfo(row: Record<string, unknown>): {
  expireRaw: string | null;
  daysLeft: number | null;
} {
  const expireRaw = certificateExpire(row) || null;
  if (!expireRaw) return { expireRaw: null, daysLeft: null };
  const date = parseCertificateExpireDate(expireRaw);
  return {
    expireRaw,
    daysLeft: date ? daysUntilCertificateExpiry(date) : null,
  };
}

export function certificateRowProvider(row: Record<string, unknown>): string {
  const raw = row.provider ?? row.organization ?? row.issuer ?? "";
  const text = String(raw).trim();
  return text || "—";
}

/** 证书申请方式原始值（dnsAccount / http / manual 等）。 */
export function certificateRowProviderKey(row: Record<string, unknown>): string {
  const text = String(row.provider ?? "").trim();
  return text || "—";
}

export function certificateRowStatus(row: Record<string, unknown>): string {
  const raw = row.status;
  if (raw == null || raw === "") return "—";
  return String(raw).trim() || "—";
}

export function certificateRowRemark(row: Record<string, unknown>): string {
  const raw = row.description ?? row.remark ?? row.desc;
  if (raw == null) return "";
  return String(raw).trim();
}

export function certificateRowAutoRenew(row: Record<string, unknown>): string {
  const raw = row.autoRenew ?? row.auto_renew;
  if (typeof raw === "boolean") return raw ? "true" : "false";
  if (raw == null || raw === "") return "—";
  return String(raw);
}

/** 自动续签开关状态；无法识别时返回 null。 */
export function certificateRowAutoRenewEnabled(row: Record<string, unknown>): boolean | null {
  const raw = row.autoRenew ?? row.auto_renew;
  if (typeof raw === "boolean") return raw;
  if (raw === 1 || raw === "1" || String(raw).toLowerCase() === "true" || String(raw).toLowerCase() === "yes") {
    return true;
  }
  if (raw === 0 || raw === "0" || String(raw).toLowerCase() === "false" || String(raw).toLowerCase() === "no") {
    return false;
  }
  return null;
}

/** 证书状态 → badge 色调 */
export function certificateStatusBadgeClass(status: string): string {
  const lower = status.trim().toLowerCase();
  if (!lower || lower === "—" || lower === "-" || lower === "unknown" || lower === "n/a") {
    return "badge badge-muted";
  }
  if (lower === "ready" || lower === "success" || lower === "ok" || lower.includes("正常") || lower.includes("成功")) {
    return "badge badge-success";
  }
  if (
    lower === "applying" ||
    lower === "pending" ||
    lower === "systemrestart" ||
    lower === "system_restart" ||
    lower.includes("申请中") ||
    lower.includes("进行中")
  ) {
    return "badge badge-warn";
  }
  if (lower === "init" || lower === "new" || lower.includes("待") || lower.includes("初始化")) {
    return "badge badge-accent";
  }
  if (
    lower === "error" ||
    lower === "applyerror" ||
    lower === "apply_error" ||
    lower === "failed" ||
    lower.includes("失败") ||
    lower.includes("错误") ||
    lower.includes("异常")
  ) {
    return "badge badge-danger";
  }
  return "badge badge-muted";
}

export function cronjobRowId(row: Record<string, unknown>, index: number): string {
  return String(row.id ?? row.name ?? row.title ?? index);
}

export function cronjobRowName(row: Record<string, unknown>): string {
  return String(row.name ?? row.title ?? row.id ?? "—");
}

export function cronjobRowSchedule(row: Record<string, unknown>): string {
  return String(row.spec ?? row.schedule ?? row.sName ?? row.cron ?? "").trim() || "—";
}

export function cronjobRowStatus(row: Record<string, unknown>): string {
  const raw = row.status ?? row.state;
  if (raw == null || raw === "") return "—";
  if (typeof raw === "boolean") return raw ? "Enable" : "Disable";
  if (typeof raw === "number") {
    if (raw === 1) return "Enable";
    if (raw === 0) return "Disable";
  }
  const text = String(raw).trim();
  if (text === "1") return "Enable";
  if (text === "0") return "Disable";
  return text || "—";
}

export function cronjobRowType(row: Record<string, unknown>): string {
  return String(row.type ?? row.scriptType ?? row.jobType ?? "").trim() || "—";
}

/** 解析证书到期时间（支持日期字符串 / ISO / Unix 秒或毫秒） */
export function parseCertificateExpireDate(raw: string): Date | null {
  const text = raw.trim();
  if (!text) return null;

  if (/^\d{10,13}$/.test(text)) {
    const num = Number(text);
    if (!Number.isFinite(num)) return null;
    const ms = text.length >= 13 ? num : num * 1000;
    const date = new Date(ms);
    return isPlausibleCertificateExpireDate(date) ? date : null;
  }

  // 常见面板格式：2026-12-31 / 2026-12-31 23:59:59 / 2026/12/31
  const normalized = text.includes("T") ? text : text.replace(/-/g, "/");
  const date = new Date(normalized);
  return isPlausibleCertificateExpireDate(date) ? date : null;
}

/** 过滤 1Panel 站点占位日（0001-01-01）与远古/超远日期，避免未绑证误判「已过期」 */
function isPlausibleCertificateExpireDate(date: Date): boolean {
  if (Number.isNaN(date.getTime())) return false;
  const year = date.getFullYear();
  return year >= 2000 && year <= 2100;
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** 距到期还有多少整天；已过期为负数；今天到期为 0 */
export function daysUntilCertificateExpiry(expire: Date, now = new Date()): number {
  const today = startOfLocalDay(now);
  const end = startOfLocalDay(expire);
  return Math.round((end.getTime() - today.getTime()) / 86_400_000);
}

export type WebsiteCertificateInfo = {
  /** 原始到期时间文案（tooltip / 复制用） */
  expireRaw: string | null;
  /** 剩余天数；无有效日期时为 null */
  daysLeft: number | null;
  /** 是否已绑定证书 */
  hasCert: boolean;
};

/** 1Panel：`sslStatus === "success"` 表示已绑定；其它面板无该字段时回退 SSL id。 */
export function isWebsiteSslBound(website: Record<string, unknown>): boolean {
  const status = String(website.sslStatus ?? website.ssl_status ?? "")
    .trim()
    .toLowerCase();
  if (status) return status === "success";
  return websiteSslId(website) != null;
}

/** 证书过期时间：优先网站行 `sslExpireDate`，其次嵌套 SSL 对象。 */
export function websiteSslExpireRaw(website: Record<string, unknown>): string {
  const direct = String(
    website.sslExpireDate ?? website.ssl_expire_date ?? website.sslExpire ?? "",
  ).trim();
  if (direct) return direct;
  const ssl = website.websiteSSL ?? website.webSiteSSL ?? website.ssl;
  if (ssl && typeof ssl === "object") {
    return certificateExpire(ssl as Record<string, unknown>);
  }
  return "";
}

/**
 * 从网站字段解析证书展示信息。
 * 事实源（1Panel）：`sslStatus=success` 已绑定，`sslExpireDate` 为过期时间。
 */
export function websiteCertificateInfo(
  website: Record<string, unknown>,
  _certificates: Record<string, unknown>[] = [],
): WebsiteCertificateInfo {
  if (!isWebsiteSslBound(website)) {
    return { expireRaw: null, daysLeft: null, hasCert: false };
  }

  const expireRawText = websiteSslExpireRaw(website);
  if (!expireRawText) {
    return { expireRaw: null, daysLeft: null, hasCert: true };
  }
  const date = parseCertificateExpireDate(expireRawText);
  if (!date) {
    // 占位日（如 0001-01-01）：已绑定但不展示假「已过期」
    return { expireRaw: null, daysLeft: null, hasCert: true };
  }
  return {
    expireRaw: expireRawText,
    daysLeft: daysUntilCertificateExpiry(date),
    hasCert: true,
  };
}

/** 证书剩余天数 → badge 色调（绿→黄→红连续渐变） */
const CERT_BADGE_FULL_GREEN_DAYS = 90;

export function websiteCertificateDaysBadgeClass(daysLeft: number | null): string {
  if (daysLeft == null) return "badge badge-muted";
  return "badge server-cert-days-badge";
}

/** 按剩余天数插值：≥90 天纯绿，0 天纯红，过期更深红 */
export function websiteCertificateDaysBadgeStyle(
  daysLeft: number | null,
): { color: string; background: string } | undefined {
  if (daysLeft == null) return undefined;

  // t: 0 = 红，1 = 绿
  const t =
    daysLeft <= 0 ? 0 : Math.min(1, daysLeft / CERT_BADGE_FULL_GREEN_DAYS);

  // 色相：0° 红 → 48° 黄 → 142° 绿（分段让中段偏黄更醒目）
  const hue = t <= 0.5 ? t * 2 * 48 : 48 + (t - 0.5) * 2 * (142 - 48);
  const lightness = daysLeft < 0 ? 34 : 38;
  const color = `hsl(${hue.toFixed(1)} 72% ${lightness}%)`;
  const background = `hsl(${hue.toFixed(1)} 72% ${lightness}% / 0.16)`;
  return { color, background };
}

/** 从网站自身字段解析展示用证书文案（兼容旧调用） */
export function websiteCertificateLabel(
  website: Record<string, unknown>,
  certificates: Record<string, unknown>[] = [],
): string {
  const info = websiteCertificateInfo(website, certificates);
  if (info.expireRaw) return info.expireRaw;
  if (info.hasCert) return "HTTPS";
  return "—";
}

export function makeServerTreeKey(
  serverId: string,
  category?: ServerDetailTab,
  itemId?: string,
): string {
  if (!category) return `server:${serverId}`;
  if (!itemId) return `server:${serverId}:${category}`;
  return `server:${serverId}:${category}:${itemId}`;
}

export function serverSupportsResources(server: ServerEntry): boolean {
  return isOnePanelService(server.serviceType) || isBtPanelService(server.serviceType);
}
