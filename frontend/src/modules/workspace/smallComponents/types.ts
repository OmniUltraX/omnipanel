import type { ComponentType } from "react";
import type { ConnectionKind } from "../../../ipc/bindings";

/** 小组件列表 / 标题旁图标 */
export type SmallComponentIcon = ComponentType<{
  size?: number;
  className?: string;
}>;

/** 小组件栅格尺寸（12 列体系）；可作唯一尺寸，也可作多预设之一 */
export interface SmallComponentSize {
  /** 预设 id（多尺寸时用于区分；单尺寸可省略） */
  id?: string;
  w: number;
  h: number;
  minW?: number;
  minH?: number;
  maxW?: number;
  maxH?: number;
  /** 预设名称 i18n key（可选） */
  labelKey?: string;
}

/** @deprecated 使用 SmallComponentSize */
export type SmallComponentDefaultSize = SmallComponentSize;

/**
 * 小组件数据源类型（对齐 ConnectionKind 子集）。
 * `null` / 省略表示无需外部连接。
 */
export type SmallComponentDataSourceKind =
  | Extract<ConnectionKind, "ssh" | "database" | "docker" | "panel">
  | null;

export interface SmallComponentInstanceContext {
  instanceId: string;
  panelId: string;
}

/** 运行时控制器最小契约（由 SmallComponentBase 实现） */
export interface SmallComponentController {
  readonly instanceId: string;
  readonly panelId: string;
  update(): void | Promise<void>;
}

export interface SmallComponentRenderProps extends SmallComponentInstanceContext {
  /**
   * 由基类绑定层注入的控制器实例。
   * 纯 definition 注册（无 createInstance）时可能为空。
   */
  controller?: SmallComponentController;
  /** 当前绑定的数据源连接 id（由面板顶栏选择，持久化在 widget 上） */
  dataSourceId?: string | null;
}

/**
 * 小组件二级绑定目标（在 dataSourceId 之上）。
 * - docker-container：具体容器
 * - docker-compose：Compose 项目
 * - database-schema：具体业务库（磁盘占用等按库统计）
 * - bt-java-project：宝塔 Java 项目（get_load_info）
 */
export type HomeCustomPanelWidgetTarget =
  | { kind: "docker-container"; containerId: string }
  | { kind: "docker-compose"; composeProject: string }
  | { kind: "database-schema"; database: string }
  | { kind: "bt-java-project"; projectName: string };

/** 定义侧声明的二级目标类型（驱动编辑表单） */
export type SmallComponentTargetKind =
  | HomeCustomPanelWidgetTarget["kind"]
  | null;

export interface SmallComponentDefinition {
  /** 注册键，全局唯一 */
  type: string;
  /** i18n key；UI 层用 t() 解析 */
  labelKey: string;
  descriptionKey?: string;
  /** 组件列表左侧图标 */
  icon?: SmallComponentIcon;
  /**
   * 支持的尺寸预设（至少一个）。
   * 添加到画布时默认使用第一项；min/max 约束可取全体预设并集。
   */
  sizes: readonly SmallComponentSize[];
  /**
   * 数据源类型：添加后需在设置中选择对应连接。
   * 例如服务器监控 → ssh；Docker 监控 → docker。
   */
  dataSourceKind?: SmallComponentDataSourceKind;
  /**
   * 当 dataSourceKind 为 database 时，可按 db_type 过滤（如仅 MySQL）。
   * 值小写比较（mysql / mariadb）。
   */
  dataSourceDbTypes?: readonly string[];
  /**
   * 当 dataSourceKind 为 panel 时，可按面板类型过滤（如仅宝塔）。
   */
  dataSourcePanelServiceTypes?: readonly ("bt" | "1panel")[];
  /**
   * 二级目标：Docker 连接选定后再选容器 / Compose 项目。
   */
  targetKind?: SmallComponentTargetKind;
  /** 实际渲染组件 */
  component: ComponentType<SmallComponentRenderProps>;
  /** 类封装注册时提供：创建运行时实例以调用 update() */
  createInstance?: (ctx: SmallComponentInstanceContext) => SmallComponentController;
}

/** 自定义面板中已放置的小组件实例 */
export interface HomeCustomPanelWidget {
  id: string;
  type: string;
  /** 选用的尺寸预设 id（对应 SmallComponentSize.id）；未设则按布局数值） */
  sizeId?: string;
  /**
   * 等比缩放倍率（1× / 2×）：相对 sizeId 对应预设的 w/h。
   * 省略视为 1。
   */
  scale?: 1 | 2;
  /** 绑定的数据源连接 id（SSH / DB / Docker 等） */
  dataSourceId?: string;
  /** 二级目标（容器 id / Compose 项目名等） */
  target?: HomeCustomPanelWidgetTarget;
  layout: {
    x: number;
    y: number;
    w: number;
    h: number;
    minW?: number;
    minH?: number;
    maxW?: number;
    maxH?: number;
  };
}

/** 取默认尺寸（sizes 第一项） */
export function getDefaultSize(
  def: Pick<SmallComponentDefinition, "sizes">,
): SmallComponentSize {
  const size = def.sizes[0];
  if (!size) {
    throw new Error("[smallComponents] sizes must contain at least one preset");
  }
  return size;
}

/** 由多预设推导拖拽缩放边界 */
export function sizeBoundsFromPresets(
  sizes: readonly SmallComponentSize[],
): Pick<SmallComponentSize, "minW" | "minH" | "maxW" | "maxH"> {
  if (sizes.length === 0) {
    return {};
  }
  let minW = Infinity;
  let minH = Infinity;
  let maxW = -Infinity;
  let maxH = -Infinity;
  for (const s of sizes) {
    minW = Math.min(minW, s.minW ?? s.w);
    minH = Math.min(minH, s.minH ?? s.h);
    maxW = Math.max(maxW, s.maxW ?? s.w);
    maxH = Math.max(maxH, s.maxH ?? s.h);
  }
  return { minW, minH, maxW, maxH };
}
