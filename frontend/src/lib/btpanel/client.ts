import { commands, type OmniError_Serialize } from "../../ipc/bindings";
import { canUseIpcBackend } from "../isTauriRuntime";
import { btDockerAppIconUrl } from "./appsMap";
import { buildBtAuthFields, normalizeBtPanelBaseUrl } from "./auth";
import {
  BtPanelApiError,
  type BtAddDatabaseParams,
  type BtAddSiteParams,
  type BtAddSiteResult,
  type BtCrontabParams,
  type BtDataListResult,
  type BtDirListResult,
  type BtDiskInfo,
  type BtFileBodyResult,
  type BtApp,
  type BtAppsParams,
  type BtAppsResult,
  type BtCreateAppParams,
  type BtCreateDockerAppParams,
  type BtDockerApp,
  type BtDockerAppsResult,
  type BtInstalledApp,
  type BtInstalledAppsParams,
  type BtInstalledAppsResult,
  type BtSoftItem,
  type BtSoftListParams,
  type BtSoftListResult,
  type BtNetworkInfo,
  type BtPhpVersion,
  type BtRequestOptions,
  type BtSite,
  type BtSiteSslInfo,
  type BtSiteType,
  type BtSystemTotal,
  type BtWebsiteListParams,
} from "./types";

export interface BtPanelClientOptions {
  host: string;
  apiSk: string;
  /** 连接 ID：apiSk 为空时从 Vault 解析密钥 */
  connectionId?: string;
  /** 默认 true：在有 IPC 后端时走 Rust 代理，避免浏览器 CORS 并复用 Cookie。 */
  useTauri?: boolean;
}

function formatIpcError(error: OmniError_Serialize): string {
  return error.cause ? `${error.message}（${error.cause}）` : error.message;
}

function serializeParams(params?: BtRequestOptions["params"]): string | null {
  if (!params) return null;
  const body: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value == null) continue;
    body[key] = value;
  }
  return Object.keys(body).length > 0 ? JSON.stringify(body) : null;
}

function enrichBtPanelErrorMessage(msg: string): string {
  const trimmed = msg.trim();
  if (!trimmed) return "宝塔 API 错误";

  // 宝塔「API 接口 → IP 白名单」未放行本机出口 IP
  const ipMatch = trimmed.match(/IP校验失败[^[]*\[([^\]]+)\]/i);
  if (ipMatch || /IP校验失败|IP.?校验|IP.?白名单/i.test(trimmed)) {
    const ip = ipMatch?.[1]?.trim();
    const ipHint = ip ? `当前访问 IP：${ip}。` : "";
    return (
      `${trimmed}。${ipHint}` +
      "请到宝塔面板「面板设置 → API 接口」将上述 IP 加入白名单（可填 * 临时关闭校验），保存后再试。"
    );
  }

  // 连续校验失败触发的临时封禁（常见于密钥错误或 IP 白名单未配好反复点「测试」）
  if (/连续\s*\d+\s*次验证失败|禁止\s*\d+\s*小时|验证失败.*禁止/i.test(trimmed)) {
    return (
      `${trimmed}。` +
      "这是宝塔侧临时封禁，不是 OmniPanel 故障。" +
      "请先到「面板设置 → API 接口」确认：① API 已开启；② 密钥正确；③ 已把访问 IP（如 10.110.10.6）加入白名单。" +
      "然后等待提示的封禁时长结束再测；期间请勿反复点「测试连接」。" +
      "若需立刻解禁，请在服务器上用宝塔官方方式清除 API/登录失败限制（不同版本菜单位置可能不同）。"
    );
  }

  return trimmed;
}

function parseResponseText<T>(text: string, tolerateFalseStatus = false): T {
  const trimmed = text.trim().replace(/^\uFEFF/, "");
  if (!trimmed) {
    throw new BtPanelApiError("宝塔面板返回空响应", 0);
  }
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("<!doctype") || lower.startsWith("<html")) {
    throw new BtPanelApiError("宝塔面板返回了 HTML 页面而非 JSON", 0, trimmed.slice(0, 300));
  }
  try {
    const payload = JSON.parse(trimmed) as unknown;
    if (payload && typeof payload === "object") {
      const obj = payload as { status?: boolean; msg?: string; code?: number };
      if (obj.status === false && !tolerateFalseStatus) {
        throw new BtPanelApiError(
          enrichBtPanelErrorMessage(obj.msg ?? "宝塔 API 错误"),
          0,
          trimmed.slice(0, 300),
        );
      }
      if (typeof obj.code === "number" && obj.code !== 0) {
        throw new BtPanelApiError(
          enrichBtPanelErrorMessage(obj.msg?.trim() || `宝塔 API 错误 (${obj.code})`),
          obj.code,
          trimmed.slice(0, 300),
        );
      }
    }
    return payload as T;
  } catch (error) {
    if (error instanceof BtPanelApiError) {
      throw error;
    }
    throw new BtPanelApiError("宝塔面板响应不是合法 JSON", 0, trimmed.slice(0, 300));
  }
}

