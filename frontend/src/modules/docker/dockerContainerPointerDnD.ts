export const DOCKER_CONTAINER_POINTER_DRAG_THRESHOLD_PX = 5;

export function isDockerContainerPointerDragExcluded(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return true;
  return Boolean(target.closest(".tree-arrow, .tree-action-btn, button"));
}

/** WebView2 不触发 HTML5 dragover，用 pointer + elementFromPoint 解析服务组落点。 */
export function resolveDockerServiceGroupDropFromPointer(
  clientX: number,
  clientY: number,
  connectionId: string,
): string | null {
  const hit = document.elementFromPoint(clientX, clientY);
  if (!hit?.closest(".docker-sidebar-tree")) {
    return null;
  }

  const category = hit.closest(
    `[data-docker-connection-id="${connectionId}"][data-docker-service-group-id]`,
  ) as HTMLElement | null;

  return category?.dataset.dockerServiceGroupId ?? null;
}
