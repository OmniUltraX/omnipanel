// G6 自定义扩展改编自官方 mindmap 示例，类型声明较复杂，此处关闭严格检查。
// @ts-nocheck
import { Rect as GRect, Text } from "@antv/g";
import {
  Badge,
  BaseBehavior,
  BaseNode,
  BaseTransform,
  CommonEvent,
  CubicHorizontal,
  ExtensionCategory,
  Graph,
  idOf,
  register,
  treeToGraphData,
  type GraphData,
  type NodeData,
  type TreeData,
} from "@antv/g6";
import { readTreeDiagramTheme, type TreeDiagramTheme } from "./treeDiagramTheme";

const TreeEvent = {
  COLLAPSE_EXPAND: "collapse-expand",
} as const;

const COLLAPSE_BADGE_SIZE = 16;
const COLLAPSE_INSET_X = 8;
const COLLAPSE_RESERVE = 26;

const LABEL_FONT_FAMILY = 'system-ui, -apple-system, "Segoe UI", sans-serif';

function resolveThemeContainer(graph: Graph): HTMLElement {
  const container = graph.getOptions().container;
  return container instanceof HTMLElement ? container : document.documentElement;
}

function buildRootNodeStyle(theme: TreeDiagramTheme) {
  return {
    fill: theme.rootFill,
    stroke: theme.rootStroke,
    lineWidth: 1,
    labelFill: theme.rootLabelFill,
    labelFontSize: 18,
    labelFontWeight: 600,
    labelOffsetY: 4,
    labelPlacement: "center" as const,
    ports: [{ placement: "right" as const }],
    radius: 8,
  };
}

function buildNodeStyle(theme: TreeDiagramTheme) {
  return {
    fill: theme.nodeFill,
    stroke: theme.nodeStroke,
    lineWidth: 1,
    labelFill: theme.labelFill,
    labelPlacement: "center" as const,
    labelFontSize: 14,
    ports: [{ placement: "right" as const }],
    radius: 6,
  };
}

let textShape: Text | undefined;
const measureText = (text: ConstructorParameters<typeof Text>[0]["style"]) => {
  if (!textShape) textShape = new Text({ style: text });
  textShape.attr(text);
  return textShape.getBBox().width;
};

const getNodeWidth = (nodeId: string, isRoot: boolean, hasChildren = false) => {
  const padding = isRoot ? 40 : 28;
  const collapseReserve = hasChildren ? COLLAPSE_RESERVE : 0;
  const labelFontSize = isRoot ? 18 : 14;
  return (
    measureText({
      text: nodeId,
      fontSize: labelFontSize,
      fontFamily: LABEL_FONT_FAMILY,
    }) +
    padding +
    collapseReserve
  );
};

const getNodeSize = (nodeId: string, isRoot: boolean, hasChildren = false): [number, number] => {
  const width = getNodeWidth(nodeId, isRoot, hasChildren);
  const height = isRoot ? 48 : 36;
  return [width, height];
};

/** 子节点全部在右侧展开，根节点居中 */
const getNodeSide = (_nodeData: NodeData, parentData?: NodeData) => {
  if (!parentData) return "center";
  return "right";
};

type ViewportSnapshot = {
  zoom: number;
  viewportPoint: [number, number];
};

/** 记录节点在视口中的屏幕位置，用于收起/展开后把该点拉回原位 */
function captureNodeViewport(graph: Graph, nodeId: string): ViewportSnapshot | null {
  if (graph.destroyed) return null;
  const position = graph.getElementPosition(nodeId);
  if (!position) return null;
  const viewportPoint = graph.getViewportByCanvas([position[0], position[1]]) as [number, number];
  return {
    zoom: graph.getZoom(),
    viewportPoint,
  };
}

async function restoreNodeViewport(graph: Graph, nodeId: string, snapshot: ViewportSnapshot | null) {
  if (!snapshot || graph.destroyed) return;

  const position = graph.getElementPosition(nodeId);
  if (!position) return;

  const currentViewportPoint = graph.getViewportByCanvas([position[0], position[1]]) as [number, number];
  const dx = snapshot.viewportPoint[0] - currentViewportPoint[0];
  const dy = snapshot.viewportPoint[1] - currentViewportPoint[1];

  if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) {
    await graph.translateBy([dx, dy], false);
  }

  const zoom = graph.getZoom();
  if (Math.abs(zoom - snapshot.zoom) > 0.001) {
    await graph.zoomTo(snapshot.zoom, false);
  }
}

