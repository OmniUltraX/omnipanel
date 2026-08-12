import { useDashboardStore } from "../../useDashboardStore";
import {
  SmallComponentBase,
  registerSmallComponentClass,
  type SmallComponentClass,
} from "../base";
import {
  REDIS_OVERVIEW_DB_TYPES,
  REDIS_OVERVIEW_SIZES,
  REDIS_OVERVIEW_TYPE,
} from "./layout";
import { RedisOverviewView } from "./RedisOverviewView";

/**
 * Redis 概览：内存占用 / 连接数 / 缓存命中率 / 内存碎片率。
 * 数据源：database（仅 redis）。
 */
export class RedisOverviewWidget extends SmallComponentBase {
  static readonly type = REDIS_OVERVIEW_TYPE;
  static readonly labelKey = "homeWorkspace.widgets.redisOverview.label";
  static readonly descriptionKey =
    "homeWorkspace.widgets.redisOverview.description";
  static readonly sizes = REDIS_OVERVIEW_SIZES;
  static readonly dataSourceKind = "database" as const;
  static readonly dataSourceDbTypes = REDIS_OVERVIEW_DB_TYPES;
  static readonly View = RedisOverviewView;

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

registerSmallComponentClass(RedisOverviewWidget as unknown as SmallComponentClass);
