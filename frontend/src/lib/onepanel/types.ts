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
