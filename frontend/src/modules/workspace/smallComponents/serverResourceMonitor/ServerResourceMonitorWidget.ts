import { enableSshMonitoring } from "../../../../stores/sshMonitoringLifecycle";
import { useDashboardStore } from "../../useDashboardStore";
import {
  SmallComponentBase,
  registerSmallComponentClass,
  type SmallComponentClass,
} from "../base";
import { ServerResourceMonitorIcon } from "../widgetIcons";
import {
  SERVER_RESOURCE_MONITOR_SIZES,
  SERVER_RESOURCE_MONITOR_TYPE,
} from "./layout";
import { ServerResourceMonitorView } from "./ServerResourceMonitorView";

/**
 * 服务器资源监控小组件：CPU / 内存 / 磁盘 / GPU。
 * 尺寸 2x2、1x4、1x3；1x3 不渲染 GPU。
 * 数据源：SSH 连接（顶栏选择）。
 */
export class ServerResourceMonitorWidget extends SmallComponentBase {
  static readonly type = SERVER_RESOURCE_MONITOR_TYPE;
  static readonly labelKey = "homeWorkspace.widgets.serverResourceMonitor.label";
  static readonly descriptionKey =
    "homeWorkspace.widgets.serverResourceMonitor.description";
  static readonly Icon = ServerResourceMonitorIcon;
  static readonly sizes = SERVER_RESOURCE_MONITOR_SIZES;
  static readonly dataSourceKind = "ssh" as const;
  static readonly View = ServerResourceMonitorView;

  /** 当前绑定的 SSH 连接 id（与 widget.dataSourceId 同步） */
  hostId: string | null = null;

  private listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  setHostId(hostId: string | null): void {
    if (this.hostId === hostId) return;
    this.hostId = hostId;
    this.emit();
  }

  async update(): Promise<void> {
    const widget = useDashboardStore
      .getState()
      .customPanels[this.panelId]?.widgets.find((w) => w.id === this.instanceId);
    const nextId = widget?.dataSourceId ?? null;
    this.hostId = nextId;
    if (nextId) {
      await enableSshMonitoring(nextId);
    }
    this.emit();
  }
}

registerSmallComponentClass(
  ServerResourceMonitorWidget as unknown as SmallComponentClass,
);