/** Nginx vhost 配置默认路径。 */
export function btNginxVhostPath(siteName: string): string {
  return `/www/server/panel/vhost/nginx/${siteName}.conf`;
}

export class BtPanelClient {
  private readonly baseUrl: string;
  private apiSk: string;
  private readonly connectionId?: string;
  private readonly useTauri: boolean;
  private resolvePromise: Promise<string> | null = null;

  constructor(options: BtPanelClientOptions) {
    this.baseUrl = normalizeBtPanelBaseUrl(options.host);
    this.apiSk = options.apiSk;
    this.connectionId = options.connectionId;
    this.useTauri = options.useTauri ?? true;
  }

  private async resolveApiSk(): Promise<string> {
    if (this.apiSk.trim()) return this.apiSk;
    if (!this.connectionId) {
      throw new BtPanelApiError("缺少宝塔 API 密钥", 0);
    }
    if (!this.resolvePromise) {
      this.resolvePromise = (async () => {
        const result = await commands.panelResolveApiKey(this.connectionId!);
        if (result.status === "error") {
          throw new BtPanelApiError(formatIpcError(result.error), 0, result.error.cause ?? undefined);
        }
        this.apiSk = result.data;
        return this.apiSk;
      })();
    }
    return this.resolvePromise;
  }

  /** 原始 POST 请求。path 含 query，如 `/system?action=GetSystemTotal`。 */
  async request<T = unknown>(options: BtRequestOptions): Promise<T> {
    const path = options.path.startsWith("/") ? options.path : `/${options.path}`;
    const tolerate = Boolean(options.tolerateFalseStatus);
    const apiSk = await this.resolveApiSk();

    if (this.useTauri && canUseIpcBackend()) {
      const result = await commands.panelBtRequest(
        this.baseUrl,
        apiSk,
        path,
        serializeParams(options.params),
      );
      if (result.status === "error") {
        throw new BtPanelApiError(formatIpcError(result.error), 0, result.error.cause ?? undefined);
      }
      return parseResponseText<T>(result.data, tolerate);
    }

    return this.requestViaFetch<T>(path, apiSk, options.params, tolerate);
  }

