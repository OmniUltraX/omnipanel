import {
  createElement,
  useEffect,
  useRef,
  type ComponentType,
  type ReactElement,
} from "react";
import { registerSmallComponent } from "./registry";
import type {
  SmallComponentController,
  SmallComponentDataSourceKind,
  SmallComponentDefinition,
  SmallComponentInstanceContext,
  SmallComponentRenderProps,
  SmallComponentSize,
} from "./types";

/**
 * 小组件抽象基类（方案：每实例持有 update()）。
 *
 * 子类需在 **静态侧** 声明元数据，并实现实例级 `update()`：
 * - `type` / `labelKey` / `sizes` / `View`
 * - `update()`：拉取或刷新数据，供宿主定时/手动调用
 *
 * @example
 * ```ts
 * class CpuWidget extends SmallComponentBase {
 *   static readonly type = "cpu";
 *   static readonly labelKey = "homeWorkspace.widgets.cpu";
 *   static readonly sizes = [{ w: 4, h: 3 }] as const;
 *   static readonly View = CpuWidgetView;
 *   async update() { ... }
 * }
 * registerSmallComponentClass(CpuWidget);
 * ```
 */
export abstract class SmallComponentBase implements SmallComponentController {
  readonly instanceId: string;
  readonly panelId: string;

  constructor(ctx: SmallComponentInstanceContext) {
    this.instanceId = ctx.instanceId;
    this.panelId = ctx.panelId;
  }

  /** 抽象更新：刷新本实例数据（可异步） */
  abstract update(): void | Promise<void>;
}

/** 可注册的小组件类（静态元数据 + 可 new 出基类实例） */
export interface SmallComponentClass {
  new (ctx: SmallComponentInstanceContext): SmallComponentBase;
  readonly type: string;
  readonly labelKey: string;
  readonly descriptionKey?: string;
  readonly sizes: readonly SmallComponentSize[];
  /** 数据源类型；省略则无需选择连接 */
  readonly dataSourceKind?: SmallComponentDataSourceKind;
  /** database 数据源按引擎过滤（如 mysql / mariadb） */
  readonly dataSourceDbTypes?: readonly string[];
  /** 二级目标类型；省略则无需二级选择 */
  readonly targetKind?: import("./types").SmallComponentTargetKind;
  readonly View: ComponentType<SmallComponentRenderProps>;
}

/** 运行中的实例，按 instanceId 索引，供面板批量 update */
const liveInstances = new Map<string, SmallComponentBase>();

export function getLiveSmallComponent(
  instanceId: string,
): SmallComponentBase | undefined {
  return liveInstances.get(instanceId);
}

export function listLiveSmallComponents(
  panelId?: string,
): SmallComponentBase[] {
  const all = [...liveInstances.values()];
  if (!panelId) return all;
  return all.filter((inst) => inst.panelId === panelId);
}

export async function updateSmallComponent(instanceId: string): Promise<void> {
  const inst = liveInstances.get(instanceId);
  if (!inst) return;
  await inst.update();
}

export async function updateAllSmallComponents(panelId?: string): Promise<void> {
  await Promise.all(listLiveSmallComponents(panelId).map((inst) => inst.update()));
}

function attachLiveInstance(inst: SmallComponentBase): void {
  liveInstances.set(inst.instanceId, inst);
}

function detachLiveInstance(inst: SmallComponentBase): void {
  const current = liveInstances.get(inst.instanceId);
  if (current === inst) {
    liveInstances.delete(inst.instanceId);
  }
}

/**
 * 将类的 View 包一层：挂载时创建实例、注册到 live map，并触发一次 update。
 */
export function bindSmallComponentView(
  Cls: SmallComponentClass,
): ComponentType<SmallComponentRenderProps> {
  function BoundSmallComponentView(
    props: SmallComponentRenderProps,
  ): ReactElement {
    const controllerRef = useRef<SmallComponentBase | null>(null);

    if (
      !controllerRef.current ||
      controllerRef.current.instanceId !== props.instanceId ||
      controllerRef.current.panelId !== props.panelId
    ) {
      controllerRef.current = new Cls({
        instanceId: props.instanceId,
        panelId: props.panelId,
      });
    }

    const controller = controllerRef.current;

    useEffect(() => {
      attachLiveInstance(controller);
      void Promise.resolve(controller.update()).catch((err) => {
        console.warn(
          `[smallComponents] update failed (${Cls.type}/${controller.instanceId})`,
          err,
        );
      });
      return () => {
        detachLiveInstance(controller);
      };
    }, [controller, props.dataSourceId]);

    return createElement(Cls.View, { ...props, controller });
  }

  BoundSmallComponentView.displayName = `SmallComponent(${Cls.type})`;
  return BoundSmallComponentView;
}

/** 由小组件类生成注册用 definition */
export function definitionFromSmallComponentClass(
  Cls: SmallComponentClass,
): SmallComponentDefinition {
  if (!Cls.sizes || Cls.sizes.length === 0) {
    throw new Error(
      `[smallComponents] ${Cls.type}: sizes must contain at least one preset`,
    );
  }
  return {
    type: Cls.type,
    labelKey: Cls.labelKey,
    descriptionKey: Cls.descriptionKey,
    sizes: Cls.sizes,
    dataSourceKind: Cls.dataSourceKind ?? null,
    dataSourceDbTypes: Cls.dataSourceDbTypes,
    targetKind: Cls.targetKind ?? null,
    component: bindSmallComponentView(Cls),
    createInstance: (ctx) => new Cls(ctx),
  };
}

/** 注册基于基类的小组件 */
export function registerSmallComponentClass(Cls: SmallComponentClass): void {
  registerSmallComponent(definitionFromSmallComponentClass(Cls));
}
