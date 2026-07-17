import { commands, type OmniError_Serialize } from "../../ipc/bindings";
import { buildOnePanelAuthHeaders, normalizeOnePanelBaseUrl } from "./auth";
import {
  OnePanelApiError,
  type OnePanelAcmeAccount,
  type OnePanelApiEnvelope,
  type OnePanelDashboardBase,
  type OnePanelDashboardCurrent,
  type OnePanelDeviceBase,
  type OnePanelDnsAccount,
  type OnePanelFileEntry,
  type OnePanelGroup,
  type OnePanelHostInfo,
  type OnePanelInstalledApp,
  type OnePanelInstalledSearchParams,
  type OnePanelInstalledSearchResult,
  type OnePanelApp,
  type OnePanelAppDetail,
  type OnePanelAppInstallCreate,
  type OnePanelAppSearchParams,
  type OnePanelAppSearchResult,
  type OnePanelAppTag,
  type OnePanelMonitorData,
  type OnePanelProcess,
  type OnePanelRequestOptions,
  type OnePanelRuntime,
  type OnePanelWebsiteCreate,
  type OnePanelWebsiteSslCreate,
  type OnePanelWebsiteSslUpload,
  type OnePanelWebsiteSslUpdate,
  type OnePanelWebsiteUpdate,
  type OnePanelCronjobCreate,
  type OnePanelCronjobUpdate,
} from "./types";

export interface OnePanelClientOptions {
  host: string;
  apiKey: string;
  /** 默认 true：在 Tauri 环境走 Rust 后端，避免 WebView CORS。 */
  useTauri?: boolean;
}

function unwrapEnvelope<T>(payload: unknown): T {
  if (payload == null) {
    throw new OnePanelApiError("1Panel 返回空响应", 0);
  }
  if (typeof payload === "object" && payload !== null && "data" in payload) {
    const envelope = payload as OnePanelApiEnvelope<T>;
    if (envelope.code != null && envelope.code !== 200) {
      throw new OnePanelApiError(envelope.message ?? `1Panel API 错误 (${envelope.code})`, envelope.code);
    }
    return envelope.data as T;
  }
  return payload as T;
}

function unwrapList<T>(payload: unknown): T[] {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    if (Array.isArray(obj.items)) return obj.items as T[];
    if (Array.isArray(obj.list)) return obj.list as T[];
    if (Array.isArray(obj.records)) return obj.records as T[];
  }
  return [];
}

function buildQueryString(query?: OnePanelRequestOptions["query"]): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value == null) continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function formatIpcError(error: OmniError_Serialize): string {
  return error.cause ? `${error.message}（${error.cause}）` : error.message;
}

function serializeRequestBody(method: string, body?: unknown): string | null {
  if (body != null) {
    return JSON.stringify(body);
  }
  if (method === "POST" || method === "PUT" || method === "PATCH") {
    return "{}";
  }
  return null;
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function parseContentDispositionFilename(header: string): string | null {
  const trimmed = header.trim();
  if (!trimmed) return null;

  const starMatch = /filename\*\s*=\s*([^;]+)/i.exec(trimmed);
  if (starMatch?.[1]) {
    let value = starMatch[1].trim().replace(/^"|"$/g, "");
    const encoded = value.includes("''") ? value.split("''").slice(1).join("''") : value;
    try {
      const decoded = decodeURIComponent(encoded);
      if (decoded) return decoded;
    } catch {
      if (encoded) return encoded;
    }
  }

  const plainMatch = /filename\s*=\s*([^;]+)/i.exec(trimmed);
  if (plainMatch?.[1]) {
    const value = plainMatch[1].trim().replace(/^"|"$/g, "");
    if (value) return value;
  }
  return null;
}

function parseFileLineContent(data: Record<string, unknown> | null | undefined): {
  content: string;
  end?: boolean;
  path?: string;
} {
  const content =
    typeof data?.content === "string"
      ? data.content
      : Array.isArray(data?.lines)
        ? (data.lines as unknown[]).map(String).join("\n")
        : "";
  return {
    content,
    end: Boolean(data?.end),
    path: typeof data?.path === "string" ? data.path : undefined,
  };
}

function parseResponseText<T>(text: string): T {
  const trimmed = text.trim().replace(/^\uFEFF/, "");
  if (!trimmed) {
    throw new OnePanelApiError("1Panel 返回空响应", 0);
  }
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("<!doctype") || lower.startsWith("<html")) {
    throw new OnePanelApiError("1Panel 返回了 HTML 页面而非 JSON", 0, trimmed.slice(0, 300));
  }
  try {
    return unwrapEnvelope<T>(JSON.parse(trimmed));
  } catch (error) {
    if (error instanceof OnePanelApiError) {
      throw error;
    }
    throw new OnePanelApiError("1Panel 响应不是合法 JSON", 0, trimmed.slice(0, 300));
  }
}

