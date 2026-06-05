/** 宝塔 API 通用状态响应（部分写操作）。 */
export interface BtApiStatusResponse {
  status?: boolean;
  msg?: string;
  code?: number;
}

/** GET /system?action=GetSystemTotal */
export interface BtSystemTotal {
  system?: string;
  version?: string;
  time?: string;
  cpuNum?: number;
  cpuRealUsed?: number;
  memTotal?: number;
  memRealUsed?: number;
  memFree?: number;
  memCached?: number;
  memBuffers?: number;
  isuser?: number;
}

/** GET /system?action=GetDiskInfo */
export interface BtDiskInfo {
  path: string;
  inodes: string[];
  size: string[];
}

/** GET /system?action=GetNetWork */
export interface BtNetworkInfo {
  down?: number;
  up?: number;
  downTotal?: number;
  upTotal?: number;
  downPackets?: number;
  upPackets?: number;
  cpu?: [number, number];
  mem?: {
    memFree: number;
    memTotal: number;
    memCached: number;
    memBuffers: number;
    memRealUsed: number;
  };
  load?: {
    max: number;
    safe: number;
    one: number;
    five: number;
    limit: number;
    fifteen: number;
  };
}

/** /data?action=getData&table=sites 网站条目。 */
export interface BtSite {
  id: number;
  name: string;
  status?: string;
  path?: string;
  ps?: string;
  addtime?: string;
  edate?: string;
  domain?: number;
  backup_count?: number;
}

export interface BtDataListResult<T> {
  data: T[];
  page?: string;
  where?: string;
}

export interface BtSiteType {
  id: number;
  name: string;
}

export interface BtPhpVersion {
  version: string;
  name: string;
}

export interface BtWebsiteListParams {
  p?: number;
  limit?: number;
  type?: number;
  order?: string;
  tojs?: string;
  search?: string;
}

/** POST /mod/docker/com/get_installed_apps 查询参数。 */
export interface BtInstalledAppsParams {
  appType?: string;
  p?: number;
  row?: number;
  query?: string;
}

/** 宝塔 Docker 应用配置字段。 */
export interface BtAppInfoField {
  fieldKey: string;
  fieldTitle: string;
  fieldValue: string | number | boolean | null;
}

/** POST /mod/docker/com/get_installed_apps 应用条目。 */
export interface BtInstalledApp {
  id: string;
  appid: number;
  appname: string;
  apptitle: string;
  appdesc?: string;
  apptype?: string;
  appstatus?: number;
  status?: string;
  version?: string;
  m_version?: string;
  s_version?: string;
  service_name: string;
  container_id?: string;
  path?: string;
  port?: string[];
  icon?: string;
  home?: string;
  server_ip?: string;
  host_ip?: string;
  createat?: string;
  createTime?: number;
  canUpdate?: number;
  installed?: boolean;
  appinfo?: BtAppInfoField[];
  sort?: number;
}

export interface BtInstalledAppsResult {
  items: BtInstalledApp[];
  total: number;
  page?: string;
}

export interface BtRequestOptions {
  /** 含 query 的路径，如 `/system?action=GetSystemTotal` */
  path: string;
  params?: Record<string, string | number | boolean | undefined | null>;
}

export class BtPanelApiError extends Error {
  readonly status: number;
  readonly body?: string;

  constructor(message: string, status: number, body?: string) {
    super(message);
    this.name = "BtPanelApiError";
    this.status = status;
    this.body = body;
  }

  get isAuthError(): boolean {
    return this.status === 401;
  }
}
