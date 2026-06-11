import { commands, type OmniError_Serialize } from "../../ipc/bindings";
import { buildOnePanelAuthHeaders, normalizeOnePanelBaseUrl } from "./auth";
import {
  OnePanelApiError,
  type OnePanelApiEnvelope,
  type OnePanelDashboardBase,
  type OnePanelDeviceBase,
  type OnePanelHostInfo,
  type OnePanelInstalledApp,
  type OnePanelInstalledSearchParams,
  type OnePanelInstalledSearchResult,
  type OnePanelMonitorData,
  type OnePanelProcess,
  type OnePanelRequestOptions,
  type OnePanelSystemInfo,
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

  /** 兼容旧调用：映射到 getDashboardBase。 */
  async getSystemInfo(): Promise<OnePanelSystemInfo> {
    const base = await this.getDashboardBase();
    const current = base.currentInfo ?? {};
    const disk = current.diskData?.[0];
    return {
      hostname: base.hostname ?? "",
      os: base.os ?? "",
      kernel: base.kernelVersion ?? "",
      platformVersion: base.platformVersion ?? "",
      uptime: current.uptime ?? 0,
      cpuCores: base.cpuCores ?? 0,
      cpuModel: base.cpuModelName ?? "",
      totalMemory: current.memoryTotal ?? 0,
      usedMemory: current.memoryUsed ?? 0,
      totalDisk: disk?.total ?? 0,
      usedDisk: disk?.used ?? 0,
      swapTotal: 0,
      swapUsed: 0,
      currentTime: "",
    };
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

  /** @deprecated 使用 searchMonitorHistory */
  async getMonitor(params: {
    startTime: string;
    endTime: string;
    point?: number;
  }): Promise<OnePanelMonitorData[]> {
    const data = await this.searchMonitorHistory({
      param: "cpu",
      startTime: params.startTime,
      endTime: params.endTime,
    });
    return [data];
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

  /** POST /websites/search — 网站列表。 */
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

  /** POST /websites/ssl/search — SSL 证书列表。 */
  async searchCertificates(body: Record<string, unknown> = {}): Promise<unknown[]> {
    const data = await this.request<unknown>({
      method: "POST",
      path: "/websites/ssl/search",
      body: {
        page: 1,
        pageSize: 100,
        name: "",
        acmeAccountID: "",
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

/** 从服务器连接配置创建客户端。 */
export function createOnePanelClient(host: string, apiKey: string): OnePanelClient {
  return new OnePanelClient({ host, apiKey });
}
