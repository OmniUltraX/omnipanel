import type { PointerEvent as ReactPointerEvent } from "react";
import { logSchemaTreeDrop, resolveSchemaDropTargetType } from "./schemaTreeDragLog";
import {
  clearSchemaReorderScopeHighlight,
  getSchemaReorderIndicatorRect,
  getSchemaReorderScope,
  isSameReorderScope,
  resolveSchemaReorderTargetAtPoint,
  setSchemaReorderScopeHighlight,
  type SchemaReorderTarget,
} from "./schemaTreeReorder";
import {
  getSchemaTreeDragText,
  isSchemaTreeItemDraggable,
  setActiveSchemaDragItem,
  type SchemaTreeItem,
} from "./schemaTreeItem";

const DRAG_THRESHOLD_PX = 5;
export const SCHEMA_TREE_DROP_ZONE_ATTR = "data-schema-drop-zone";

type SchemaTreeDropListener = (item: SchemaTreeItem) => void;
type SchemaTreeReorderListener = (item: SchemaTreeItem, target: SchemaReorderTarget) => void;

const dropListeners = new Set<SchemaTreeDropListener>();
const reorderListeners = new Set<SchemaTreeReorderListener>();

export function registerSchemaTreeDropListener(
  listener: SchemaTreeDropListener,
): () => void {
  dropListeners.add(listener);
  return () => {
    dropListeners.delete(listener);
  };
}

export function registerSchemaTreeReorderListener(
  listener: SchemaTreeReorderListener,
): () => void {
  reorderListeners.add(listener);
  return () => {
    reorderListeners.delete(listener);
  };
}

interface PointerDragState {
  item: SchemaTreeItem;
  pointerId: number;
  startX: number;
  startY: number;
  active: boolean;
  ghost: HTMLDivElement | null;
  insertionLine: HTMLDivElement | null;
  reorderTarget: SchemaReorderTarget | null;
  reorderCrossScope: boolean;
  sourceEl: HTMLElement;
}

let dragState: PointerDragState | null = null;
let windowListenersAttached = false;
let suppressNextClick = false;

export function shouldSuppressSchemaTreeClick(): boolean {
  if (!suppressNextClick) {
    return false;
  }
  suppressNextClick = false;
  return true;
}

function ensureWindowListeners(): void {
  if (windowListenersAttached) {
    return;
  }
  windowListenersAttached = true;
  window.addEventListener("pointermove", onWindowPointerMove);
  window.addEventListener("pointerup", onWindowPointerUp);
  window.addEventListener("pointercancel", onWindowPointerCancel);
}

function removeWindowListenersIfIdle(): void {
  if (dragState) {
    return;
  }
  if (!windowListenersAttached) {
    return;
  }
  window.removeEventListener("pointermove", onWindowPointerMove);
  window.removeEventListener("pointerup", onWindowPointerUp);
  window.removeEventListener("pointercancel", onWindowPointerCancel);
  windowListenersAttached = false;
}

function createGhost(item: SchemaTreeItem, x: number, y: number): HTMLDivElement {
  const ghost = document.createElement("div");
  ghost.className = "schema-tree-drag-ghost";
  ghost.textContent = getSchemaTreeDragText(item);
  ghost.style.left = `${x + 12}px`;
  ghost.style.top = `${y + 12}px`;
  document.body.appendChild(ghost);
  return ghost;
}

function updateGhostPosition(x: number, y: number): void {
  if (!dragState?.ghost) {
    return;
  }
  dragState.ghost.style.left = `${x + 12}px`;
  dragState.ghost.style.top = `${y + 12}px`;
}

function removeGhost(): void {
  dragState?.ghost?.remove();
  if (dragState) {
    dragState.ghost = null;
  }
}

function clearInsertionLine(): void {
  dragState?.insertionLine?.remove();
  if (dragState) {
    dragState.insertionLine = null;
  }
}

function clearDropZoneHighlight(): void {
  document.querySelectorAll(".schema-tree-drop-zone--active").forEach((el) => {
    el.classList.remove("schema-tree-drop-zone--active");
  });
}

function updateDropZoneHighlight(x: number, y: number): void {
  clearDropZoneHighlight();
  const target = document.elementFromPoint(x, y);
  const zone = target?.closest(`[${SCHEMA_TREE_DROP_ZONE_ATTR}]`);
  zone?.classList.add("schema-tree-drop-zone--active");
}

function clearReorderUi(): void {
  clearInsertionLine();
  clearSchemaReorderScopeHighlight();
  if (dragState) {
    dragState.reorderTarget = null;
    dragState.reorderCrossScope = false;
  }
}