export class OnePanelClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly useTauri: boolean;

  constructor(options: OnePanelClientOptions) {
    this.baseUrl = normalizeOnePanelBaseUrl(options.host);
    this.apiKey = options.apiKey;
    this.useTauri = options.useTauri ?? true;
  }

  /** 原始请求：path 不含 `/api/v2` 前缀，如 `/toolbox/device/base`。 */
  async request<T = unknown>(options: OnePanelRequestOptions): Promise<T> {
    const method = (options.method ?? "GET").toUpperCase();
    const path = options.path.startsWith("/") ? options.path : `/${options.path}`;
    const pathWithQuery = `${path}${buildQueryString(options.query)}`;

    if (this.useTauri && isTauriRuntime()) {
      const result = await commands.panel1panelRequest(
        this.baseUrl,
        this.apiKey,
        method,
        pathWithQuery,
        serializeRequestBody(method, options.body),
      );
      if (result.status === "error") {
        throw new OnePanelApiError(formatIpcError(result.error), 0, result.error.cause ?? undefined);
      }
      return parseResponseText<T>(result.data);
    }

    return this.requestViaFetch<T>(method, pathWithQuery, options.body);
  }

  /** 原始文本响应（日志下载等非 JSON 接口）。 */
  async requestText(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<string> {
    const upperMethod = method.toUpperCase();
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;

    if (this.useTauri && isTauriRuntime()) {
      const result = await commands.panel1panelRequestText(
        this.baseUrl,
        this.apiKey,
        upperMethod,
        normalizedPath,
        serializeRequestBody(upperMethod, body),
      );
      if (result.status === "error") {
        throw new OnePanelApiError(formatIpcError(result.error), 0, result.error.cause ?? undefined);
      }
      return result.data;
    }

    return this.requestTextViaFetch(upperMethod, normalizedPath, body);
  }

  private async requestTextViaFetch(method: string, path: string, body?: unknown): Promise<string> {
    const timestamp = Math.floor(Date.now() / 1000);
    const hasBody = body != null || method === "POST" || method === "PUT" || method === "PATCH";
    const res = await fetch(`${this.baseUrl}/api/v2${path}`, {
      method,
      headers: {
        Accept: "application/json, text/plain, */*",
        ...(hasBody ? { "Content-Type": "application/json" } : {}),
        ...buildOnePanelAuthHeaders(this.apiKey, timestamp),
      },
      body: hasBody ? JSON.stringify(body ?? {}) : undefined,
    });

    const text = await res.text().catch(() => "");
    if (!res.ok) {
      const hint = res.status === 401 ? "API 接口密钥错误" : text || res.statusText;
      throw new OnePanelApiError(`1Panel API 错误 (${res.status}): ${hint}`, res.status, text);
    }
    return text;
  }

  /** POST /containers/download/log — 下载 Compose 应用日志文本。 */
  async downloadComposeLogs(composePath: string, tail = 500): Promise<string> {
    return this.requestText("POST", "/containers/download/log", {
      container: composePath,
      since: "all",
      tail,
      containerType: "compose",
    });
  }

  private async requestViaFetch<T>(method: string, pathWithQuery: string, body?: unknown): Promise<T> {
    const timestamp = Math.floor(Date.now() / 1000);
    const hasBody = body != null || method === "POST" || method === "PUT" || method === "PATCH";
    const res = await fetch(`${this.baseUrl}/api/v2${pathWithQuery}`, {
      method,
      headers: {
        Accept: "application/json",
        ...(hasBody ? { "Content-Type": "application/json" } : {}),
        ...buildOnePanelAuthHeaders(this.apiKey, timestamp),
      },
      body: hasBody ? JSON.stringify(body ?? {}) : undefined,
    });

    const text = await res.text().catch(() => "");
    if (!res.ok) {
      const hint = res.status === 401 ? "API 接口密钥错误" : text || res.statusText;
      throw new OnePanelApiError(`1Panel API 错误 (${res.status}): ${hint}`, res.status, text);
    }

    return parseResponseText<T>(text);
  }

  /** 连通性测试（官方文档示例接口）。 */
  async testConnection(): Promise<boolean> {
    try {
      await this.getDeviceBase();
      return true;
    } catch {
      return false;
    }
  }

  /** POST /toolbox/device/base — 设备基础信息。 */
  async getDeviceBase(): Promise<OnePanelDeviceBase> {
    return this.request<OnePanelDeviceBase>({
      method: "POST",
      path: "/toolbox/device/base",
    });
  }

  /** GET /dashboard/base/os — OS 与磁盘摘要。 */
  async getOsInfo(): Promise<OnePanelDashboardBase> {
    return this.request<OnePanelDashboardBase>({ method: "GET", path: "/dashboard/base/os" });
  }

  /** GET /dashboard/base/:ioOption/:netOption — 仪表盘基础信息与实时指标。 */
  async getDashboardBase(ioOption = "all", netOption = "all"): Promise<OnePanelDashboardBase> {
    return this.request<OnePanelDashboardBase>({
      method: "GET",
      path: `/dashboard/base/${ioOption}/${netOption}`,
    });
  }

  /** GET /dashboard/current/:ioOption/:netOption — 仪表盘实时指标。 */
  async getDashboardCurrent(ioOption = "all", netOption = "all"): Promise<OnePanelDashboardCurrent> {
    return this.request<OnePanelDashboardCurrent>({
      method: "GET",
      path: `/dashboard/current/${ioOption}/${netOption}`,
    });
  }

  /** POST /hosts/monitor/search — 监控历史时序。 */
  async searchMonitorHistory(params: {
    param: "all" | "cpu" | "memory" | "load" | "io" | "network";
    startTime: string;
    endTime: string;
    io?: string;
    network?: string;
  }): Promise<OnePanelMonitorData> {
    return this.request<OnePanelMonitorData>({
      method: "POST",
      path: "/hosts/monitor/search",
      body: {
        param: params.param,
        io: params.io ?? "",
        network: params.network ?? "",
        startTime: params.startTime,
        endTime: params.endTime,
      },
    });
  }

  /** GET /dashboard/current/top/cpu|mem — Top 进程。 */
  async getTopProcesses(kind: "cpu" | "mem" = "cpu"): Promise<OnePanelProcess[]> {
    const data = await this.request<OnePanelProcess[] | { items?: OnePanelProcess[] }>({
      method: "GET",
      path: `/dashboard/current/top/${kind}`,
    });
    return unwrapList(data);
  }

  /** POST /process/listening — 监听端口进程（备用）。 */
  async getProcesses(_body: Record<string, unknown> = {}): Promise<OnePanelProcess[]> {
    return this.getTopProcesses("cpu");
  }

  /** GET /dashboard/base/os — 主机信息摘要。 */
  async getHostInfo(): Promise<OnePanelHostInfo> {
    const base = await this.getOsInfo();
    return {
      hostname: base.hostname ?? "",
      os: base.os ?? "",
      kernel: base.kernelVersion ?? "",
      platformVersion: base.platformVersion ?? "",
      platform: base.platform ?? "",
    };
  }

  /** POST /websites — 创建网站。 */
  async createWebsite(body: OnePanelWebsiteCreate): Promise<void> {
    await this.request({
      method: "POST",
      path: "/websites",
      body,
    });
  }

  /** POST /websites/update — 修改网站基本信息。 */
  async updateWebsite(body: OnePanelWebsiteUpdate): Promise<void> {
    await this.request({
      method: "POST",
      path: "/websites/update",
      body,
    });
  }

  /** POST /groups/search — 分组列表（网站分组 type=website）。 */
  async searchGroups(type: string = "website"): Promise<OnePanelGroup[]> {
    const data = await this.request<unknown>({
      method: "POST",
      path: "/groups/search",
      body: { type },
    });
    return unwrapList<OnePanelGroup>(data)
      .map((item) => ({
        id: Number((item as OnePanelGroup).id ?? 0),
        name: String((item as OnePanelGroup).name ?? ""),
        type: (item as OnePanelGroup).type,
        isDefault: (item as OnePanelGroup).isDefault,
      }))
      .filter((item) => item.id > 0 && item.name);
  }

  /** POST /runtimes/search — 运行环境列表。 */
  async searchRuntimes(body: {
    page?: number;
    pageSize?: number;
    type?: string;
    status?: string;
    name?: string;
  } = {}): Promise<OnePanelRuntime[]> {
    const data = await this.request<unknown>({
      method: "POST",
      path: "/runtimes/search",
      body: {
        page: body.page ?? 1,
        pageSize: body.pageSize ?? 100,
        name: body.name ?? "",
        type: body.type ?? "",
        status: body.status ?? "",
      },
    });
    return unwrapList<OnePanelRuntime>(data)
      .map((item) => ({
        id: Number((item as OnePanelRuntime).id ?? 0),
        name: String((item as OnePanelRuntime).name ?? ""),
        type: (item as OnePanelRuntime).type,
        status: (item as OnePanelRuntime).status,
        resource: (item as OnePanelRuntime).resource,
        version: (item as OnePanelRuntime).version,
        port: (item as OnePanelRuntime).port,
        appDetailID: (item as OnePanelRuntime).appDetailID,
      }))
      .filter((item) => item.id > 0);
  }

  /** POST /websites/ssl — 申请/创建 ACME 证书。 */
  async createWebsiteSsl(body: OnePanelWebsiteSslCreate): Promise<void> {
    await this.request({
      method: "POST",
      path: "/websites/ssl",
      body,
    });
  }

  /** POST /websites/ssl/update — 修改证书。 */
  async updateWebsiteSsl(body: OnePanelWebsiteSslUpdate): Promise<void> {
    await this.request({
      method: "POST",
      path: "/websites/ssl/update",
      body,
    });
  }

  /** POST /websites/ssl/upload — 上传/粘贴 SSL 证书。 */
  async uploadWebsiteSsl(body: OnePanelWebsiteSslUpload): Promise<void> {
    await this.request({
      method: "POST",
      path: "/websites/ssl/upload",
      body,
    });
  }

  /** POST /websites/acme/search — ACME 账户列表。 */
  async searchAcmeAccounts(body: { page?: number; pageSize?: number } = {}): Promise<OnePanelAcmeAccount[]> {
    const data = await this.request<unknown>({
      method: "POST",
      path: "/websites/acme/search",
      body: {
        page: body.page ?? 1,
        pageSize: body.pageSize ?? 100,
      },
    });
    return unwrapList<Record<string, unknown>>(data)
      .map((item) => ({
        id: Number(item.id ?? 0),
        email: String(item.email ?? ""),
        type: item.type != null ? String(item.type) : undefined,
        keyType: item.keyType != null ? String(item.keyType) : undefined,
      }))
      .filter((item) => item.id > 0);
  }

  /** POST /websites/dns/search — DNS 账户列表。 */
  async searchDnsAccounts(body: { page?: number; pageSize?: number } = {}): Promise<OnePanelDnsAccount[]> {
    const data = await this.request<unknown>({
      method: "POST",
      path: "/websites/dns/search",
      body: {
        page: body.page ?? 1,
        pageSize: body.pageSize ?? 100,
      },
    });
    return unwrapList<Record<string, unknown>>(data)
      .map((item) => ({
        id: Number(item.id ?? 0),
        name: String(item.name ?? ""),
        type: item.type != null ? String(item.type) : undefined,
      }))
      .filter((item) => item.id > 0 && item.name);
  }

  /** POST /cronjobs — 创建计划任务。 */
  async createCronjob(body: OnePanelCronjobCreate): Promise<void> {
    await this.request({
      method: "POST",
      path: "/cronjobs",
      body,
    });
  }

  /** POST /cronjobs/update — 修改计划任务。 */
  async updateCronjob(body: OnePanelCronjobUpdate): Promise<void> {
    await this.request({
      method: "POST",
      path: "/cronjobs/update",
      body,
    });
  }

  /** POST /cronjobs/load/info — 计划任务详情。 */
  async loadCronjobInfo(id: number): Promise<Record<string, unknown>> {
    const data = await this.request<Record<string, unknown>>({
      method: "POST",
      path: "/cronjobs/load/info",
      body: { id },
    });
    return data && typeof data === "object" ? data : {};
  }

  /** POST /cronjobs/del — 删除计划任务。 */
  async deleteCronjobs(
    ids: number[],
    options: { cleanData?: boolean; cleanRemoteData?: boolean } = {},
  ): Promise<void> {
    await this.request({
      method: "POST",
      path: "/cronjobs/del",
      body: {
        ids,
        cleanData: options.cleanData ?? false,
        cleanRemoteData: options.cleanRemoteData ?? false,
      },
    });
  }

  /** POST /websites/del — 删除网站。 */
  async deleteWebsite(
    id: number,
    options: {
      forceDelete?: boolean;
      deleteApp?: boolean;
      deleteBackup?: boolean;
      deleteDB?: boolean;
    } = {},
  ): Promise<void> {
    await this.request({
      method: "POST",
      path: "/websites/del",
      body: {
        id,
        forceDelete: options.forceDelete ?? false,
        deleteApp: options.deleteApp ?? false,
        deleteBackup: options.deleteBackup ?? false,
        deleteDB: options.deleteDB ?? false,
      },
    });
  }

  /** POST /websites/ssl/del — 删除 SSL 证书。 */
  async deleteWebsiteSsl(ids: number[]): Promise<void> {
    await this.request({
      method: "POST",
      path: "/websites/ssl/del",
      body: { ids },
    });
  }

  /**
   * POST /websites/ssl/download — 下载证书 zip（含 fullchain.pem / privkey.pem）。
   * 返回文件名与二进制内容，由调用方触发本地保存。
   */
  async downloadWebsiteSsl(id: number): Promise<{ filename: string; bytes: Uint8Array }> {
    const fallbackName = `ssl-${id}.zip`;
    if (this.useTauri && isTauriRuntime()) {
      const result = await commands.panel1panelRequestBytes(
        this.baseUrl,
        this.apiKey,
        "POST",
        "/websites/ssl/download",
        serializeRequestBody("POST", { id }),
      );
      if (result.status === "error") {
        throw new OnePanelApiError(formatIpcError(result.error), 0, result.error.cause ?? undefined);
      }
      const payload = result.data;
      const bytes = base64ToUint8Array(payload.contentBase64);
      return {
        filename: payload.filename?.trim() || fallbackName,
        bytes,
      };
    }

    return this.downloadWebsiteSslViaFetch(id, fallbackName);
  }

  private async downloadWebsiteSslViaFetch(
    id: number,
    fallbackName: string,
  ): Promise<{ filename: string; bytes: Uint8Array }> {
    const timestamp = Math.floor(Date.now() / 1000);
    const res = await fetch(`${this.baseUrl}/api/v2/websites/ssl/download`, {
      method: "POST",
      headers: {
        Accept: "application/json, application/zip, */*",
        "Content-Type": "application/json",
        ...buildOnePanelAuthHeaders(this.apiKey, timestamp),
      },
      body: JSON.stringify({ id }),
    });

    const buffer = await res.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    if (!res.ok) {
      const text = new TextDecoder().decode(bytes);
      const hint = res.status === 401 ? "API 接口密钥错误" : text || res.statusText;
      throw new OnePanelApiError(`1Panel API 错误 (${res.status}): ${hint}`, res.status, text);
    }

    const disposition = res.headers.get("content-disposition") ?? "";
    const filename = parseContentDispositionFilename(disposition) || fallbackName;
    return { filename, bytes };
  }

  /** POST /websites/search — 网站列表（完整路径 `/api/v2/websites/search`）。 */
  async searchWebsites(body: Record<string, unknown> = {}): Promise<unknown[]> {
    const data = await this.request<unknown>({
      method: "POST",
      path: "/websites/search",
      body: {
        page: 1,
        pageSize: 100,
        name: "",
        websiteGroupId: 0,
        orderBy: "createdAt",
        order: "descending",
        ...body,
      },
    });
    return unwrapList(data);
  }

  /** POST /websites/operate — 启停网站（完整路径 `/api/v2/websites/operate`）。 */
  async operateWebsite(id: number | string, operate: "start" | "stop"): Promise<void> {
    await this.request({
      method: "POST",
      path: "/websites/operate",
      body: { id: Number(id), operate },
    });
  }

  /** GET /websites/:id — 网站详情。 */
  async getWebsite(id: number | string): Promise<Record<string, unknown>> {
    const data = await this.request<Record<string, unknown>>({
      method: "GET",
      path: `/websites/${id}`,
    });
    return data && typeof data === "object" ? data : {};
  }

  /** GET /websites/:id/config/:type — 网站 Nginx/OpenResty 配置文件。 */
  async getWebsiteConfig(
    id: number | string,
    type: string = "openresty",
  ): Promise<{ path?: string; content?: string; name?: string } & Record<string, unknown>> {
    const data = await this.request<Record<string, unknown>>({
      method: "GET",
      path: `/websites/${id}/config/${type}`,
    });
    return data && typeof data === "object" ? data : {};
  }

  /** POST /websites/nginx/update — 保存网站 Nginx 配置。 */
  async updateWebsiteNginx(id: number | string, content: string): Promise<void> {
    await this.request({
      method: "POST",
      path: "/websites/nginx/update",
      body: { id: Number(id), content },
    });
  }

  /**
   * POST /files/read/website?operateNode=local — 按行读取网站日志。
   * name 通常为 access.log / error.log。
   */
  async readWebsiteLog(params: {
    id: number | string;
    name?: string;
    page?: number;
    pageSize?: number;
  }): Promise<{ content: string; end?: boolean; path?: string }> {
    const data = await this.request<Record<string, unknown>>({
      method: "POST",
      path: "/files/read/website",
      query: { operateNode: "local" },
      body: {
        id: Number(params.id),
        type: "website",
        name: params.name ?? "access.log",
        page: params.page ?? 1,
        pageSize: params.pageSize ?? 500,
      },
    });
    return parseFileLineContent(data);
  }

  /**
   * POST /files/read/ssl?operateNode=local — 按行读取证书申请日志。
   */
  async readSslLog(params: {
    id: number | string;
    page?: number;
    pageSize?: number;
    latest?: boolean;
  }): Promise<{ content: string; end?: boolean; path?: string }> {
    const data = await this.request<Record<string, unknown>>({
      method: "POST",
      path: "/files/read/ssl",
      query: { operateNode: "local" },
      body: {
        id: Number(params.id),
        type: "ssl",
        page: params.page ?? 1,
        pageSize: params.pageSize ?? 500,
        latest: params.latest ?? true,
      },
    });
    return parseFileLineContent(data);
  }

  /** POST /files/search — 列目录。 */
  async searchFiles(path: string): Promise<OnePanelFileEntry[]> {
    const data = await this.request<Record<string, unknown>>({
      method: "POST",
      path: "/files/search",
      query: { operateNode: "local" },
      body: {
        path,
        expand: true,
        page: 1,
        pageSize: 500,
        showHidden: true,
      },
    });
    const items = Array.isArray(data?.items) ? data.items : [];
    return items
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
      .map((item) => ({
        name: String(item.name ?? ""),
        path: String(item.path ?? ""),
        isDir: Boolean(item.isDir),
        isSymlink: Boolean(item.isSymlink),
        linkTarget: item.linkPath != null ? String(item.linkPath) : null,
        size: Number(item.size ?? 0),
      }))
      .filter((item) => item.name && item.name !== "." && item.name !== "..");
  }

  /** POST /files/content — 读取文件内容。 */
  async getFileContent(path: string): Promise<string> {
    const data = await this.request<Record<string, unknown>>({
      method: "POST",
      path: "/files/content",
      query: { operateNode: "local" },
      body: { path, expand: true },
    });
    return typeof data?.content === "string" ? data.content : "";
  }

  /** GET /websites/ssl/website/:websiteId — 网站绑定的 SSL 证书。 */
  async getWebsiteSsl(websiteId: number | string): Promise<Record<string, unknown>> {
    const data = await this.request<Record<string, unknown>>({
      method: "GET",
      path: `/websites/ssl/website/${websiteId}`,
    });
    return data && typeof data === "object" ? data : {};
  }

  /** GET /websites/ssl/:id — SSL 证书详情。 */
  async getSslById(id: number | string): Promise<Record<string, unknown>> {
    const data = await this.request<Record<string, unknown>>({
      method: "GET",
      path: `/websites/ssl/${id}`,
    });
    return data && typeof data === "object" ? data : {};
  }

  /** POST /databases/db/search — 数据库连接列表。 */
  async searchDatabases(body: Record<string, unknown> = {}): Promise<unknown[]> {
    const data = await this.request<unknown>({
      method: "POST",
      path: "/databases/db/search",
      body: {
        page: 1,
        pageSize: 100,
        info: "",
        type: "",
        orderBy: "name",
        order: "null",
        ...body,
      },
    });
    return unwrapList(data);
  }

  /** POST /cronjobs/search — 计划任务列表。 */
  async searchCronjobs(body: Record<string, unknown> = {}): Promise<unknown[]> {
    const data = await this.request<unknown>({
      method: "POST",
      path: "/cronjobs/search",
      body: {
        page: 1,
        pageSize: 100,
        info: "",
        groupIDs: [],
        orderBy: "createdAt",
        order: "descending",
        ...body,
      },
    });
    return unwrapList(data);
  }

  /** POST /websites/ssl/search — SSL 证书列表（WebsiteSSLSearch）。 */
  async searchCertificates(body: Record<string, unknown> = {}): Promise<unknown[]> {
    const data = await this.request<unknown>({
      method: "POST",
      path: "/websites/ssl/search",
      // 官方前端仅传 page/pageSize；字段对齐 request.WebsiteSSLSearch（domain，非 name）
      body: {
        page: 1,
        pageSize: 100,
        domain: "",
        ...body,
      },
    });
    return unwrapList(data);
  }

  /** GET /apps/icon/:key — 应用图标（返回 data URL 或绝对 URL）。 */
  async getAppIconDataUrl(appKey: string): Promise<string> {
    const key = appKey.trim();
    if (!key) {
      throw new OnePanelApiError("应用 key 不能为空", 0);
    }

    if (this.useTauri && isTauriRuntime()) {
      const result = await commands.panel1panelAppIcon(this.baseUrl, this.apiKey, key);
      if (result.status === "error") {
        throw new OnePanelApiError(formatIpcError(result.error), 0, result.error.cause ?? undefined);
      }
      return result.data;
    }

    return this.fetchAppIconViaFetch(key);
  }

  private async fetchAppIconViaFetch(appKey: string): Promise<string> {
    const timestamp = Math.floor(Date.now() / 1000);
    const res = await fetch(`${this.baseUrl}/api/v2/apps/icon/${encodeURIComponent(appKey)}`, {
      method: "GET",
      headers: {
        Accept: "application/json, image/*, */*",
        ...buildOnePanelAuthHeaders(this.apiKey, timestamp),
      },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const hint = res.status === 401 ? "API 接口密钥错误" : text || res.statusText;
      throw new OnePanelApiError(`获取应用图标失败 (${res.status}): ${hint}`, res.status, text);
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("json")) {
      const json = (await res.json()) as unknown;
      const data = unwrapEnvelope<unknown>(json);
      if (typeof data === "string" && data) {
        if (data.startsWith("data:") || data.startsWith("http://") || data.startsWith("https://")) {
          return data;
        }
        if (data.startsWith("/")) {
          return `${this.baseUrl}${data}`;
        }
        return `data:image/png;base64,${data}`;
      }
      throw new OnePanelApiError("应用图标响应格式不支持", res.status);
    }

    const blob = await res.blob();
    return URL.createObjectURL(blob);
  }

  /** POST /apps/sync/remote — 从远程同步应用商店数据。 */
  async syncAppsRemote(): Promise<void> {
    await this.request<unknown>({
      method: "POST",
      path: "/apps/sync/remote",
    });
  }

  /** POST /apps/search — 应用市场列表。 */
  async searchApps(params: OnePanelAppSearchParams = {}): Promise<OnePanelAppSearchResult> {
    const body = {
      page: params.page ?? 1,
      pageSize: params.pageSize ?? 64,
      name: params.name ?? "",
      type: params.type ?? "",
      recommend: params.recommend ?? false,
      resource: params.resource ?? "",
      tags: params.tags ?? [],
    };
    const data = await this.request<
      OnePanelAppSearchResult | { items?: OnePanelApp[]; total?: number }
    >({
      method: "POST",
      path: "/apps/search",
      body,
    });
    if (data && typeof data === "object" && "items" in data) {
      const items = (data.items ?? []).map(normalizeAppItem);
      return {
        items,
        total: data.total ?? items.length,
      };
    }
    return { items: [], total: 0 };
  }

  /** GET /apps/:key — 应用详情（含 versions）。 */
  async getApp(appKey: string): Promise<OnePanelApp> {
    const key = appKey.trim();
    if (!key) {
      throw new OnePanelApiError("应用 key 不能为空", 0);
    }
    const data = await this.request<OnePanelApp>({
      method: "GET",
      path: `/apps/${encodeURIComponent(key)}`,
    });
    return normalizeAppItem(data);
  }

  /** GET /apps/detail/:appId/:version/:type — 版本级详情（含 appDetailId）。 */
  async getAppDetail(
    appId: number,
    version: string,
    appType: string,
  ): Promise<OnePanelAppDetail> {
    const ver = version.trim();
    const typ = appType.trim() || "runtime";
    if (!Number.isFinite(appId) || appId <= 0 || !ver) {
      throw new OnePanelApiError("应用详情参数无效", 0);
    }
    const data = await this.request<OnePanelAppDetail>({
      method: "GET",
      path: `/apps/detail/${appId}/${encodeURIComponent(ver)}/${encodeURIComponent(typ)}`,
    });
    return data;
  }

  /** POST /apps/install — 安装应用（MVP 使用默认参数）。 */
  async installApp(payload: OnePanelAppInstallCreate): Promise<void> {
    if (!Number.isFinite(payload.appDetailId) || payload.appDetailId <= 0) {
      throw new OnePanelApiError("appDetailId 无效", 0);
    }
    const name = payload.name.trim();
    if (!name) {
      throw new OnePanelApiError("应用实例名不能为空", 0);
    }
    await this.request<unknown>({
      method: "POST",
      path: "/apps/install",
      body: {
        appDetailId: payload.appDetailId,
        name,
        params: payload.params ?? {},
        advanced: payload.advanced ?? false,
        allowPort: payload.allowPort ?? true,
        pullImage: payload.pullImage ?? true,
        hostMode: payload.hostMode ?? false,
      },
    });
  }

  /** POST /apps/installed/search — 已安装应用列表。 */
  async searchInstalledApps(
    params: OnePanelInstalledSearchParams = {},
  ): Promise<OnePanelInstalledSearchResult> {
    const body = {
      page: params.page ?? 1,
      pageSize: params.pageSize ?? 200,
      name: params.name ?? "",
      all: params.all ?? true,
      sync: params.sync ?? false,
      update: params.update ?? false,
      unused: params.unused ?? false,
      checkUpdate: params.checkUpdate ?? false,
      tags: params.tags ?? [],
      type: params.type ?? "",
    };
    const data = await this.request<
      OnePanelInstalledSearchResult | { items?: OnePanelInstalledApp[]; total?: number }
    >({
      method: "POST",
      path: "/apps/installed/search",
      body,
    });
    if (data && typeof data === "object" && "items" in data) {
      return {
        items: data.items ?? [],
        total: data.total ?? data.items?.length ?? 0,
      };
    }
    return { items: [], total: 0 };
  }
}

/** 兼容 dart OpenAPI 的 xname / 常规 name 字段。 */
function normalizeAppTag(raw: unknown): OnePanelAppTag | null {
  if (typeof raw === "string") {
    const label = raw.trim();
    if (!label) return null;
    return { key: label, name: label };
  }
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const name =
    (typeof item.name === "string" && item.name.trim()) ||
    (typeof item.xname === "string" && item.xname.trim()) ||
    "";
  const key = typeof item.key === "string" ? item.key.trim() : "";
  if (!name && !key) return null;
  const id = typeof item.id === "number" ? item.id : Number(item.id);
  return {
    id: Number.isFinite(id) ? id : undefined,
    key: key || undefined,
    name: name || key,
    sort: typeof item.sort === "number" ? item.sort : undefined,
  };
}

function normalizeAppItem(raw: OnePanelApp | Record<string, unknown>): OnePanelApp {
  const item = raw as Record<string, unknown>;
  const name =
    (typeof item.name === "string" && item.name) ||
    (typeof item.xname === "string" && item.xname) ||
    "";
  const key = typeof item.key === "string" ? item.key : "";
  const id = typeof item.id === "number" ? item.id : Number(item.id) || 0;
  const tags = Array.isArray(item.tags)
    ? item.tags.map(normalizeAppTag).filter((tag): tag is OnePanelAppTag => tag != null)
    : undefined;
  return {
    ...(item as unknown as OnePanelApp),
    id,
    name,
    key,
    tags,
    versions: Array.isArray(item.versions)
      ? item.versions.filter((v): v is string => typeof v === "string")
      : undefined,
    installed: Boolean(item.installed),
  };
}

/** 从服务器连接配置创建客户端。 */
export function createOnePanelClient(host: string, apiKey: string): OnePanelClient {
  return new OnePanelClient({ host, apiKey });
}
