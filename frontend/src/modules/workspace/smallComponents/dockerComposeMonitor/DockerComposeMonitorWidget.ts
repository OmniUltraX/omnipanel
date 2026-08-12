import {
  SmallComponentBase,
  registerSmallComponentClass,
  type SmallComponentClass,
} from "../base";
import {
  DOCKER_COMPOSE_MONITOR_TYPE,
  DOCKER_MONITOR_SIZES,
} from "../dockerMonitorShared/sizes";
import { DockerComposeMonitorView } from "./DockerComposeMonitorView";

/**
 * Docker Compose 监控：项目内各容器状态 / CPU / 内存。
 * 数据源：Docker 连接；二级目标：Compose 项目。
 */
export class DockerComposeMonitorWidget extends SmallComponentBase {
  static readonly type = DOCKER_COMPOSE_MONITOR_TYPE;
  static readonly labelKey =
    "homeWorkspace.widgets.dockerComposeMonitor.label";
  static readonly descriptionKey =
    "homeWorkspace.widgets.dockerComposeMonitor.description";
  static readonly sizes = DOCKER_MONITOR_SIZES;
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