function updateReorderIndicator(clientX: number, clientY: number): void {
  if (!dragState) {
    return;
  }

  clearReorderUi();

  if (!getSchemaReorderScope(dragState.item)) {
    return;
  }

  const hit = document.elementFromPoint(clientX, clientY);
  if (hit?.closest(`[${SCHEMA_TREE_DROP_ZONE_ATTR}]`)) {
    return;
  }
  if (!hit?.closest(".schema-tree")) {
    return;
  }

  const target = resolveSchemaReorderTargetAtPoint(clientX, clientY, dragState.item);
  if (!target) {
    return;
  }

  const sourceScope = getSchemaReorderScope(dragState.item);
  const crossScope = !isSameReorderScope(sourceScope, target);

  const lineRect = getSchemaReorderIndicatorRect(
    target.scopeKey,
    dragState.item.type,
    target.insertBeforeName,
  );
  if (!lineRect) {
    return;
  }

  dragState.reorderTarget = target;
  dragState.reorderCrossScope = crossScope;

  const line = document.createElement("div");
  line.className = crossScope
    ? "schema-tree-reorder-indicator schema-tree-reorder-indicator--cross-scope"
    : "schema-tree-reorder-indicator";
  line.style.left = `${lineRect.left}px`;
  line.style.top = `${lineRect.top}px`;
  line.style.width = `${lineRect.width}px`;
  document.body.appendChild(line);
  dragState.insertionLine = line;

  setSchemaReorderScopeHighlight(target.scopeKey, dragState.item.type, crossScope);
}

function emitDrop(item: SchemaTreeItem): void {
  for (const listener of dropListeners) {
    listener(item);
  }
}

function emitReorder(item: SchemaTreeItem, target: SchemaReorderTarget): void {
  for (const listener of reorderListeners) {
    listener(item, target);
  }
}

function finishDrag(clientX: number, clientY: number, cancelled: boolean): void {
  const state = dragState;
  if (!state) {
    return;
  }

  clearDropZoneHighlight();
  clearInsertionLine();
  clearSchemaReorderScopeHighlight();
  removeGhost();
  state.sourceEl.classList.remove("tree-node--dragging");

  if (state.active && !cancelled) {
    suppressNextClick = true;

    const hit = document.elementFromPoint(clientX, clientY);
    const sourceScope = getSchemaReorderScope(state.item);
    let reorderTarget: SchemaReorderTarget | null = null;
    let crossScope = false;

    if (!hit?.closest(`[${SCHEMA_TREE_DROP_ZONE_ATTR}]`) && hit?.closest(".schema-tree")) {
      reorderTarget = resolveSchemaReorderTargetAtPoint(clientX, clientY, state.item);
      crossScope = !isSameReorderScope(sourceScope, reorderTarget);
    }

    if (reorderTarget && !crossScope) {
      logSchemaTreeDrop(state.item.type, reorderTarget.referenceType);
      emitReorder(state.item, reorderTarget);
    } else if (reorderTarget && crossScope) {
      // 跨父级：仅 UI 预览，业务逻辑后续补充
      logSchemaTreeDrop(state.item.type, reorderTarget.referenceType);
    } else {
      const dropTargetType = resolveSchemaDropTargetType(hit);
      logSchemaTreeDrop(state.item.type, dropTargetType);

      if (hit?.closest(`[${SCHEMA_TREE_DROP_ZONE_ATTR}]`)) {
        emitDrop(state.item);
      }
    }

    setActiveSchemaDragItem(null);
  }

  dragState = null;
  removeWindowListenersIfIdle();
}

function onWindowPointerMove(event: PointerEvent): void {
  if (!dragState || event.pointerId !== dragState.pointerId) {
    return;
  }

  const dx = event.clientX - dragState.startX;
  const dy = event.clientY - dragState.startY;

  if (!dragState.active) {
    if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) {
      return;
    }
    dragState.active = true;
    setActiveSchemaDragItem(dragState.item);
    dragState.ghost = createGhost(dragState.item, event.clientX, event.clientY);
    dragState.sourceEl.classList.add("tree-node--dragging");
  }

  event.preventDefault();
  updateGhostPosition(event.clientX, event.clientY);
  updateReorderIndicator(event.clientX, event.clientY);

  if (dragState.reorderTarget) {
    clearDropZoneHighlight();
  } else {
    updateDropZoneHighlight(event.clientX, event.clientY);
  }
}

function onWindowPointerUp(event: PointerEvent): void {
  if (!dragState || event.pointerId !== dragState.pointerId) {
    return;
  }
  finishDrag(event.clientX, event.clientY, false);
}

function onWindowPointerCancel(event: PointerEvent): void {
  if (!dragState || event.pointerId !== dragState.pointerId) {
    return;
  }
  finishDrag(event.clientX, event.clientY, true);
}

/** Pointer 拖动：Tauri WebView 下比 HTML5 DnD 更可靠。 */
export function handleSchemaTreePointerDown(
  item: SchemaTreeItem,
  event: ReactPointerEvent<HTMLElement>,
): void {
  if (!isSchemaTreeItemDraggable(item.type)) {
    return;
  }
  if (event.button !== 0) {
    return;
  }
  if (dragState) {
    return;
  }

  dragState = {
    item,
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    active: false,
    ghost: null,
    insertionLine: null,
    reorderTarget: null,
    reorderCrossScope: false,
    sourceEl: event.currentTarget,
  };
  ensureWindowListeners();
}
