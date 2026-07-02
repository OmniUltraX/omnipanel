import type { DbConnectionConfig } from "../api";
import type { NavicatImportIssue, NavicatImportPreviewItem, NavicatRawConnection } from "./types";

const ENGINE_MAP: Record<string, string> = {
  MYSQL: "mysql",
  MARIADB: "mysql",
  POSTGRESQL: "postgresql",
  POSTGRES: "postgresql",
  REDIS: "redis",
  MONGODB: "mongodb",
};

const SUPPORTED_ENGINES = new Set(["mysql", "postgresql", "redis", "mongodb"]);

function mapEngine(connType: string): string | null {
  return ENGINE_MAP[connType.toUpperCase()] ?? null;
}

function connectionFingerprint(
  engine: string,
  host: string,
  port: number,
  user: string,
  database: string,
): string {
  return [engine, host.toLowerCase(), String(port), user.toLowerCase(), database.toLowerCase()].join("|");
}

function existingFingerprints(connections: DbConnectionConfig[]): Set<string> {
  const set = new Set<string>();
  for (const conn of connections) {
    set.add(
      connectionFingerprint(conn.db_type, conn.host, conn.port, conn.user, conn.database ?? ""),
    );
  }
  return set;
}

function existingNames(connections: DbConnectionConfig[]): Set<string> {
  return new Set(connections.map((conn) => conn.name.trim().toLowerCase()).filter(Boolean));
}

export function buildNavicatImportPreview(
  rawItems: NavicatRawConnection[],
  decryptedPasswords: string[],
  existingConnections: DbConnectionConfig[],
): NavicatImportPreviewItem[] {
  const names = existingNames(existingConnections);
  const fingerprints = existingFingerprints(existingConnections);
  const previewNames = new Set<string>();

  return rawItems.map((raw, index) => {
    const engine = mapEngine(raw.connType);
    const issues: NavicatImportIssue[] = [];
    const password =
      raw.savePassword && raw.encryptedPassword.trim()
        ? (decryptedPasswords[index] ?? "")
        : "";

    if (!raw.host.trim()) {
      issues.push("missing_host");
    }

    if (!engine || !SUPPORTED_ENGINES.has(engine)) {
      issues.push("unsupported_engine");
    }

    if (raw.savePassword && raw.encryptedPassword.trim() && !password) {
      issues.push("password_decrypt_failed");
    }

    const normalizedName = raw.name.trim().toLowerCase();
    if (normalizedName) {
      if (names.has(normalizedName) || previewNames.has(normalizedName)) {
        issues.push("duplicate_name");
      } else {
        previewNames.add(normalizedName);
      }
    }

    if (engine && raw.host.trim()) {
      const fingerprint = connectionFingerprint(
        engine,
        raw.host,
        raw.port,
        raw.user,
        raw.database ?? "",
      );
      if (fingerprints.has(fingerprint)) {
        issues.push("duplicate_fingerprint");
      }
    }

    const importable =
      Boolean(engine && SUPPORTED_ENGINES.has(engine)) &&
      Boolean(raw.host.trim()) &&
      !issues.includes("duplicate_name") &&
      !issues.includes("duplicate_fingerprint");

    return {
      id: `${index}:${raw.name}:${raw.host}:${raw.port}`,
      raw,
      engine,
      password,
      issues,
      importable,
    };
  });
}

export function previewItemToConnection(
  item: NavicatImportPreviewItem,
  group: string,
): DbConnectionConfig {
  const engine = item.engine ?? "mysql";
  return {
    id: "",
    name: item.raw.name.trim() || item.raw.host.trim() || "Untitled",
    db_type: engine,
    host: item.raw.host.trim(),
    port: item.raw.port,
    user: item.raw.user.trim(),
    password: item.password,
    database: item.raw.database.trim(),
    ssl: item.raw.ssl,
    group: group.trim() || "默认",
    status: "unknown",
    enabled: true,
  };
}