  private async requestViaFetch<T>(
    path: string,
    apiSk: string,
    params?: BtRequestOptions["params"],
    tolerateFalseStatus = false,
  ): Promise<T> {
    const form = new URLSearchParams(buildBtAuthFields(apiSk));
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value == null) continue;
        form.set(key, String(value));
      }
    }

    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        Accept: "application/json, text/plain, */*",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form,
      credentials: "include",
    });

    const text = await res.text().catch(() => "");
    if (!res.ok) {
      const hint = res.status === 401 ? "API 接口密钥错误" : text || res.statusText;
      throw new BtPanelApiError(`宝塔 API 错误 (${res.status}): ${hint}`, res.status, text);
    }

    return parseResponseText<T>(text, tolerateFalseStatus);
  }

  /** 连通性测试（/system?action=GetSystemTotal）。 */
  async testConnection(): Promise<boolean> {
    try {
      await this.getSystemTotal();
      return true;
    } catch {
      return false;
    }
  }

  /** /system?action=GetSystemTotal — 系统基础统计。 */
  async getSystemTotal(): Promise<BtSystemTotal> {
    return this.request<BtSystemTotal>({ path: "/system?action=GetSystemTotal" });
  }

  /** /system?action=GetDiskInfo — 磁盘分区信息。 */
  async getDiskInfo(): Promise<BtDiskInfo[]> {
    return this.request<BtDiskInfo[]>({ path: "/system?action=GetDiskInfo" });
  }

  /** /system?action=GetNetWork — 实时 CPU/内存/网络/负载。 */
  async getNetwork(): Promise<BtNetworkInfo> {
    return this.request<BtNetworkInfo>({ path: "/system?action=GetNetWork" });
  }

  /** /ajax?action=GetTaskCount — 是否有安装任务。 */
  async getTaskCount(): Promise<number> {
    return this.request<number>({ path: "/ajax?action=GetTaskCount" });
  }

  /** /data?action=getData — 通用表查询。table 必须在 POST 体中，仅放 URL 会「指定参数无效」。 */
  private async getDataTable<T = Record<string, unknown>>(
    table: string,
    params: { p?: number; limit?: number; type?: number | string; search?: string; list?: boolean } = {},
  ): Promise<BtDataListResult<T>> {
    const data = await this.request<BtDataListResult<T>>({
      path: "/data?action=getData",
      params: {
        table,
        p: params.p ?? 1,
        limit: params.limit ?? 100,
        type: params.type ?? -1,
        ...(params.search ? { search: params.search } : {}),
        ...(params.list ? { list: "true" } : {}),
      },
    });
    return {
      data: data.data ?? [],
      page: data.page,
      where: data.where,
    };
  }

  /** /data?action=getData — 网站列表（table=sites）。 */
  async getWebsiteList(params: BtWebsiteListParams = {}): Promise<BtDataListResult<BtSite>> {
    return this.getDataTable<BtSite>("sites", {
      p: params.p,
      limit: params.limit ?? 15,
      type: params.type ?? -1,
      search: params.search,
    });
  }

  /** /site?action=get_site_types — 网站分类。 */
  async getSiteTypes(): Promise<BtSiteType[]> {
    const payload = await this.request<unknown>({ path: "/site?action=get_site_types" });
    if (Array.isArray(payload)) {
      return payload as BtSiteType[];
    }
    if (payload && typeof payload === "object") {
      const root = payload as Record<string, unknown>;
      if (Array.isArray(root.data)) return root.data as BtSiteType[];
      if (Array.isArray(root.list)) return root.list as BtSiteType[];
    }
    return [];
  }

  /** /site?action=GetPHPVersion — 已安装 PHP 版本。 */
  async getPhpVersions(): Promise<BtPhpVersion[]> {
    return this.request<BtPhpVersion[]>({ path: "/site?action=GetPHPVersion" });
  }

  /** /site?action=AddSite — 创建网站。 */
  async addSite(params: BtAddSiteParams): Promise<BtAddSiteResult> {
    const domainList = params.domainList ?? [];
    const webname = JSON.stringify({
      domain: params.domain,
      domainlist: domainList,
      count: domainList.length,
    });
    const result = await this.request<BtAddSiteResult>({
      path: "/site?action=AddSite",
      params: {
        webname,
        path: params.path,
        type: params.type ?? (params.version === "00" ? "" : "PHP"),
        version: params.version,
        port: params.port ?? "80",
        type_id: params.typeId ?? 0,
        ps: params.ps ?? "",
        ftp: params.ftp ? "true" : "false",
        sql: params.sql ? "true" : "false",
        codeing: params.codeing ?? "utf8mb4",
        datauser: params.datauser,
        datapassword: params.datapassword,
      },
    });
    if (result.siteStatus === false) {
      throw new BtPanelApiError(result.msg ?? "创建网站失败", 0);
    }
    return result;
  }

  /** /site?action=SiteStop — 停用网站。 */
  async stopWebsite(id: number, name: string): Promise<void> {
    await this.request({ path: "/site?action=SiteStop", params: { id, name } });
  }

  /** /site?action=SiteStart — 启用网站。 */
  async startWebsite(id: number, name: string): Promise<void> {
    await this.request({ path: "/site?action=SiteStart", params: { id, name } });
  }

  /** /site?action=DeleteSite — 删除网站。 */
  async deleteWebsite(
    id: number,
    webname: string,
    options?: { ftp?: boolean; database?: boolean; path?: boolean },
  ): Promise<void> {
    await this.request({
      path: "/site?action=DeleteSite",
      params: {
        id,
        webname,
        ...(options?.ftp ? { ftp: 1 } : {}),
        ...(options?.database ? { database: 1 } : {}),
        ...(options?.path ? { path: 1 } : {}),
      },
    });
  }

  /** /data?action=setPs — 修改网站备注。 */
  async setSiteRemark(id: number, ps: string): Promise<void> {
    await this.request({
      path: "/data?action=setPs",
      params: { table: "sites", id, ps },
    });
  }

  /** /site?action=SetPHPVersion — 切换网站 PHP 版本。 */
  async setSitePhpVersion(siteName: string, version: string): Promise<void> {
    await this.request({
      path: "/site?action=SetPHPVersion",
      params: { siteName, version },
    });
  }

  /** /site?action=GetSitePHPVersion — 当前网站 PHP 版本。 */
  async getSitePhpVersion(siteName: string): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>({
      path: "/site?action=GetSitePHPVersion",
      params: { siteName },
    });
  }

  /** /site?action=GetSiteDomains — 域名列表。 */
  async getSiteDomains(id: number): Promise<unknown> {
    return this.request({
      path: "/site?action=GetSiteDomains",
      params: { id },
    });
  }

  /** /site?action=GetSiteLogs — 访问日志（内容在 msg）。 */
  async getSiteAccessLogs(siteName: string): Promise<string> {
    const data = await this.request<{ status?: boolean; msg?: string }>({
      path: "/site?action=GetSiteLogs",
      params: { siteName },
    });
    return typeof data.msg === "string" ? data.msg : "";
  }

  /** /site?action=get_site_errlog — 错误日志。 */
  async getSiteErrorLogs(siteName: string): Promise<string> {
    const data = await this.request<{ status?: boolean; msg?: string; data?: string }>({
      path: "/site?action=get_site_errlog",
      params: { siteName },
    });
    if (typeof data.msg === "string" && data.msg.length > 0) return data.msg;
    if (typeof data.data === "string") return data.data;
    return "";
  }

  /** /site?action=GetSSL — 站点 SSL 信息（未部署时 status=false）。 */
  async getSiteSsl(siteName: string): Promise<BtSiteSslInfo> {
    return this.request<BtSiteSslInfo>({
      path: "/site?action=GetSSL",
      params: { siteName },
      tolerateFalseStatus: true,
    });
  }

  /** /site?action=SetSSL — 部署自定义证书到站点。 */
  async setSiteSsl(siteName: string, key: string, csr: string): Promise<void> {
    await this.request({
      path: "/site?action=SetSSL",
      params: { siteName, key, csr },
    });
  }

  /** /site?action=CloseSSLConf — 关闭站点 SSL。 */
  async closeSiteSsl(siteName: string): Promise<void> {
    await this.request({
      path: "/site?action=CloseSSLConf",
      params: { siteName, updateOf: 1 },
    });
  }

  /** /ssl?action=remove_cert — 从证书夹删除证书（优先 hash）。 */
  async removeSslCert(params: { id?: number | string; hash?: string }): Promise<void> {
    const sslHash = params.hash?.trim();
    if (sslHash) {
      await this.request({
        path: "/ssl?action=remove_cert",
        params: { ssl_hash: sslHash, hash: sslHash },
      });
      return;
    }
    if (params.id == null) {
      throw new BtPanelApiError("缺少证书 hash/id，无法删除", 0);
    }
    await this.request({
      path: "/ssl?action=remove_cert",
      params: { id: params.id, ssl_id: params.id },
    });
  }

  /** /files?action=GetDir — 目录列表。 */
  async getDir(path: string, p = 1): Promise<BtDirListResult> {
    return this.request<BtDirListResult>({
      path: "/files?action=GetDir",
      params: { path, p },
    });
  }

  /** /files?action=GetFileBody — 读文件。 */
  async getFileBody(path: string): Promise<BtFileBodyResult> {
    return this.request<BtFileBodyResult>({
      path: "/files?action=GetFileBody",
      params: { path },
    });
  }

  /** /files?action=SaveFileBody — 写文件。 */
  async saveFileBody(path: string, data: string, encoding = "utf-8"): Promise<void> {
    await this.request({
      path: "/files?action=SaveFileBody",
      params: { path, data, encoding },
    });
  }

  /** 读取站点 Nginx 配置。 */
  async getNginxConfig(siteName: string): Promise<{ path: string; content: string }> {
    const path = btNginxVhostPath(siteName);
    const body = await this.getFileBody(path);
    const content = typeof body.data === "string" ? body.data : "";
    if (!content && body.status === false) {
      throw new BtPanelApiError(body.msg ?? `无法读取配置：${path}`, 0);
    }
    return { path, content };
  }

  /** 保存站点 Nginx 配置。 */
  async saveNginxConfig(siteName: string, content: string): Promise<void> {
    await this.saveFileBody(btNginxVhostPath(siteName), content);
  }

  /**
   * 获取应用商店图标（data URL）。
   * 面板安全入口会拦截匿名 /static 访问，因此经 Rust 鉴权下载磁盘图标。
   * @param iconFile 软件商店 icon 字段（如 `ico-redis.png`）；Docker 商店可省略。
   */
  async getAppIconDataUrl(appName: string, iconFile?: string | null): Promise<string> {
    const name = appName.trim();
    if (!name) {
      throw new BtPanelApiError("应用名称不能为空", 0);
    }
    const file = (iconFile ?? "").trim() || null;
    if (this.useTauri && canUseIpcBackend()) {
      const apiSk = await this.resolveApiSk();
      const result = await commands.panelBtAppIcon(this.baseUrl, apiSk, name, file);
      if (result.status === "error") {
        throw new BtPanelApiError(formatIpcError(result.error), 0, result.error.cause ?? undefined);
      }
      return result.data;
    }
    // 浏览器开发态：直接拼 URL（需地址含安全入口，且可能受 CORS 限制）
    if (file) {
      const base = this.baseUrl.replace(/\/$/, "");
      const basename = file.replace(/^.*[/\\]/, "");
      return `${base}/static/img/soft_ico/${basename}`;
    }
    return btDockerAppIconUrl(this.baseUrl, name);
  }

  /** POST /mod/docker/com/get_apps — Docker 应用商店列表。 */
  async getApps(params: BtAppsParams = {}): Promise<BtAppsResult> {
    const payload = await this.request<unknown>({
      path: "/mod/docker/com/get_apps",
      params: {
        p: params.p ?? 1,
        row: params.row ?? 200,
        query: params.query ?? "",
        force: params.force ?? 0,
        app_type: params.appType ?? "all",
      },
    });
    return unwrapAppsPayload(payload);
  }

  /** POST /mod/docker/com/get_installed_apps — Docker 已安装应用列表。 */
  async getInstalledApps(params: BtInstalledAppsParams = {}): Promise<BtInstalledAppsResult> {
    const payload = await this.request<unknown>({
      path: "/mod/docker/com/get_installed_apps",
      params: {
        app_type: params.appType ?? "all",
        p: params.p ?? 1,
        row: params.row ?? 20,
        query: params.query ?? "",
      },
    });
    return unwrapAppsPayload(payload) as BtInstalledAppsResult;
  }

  /** POST /mod/docker/com/create_app — 从应用商店安装 Docker 应用。 */
  async createApp(params: BtCreateAppParams): Promise<void> {
    const allowAccess =
      params.allowAccess === false || params.allowAccess === "0" ? "0" : "1";
    await this.request({
      path: "/mod/docker/com/create_app",
      params: {
        ...(params.extras ?? {}),
        app_name: params.appName,
        service_name: params.serviceName,
        m_version: params.mVersion,
        s_version: params.sVersion,
        allow_access: allowAccess,
        ...(params.cpus != null ? { cpus: params.cpus } : {}),
        ...(params.memoryLimit != null ? { memory_limit: params.memoryLimit } : {}),
        ...(params.disableDomain === true || params.disableDomain === "1"
          ? { disable_domain: "1" }
          : {}),
      },
    });
  }

  /**
   * POST /plugin?action=get_soft_list — 传统软件商店列表（Nginx/PHP/插件等）。
   * 多数面板版本可用；Docker 商店未初始化时以此作为应用市场主数据源。
   */
  async getSoftList(params: BtSoftListParams = {}): Promise<BtSoftListResult> {
    const payload = await this.request<unknown>({
      path: "/plugin?action=get_soft_list",
      params: {
        p: params.p ?? 1,
        type: params.type ?? 0,
        query: params.query ?? "",
        force: params.force ? 1 : 0,
        row: params.row ?? 100,
      },
    });
    return unwrapSoftList(payload);
  }

  /** POST /plugin?action=install_plugin — 安装软件商店应用（异步任务）。 */
  async installSoft(name: string, version: string): Promise<string> {
    const result = await this.request<{ msg?: string; status?: boolean }>({
      path: "/plugin?action=install_plugin",
      params: {
        sName: name,
        version,
        min_version: version,
        type: 0,
      },
    });
    return result.msg?.trim() || "已提交安装任务";
  }

  /**
   * POST /mod/docker/com/get_apps[/stype] — Docker 应用商店列表。
   * 官方文档路径带 `/stype`；旧版无后缀时自动回退。
   */
  async getDockerApps(): Promise<BtDockerAppsResult> {
    try {
      const payload = await this.request<unknown>({
        path: "/mod/docker/com/get_apps/stype",
      });
      return unwrapDockerApps(payload);
    } catch (error) {
      if (!(error instanceof BtPanelApiError)) throw error;
      const payload = await this.request<unknown>({
        path: "/mod/docker/com/get_apps",
      });
      return unwrapDockerApps(payload);
    }
  }

  /**
   * POST /mod/docker/com/create_app[/stype] — 从商店安装 Docker 应用。
   * 安装参数需来自 getDockerApps 返回的 env/field/appversion。
   */
  async createDockerApp(params: BtCreateDockerAppParams): Promise<string> {
    const body: Record<string, string | number | boolean | undefined | null> = {
      app_name: params.appName,
      service_name: params.serviceName,
      m_version: params.mVersion,
      s_version: params.sVersion,
      allow_access: params.allowAccess === false ? "0" : "1",
      ...(params.cpus != null ? { cpus: params.cpus } : {}),
      ...(params.memoryLimit != null ? { memory_limit: params.memoryLimit } : {}),
      ...(params.disableDomain ? { disable_domain: "1" } : {}),
      ...(params.extra ?? {}),
    };
    try {
      const result = await this.request<{ msg?: string; status?: boolean }>({
        path: "/mod/docker/com/create_app/stype",
        params: body,
      });
      return result.msg?.trim() || "应用创建成功";
    } catch (error) {
      if (!(error instanceof BtPanelApiError)) throw error;
      const result = await this.request<{ msg?: string; status?: boolean }>({
        path: "/mod/docker/com/create_app",
        params: body,
      });
      return result.msg?.trim() || "应用创建成功";
    }
  }

  /** 按默认参数从商店定义安装应用（MVP）。 */
  async installDockerAppFromDefinition(
    app: BtDockerApp,
    options?: { serviceName?: string },
  ): Promise<string> {
    const appName = (app.appname || "").trim();
    if (!appName) {
      throw new BtPanelApiError("应用标识为空", 0);
    }
    const version = pickDockerAppVersion(app);
    if (!version) {
      throw new BtPanelApiError("无法获取应用版本信息", 0);
    }
    const extra = buildDockerAppDefaultParams(app);
    const isWebsite = (app.apptype || "").toLowerCase().includes("website");
    const serviceName =
      (options?.serviceName || "").trim() ||
      `docker_${appName}`.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 48);
    return this.createDockerApp({
      appName,
      serviceName,
      mVersion: version.mVersion,
      sVersion: version.sVersion,
      allowAccess: true,
      disableDomain: isWebsite,
      extra,
    });
  }

  /** /data?action=getData — 数据库列表（table=databases）。 */
  async getDatabaseList(params: { p?: number; limit?: number } = {}): Promise<BtDataListResult<Record<string, unknown>>> {
    return this.getDataTable("databases", {
      p: params.p,
      limit: params.limit ?? 100,
    });
  }

  /** /database?action=AddDatabase — 创建数据库。 */
  async addDatabase(params: BtAddDatabaseParams): Promise<void> {
    await this.request({
      path: "/database?action=AddDatabase",
      params: {
        sid: params.sid ?? 0,
        name: params.name,
        db_user: params.dbUser,
        password: params.password,
        address: params.address ?? "127.0.0.1",
        codeing: params.codeing ?? "utf8mb4",
        ps: params.ps ?? "",
        ...(params.pid != null ? { pid: params.pid } : {}),
      },
    });
  }

  /** /database?action=DeleteDatabase — 删除数据库。 */
  async deleteDatabase(params: {
    id: number;
    name: string;
    dbUser: string;
    sid?: number;
  }): Promise<void> {
    await this.request({
      path: "/database?action=DeleteDatabase",
      params: {
        id: params.id,
        sid: params.sid ?? 0,
        name: params.name,
        db_user: params.dbUser,
      },
    });
  }

  /** /data?action=getData — 计划任务列表（table=crontab）。 */
  async getCronList(params: { p?: number; limit?: number } = {}): Promise<BtDataListResult<Record<string, unknown>>> {
    return this.getDataTable("crontab", {
      p: params.p,
      limit: params.limit ?? 100,
    });
  }

  /** /crontab?action=get_crond_find — 单个计划任务详情。 */
  async getCronDetail(id: number): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>({
      path: "/crontab?action=get_crond_find",
      params: { id },
    });
  }

  /** /crontab?action=AddCrontab — 创建计划任务。 */
  async addCrontab(params: BtCrontabParams): Promise<void> {
    await this.request({
      path: "/crontab?action=AddCrontab",
      params: {
        name: params.name,
        type: params.type,
        where1: params.where1,
        sType: params.sType,
        sBody: params.sBody,
        sName: params.sName ?? "",
        save: params.save ?? 0,
        backupTo: params.backupTo ?? "localhost",
        hour: params.hour ?? "",
        minute: params.minute ?? "",
        week: params.week ?? "",
      },
    });
  }

  /** /crontab?action=modify_crond — 修改计划任务。 */
  async modifyCrontab(id: number, params: BtCrontabParams): Promise<void> {
    await this.request({
      path: "/crontab?action=modify_crond",
      params: {
        id,
        name: params.name,
        type: params.type,
        where1: params.where1,
        sType: params.sType,
        sBody: params.sBody,
        sName: params.sName ?? "",
        save: params.save ?? 0,
        backupTo: params.backupTo ?? "localhost",
        hour: params.hour ?? "",
        minute: params.minute ?? "",
        week: params.week ?? "",
      },
    });
  }

  /** /crontab?action=DelCrontab — 删除计划任务。 */
  async deleteCrontab(id: number): Promise<void> {
    await this.request({
      path: "/crontab?action=DelCrontab",
      params: { id },
    });
  }

  /** /crontab?action=set_cron_status — 切换计划任务启用状态。 */
  async setCronStatus(id: number): Promise<void> {
    await this.request({
      path: "/crontab?action=set_cron_status",
      params: { id },
    });
  }

  /** /crontab?action=StartTask — 立即执行一次计划任务。 */
  async startCronTask(id: number): Promise<void> {
    await this.request({
      path: "/crontab?action=StartTask",
      params: { id },
    });
  }

  /** /ssl?action=get_cert_list — 证书夹列表（官方接口；旧 GetSSLList 会报参数无效）。 */
  async getSslList(): Promise<Record<string, unknown>[]> {
    try {
      const data = await this.request<unknown>({
        path: "/ssl?action=get_cert_list",
        tolerateFalseStatus: true,
      });
      return normalizeBtCertList(data);
    } catch {
      // 兼容旧面板：已部署证书概览
      const data = await this.request<unknown>({
        path: "/ssl?action=GetCertList",
        tolerateFalseStatus: true,
      });
      return normalizeBtCertList(data);
    }
  }
}

