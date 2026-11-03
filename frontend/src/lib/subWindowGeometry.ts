export type SubWindowResizeDirection = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

export interface SubWindowGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const SUBWINDOW_MIN_WIDTH = 280;
export const SUBWINDOW_MIN_HEIGHT = 160;
export const SUBWINDOW_VIEWPORT_PADDING = 16;

export function createCenteredSubWindowGeometry(
  widthRatio: number,
  heightRatio: number,
  viewportWidth = window.innerWidth,
  viewportHeight = window.innerHeight,
  limits?: { maxWidth?: number; maxHeight?: number },
): SubWindowGeometry {
  const maxWidth = Math.max(
    SUBWINDOW_MIN_WIDTH,
    viewportWidth - SUBWINDOW_VIEWPORT_PADDING * 2,
  );
  const maxHeight = Math.max(
    SUBWINDOW_MIN_HEIGHT,
    viewportHeight - SUBWINDOW_VIEWPORT_PADDING * 2,
  );
  const widthCap = limits?.maxWidth ?? maxWidth;
  const heightCap = limits?.maxHeight ?? maxHeight;
  const width = Math.round(
    Math.min(maxWidth, widthCap, Math.max(SUBWINDOW_MIN_WIDTH, viewportWidth * widthRatio)),
  );
  const height = Math.round(
    Math.min(maxHeight, heightCap, Math.max(SUBWINDOW_MIN_HEIGHT, viewportHeight * heightRatio)),
  );
  const x = Math.round((viewportWidth - width) / 2);
  const y = Math.round((viewportHeight - height) / 2);
  return { x, y, width, height };
}

export function clampSubWindowGeometry(geometry: SubWindowGeometry): SubWindowGeometry {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const maxWidth = Math.max(
    SUBWINDOW_MIN_WIDTH,
    viewportWidth - SUBWINDOW_VIEWPORT_PADDING * 2,
  );
  const maxHeight = Math.max(
    SUBWINDOW_MIN_HEIGHT,
    viewportHeight - SUBWINDOW_VIEWPORT_PADDING * 2,
  );
  const width = Math.round(Math.min(maxWidth, Math.max(SUBWINDOW_MIN_WIDTH, geometry.width)));
  const height = Math.round(Math.min(maxHeight, Math.max(SUBWINDOW_MIN_HEIGHT, geometry.height)));
  const maxX = viewportWidth - width - SUBWINDOW_VIEWPORT_PADDING;
  const maxY = viewportHeight - height - SUBWINDOW_VIEWPORT_PADDING;
  const x = Math.round(
    Math.min(maxX, Math.max(SUBWINDOW_VIEWPORT_PADDING, geometry.x)),
  );
  const y = Math.round(
    Math.min(maxY, Math.max(SUBWINDOW_VIEWPORT_PADDING, geometry.y)),
  );
  return { x, y, width, height };
}

export function maximizedSubWindowGeometry(): SubWindowGeometry {
  return {
    x: SUBWINDOW_VIEWPORT_PADDING,
    y: SUBWINDOW_VIEWPORT_PADDING,
    width: Math.max(
      SUBWINDOW_MIN_WIDTH,
      window.innerWidth - SUBWINDOW_VIEWPORT_PADDING * 2,
    ),
    height: Math.max(
      SUBWINDOW_MIN_HEIGHT,
      window.innerHeight - SUBWINDOW_VIEWPORT_PADDING * 2,
    ),
  };
}

export function resizeSubWindowGeometry(
  start: SubWindowGeometry,
  direction: SubWindowResizeDirection,
  deltaX: number,
  deltaY: number,
): SubWindowGeometry {
  let { x, y, width, height } = start;

  if (direction.includes("e")) {
    width = start.width + deltaX;
  }
  if (direction.includes("w")) {
    width = start.width - deltaX;
    x = start.x + deltaX;
  }
  if (direction.includes("s")) {
    height = start.height + deltaY;
  }
  if (direction.includes("n")) {
    height = start.height - deltaY;
    y = start.y + deltaY;
  }

  if (width < SUBWINDOW_MIN_WIDTH) {
    if (direction.includes("w")) {
      x -= SUBWINDOW_MIN_WIDTH - width;
    }
    width = SUBWINDOW_MIN_WIDTH;
  }
  if (height < SUBWINDOW_MIN_HEIGHT) {
    if (direction.includes("n")) {
      y -= SUBWINDOW_MIN_HEIGHT - height;
    }
    height = SUBWINDOW_MIN_HEIGHT;
  }

  return clampSubWindowGeometry({ x, y, width, height });
}