function isGraphAlive(graph: Graph | undefined | null): graph is Graph {
  return Boolean(graph && !graph.destroyed);
}

class MindmapNode extends BaseNode {
  static defaultStyleProps = {
    showIcon: false,
  };

  constructor(options: ConstructorParameters<typeof BaseNode>[0]) {
    Object.assign(options.style, MindmapNode.defaultStyleProps);
    super(options);
  }

  get childrenData() {
    return this.context.model.getChildrenData(this.id);
  }

  get rootId() {
    return idOf(this.context.model.getRootsData()[0]);
  }

  getTheme(): TreeDiagramTheme {
    return readTreeDiagramTheme(resolveThemeContainer(this.context.graph));
  }

  /** 折叠/展开按钮中心（节点局部坐标，原点在节点中心） */
  getCollapseCenter(attributes: Record<string, unknown>) {
    const [width] = this.getSize(attributes);
    return {
      x: width / 2 - COLLAPSE_INSET_X - COLLAPSE_BADGE_SIZE / 2,
      y: 0,
    };
  }

  hasCollapseControl(attributes: Record<string, unknown>) {
    return Boolean(this.getCollapseStyle(attributes) || this.getCountStyle(attributes));
  }

  emitCollapseExpand(event: Event) {
    event.stopPropagation();
    const collapsed = Boolean(this.parsedAttributes.collapsed);
    this.context.graph.emit(TreeEvent.COLLAPSE_EXPAND, {
      id: this.id,
      collapsed: !collapsed,
    });
  }

  bindCollapsePointer(target: { addEventListener: (type: string, listener: (event: Event) => void) => void; removeEventListener?: (type: string, listener: (event: Event) => void) => void } | false | undefined) {
    if (!target) return;

    const prev = Reflect.get(target, "__collapse_listener__") as ((event: Event) => void) | undefined;
    if (prev && target.removeEventListener) {
      target.removeEventListener(CommonEvent.CLICK, prev);
    }

    const onClick = (event: Event) => {
      this.emitCollapseExpand(event);
    };

    Reflect.set(target, "__collapse_listener__", onClick);
    target.addEventListener(CommonEvent.CLICK, onClick);
  }

  drawCollapseHitArea(attributes: Record<string, unknown>, container: unknown) {
    if (!this.hasCollapseControl(attributes)) {
      this.upsert("collapse-hit", GRect, false, container);
      return;
    }

    const center = this.getCollapseCenter(attributes);
    const hitSize = 24;
    const hit = this.upsert(
      "collapse-hit",
      GRect,
      {
        cursor: "pointer",
        fill: "transparent",
        height: hitSize,
        lineWidth: 0,
        stroke: "transparent",
        width: hitSize,
        x: center.x - hitSize / 2,
        y: center.y - hitSize / 2,
        zIndex: 20,
      },
      container,
    );

    this.bindCollapsePointer(hit);
  }

  buildBadgeStyle(
    attributes: Record<string, unknown>,
    text: string,
    color?: string,
  ): Record<string, unknown> | false {
    const theme = this.getTheme();
    const center = this.getCollapseCenter(attributes);
    return {
      backgroundFill: color || theme.branchColors[0],
      backgroundHeight: COLLAPSE_BADGE_SIZE,
      backgroundWidth: COLLAPSE_BADGE_SIZE,
      backgroundRadius: 3,
      cursor: "pointer",
      fill: theme.collapseIconFill,
      fontFamily: LABEL_FONT_FAMILY,
      fontSize: 10,
      fontWeight: 600,
      text,
      textAlign: "center",
      textBaseline: "middle",
      x: center.x,
      y: center.y,
    };
  }

  isShowCollapse(attributes: Record<string, unknown>) {
    const { collapsed } = attributes;
    return !collapsed && this.childrenData.length > 0;
  }

  getCollapseStyle(attributes: Record<string, unknown>) {
    const { color } = attributes;
    if (!this.isShowCollapse(attributes)) return false;
    return this.buildBadgeStyle(attributes, "−", color as string | undefined);
  }

  drawCollapseShape(attributes: Record<string, unknown>, container: unknown) {
    const iconStyle = this.getCollapseStyle(attributes);
    const btn = this.upsert("collapse-expand", Badge, iconStyle, container);
    this.bindCollapsePointer(btn);
  }

