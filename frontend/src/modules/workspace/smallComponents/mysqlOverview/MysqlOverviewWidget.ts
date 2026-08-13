import { useDashboardStore } from "../../useDashboardStore";
import {
  SmallComponentBase,
  registerSmallComponentClass,
  type SmallComponentClass,
} from "../base";
import { MysqlOverviewIcon } from "../widgetIcons";
import {
  MYSQL_OVERVIEW_DB_TYPES,
  MYSQL_OVERVIEW_SIZES,
  MYSQL_OVERVIEW_TYPE,
} from "./layout";
import { MysqlOverviewView } from "./MysqlOverviewView";

/**
 * MySQL 概览：InnoDB 缓冲池占用 / 连接占用 / 库磁盘占用。
 * 数据源：database（仅 mysql / mariadb）。
 */
export class MysqlOverviewWidget extends SmallComponentBase {
  static readonly type = MYSQL_OVERVIEW_TYPE;
  static readonly labelKey = "homeWorkspace.widgets.mysqlOverview.label";
  static readonly descriptionKey = "homeWorkspace.widgets.mysqlOverview.description";
  static readonly Icon = MysqlOverviewIcon;
  static readonly sizes = MYSQL_OVERVIEW_SIZES;
  static readonly dataSourceKind = "database" as const;
  static readonly dataSourceDbTypes = MYSQL_OVERVIEW_DB_TYPES;
  static readonly targetKind = "database-schema" as const;
  static readonly View = MysqlOverviewView;

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

  /** View 可订阅，用于手动刷新后触发重渲染 */
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

registerSmallComponentClass(MysqlOverviewWidget as unknown as SmallComponentClass);