function normalizeBtCertList(payload: unknown): Record<string, unknown>[] {
  const rows = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object" && Array.isArray((payload as { data?: unknown }).data)
      ? ((payload as { data: unknown[] }).data)
      : [];

  return rows
    .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object")
    .map((row) => {
      const info =
        row.info && typeof row.info === "object"
          ? (row.info as Record<string, unknown>)
          : {};
      const dnsRaw = row.dns;
      const dnsList = Array.isArray(dnsRaw)
        ? dnsRaw.map(String)
        : typeof dnsRaw === "string" && dnsRaw.trim()
          ? [dnsRaw.trim()]
          : [];
      const subject = String(row.subject ?? dnsList[0] ?? "").trim();
      return {
        ...row,
        primaryDomain: subject || dnsList[0] || "",
        domain: subject || dnsList.join(","),
        dns: dnsList.join(",") || subject,
        expireDate: String(info.notAfter ?? row.notAfter ?? row.endtime ?? "").trim(),
        hash: row.hash ?? row.ssl_hash,
      };
    });
}

function parseTotalFromPage(page: unknown, fallback: number): number {
  if (typeof page !== "string") return fallback;
  const match = page.match(/共(\d+)条/);
  if (!match) return fallback;
  const total = Number(match[1]);
  return Number.isFinite(total) ? total : fallback;
}

