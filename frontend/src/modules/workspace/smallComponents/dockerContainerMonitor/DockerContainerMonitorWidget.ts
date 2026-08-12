import { useDashboardStore } from "../../useDashboardStore";
import {
  SmallComponentBase,
  registerSmallComponentClass,
  type SmallComponentClass,
} from "../base";
import {
  DOCKER_CONTAINER_MONITOR_TYPE,
  DOCKER_MONITOR_SIZES,
} from "../dockerMonitorShared/sizes";
import { DockerContainerMonitorView } from "./DockerContainerMonitorView";

/**
 * Docker 容器监控：状态 / CPU / 内存。
 * 数据源：Docker 连接；二级目标：容器。
 */
export class DockerContainerMonitorWidget extends SmallComponentBase {
  static readonly type = DOCKER_CONTAINER_MONITOR_TYPE;
  static readonly labelKey =
    "homeWorkspace.widgets.dockerContainerMonitor.label";
  static readonly descriptionKey =
    "homeWorkspace.widgets.dockerContainerMonitor.description";
  static readonly sizes = DOCKER_MONITOR_SIZES;
  static readonly dataSourceKind = "docker" as const;
  static readonly targetKind = "docker-container" as const;
  static readonly View = DockerContainerMonitorView;

  async update(): Promise<void> {
    // View 通过 sidebar cache + stats hook 自行刷新；此处保留契约
    void useDashboardStore
      .getState()
      .customPanels[this.panelId]?.widgets.find((w) => w.id === this.instanceId);
  }
}

registerSmallComponentClass(
  DockerContainerMonitorWidget as unknown as SmallComponentClass,
);
