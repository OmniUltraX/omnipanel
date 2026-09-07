import type { ComponentType } from "react";
import type { KeepAliveModuleId } from "../../lib/overlayKeepAlive";

export type ModuleViewComponent = ComponentType<object>;

export interface ViewSink {
  push(event: unknown): void;
}

export interface SessionHandle {
  id: string;
}

/** 与 React 解耦的会话门面；P0 仅定义契约，业务实现自 P1 起迁移 */
export interface ModuleSessionService {
  list(): SessionHandle[];
  get(id: string): SessionHandle | null;
  bindView(id: string, sink: ViewSink): () => void;
  dispose(id: string): Promise<void>;
  onModuleEvicted?(): void;
}

export type ModulePinWhen = "workspace-mirror";

export interface ModuleKeepAlivePolicy {
  /** 是否进入「当前 + 最近 N」窗口 */
  recentEligible: boolean;
  /** 工作区底部仍挂镜像 Tab 时 pin */
  pinWhen?: ModulePinWhen;
}

/** 注册表模块 id：叠层保活键，或常驻 dashboard */
export type ModuleRegistryId = KeepAliveModuleId | "dashboard";

export interface ModuleDescriptor {
  id: ModuleRegistryId;
  /** 主路径，如 /module/terminal、/dashboard */
  path: string;
  /** 含 dockview 等依赖尺寸测量的模块为 true */
  keepLayout: boolean;
  /** 忽略 LRU，始终 mounted（Dashboard） */
  alwaysMounted?: boolean;
  keepAlive: ModuleKeepAlivePolicy;
  loadView: () => Promise<{ default: ModuleViewComponent }>;
  warmChunk?: () => Promise<unknown>;
  createSessionService?: () => ModuleSessionService;
}
