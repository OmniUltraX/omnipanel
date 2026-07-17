/** 1Panel 通用 API 响应包装（多数 v2 接口）。 */
export interface OnePanelApiEnvelope<T = unknown> {
  code?: number;
  message?: string;
  data?: T;
}

export interface OnePanelDeviceBase {
  hostname?: string;
  os?: string;
  platform?: string;
  platformVersion?: string;
  kernelVersion?: string;
  kernel?: string;
  cpuCores?: number;
  cpuModel?: string;
  totalMemory?: number;
  usedMemory?: number;
  totalDisk?: number;
  usedDisk?: number;
  swapTotal?: number;
  swapUsed?: number;
  uptime?: number;
  currentTime?: string;
}

export interface OnePanelDiskInfo {
  path?: string;
  total?: number;
  used?: number;
  free?: number;
  usedPercent?: number;
}

export interface OnePanelDashboardCurrent {
  uptime?: number;
  timeSinceUptime?: string;
  load1?: number;
  load5?: number;
  load15?: number;
  cpuUsedPercent?: number;
  memoryTotal?: number;
  memoryUsed?: number;
  memoryAvailable?: number;
  memoryUsedPercent?: number;
  netBytesSent?: number;
  netBytesRecv?: number;
  diskData?: OnePanelDiskInfo[];
}

export interface OnePanelDashboardBase {
  hostname?: string;
  os?: string;
  platform?: string;
  platformVersion?: string;
  kernelVersion?: string;
  ipV4Addr?: string;
  cpuCores?: number;
  cpuLogicalCores?: number;
  cpuModelName?: string;
  cpuMhz?: number;
  currentInfo?: OnePanelDashboardCurrent;
}

export interface OnePanelMonitorData {
  param?: string;
  date?: string[];
  value?: number[];
}

export interface OnePanelProcess {
  pid: number;
  name: string;
  /** 1Panel v2 进程 API 使用 percent */
  percent?: number;
  cpuPercent?: number;
  memory?: number;
  memoryPercent?: number;
  memoryRss?: number;
  cmd?: string;
  state?: string;
  user?: string;
}

export interface OnePanelHostInfo {
  hostname: string;
  os: string;
  kernel: string;
  platformVersion: string;
  platform: string;
}

/** POST /apps/installed/search 请求体。 */
export interface OnePanelInstalledSearchParams {
  page?: number;
  pageSize?: number;
  name?: string;
  all?: boolean;
  sync?: boolean;
  update?: boolean;
  unused?: boolean;
  checkUpdate?: boolean;
  tags?: string[];
  type?: string;
}

/** 1Panel 应用元信息（嵌套于已安装应用条目）。 */
export interface OnePanelInstalledAppMeta {
  website?: string;
  document?: string;
  github?: string;
}

/** 1Panel 已安装应用条目（AppInstallDto）。 */
export interface OnePanelInstalledApp {
  id: number;
  name: string;
  appName?: string;
  appKey?: string;
  appType?: string;
  version?: string;
  status?: string;
  appStatus?: string;
  message?: string;
  httpPort?: number;
  httpsPort?: number;
  path?: string;
  icon?: string;
  canUpdate?: boolean;
  createdAt?: string;
  container?: string;
  serviceName?: string;
  dockerCompose?: string;
  webUI?: string;
  appDetailID?: number;
  appID?: number;
  app?: OnePanelInstalledAppMeta;
}

export interface OnePanelInstalledSearchResult {
  items: OnePanelInstalledApp[];
  total: number;
}

/** POST /apps/search 请求体。 */
export interface OnePanelAppSearchParams {
  page?: number;
  pageSize?: number;
  name?: string;
  type?: string;
  recommend?: boolean;
  resource?: string;
  tags?: string[];
}

/** 应用市场标签。 */
export interface OnePanelAppTag {
  id?: number;
  key?: string;
  name?: string;
  sort?: number;
}

/** POST /apps/search 单条（AppItem / AppDTO）。 */
export interface OnePanelApp {
  id: number;
  name: string;
  key: string;
  type?: string;
  icon?: string;
  description?: string;
  shortDescZh?: string;
  shortDescEn?: string;
  status?: string;
  resource?: string;
  installed?: boolean;
  limit?: number;
  versions?: string[];
  tags?: OnePanelAppTag[];
}

export interface OnePanelAppSearchResult {
  items: OnePanelApp[];
  total: number;
}

/** GET /apps/detail/:appId/:version/:type */
export interface OnePanelAppDetail {
  id: number;
  appId?: number;
  version?: string;
  status?: string;
  params?: unknown;
  dockerCompose?: string;
  hostMode?: boolean;
  lastVersion?: string;
}

/** POST /apps/install 请求体（MVP：默认参数）。 */
export interface OnePanelAppInstallCreate {
  appDetailId: number;
  name: string;
  params?: Record<string, unknown>;
  advanced?: boolean;
  allowPort?: boolean;
  pullImage?: boolean;
  hostMode?: boolean;
}

export interface OnePanelRequestOptions {
  method?: string;
  path: string;
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
}

export class OnePanelApiError extends Error {
  readonly status: number;
  readonly body?: string;

  constructor(message: string, status: number, body?: string) {
    super(message);
    this.name = "OnePanelApiError";
    this.status = status;
    this.body = body;
  }

  get isAuthError(): boolean {
    return this.status === 401;
  }
}

