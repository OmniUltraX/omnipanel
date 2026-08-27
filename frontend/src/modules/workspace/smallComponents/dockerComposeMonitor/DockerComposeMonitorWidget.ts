import {
  SmallComponentBase,
  registerSmallComponentClass,
  type SmallComponentClass,
} from "../base";
import { DockerMonitorIcon } from "../widgetIcons";
import {
  DOCKER_COMPOSE_MONITOR_TYPE,
  DOCKER_COMPOSE_MONITOR_SIZES,
} from "../dockerMonitorShared/sizes";
import { DockerComposeMonitorView } from "./DockerComposeMonitorView";

/**
 * Docker Compose 监控：项目内各容器状态 / CPU / 内存。
 * 尺寸 2x2 一列、4x4 两列；行高随容器数量自动扩展。
 * 数据源：Docker 连接；二级目标：Compose 项目。
 */
export class DockerComposeMonitorWidget extends SmallComponentBase {
  static readonly type = DOCKER_COMPOSE_MONITOR_TYPE;
  static readonly labelKey =
    "homeWorkspace.widgets.dockerComposeMonitor.label";
  static readonly descriptionKey =
    "homeWorkspace.widgets.dockerComposeMonitor.description";
  static readonly Icon = DockerMonitorIcon;
  static readonly sizes = DOCKER_COMPOSE_MONITOR_SIZES;
  static readonly dataSourceKind = "docker" as const;
  static readonly targetKind = "docker-compose" as const;
  static readonly View = DockerComposeMonitorView;

  async update(): Promise<void> {
    // View 通过 compose containers hook 自行刷新
  }
}

registerSmallComponentClass(
  DockerComposeMonitorWidget as unknown as SmallComponentClass,
);
