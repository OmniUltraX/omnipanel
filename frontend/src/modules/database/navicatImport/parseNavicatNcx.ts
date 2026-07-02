import type { NavicatRawConnection } from "./types";

function readAttr(element: Element, name: string): string {
  return element.getAttribute(name)?.trim() ?? "";
}

function readBoolAttr(element: Element, name: string): boolean {
  const value = readAttr(element, name).toLowerCase();
  return value === "true" || value === "1";
}

function readPort(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const DEFAULT_PORTS: Record<string, number> = {
  MYSQL: 3306,
  MARIADB: 3306,
  POSTGRESQL: 5432,
  SQLSERVER: 1433,
  REDIS: 6379,
  MONGODB: 27017,
};

/** 解析 Navicat 导出的 NCX（XML）连接列表。 */
export function parseNavicatNcx(xmlText: string): NavicatRawConnection[] {
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  const parserError = doc.querySelector("parsererror");
  if (parserError) {
    throw new Error("Invalid NCX XML");
  }

  const root = doc.documentElement;
  if (!root || root.tagName.toLowerCase() !== "connections") {
    throw new Error("Unsupported NCX format");
  }

  const items: NavicatRawConnection[] = [];
  for (const node of root.querySelectorAll(":scope > Connection")) {
    const connType = readAttr(node, "ConnType").toUpperCase();
    const host = readAttr(node, "Host");
    items.push({
      name: readAttr(node, "ConnectionName"),
      connType,
      host,
      port: readPort(readAttr(node, "Port"), DEFAULT_PORTS[connType] ?? 0),
      user: readAttr(node, "UserName"),
      encryptedPassword: readAttr(node, "Password"),
      savePassword: readBoolAttr(node, "SavePassword"),
      database: readAttr(node, "Database"),
      ssl: readBoolAttr(node, "SSL"),
      remarks: readAttr(node, "Remarks"),
    });
  }

  return items;
}
