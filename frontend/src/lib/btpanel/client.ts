import { commands, type OmniError_Serialize } from "../../ipc/bindings";
import { buildBtAuthFields, normalizeBtPanelBaseUrl } from "./auth";
import {
  BtPanelApiError,
  type BtDataListResult,
  type BtDiskInfo,
  type BtNetworkInfo,
  type BtInstalledApp,
  type BtInstalledAppsParams,
  type BtInstalledAppsResult,
  type BtPhpVersion,
  type BtRequestOptions,
  type BtSite,
  type BtSiteType,
  type BtSystemTotal,
  type BtWebsiteListParams,
} from "./types";

export interface BtPanelClientOptions {
  host: string;
  apiSk: string;
  /** 默认 true：在 Tauri 环境走 Rust 后端，避免 WebView CORS 并复用 Cookie。 */
  useTauri?: boolean;
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
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

function parseResponseText<T>(text: string): T {
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
      if (obj.status === false) {
        throw new BtPanelApiError(obj.msg ?? "宝塔 API 错误", 0, trimmed.slice(0, 300));
      }
      if (typeof obj.code === "number" && obj.code !== 0) {
        throw new BtPanelApiError(obj.msg?.trim() || `宝塔 API 错误 (${obj.code})`, obj.code, trimmed.slice(0, 300));
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

export class BtPanelClient {
  private readonly baseUrl: string;
  private readonly apiSk: string;
  private readonly useTauri: boolean;

  constructor(options: BtPanelClientOptions) {
    this.baseUrl = normalizeBtPanelBaseUrl(options.host);
    this.apiSk = options.apiSk;
    this.useTauri = options.useTauri ?? true;
  }

  /** 原始 POST 请求。path 含 query，如 `/system?action=GetSystemTotal`。 */
  async request<T = unknown>(options: BtRequestOptions): Promise<T> {
    const path = options.path.startsWith("/") ? options.path : `/${options.path}`;

    if (this.useTauri && isTauriRuntime()) {
      const result = await commands.panelBtRequest(
        this.baseUrl,
        this.apiSk,
        path,
        serializeParams(options.params),
      );
      if (result.status === "error") {
        throw new BtPanelApiError(formatIpcError(result.error), 0, result.error.cause ?? undefined);
      }
      return parseResponseText<T>(result.data);
    }

    return this.requestViaFetch<T>(path, options.params);
  }

  private async requestViaFetch<T>(
    path: string,
    params?: BtRequestOptions["params"],
  ): Promise<T> {
    const form = new URLSearchParams(buildBtAuthFields(this.apiSk));
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

    return parseResponseText<T>(text);
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

  /** /data?action=getData&table=sites — 网站列表。 */
  async getWebsiteList(params: BtWebsiteListParams = {}): Promise<BtDataListResult<BtSite>> {
    const data = await this.request<BtDataListResult<BtSite>>({
      path: "/data?action=getData&table=sites",
      params: {
        p: params.p ?? 1,
        limit: params.limit ?? 15,
        type: params.type ?? -1,
        order: params.order ?? "id desc",
        tojs: params.tojs,
        search: params.search,
      },
    });
    return {
      data: data.data ?? [],
      page: data.page,
      where: data.where,
    };
  }

  /** /site?action=get_site_types — 网站分类。 */
  async getSiteTypes(): Promise<BtSiteType[]> {
    return this.request<BtSiteType[]>({ path: "/site?action=get_site_types" });
  }

  /** /site?action=GetPHPVersion — 已安装 PHP 版本。 */
  async getPhpVersions(): Promise<BtPhpVersion[]> {
    return this.request<BtPhpVersion[]>({ path: "/site?action=GetPHPVersion" });
  }

  /** /site?action=SiteStop — 停用网站。 */
  async stopWebsite(id: number, name: string): Promise<void> {
    await this.request({ path: "/site?action=SiteStop", params: { id, name } });
  }

  /** /site?action=SiteStart — 启用网站。 */
  async startWebsite(id: number, name: string): Promise<void> {
    await this.request({ path: "/site?action=SiteStart", params: { id, name } });
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
    return unwrapInstalledApps(payload);
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
}

function parseTotalFromPage(page: unknown, fallback: number): number {
  if (typeof page !== "string") return fallback;
  const match = page.match(/共(\d+)条/);
  if (!match) return fallback;
  const total = Number(match[1]);
  return Number.isFinite(total) ? total : fallback;
}

function unwrapInstalledApps(payload: unknown): BtInstalledAppsResult {
  if (Array.isArray(payload)) {
    return { items: payload as BtInstalledApp[], total: payload.length };
  }
  if (!payload || typeof payload !== "object") {
    return { items: [], total: 0 };
  }

  const root = payload as Record<string, unknown>;
  if (Array.isArray(root.data)) {
    const items = root.data as BtInstalledApp[];
    return {
      items,
      total: parseTotalFromPage(root.page, items.length),
      page: typeof root.page === "string" ? root.page : undefined,
    };
  }

  return { items: [], total: 0 };
}

/** 从服务器连接配置创建客户端。 */
export function createBtPanelClient(host: string, apiSk: string): BtPanelClient {
  return new BtPanelClient({ host, apiSk });
}

