/**
 * `@tauri-apps/api/menu` / `@tauri-apps/api/tray` / `@tauri-apps/api/app` 的 Web shim。
 *
 * 系统托盘 / 原生菜单 / 桌面图标是桌面端专属能力，Web 模式下退化为 no-op 类，
 * 保证 `systemTray.ts` 等模块在浏览器不抛错（相关入口已被 `isTauriRuntime()` 短路）。
 */

export class Menu {
  static async new(_items?: unknown[]): Promise<Menu> {
    return new Menu();
  }
  async append(_item: unknown): Promise<void> {}
  async popup(): Promise<void> {}
  async show(): Promise<void> {}
  async hide(): Promise<void> {}
}

export class Submenu {
  static async new(_label: string, _items?: unknown[]): Promise<Submenu> {
    return new Submenu();
  }
  async append(_item: unknown): Promise<void> {}
  async popup(): Promise<void> {}
  async show(): Promise<void> {}
  async hide(): Promise<void> {}
}

export class MenuItem {
  constructor(_options: unknown) {}
}

export class TrayIcon {
  static async new(_options: unknown): Promise<TrayIcon> {
    return new TrayIcon();
  }
  async setTooltip(_tooltip: string): Promise<void> {}
  async setTitle(_title: string): Promise<void> {}
  async setMenu(_menu: unknown): Promise<void> {}
  async close(): Promise<void> {}
  static async getById(_id: string): Promise<TrayIcon | null> {
    return null;
  }
}

export async function defaultWindowIcon(): Promise<unknown> {
  return null;
}