/** 解析宝塔 Docker 应用列表（get_apps / get_installed_apps 同构：data + page）。 */
function unwrapAppsPayload<T = BtApp | BtInstalledApp>(
  payload: unknown,
): { items: T[]; total: number; page?: string } {
  if (Array.isArray(payload)) {
    return { items: payload as T[], total: payload.length };
  }
  if (!payload || typeof payload !== "object") {
    return { items: [], total: 0 };
  }

  const root = payload as Record<string, unknown>;
  if (Array.isArray(root.data)) {
    const items = root.data as T[];
    return {
      items,
      total: parseTotalFromPage(root.page, items.length),
      page: typeof root.page === "string" ? root.page : undefined,
    };
  }

  return { items: [], total: 0 };
}

function unwrapSoftList(payload: unknown): BtSoftListResult {
  if (!payload || typeof payload !== "object") {
    return { items: [], total: 0, types: [] };
  }
  const root = payload as Record<string, unknown>;
  const listRoot = root.list;
  let items: BtSoftItem[] = [];
  let total = 0;
  if (Array.isArray(listRoot)) {
    items = listRoot as BtSoftItem[];
    total = items.length;
  } else if (listRoot && typeof listRoot === "object") {
    const obj = listRoot as Record<string, unknown>;
    if (Array.isArray(obj.data)) {
      items = obj.data as BtSoftItem[];
      total = parseTotalFromPage(obj.page, items.length);
    }
  }
  const typesRaw = root.type;
  const types: Array<{ id: number; title: string }> = [];
  if (Array.isArray(typesRaw)) {
    for (const item of typesRaw) {
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      const id = Number(row.id);
      const title = String(row.title ?? row.name ?? "").trim();
      if (Number.isFinite(id) && title) types.push({ id, title });
    }
  }
  return {
    items: items.filter((item) => item && typeof item.name === "string" && item.name.trim()),
    total,
    types,
  };
}

