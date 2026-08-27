import { useDashboardStore } from "../../useDashboardStore";
import {
  SmallComponentBase,
  registerSmallComponentClass,
  type SmallComponentClass,
} from "../base";
import { SpringBootAdminIcon } from "../widgetIcons";
import {
  SPRING_BOOT_ADMIN_SIZES,
  SPRING_BOOT_ADMIN_TYPE,
} from "./layout";
import { SpringBootAdminView } from "./SpringBootAdminView";

/**
 * Spring Boot Admin：线程 / Heap / Non-heap 时序图。
 * 数据源：手填 SBA 地址 + 选择 Java 实例（无需 OmniPanel 连接）。
 */
export class SpringBootAdminWidget extends SmallComponentBase {
  static readonly type = SPRING_BOOT_ADMIN_TYPE;
  static readonly labelKey = "homeWorkspace.widgets.springBootAdmin.label";
  static readonly descriptionKey =
    "homeWorkspace.widgets.springBootAdmin.description";
  static readonly Icon = SpringBootAdminIcon;
  static readonly sizes = SPRING_BOOT_ADMIN_SIZES;
  static readonly dataSourceKind = null;
  static readonly targetKind = "spring-boot-admin" as const;
  static readonly View = SpringBootAdminView;

  private listeners = new Set<() => void>();
  private tick = 0;

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    this.tick += 1;
    for (const listener of this.listeners) listener();
  }

  get revision(): number {
    return this.tick;
  }

  async update(): Promise<void> {
    void useDashboardStore
      .getState()
      .customPanels[this.panelId]?.widgets.find((w) => w.id === this.instanceId);
    this.emit();
  }
}

registerSmallComponentClass(SpringBootAdminWidget as unknown as SmallComponentClass);
