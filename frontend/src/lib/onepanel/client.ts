import { commands, type OmniError_Serialize } from "../../ipc/bindings";
import { canUseIpcBackend } from "../isTauriRuntime";
import { buildOnePanelAuthHeaders, resolveOnePanelEndpoint } from "./auth";
import {
  expandOnePanelRequestUrls,
  expandOnePanelRoutes,
  isOnePanelRouteMiss,
  polishOnePanelError,
} from "./compat";
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
  type OnePanelAppParam,
  type OnePanelAppInstalledParams,
  type OnePanelApp,
  type OnePanelAppDetail,
  type OnePanelAppInstallCreate,
  type OnePanelTaskLogContent,
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
  /** 连接 ID：apiKey 为空时从 Vault 解析密钥 */
  connectionId?: string;
  /** 旧版 JWT 登录用户名，默认 admin */
  username?: string;
  /** 默认 true：在有 IPC 后端时走 Rust 代理，避免浏览器 CORS。 */
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
    throw new OnePanelApiError("1Panel 返回了 HTML 页面而非 JSON", 404, trimmed.slice(0, 300));
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
  private readonly entrance: string;
  private apiKey: string;
  private readonly connectionId?: string;
  private readonly useTauri: boolean;
  private readonly username: string;
  private resolvePromise: Promise<string> | null = null;

  constructor(options: OnePanelClientOptions) {
    const endpoint = resolveOnePanelEndpoint(options.host);
    this.baseUrl = endpoint.baseUrl;
    this.entrance = endpoint.entrance;
    this.apiKey = options.apiKey;
    this.connectionId = options.connectionId;
    this.username = options.username?.trim() ?? "";
    this.useTauri = options.useTauri ?? true;
  }

  /** 把登录用户名塞进 URL userinfo，供 Rust 走官方 JWT 登录。 */
  private ipcHost(): string {
    if (!this.username) return this.baseUrl;
    try {
      const url = new URL(this.baseUrl);
      return `${url.protocol}//${encodeURIComponent(this.username)}@${url.host}`;
    } catch {
      return this.baseUrl;
    }
  }

  private async resolveApiKey(): Promise<string> {
    // 构造时明文优先；空则回源 Vault
    const inline = this.apiKey.trim();
    if (inline) return inline;
    if (!this.connectionId) {
      throw new OnePanelApiError("缺少 1Panel API 密钥", 0);
    }
    if (!canUseIpcBackend()) {
      throw new OnePanelApiError("缺少 1Panel API 密钥", 0);
    }
    if (!this.resolvePromise) {
      this.resolvePromise = (async () => {
        const result = await commands.panelResolveApiKey(this.connectionId!);
        if (result.status === "error") {
          throw new OnePanelApiError(formatIpcError(result.error), 0, result.error.cause ?? undefined);
        }
        const fromVault = result.data.trim();
        if (!fromVault) {
          throw new OnePanelApiError("缺少 1Panel API 密钥", 0);
        }
        this.apiKey = fromVault;
        return fromVault;
      })().catch((err) => {
        this.resolvePromise = null;
        throw err;
      });
    }
    return this.resolvePromise;
  }

  private async resolvePresenceToken(
    path: string,
    body: string | null,
  ): Promise<string | null> {
    const { ACTION_PANEL_DELETE, isPanelDestructive, panelDeleteTarget } = await import(
      "../presenceTargets"
    );
    if (!isPanelDestructive(path, body)) return null;
    const { requireStepUp } = await import("../stepUp");
    const token = await requireStepUp({
      action: ACTION_PANEL_DELETE,
      target: panelDeleteTarget(this.baseUrl, path),
      title: "删除面板资源",
      message: `即将通过面板删除资源：${path}`,
      reason: path,
    });
    if (!token) throw new OnePanelApiError("已取消", 0);
    return token;
  }

  /** 原始请求：path 不含 `/api/v2` 前缀，如 `/toolbox/device/base`。 */
  async request<T = unknown>(options: OnePanelRequestOptions): Promise<T> {
    const method = (options.method ?? "GET").toUpperCase();
    const path = options.path.startsWith("/") ? options.path : `/${options.path}`;
    const candidates = expandOnePanelRoutes(method, path);
    let lastErr: unknown;
    for (const candidate of candidates) {
      try {
        const body =
          candidate.body !== undefined
            ? candidate.body
            : candidate.method === "GET" || candidate.method === "HEAD"
              ? undefined
              : options.body;
        return await this.requestOnce<T>({
          ...options,
          method: candidate.method,
          path: candidate.path,
          body,
        });
      } catch (err) {
        if (!isOnePanelRouteMiss(err)) throw err;
        lastErr = err;
      }
    }
    throw polishOnePanelError(lastErr);
  }

  private async requestOnce<T = unknown>(options: OnePanelRequestOptions): Promise<T> {
    const method = (options.method ?? "GET").toUpperCase();
    const path = options.path.startsWith("/") ? options.path : `/${options.path}`;
    const pathWithQuery = `${path}${buildQueryString(options.query)}`;
    const apiKey = await this.resolveApiKey();

    if (this.useTauri && canUseIpcBackend()) {
      const body = serializeRequestBody(method, options.body);
      const presenceToken = await this.resolvePresenceToken(pathWithQuery, body);
      const result = await commands.panel1panelRequest(
        this.ipcHost(),
        apiKey,
        method,
        pathWithQuery,
        body,
        presenceToken,
      );
      if (result.status === "error") {
        const ipcHay = `${result.error.message} ${result.error.cause ?? ""}`;
        const status = /404|405|not found|版本不兼容|接口不存在|鉴权或入口/i.test(ipcHay) ? 404 : 0;
        throw new OnePanelApiError(
          formatIpcError(result.error),
          status,
          result.error.cause ?? undefined,
        );
      }
      return parseResponseText<T>(result.data);
    }

    return this.requestViaFetch<T>(method, pathWithQuery, options.body, apiKey);
  }

  /**
   * v1 OrderBy=created_at，v2 OrderBy=createdAt；oneof 失败时自动换一种再试。
   */
  private async requestWithOrderByFallback<T = unknown>(
    path: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    try {
      return await this.request<T>({ method: "POST", path, body });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/OrderBy/i.test(msg) || !/oneof/i.test(msg)) throw err;
      const orderBy = String(body.orderBy ?? "");
      const alt =
        orderBy === "createdAt" ? "created_at" : orderBy === "created_at" ? "createdAt" : "";
      if (!alt) throw err;
      return this.request<T>({ method: "POST", path, body: { ...body, orderBy: alt } });
    }
  }

  /** 原始文本响应（日志下载等非 JSON 接口）。 */
  async requestText(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<string> {
    const upperMethod = method.toUpperCase();
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const apiKey = await this.resolveApiKey();

    if (this.useTauri && canUseIpcBackend()) {
      const serialized = serializeRequestBody(upperMethod, body);
      const presenceToken = await this.resolvePresenceToken(normalizedPath, serialized);
      const result = await commands.panel1panelRequestText(
        this.ipcHost(),
        apiKey,
        upperMethod,
        normalizedPath,
        serialized,
        presenceToken,
      );
      if (result.status === "error") {
        throw new OnePanelApiError(formatIpcError(result.error), 0, result.error.cause ?? undefined);
      }
      return result.data;
    }

    return this.requestTextViaFetch(upperMethod, normalizedPath, body, apiKey);
  }

  private async requestTextViaFetch(
    method: string,
    path: string,
    body: unknown | undefined,
    apiKey: string,
  ): Promise<string> {
    const timestamp = Math.floor(Date.now() / 1000);
    const hasBody = body != null || method === "POST" || method === "PUT" || method === "PATCH";
    const headers = {
      Accept: "application/json, text/plain, */*",
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
      ...buildOnePanelAuthHeaders(apiKey, timestamp, this.entrance),
    };
    const payload = hasBody ? JSON.stringify(body ?? {}) : undefined;
    let lastErr: Error | null = null;
    for (const url of expandOnePanelRequestUrls(this.baseUrl, this.entrance, path)) {
      const res = await fetch(url, {
        method,
        headers,
        body: payload,
      });
      const text = await res.text().catch(() => "");
      const trimmed = text.trim().toLowerCase();
      if (trimmed.startsWith("<!doctype") || trimmed.startsWith("<html")) {
        lastErr = new OnePanelApiError("1Panel 返回了 HTML 页面而非 JSON", res.status, text);
        continue;
      }
      if (!res.ok) {
        const hint = res.status === 401 ? "API 接口密钥错误" : text || res.statusText;
        lastErr = new OnePanelApiError(`1Panel API 错误 (${res.status}): ${hint}`, res.status, text);
        if (res.status === 401) throw lastErr;
        continue;
      }
      return text;
    }
    throw polishOnePanelError(lastErr ?? new OnePanelApiError("1Panel 请求失败", 0));
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

  private async requestViaFetch<T>(
    method: string,
    pathWithQuery: string,
    body: unknown | undefined,
    apiKey: string,
  ): Promise<T> {
    const timestamp = Math.floor(Date.now() / 1000);
    const hasBody = body != null || method === "POST" || method === "PUT" || method === "PATCH";
    const headers = {
      Accept: "application/json",
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
      ...buildOnePanelAuthHeaders(apiKey, timestamp, this.entrance),
    };
    const payload = hasBody ? JSON.stringify(body ?? {}) : undefined;
    let lastErr: Error | null = null;
    for (const url of expandOnePanelRequestUrls(this.baseUrl, this.entrance, pathWithQuery)) {
      const res = await fetch(url, {
        method,
        headers,
        body: payload,
      });
      const text = await res.text().catch(() => "");
      const trimmed = text.trim().toLowerCase();
      if (trimmed.startsWith("<!doctype") || trimmed.startsWith("<html")) {
        lastErr = new OnePanelApiError("1Panel 返回了 HTML 页面而非 JSON", res.status, text);
        continue;
      }
      if (!res.ok) {
        const hint = res.status === 401 ? "API 接口密钥错误" : text || res.statusText;
        lastErr = new OnePanelApiError(`1Panel API 错误 (${res.status}): ${hint}`, res.status, text);
        if (res.status === 401) throw lastErr;
        continue;
      }
      return parseResponseText<T>(text);
    }
    throw polishOnePanelError(lastErr ?? new OnePanelApiError("1Panel 请求失败", 0));
  }

  /** 连通性测试（兼容 v1 / v2）。 */
  async testConnection(): Promise<boolean> {
    try {
      await this.getDeviceBase();
      return true;
    } catch {
      try {
        await this.getOsInfo();
        return true;
      } catch {
        return false;
      }
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
    try {
      return await this.request<OnePanelDashboardCurrent>({
        method: "GET",
        path: `/dashboard/current/${ioOption}/${netOption}`,
      });
    } catch {
      // 1Panel v1 无 current 接口；实时数据挂在 /dashboard/base
      const base = await this.getDashboardBase(ioOption, netOption);
      if (base.currentInfo) return base.currentInfo;
      throw new OnePanelApiError("1Panel 未返回实时监控数据", 0);
    }
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

  /** GET /dashboard/current/top/cpu|mem — Top 进程（v1 无此接口时返回空）。 */
  async getTopProcesses(kind: "cpu" | "mem" = "cpu"): Promise<OnePanelProcess[]> {
    try {
      const data = await this.request<OnePanelProcess[] | { items?: OnePanelProcess[] }>({
        method: "GET",
        path: `/dashboard/current/top/${kind}`,
      });
      return unwrapList(data);
    } catch {
      return [];
    }
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

  /** POST /websites/ssl — 申请/创建 ACME 证书，返回证书 id。 */
  async createWebsiteSsl(
    body: OnePanelWebsiteSslCreate,
  ): Promise<{ id: number; status?: string; message?: string }> {
    const data = await this.request<Record<string, unknown>>({
      method: "POST",
      path: "/websites/ssl",
      body,
    });
    const id = Number(data?.id ?? 0);
    if (!Number.isFinite(id) || id <= 0) {
      throw new OnePanelApiError("创建证书未返回有效 id", 0);
    }
    return {
      id,
      status: typeof data?.status === "string" ? data.status : undefined,
      message: typeof data?.message === "string" ? data.message : undefined,
    };
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

  /** POST /cronjobs/load/info — 计划任务详情（v1 无此接口时回退 search）。 */
  async loadCronjobInfo(id: number): Promise<Record<string, unknown>> {
    try {
      const data = await this.request<Record<string, unknown>>({
        method: "POST",
        path: "/cronjobs/load/info",
        body: { id },
      });
      return data && typeof data === "object" ? data : {};
    } catch {
      const items = await this.searchCronjobs({ pageSize: 200 });
      const hit = items.find((item) => {
        const row = item as Record<string, unknown>;
        return Number(row.id) === Number(id);
      }) as Record<string, unknown> | undefined;
      if (!hit) {
        throw new OnePanelApiError(`未找到计划任务 #${id}`, 404);
      }
      return hit;
    }
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

  /** POST /cronjobs/status — 更新计划任务启用状态。 */
  async updateCronjobStatus(id: number, status: "Enable" | "Disable"): Promise<void> {
    await this.request({
      method: "POST",
      path: "/cronjobs/status",
      body: { id, status },
    });
  }

  /** POST /cronjobs/handle — 立即执行一次计划任务。 */
  async handleCronjobOnce(id: number): Promise<void> {
    await this.request({
      method: "POST",
      path: "/cronjobs/handle",
      body: { id },
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
    const apiKey = await this.resolveApiKey();
    if (this.useTauri && canUseIpcBackend()) {
      const result = await commands.panel1panelRequestBytes(
        this.ipcHost(),
        apiKey,
        "POST",
        "/websites/ssl/download",
        serializeRequestBody("POST", { id }),
        null,
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
    const apiKey = await this.resolveApiKey();
    const timestamp = Math.floor(Date.now() / 1000);
    const res = await fetch(`${this.baseUrl}/api/v2/websites/ssl/download`, {
      method: "POST",
      headers: {
        Accept: "application/json, application/zip, */*",
        "Content-Type": "application/json",
        ...buildOnePanelAuthHeaders(apiKey, timestamp, this.entrance),
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

  /** POST /websites/search — 网站列表。 */
  async searchWebsites(body: Record<string, unknown> = {}): Promise<unknown[]> {
    const payload = {
      page: 1,
      pageSize: 100,
      name: "",
      websiteGroupId: 0,
      // 默认 v2；v1 会在 requestWithOrderByFallback 里改成 created_at
      orderBy: "createdAt",
      order: "descending",
      ...body,
    };
    const data = await this.requestWithOrderByFallback<unknown>("/websites/search", payload);
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
   * 按行读取网站日志。
   * v2: POST /files/read/website；v1: POST /websites/log。
   * name 通常为 access.log / error.log。
   */
  async readWebsiteLog(params: {
    id: number | string;
    name?: string;
    page?: number;
    pageSize?: number;
  }): Promise<{ content: string; end?: boolean; path?: string }> {
    const name = params.name ?? "access.log";
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? 500;
    const id = Number(params.id);
    try {
      const data = await this.request<Record<string, unknown>>({
        method: "POST",
        path: "/files/read/website",
        query: { operateNode: "local" },
        body: {
          id,
          type: "website",
          name,
          page,
          pageSize,
        },
      });
      return parseFileLineContent(data);
    } catch {
      const logType = name.replace(/\.log$/i, "") || "access";
      const data = await this.request<Record<string, unknown>>({
        method: "POST",
        path: "/websites/log",
        body: {
          id,
          operate: "get",
          logType,
          page,
          pageSize,
        },
      });
      return parseFileLineContent(data);
    }
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

  /**
   * POST /files/upload 或 /files/chunkupload — 上传文件到目录。
   * `path` 为目标目录；`contentBase64` 为文件内容。
   */
  async uploadFile(params: {
    path: string;
    filename: string;
    contentBase64: string;
    overwrite?: boolean;
  }): Promise<void> {
    const apiKey = await this.resolveApiKey();
    if (this.useTauri && canUseIpcBackend()) {
      const result = await commands.panel1panelUploadFile(
        this.ipcHost(),
        apiKey,
        params.path,
        params.filename,
        params.contentBase64,
        params.overwrite ?? true,
      );
      if (result.status === "error") {
        throw new OnePanelApiError(formatIpcError(result.error), 0, result.error.cause ?? undefined);
      }
      return;
    }

    // 浏览器直连：仅小文件走单次 multipart（大文件请走 Tauri）
    const binary = base64ToUint8Array(params.contentBase64);
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(binary)]), params.filename);
    form.append("path", params.path.endsWith("/") ? params.path : `${params.path}/`);
    form.append("overwrite", params.overwrite === false ? "False" : "True");

    const timestamp = Math.floor(Date.now() / 1000);
    const res = await fetch(`${this.baseUrl}/api/v2/files/upload`, {
      method: "POST",
      headers: {
        Accept: "application/json, text/plain, */*",
        ...buildOnePanelAuthHeaders(apiKey, timestamp, this.entrance),
      },
      body: form,
    });
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      throw new OnePanelApiError(`1Panel 上传失败 (${res.status}): ${text || res.statusText}`, res.status, text);
    }
    if (text.trim().startsWith("{")) {
      try {
        const envelope = JSON.parse(text) as OnePanelApiEnvelope<unknown>;
        if (envelope.code != null && envelope.code !== 200) {
          throw new OnePanelApiError(envelope.message ?? `1Panel API 错误 (${envelope.code})`, envelope.code);
        }
      } catch (err) {
        if (err instanceof OnePanelApiError) throw err;
      }
    }
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

  /** POST /databases/db — 创建数据库。 */
  async createDatabase(body: {
    name: string;
    username: string;
    password: string;
    type?: string;
    from?: string;
    format?: string;
    permission?: string;
    description?: string;
  }): Promise<void> {
    const type = body.type?.trim() || "mysql";
    await this.request({
      method: "POST",
      path: "/databases/db",
      body: {
        from: body.from ?? "local",
        type,
        database: type,
        name: body.name,
        username: body.username,
        password: body.password,
        format: body.format ?? "utf8mb4",
        permission: body.permission ?? "127.0.0.1",
        description: body.description ?? "",
      },
    });
  }

  /** POST /databases/db/del — 删除数据库。 */
  async deleteDatabase(body: { id: number; name: string; type?: string }): Promise<void> {
    await this.request({
      method: "POST",
      path: "/databases/db/del",
      body: {
        id: body.id,
        type: body.type?.trim() || "mysql",
        database: body.name,
        deleteBackup: false,
        forceDelete: true,
      },
    });
  }

  /** POST /cronjobs/search — 计划任务列表。 */
  async searchCronjobs(body: Record<string, unknown> = {}): Promise<unknown[]> {
    const payload = {
      page: 1,
      pageSize: 100,
      info: "",
      groupIDs: [],
      // 默认 v2 createdAt；v1 自动回退 created_at
      orderBy: "createdAt",
      order: "descending",
      ...body,
    };
    const data = await this.requestWithOrderByFallback<unknown>("/cronjobs/search", payload);
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

    const apiKey = await this.resolveApiKey();
    if (this.useTauri && canUseIpcBackend()) {
      const result = await commands.panel1panelAppIcon(this.ipcHost(), apiKey, key);
      if (result.status === "error") {
        throw new OnePanelApiError(formatIpcError(result.error), 0, result.error.cause ?? undefined);
      }
      return result.data;
    }

    return this.fetchAppIconViaFetch(key, apiKey);
  }

  private async fetchAppIconViaFetch(appKey: string, apiKey: string): Promise<string> {
    const timestamp = Math.floor(Date.now() / 1000);
    const headers = {
      Accept: "application/json, image/*, */*",
      ...buildOnePanelAuthHeaders(apiKey, timestamp, this.entrance),
    };
    let lastErr: Error | null = null;
    let res: Response | null = null;
    for (const url of expandOnePanelRequestUrls(
      this.baseUrl,
      this.entrance,
      `/apps/icon/${encodeURIComponent(appKey)}`,
    )) {
      const next = await fetch(url, { method: "GET", headers });
      if (next.ok) {
        res = next;
        break;
      }
      const text = await next.text().catch(() => "");
      lastErr = new OnePanelApiError(
        `获取应用图标失败 (${next.status}): ${next.status === 401 ? "API 接口密钥错误" : text || next.statusText}`,
        next.status,
        text,
      );
      if (next.status === 401) throw lastErr;
    }
    if (!res) {
      throw polishOnePanelError(lastErr ?? new OnePanelApiError("获取应用图标失败", 0));
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
  async installApp(payload: OnePanelAppInstallCreate): Promise<OnePanelInstalledApp> {
    if (!Number.isFinite(payload.appDetailId) || payload.appDetailId <= 0) {
      throw new OnePanelApiError("appDetailId 无效", 0);
    }
    const name = payload.name.trim();
    if (!name) {
      throw new OnePanelApiError("应用实例名不能为空", 0);
    }
    return this.request<OnePanelInstalledApp>({
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

  /** POST /logs/tasks/read — 读取应用安装任务日志。 */
  async readAppInstallTaskLog(params: {
    installId: number;
    page?: number;
    pageSize?: number;
    latest?: boolean;
  }): Promise<OnePanelTaskLogContent> {
    const data = await this.request<Record<string, unknown>>({
      method: "POST",
      path: "/logs/tasks/read",
      body: {
        page: params.page ?? 1,
        pageSize: params.pageSize ?? 500,
        resourceID: params.installId,
        taskType: "app",
        taskOperate: "install",
        latest: params.latest ?? true,
      },
    });
    const parsed = parseFileLineContent(data);
    return {
      ...parsed,
      taskStatus: typeof data?.taskStatus === "string" ? data.taskStatus : undefined,
    };
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

  /** GET /apps/installed/params/:appInstallId — 已安装应用参数。 */
  async getInstalledAppParams(appInstallId: number): Promise<OnePanelAppInstalledParams> {
    if (!Number.isFinite(appInstallId) || appInstallId <= 0) {
      throw new OnePanelApiError("应用安装 ID 无效", 0);
    }
    const data = await this.request<unknown>({
      method: "GET",
      path: `/apps/installed/params/${appInstallId}`,
    });
    return parseInstalledAppParams(data);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseInstalledAppParam(raw: unknown): OnePanelAppParam | null {
  const item = asRecord(raw);
  if (!item) return null;
  const key = String(item.key ?? item.envKey ?? "").trim();
  if (!key) return null;
  const nestedLabel = asRecord(item.label);
  const labelZh =
    (typeof item.labelZh === "string" && item.labelZh.trim()) ||
    (typeof nestedLabel?.zh === "string" && nestedLabel.zh.trim()) ||
    undefined;
  const labelEn =
    (typeof item.labelEn === "string" && item.labelEn.trim()) ||
    (typeof nestedLabel?.en === "string" && nestedLabel.en.trim()) ||
    undefined;
  return {
    key,
    type: typeof item.type === "string" ? item.type : undefined,
    labelZh,
    labelEn,
    value: "value" in item ? item.value : item.default,
    showValue: typeof item.showValue === "string" ? item.showValue : undefined,
    required: Boolean(item.required),
    edit: Boolean(item.edit),
  };
}

function parseInstalledAppParamList(raw: unknown): OnePanelAppParam[] {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    try {
      return parseInstalledAppParamList(JSON.parse(trimmed) as unknown);
    } catch {
      return [];
    }
  }
  if (Array.isArray(raw)) {
    return raw.map(parseInstalledAppParam).filter((item): item is OnePanelAppParam => item != null);
  }
  const obj = asRecord(raw);
  if (!obj) return [];
  if (Array.isArray(obj.formFields)) {
    return parseInstalledAppParamList(obj.formFields);
  }
  if (Array.isArray(obj.fields)) {
    return parseInstalledAppParamList(obj.fields);
  }
  return Object.entries(obj)
    .filter(([key]) => key !== "formFields" && key !== "fields")
    .map(([key, value]) => {
      const nested = asRecord(value);
      return (
        parseInstalledAppParam(nested ? { ...nested, key: nested.key ?? key } : { key, value }) ?? {
          key,
          value,
        }
      );
    });
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function parseInstalledAppParams(raw: unknown): OnePanelAppInstalledParams {
  const data = asRecord(raw) ?? {};
  return {
    params: parseInstalledAppParamList(data.params),
    containerName: optionalString(data.containerName),
    webUI: optionalString(data.webUI),
    cpuQuota: optionalNumber(data.cpuQuota),
    memoryLimit: optionalNumber(data.memoryLimit),
    memoryUnit: optionalString(data.memoryUnit),
    hostMode: typeof data.hostMode === "boolean" ? data.hostMode : undefined,
    allowPort: typeof data.allowPort === "boolean" ? data.allowPort : undefined,
    pullImage: typeof data.pullImage === "boolean" ? data.pullImage : undefined,
    advanced: typeof data.advanced === "boolean" ? data.advanced : undefined,
    restartPolicy: optionalString(data.restartPolicy),
    specifyIP: optionalString(data.specifyIP),
    type: optionalString(data.type),
  };
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

/** 从服务器连接配置创建客户端。connectionId 用于 Vault 中空密钥时回源。 */
export function createOnePanelClient(
  host: string,
  apiKey: string,
  connectionId?: string,
  username?: string,
): OnePanelClient {
  return new OnePanelClient({ host, apiKey, connectionId, username });
}
