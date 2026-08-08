/**
 * `@tauri-apps/api/dpi` 的 Web shim（浏览器运行）。
 *
 * 浏览器无独立 DPI 类型：`LogicalSize`/`LogicalPosition`/`PhysicalSize`/`PhysicalPosition`
 * 退化为带 `toLogical`/`toPhysical` 的最小数值包装，保证 `getCurrentWindow().setSize(...)`
 * 等桌面调用在 Web 下不抛错。
 */

export class LogicalSize {
  width: number;
  height: number;
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }
  toPhysical(scaleFactor: number): PhysicalSize {
    return new PhysicalSize(Math.round(this.width * scaleFactor), Math.round(this.height * scaleFactor));
  }
}

export class PhysicalSize {
  width: number;
  height: number;
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }
  toLogical(scaleFactor: number): LogicalSize {
    return new LogicalSize(this.width / scaleFactor, this.height / scaleFactor);
  }
}

export class LogicalPosition {
  x: number;
  y: number;
  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }
  toPhysical(scaleFactor: number): PhysicalPosition {
    return new PhysicalPosition(Math.round(this.x * scaleFactor), Math.round(this.y * scaleFactor));
  }
}

export class PhysicalPosition {
  x: number;
  y: number;
  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }
  toLogical(scaleFactor: number): LogicalPosition {
    return new LogicalPosition(this.x / scaleFactor, this.y / scaleFactor);
  }
}