  getCountStyle(attributes: Record<string, unknown>) {
    const { collapsed, color } = attributes;
    const count = this.context.model.getDescendantsData(this.id).length;
    if (!collapsed || count === 0) return false;
    return this.buildBadgeStyle(attributes, count.toString(), color as string | undefined);
  }

  drawCountShape(attributes: Record<string, unknown>, container: unknown) {
    const countStyle = this.getCountStyle(attributes);
    const btn = this.upsert("count", Badge, countStyle, container);
    this.bindCollapsePointer(btn);
  }

  getKeyStyle(attributes: Record<string, unknown>) {
    const [width, height] = this.getSize(attributes);
    const keyShape = super.getKeyStyle(attributes);
    return {
      ...keyShape,
      width,
      height,
      x: -width / 2,
      y: -height / 2,
    };
  }

  drawKeyShape(attributes: Record<string, unknown>, container: unknown) {
    return this.upsert("key", GRect, this.getKeyStyle(attributes), container);
  }

  render(attributes = this.parsedAttributes, container = this) {
    super.render(attributes, container);

    this.drawCollapseShape(attributes, container);
    this.drawCountShape(attributes, container);
    this.drawCollapseHitArea(attributes, container);
  }
}

class MindmapEdge extends CubicHorizontal {
  get rootId() {
    return idOf(this.context.model.getRootsData()[0]);
  }

  getKeyPath(attributes: Record<string, unknown>) {
    const path = super.getKeyPath(attributes);
    const targetHasChildren = this.context.model.getChildrenData(this.targetNode.id).length > 0;
    // 叶子节点不再向右拖出多余线段
    if (!targetHasChildren) {
      return path;
    }

    const isRoot = this.targetNode.id === this.rootId;
    const [width] = getNodeSize(this.targetNode.id, isRoot, true);
    const [, tp] = this.getEndpoints(attributes);
    return [...path, ["L", tp[0] + width / 2, tp[1]]];
  }
}

interface CollapseExpandTreeOptions {
  type?: string;
}

class CollapseExpandTree extends BaseBehavior<CollapseExpandTreeOptions> {
  status: "idle" | "busy" = "idle";

  constructor(context: ConstructorParameters<typeof BaseBehavior>[0], options?: CollapseExpandTreeOptions) {
    super(context, options);
    this.bindEvents();
  }

  update(options: CollapseExpandTreeOptions) {
    this.unbindEvents();
    super.update(options);
    this.bindEvents();
  }

  bindEvents() {
    const { graph } = this.context;

    graph.on(TreeEvent.COLLAPSE_EXPAND, this.onCollapseExpand);
  }

  unbindEvents() {
    const { graph } = this.context;
    if (!isGraphAlive(graph)) return;

    graph.off(TreeEvent.COLLAPSE_EXPAND, this.onCollapseExpand);
  }

  onCollapseExpand = async (event: { id: string; collapsed: boolean }) => {
    this.status = "busy";
    const { id, collapsed } = event;
    const { graph } = this.context;
    if (!isGraphAlive(graph)) {
      this.status = "idle";
      return;
    }

    const viewportAnchor = captureNodeViewport(graph, id);
    const collapseOptions = { animation: false, align: true };

    try {
      if (collapsed) {
        await graph.collapseElement(id, collapseOptions);
      } else {
        await graph.expandElement(id, collapseOptions);
      }
      await restoreNodeViewport(graph, id, viewportAnchor);
    } finally {
      this.status = "idle";
    }
  };

  destroy() {
    this.unbindEvents();
    super.destroy();
  }
}

class AssignColorByBranch extends BaseTransform {
  constructor(
    context: ConstructorParameters<typeof BaseTransform>[0],
    options?: Record<string, never>,
  ) {
    super(context, options ?? {});
  }

  beforeDraw(input: Parameters<BaseTransform["beforeDraw"]>[0]) {
    const nodes = this.context.model.getNodeData();
    if (nodes.length === 0) return input;

    const theme = readTreeDiagramTheme(resolveThemeContainer(this.context.graph));
    const colors = theme.branchColors;

    let colorIndex = 0;
    const dfs = (nodeId: string, color?: string) => {
      const node = nodes.find((datum) => datum.id === nodeId);
      if (!node) return;

      node.style ||= {};
      node.style.color = color || colors[colorIndex++ % colors.length];
      node.children?.forEach((childId) => dfs(childId, node.style?.color as string | undefined));
    };

    nodes.filter((node) => node.depth === 1).forEach((rootNode) => dfs(rootNode.id));

    return input;
  }
}

