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
  type_id?: number;
  project_type?: string;
  rname?: string;
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

/** POST /site?action=AddSite */
export interface BtAddSiteParams {
  /** 主域名 */
  domain: string;
  /** 额外域名列表 */
  domainList?: string[];
  path: string;
  /** PHP 或留空（纯静态） */
  type?: string;
  /** PHP 版本如 "80"；纯静态传 "00" */
  version: string;
  port?: string;
  typeId?: number;
  ps?: string;
  ftp?: boolean;
  sql?: boolean;
  codeing?: string;
  datauser?: string;
  datapassword?: string;
}

export interface BtAddSiteResult {
  siteStatus?: boolean;
  siteId?: number;
  ftpStatus?: boolean;
  databaseStatus?: boolean;
  msg?: string;
  status?: boolean;
}

/** POST /files?action=GetDir */
export interface BtDirListResult {
  PATH?: string;
  DIR?: string[];
  FILES?: string[];
  PAGE?: string;
}

/** POST /files?action=GetFileBody */
export interface BtFileBodyResult {
  status?: boolean;
  data?: string;
  encoding?: string;
  size?: number;
  only_read?: boolean;
  msg?: string;
}

/** POST /site?action=GetSSL — status:false 表示未部署，非错误。 */
export interface BtSiteSslInfo {
  status?: boolean;
  oid?: number;
  domain?: Array<{ name?: string; apply_ssl?: number; dns_status?: number }>;
  key?: boolean;
  csr?: boolean;
  type?: number;
  httpTohttps?: boolean;
  cert_data?: Record<string, unknown>;
  tls_versions?: Record<string, boolean>;
  auth_type?: string;
  email?: string;
  /** 部分版本直接返回 PEM */
  private_key?: string;
  cert?: string;
  msg?: string;
}

/** POST /database?action=AddDatabase */
export interface BtAddDatabaseParams {
  name: string;
  dbUser: string;
  password: string;
  address?: string;
  codeing?: string;
  ps?: string;
  sid?: number;
  pid?: number;
}

/** POST /crontab?action=AddCrontab / modify_crond */
export interface BtCrontabParams {
  name: string;
  /** 周期类型：minute-n / hour / day / day-n / week / month */
  type: string;
  where1: string;
  /** toShell / toUrl / toPython / database / site / logs / rememory */
  sType: string;
  sBody: string;
  sName?: string;
  save?: number;
  backupTo?: string;
  hour?: string | number;
  minute?: string | number;
  week?: string | number;
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
  /**
   * 部分接口（如 GetSSL）用 status:false 表示业务状态而非错误。
   * 为 true 时不因 status===false 抛错。
   */
  tolerateFalseStatus?: boolean;
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

  /** 是否为宝塔 API IP 白名单拒绝。 */
  get isIpWhitelistError(): boolean {
    return /IP校验失败|IP.?校验|IP.?白名单/i.test(this.message);
  }
}