function unwrapDockerApps(payload: unknown): BtDockerAppsResult {
  if (Array.isArray(payload)) {
    return { items: payload as BtDockerApp[], total: payload.length };
  }
  if (!payload || typeof payload !== "object") {
    return { items: [], total: 0 };
  }
  const root = payload as Record<string, unknown>;
  const list = Array.isArray(root.data)
    ? root.data
    : Array.isArray(root.list)
      ? root.list
      : Array.isArray(root.apps)
        ? root.apps
        : null;
  if (!list) return { items: [], total: 0 };
  const items = (list as BtDockerApp[]).filter((item) => item && typeof item.appname === "string");
  return { items, total: items.length };
}

function pickDockerAppVersion(app: BtDockerApp): { mVersion: string; sVersion: string } | null {
  const versions = app.appversion;
  if (!Array.isArray(versions) || versions.length === 0) {
    const raw = (app.version || "").trim();
    if (!raw) return null;
    const [m, ...rest] = raw.split(".");
    return { mVersion: m || raw, sVersion: rest.join(".") || "0" };
  }
  const first = versions[0];
  if (!first) return null;
  const mVersion = String(first.m_version ?? "").trim();
  const sRaw = first.s_version;
  const sVersion = Array.isArray(sRaw)
    ? String(sRaw[0] ?? "0").trim()
    : String(sRaw ?? "0").trim();
  if (!mVersion) return null;
  return { mVersion, sVersion: sVersion || "0" };
}