let extensionsRegistered = false;

export function ensureG6MindmapExtensions() {
  if (extensionsRegistered) return;
  extensionsRegistered = true;

  register(ExtensionCategory.NODE, "mindmap", MindmapNode);
  register(ExtensionCategory.EDGE, "mindmap", MindmapEdge);
  register(ExtensionCategory.BEHAVIOR, "collapse-expand-tree", CollapseExpandTree);
  register(ExtensionCategory.TRANSFORM, "assign-color-by-branch", AssignColorByBranch);
}

export const SAMPLE_TREE_DATA: TreeData = {
  id: "示例根节点",
  children: [
    {
      id: "连接 A",
      children: [{ id: "数据库 db1" }, { id: "数据库 db2" }],
    },
    {
      id: "连接 B",
      children: [{ id: "表 users" }, { id: "表 orders" }],
    },
  ],
};

export function createMindmapGraph(container: HTMLElement, treeData: TreeData): Graph {
  ensureG6MindmapExtensions();

  const rootId = treeData.id as string;
  const graphData = treeToGraphData(treeData) as GraphData;
  const getTheme = () => readTreeDiagramTheme(container);

  const graph = new Graph({
    container,
    autoFit: "view",
    data: graphData,
    node: {
      type: "mindmap",
      style: function (this: Graph, d: NodeData) {
        const direction = getNodeSide(d, this.getParentData(idOf(d), "tree"));
        const nodeId = idOf(d);
        const isRoot = nodeId === rootId;
        const hasChildren = Boolean(d.children?.length);
        const theme = getTheme();

        return {
          direction,
          labelText: nodeId,
          size: getNodeSize(nodeId, isRoot, hasChildren),
          labelFontFamily: LABEL_FONT_FAMILY,
          labelBackground: true,
          labelBackgroundFill: "transparent",
          labelPointerEvents: "none",
          labelPadding: hasChildren ? [4, 30, 4, 14] : [4, 14, 4, 14],
          labelMaxWidth: hasChildren
            ? getNodeWidth(nodeId, isRoot, hasChildren) - COLLAPSE_RESERVE - 16
            : undefined,
          ...(isRoot ? buildRootNodeStyle(theme) : buildNodeStyle(theme)),
        };
      },
    },
    edge: {
      type: "mindmap",
      style: {
        lineWidth: 2,
        pointerEvents: "none",
        stroke: function (this: Graph, data: { target: string }) {
          const theme = getTheme();
          return (this.getNodeData(data.target).style?.color as string | undefined) || theme.edgeFallback;
        },
      },
    },
    layout: {
      type: "mindmap",
      direction: "H",
      getSide: () => "right",
      getHeight: (node: { id: string; children?: string[] }) =>
        getNodeSize(node.id, node.id === rootId, Boolean(node.children?.length))[1],
      getWidth: (node: { id: string; children?: string[] }) =>
        getNodeWidth(node.id, node.id === rootId, Boolean(node.children?.length)),
      getVGap: () => 16,
      getHGap: () => 64,
      animation: false,
    },
    behaviors: ["drag-canvas", "zoom-canvas", "collapse-expand-tree"],
    transforms: ["assign-color-by-branch"],
    animation: false,
  });

  return graph;
}

export async function refreshMindmapGraphTheme(graph: Graph): Promise<void> {
  if (graph.destroyed) return;
  try {
    await graph.draw();
  } catch {
    // 图已销毁时忽略
  }
}

export type MindmapGraphSession = {
  disposed: boolean;
};

export async function renderMindmapGraph(graph: Graph, session?: MindmapGraphSession): Promise<void> {
  // 与 G6 render() 首帧对齐，卸载发生在首帧前则不再调用 render，避免 destroy 竞态
  await Promise.resolve();
  if (session?.disposed || graph.destroyed) return;
  try {
    await graph.render();
  } catch {
    return;
  }
  if (session?.disposed || graph.destroyed) return;
  delete graph.getOptions().autoFit;
}