/** POST /files/search 返回的目录项。 */
export interface OnePanelFileEntry {
  name: string;
  path: string;
  isDir: boolean;
  isSymlink: boolean;
  linkTarget: string | null;
  size: number;
}

/** 1Panel 网站类型（POST /websites）。 */
export type OnePanelWebsiteType =
  | "static"
  | "runtime"
  | "deployment"
  | "proxy"
  | "stream"
  | "subsite";

export interface OnePanelWebsiteDomain {
  domain: string;
  port?: number;
  ssl?: boolean;
}

export interface OnePanelNginxUpstreamServer {
  server: string;
  weight?: number;
  maxFails?: number;
  failTimeout?: number;
  failTimeoutUnit?: string;
  maxConns?: number;
  flag?: string;
}

/** POST /websites — 创建网站请求体（字段名对齐 1Panel 前端约定）。 */
export interface OnePanelWebsiteCreate {
  type: OnePanelWebsiteType;
  alias: string;
  webSiteGroupId: number;
  remark?: string;
  domains?: OnePanelWebsiteDomain[];
  IPV6?: boolean;
  enableSSL?: boolean;
  websiteSSLID?: number;
  appType?: "new" | "installed";
  appInstallId?: number;
  runtimeID?: number;
  proxy?: string;
  proxyType?: string;
  port?: number;
  parentWebsiteID?: number;
  siteDir?: string;
  streamPorts?: string;
  udp?: boolean;
  servers?: OnePanelNginxUpstreamServer[];
  ftpUser?: string;
  ftpPassword?: string;
  taskID?: string;
}

/** POST /websites/update — 修改网站基本信息。 */
export interface OnePanelWebsiteUpdate {
  id: number;
  primaryDomain: string;
  remark?: string;
  webSiteGroupID?: number;
  expireDate?: string;
  IPV6?: boolean;
  favorite?: boolean;
}

/** POST /websites/ssl/update — 修改证书。 */
export interface OnePanelWebsiteSslUpdate {
  id: number;
  primaryDomain: string;
  provider: OnePanelSslProvider | string;
  otherDomains?: string;
  acmeAccountId?: number;
  dnsAccountId?: number;
  autoRenew?: boolean;
  keyType?: string;
  description?: string;
  apply?: boolean;
  pushDir?: boolean;
  dir?: string;
  disableCNAME?: boolean;
  skipDNS?: boolean;
  nameserver1?: string;
  nameserver2?: string;
  execShell?: boolean;
  shell?: string;
  pushNode?: boolean;
  nodes?: string;
}

/** POST /groups/search 返回的分组。 */
export interface OnePanelGroup {
  id: number;
  name: string;
  type?: string;
  isDefault?: boolean;
}

/** POST /runtimes/search 返回的运行环境。 */
export interface OnePanelRuntime {
  id: number;
  name: string;
  type?: string;
  status?: string;
  resource?: string;
  version?: string;
  port?: number;
  appDetailID?: number;
}

/** SSL 申请验证方式（POST /websites/ssl）。 */
export type OnePanelSslProvider = "dnsAccount" | "dnsManual" | "http";

/** POST /websites/ssl — 申请/创建 ACME 证书。 */
export interface OnePanelWebsiteSslCreate {
  primaryDomain: string;
  otherDomains?: string;
  provider: OnePanelSslProvider;
  acmeAccountId: number;
  dnsAccountId?: number;
  autoRenew?: boolean;
  keyType?: string;
  description?: string;
  apply?: boolean;
  pushDir?: boolean;
  dir?: string;
  disableCNAME?: boolean;
  skipDNS?: boolean;
  nameserver1?: string;
  nameserver2?: string;
  execShell?: boolean;
  shell?: string;
}

/** POST /websites/ssl/upload — 上传/粘贴证书。 */
export interface OnePanelWebsiteSslUpload {
  type: "paste" | "local";
  certificate?: string;
  privateKey?: string;
  certificatePath?: string;
  privateKeyPath?: string;
  description?: string;
  sslID?: number;
}

export interface OnePanelAcmeAccount {
  id: number;
  email: string;
  type?: string;
  keyType?: string;
}

export interface OnePanelDnsAccount {
  id: number;
  name: string;
  type?: string;
}

/** 计划任务类型（POST /cronjobs，首批）。 */
export type OnePanelCronjobType = "shell" | "curl" | "clean" | "ntp";

/** POST /cronjobs — 创建计划任务（dto.CronjobOperate 子集）。 */
export interface OnePanelCronjobCreate {
  name: string;
  type: OnePanelCronjobType;
  spec: string;
  specCustom?: boolean;
  groupID?: number;
  executor?: string;
  scriptMode?: string;
  script?: string;
  command?: string;
  containerName?: string;
  user?: string;
  url?: string;
  scriptID?: number;
  appID?: string;
  website?: string;
  exclusionRules?: string;
  dbType?: string;
  dbName?: string;
  isDir?: boolean;
  sourceDir?: string;
  sourceAccountIDs?: string;
  downloadAccountID?: number;
  retainCopies?: number;
  retryTimes?: number;
  timeout?: number;
  ignoreErr?: boolean;
  secret?: string;
  alertCount?: number;
  alertTitle?: string;
  alertMethod?: string;
  scopes?: string[];
}

/** POST /cronjobs/update — 修改计划任务（含 id）。 */
export interface OnePanelCronjobUpdate extends OnePanelCronjobCreate {
  id: number;
}