function randomPort(): number {
  return 30000 + Math.floor(Math.random() * 10000);
}

function randomSecret(length = 16): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)]!;
  }
  return out;
}

/** 从 get_apps 的 env/field 生成默认安装参数。 */
function buildDockerAppDefaultParams(app: BtDockerApp): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  const applyDefault = (key: string, type: string | undefined, fallback: unknown) => {
    if (!key || key in out) return;
    if (fallback !== undefined && fallback !== null && fallback !== "") {
      if (typeof fallback === "string" || typeof fallback === "number" || typeof fallback === "boolean") {
        out[key] = fallback;
        return;
      }
    }
    const lowerType = (type || "").toLowerCase();
    const lowerKey = key.toLowerCase();
    if (lowerType === "port" || lowerKey.endsWith("_port") || lowerKey === "port") {
      out[key] = randomPort();
      return;
    }
    if (
      lowerType === "password" ||
      lowerKey.includes("password") ||
      lowerKey.includes("passwd") ||
      lowerKey.includes("secret")
    ) {
      out[key] = randomSecret(16);
      return;
    }
    if (lowerType === "checkbox" || lowerType === "bool" || lowerType === "boolean") {
      out[key] = true;
    }
  };

  for (const field of app.field ?? []) {
    applyDefault(String(field.attr ?? "").trim(), field.type, field.default);
  }
  for (const env of app.env ?? []) {
    const key = String(env.key ?? "").trim();
    if (key === "version") {
      const ver = pickDockerAppVersion(app);
      if (ver) out.version = `${ver.mVersion}.${ver.sVersion}`;
      continue;
    }
    applyDefault(key, env.type, env.default);
  }
  return out;
}

/** 从服务器连接配置创建客户端。connectionId 用于 Vault 中空密钥时回源。 */
export function createBtPanelClient(
  host: string,
  apiSk: string,
  connectionId?: string,
): BtPanelClient {
  return new BtPanelClient({ host, apiSk, connectionId });
}
