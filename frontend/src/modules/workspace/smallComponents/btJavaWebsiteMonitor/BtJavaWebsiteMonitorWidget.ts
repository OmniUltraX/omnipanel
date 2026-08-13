import { useDashboardStore } from "../../useDashboardStore";
import {
  SmallComponentBase,
  registerSmallComponentClass,
  type SmallComponentClass,
} from "../base";
import { BtJavaWebsiteMonitorIcon } from "../widgetIcons";
import { BtJavaWebsiteMonitorView } from "./BtJavaWebsiteMonitorView";
import {
  BT_JAVA_WEBSITE_MONITOR_SIZES,
  BT_JAVA_WEBSITE_MONITOR_TYPE,
} from "./layout";

/**
 * 宝塔 Java 网站监控：调用官方 get_load_info 展示 CPU / 内存。
 * @see https://docs.bt.cn/api/java/get_load_info
 */
export class BtJavaWebsiteMonitorWidget extends SmallComponentBase {
  static readonly type = BT_JAVA_WEBSITE_MONITOR_TYPE;
  static readonly labelKey = "homeWorkspace.widgets.btJavaWebsiteMonitor.label";
  static readonly descriptionKey =
    "homeWorkspace.widgets.btJavaWebsiteMonitor.description";
  static readonly Icon = BtJavaWebsiteMonitorIcon;
  static readonly sizes = BT_JAVA_WEBSITE_MONITOR_SIZES;
  static readonly dataSourceKind = "panel" as const;
  static readonly dataSourcePanelServiceTypes = ["bt"] as const;
  static readonly targetKind = "bt-java-project" as const;
  static readonly View = BtJavaWebsiteMonitorView;

  revision = 0;
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

  async update(): Promise<void> {
    // 触发 View 内轮询 effect 依赖 revision 重拉
    void useDashboardStore.getState().customPanels[this.panelId]?.widgets.find(
      (w) => w.id === this.instanceId,
    );
    this.revision += 1;
    this.emit();
  }
}

registerSmallComponentClass(
  BtJavaWebsiteMonitorWidget as unknown as SmallComponentClass,
);
