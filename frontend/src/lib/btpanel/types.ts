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

/** POST /mod/docker/com/get_apps 查询参数（应用商店）。 */
export interface BtAppsParams {
  appType?: string;
  p?: number;
  row?: number;
  query?: string;
  /** 1=强制刷新远端应用列表；0=读缓存 */
  force?: 0 | 1;
}

/** 宝塔 Docker 应用配置字段。 */
export interface BtAppInfoField {
  fieldKey: string;
  fieldTitle: string;
  fieldValue: string | number | boolean | null;
}

/** get_apps 返回的版本项。 */
export interface BtAppVersion {
  m_version: string;
  s_version: string[] | string;
}

/** get_apps 安装参数定义（env）。 */
export interface BtAppEnvField {
  key: string;
  type?: string;
  desc?: string;
  default?: string | number | boolean | null;
}

/** get_apps UI 配置字段（field）。 */
export interface BtAppUiField {
  attr: string;
  name?: string;
  type?: string;
  default?: string | number | boolean | null;
}

/** POST /mod/docker/com/get_apps 应用商店条目。 */
export interface BtApp {
  appname: string;
  apptitle: string;
  appdesc?: string;
  apptype?: string;
  appid?: number;
  icon?: string;
  installed?: boolean;
  appversion?: BtAppVersion[];
  depend?: unknown[];
  env?: BtAppEnvField[];
  field?: BtAppUiField[];
}

export interface BtAppsResult {
  items: BtApp[];
  total: number;
  page?: string;
}

/** POST /mod/docker/com/create_app 安装参数。 */
export interface BtCreateAppParams {
  appName: string;
  serviceName: string;
  mVersion: string;
  sVersion: string;
  allowAccess?: boolean | string;
  cpus?: string | number;
  memoryLimit?: string | number;
  disableDomain?: boolean | string;
  /** 应用专属参数（来自 get_apps 的 env/field） */
  extras?: Record<string, string | number | boolean>;
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

/** Docker 应用商店版本项（get_apps）。 */
export interface BtDockerAppVersion {
  m_version?: string;
  /** 子版本列表，或单个字符串（不同面板版本形态不一） */
  s_version?: string[] | string;
}

export interface BtDockerAppEnv {
  key?: string;
  type?: string;
  desc?: string;
  default?: string | number | boolean | null;
}

export interface BtDockerAppField {
  attr?: string;
  name?: string;
  type?: string;
  default?: string | number | boolean | null;
}

/** POST /mod/docker/com/get_apps[/stype] 应用条目。 */
export interface BtDockerApp {
  appid?: number;
  appname: string;
  apptitle?: string;
  appdesc?: string;
  apptype?: string;
  icon?: string;
  version?: string;
  installed?: boolean;
  appversion?: BtDockerAppVersion[];
  depend?: unknown[];
  env?: BtDockerAppEnv[];
  field?: BtDockerAppField[];
}

export interface BtDockerAppsResult {
  items: BtDockerApp[];
  total: number;
}

/** POST /plugin?action=get_soft_list 查询参数。 */
export interface BtSoftListParams {
  p?: number;
  /** 分类 id；0=全部 */
  type?: number;
  query?: string;
  force?: boolean | number;
  row?: number;
}

export interface BtSoftVersion {
  m_version?: string;
  version?: string;
  setup?: boolean;
  soft_id?: number;
}

/** 软件商店条目（get_soft_list.list.data）。 */
export interface BtSoftItem {
  id?: number;
  name: string;
  title?: string;
  title_en?: string;
  ps?: string;
  ps_en?: string;
  type?: number;
  icon?: string;
  setup?: boolean;
  version?: string;
  versions?: BtSoftVersion[];
  task?: string | number;
  price?: number;
}

export interface BtSoftListResult {
  items: BtSoftItem[];
  total: number;
  /** 分类：id → 标题 */
  types: Array<{ id: number; title: string }>;
}

/** POST /mod/docker/com/create_app[/stype] 通用安装参数。 */
export interface BtCreateDockerAppParams {
  appName: string;
  serviceName: string;
  mVersion: string;
  sVersion: string;
  allowAccess?: boolean;
  cpus?: string | number;
  memoryLimit?: string | number;
  disableDomain?: boolean;
  /** 应用专属 env/field 参数 */
  extra?: Record<string, string | number | boolean | null | undefined>;
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
