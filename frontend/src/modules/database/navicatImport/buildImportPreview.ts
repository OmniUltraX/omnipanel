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

export function resolveImportConnectionName(
  item: NavicatImportPreviewItem,
  customName?: string,
): string {
  const trimmed = (customName ?? item.raw.name).trim();
  return trimmed || item.raw.host.trim() || "Untitled";
}

export function computeImportPreviewRowState(
  item: NavicatImportPreviewItem,
  customName: string | undefined,
  existingConnections: DbConnectionConfig[],
  otherPreviewNames: Iterable<{ id: string; name: string }>,
): { name: string; issues: NavicatImportIssue[]; importable: boolean } {
  const name = resolveImportConnectionName(item, customName);
  const issues: NavicatImportIssue[] = item.issues.filter((issue) => issue !== "duplicate_name");

  const normalizedName = name.trim().toLowerCase();
  const takenNames = existingNames(existingConnections);
  if (normalizedName && takenNames.has(normalizedName)) {
    issues.push("duplicate_name");
  }

  for (const other of otherPreviewNames) {
    if (other.id === item.id) {
      continue;
    }
    const otherNormalized = other.name.trim().toLowerCase();
    if (normalizedName && otherNormalized === normalizedName) {
      if (!issues.includes("duplicate_name")) {
        issues.push("duplicate_name");
      }
      break;
    }
  }

  const importable =
    Boolean(item.engine && SUPPORTED_ENGINES.has(item.engine)) &&
    Boolean(item.raw.host.trim()) &&
    !issues.includes("duplicate_name") &&
    !issues.includes("duplicate_fingerprint");

  return { name, issues, importable };
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
  customName?: string,
): DbConnectionConfig {
  const engine = item.engine ?? "mysql";
  return {
    id: "",
    name: resolveImportConnectionName(item, customName),
    db_type: engine,
    host: item.raw.host.trim(),
    port: item.raw.port,
    user: item.raw.user.trim(),
    password: item.password,
    database: item.raw.database.trim(),
    ssl: item.raw.ssl,
    status: "unknown",
    enabled: true,
  };
}
