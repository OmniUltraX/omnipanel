/**
 * 快捷启动文本类型检测：允许多命中，供建议层生成候选动作。
 */

import { isConnectionLevelSql } from "../../modules/database/sqlIntel/connectionLevelSql";

export type EntityKind =
  | "ipv4"
  | "ipv6"
  | "hostPort"
  | "domain"
  | "url"
  | "gitUrl"
  | "sql"
  | "json"
  | "filePath"
  | "shellCommand"
  | "naturalLanguage"
  | "plain";

export interface DetectedEntity {
  kind: EntityKind;
  confidence: number;
  payload: Record<string, string>;
}

/** 常见公共 TLD，收敛域名误判（foo.bar 等） */
const TLD_WHITELIST = new Set(
  [
    "com",
    "net",
    "org",
    "edu",
    "gov",
    "mil",
    "int",
    "io",
    "co",
    "ai",
    "app",
    "dev",
    "cloud",
    "tech",
    "info",
    "biz",
    "name",
    "pro",
    "xyz",
    "me",
    "tv",
    "cc",
    "cn",
    "hk",
    "tw",
    "jp",
    "kr",
    "uk",
    "us",
    "de",
    "fr",
    "ru",
    "au",
    "ca",
    "br",
    "in",
    "sg",
    "local",
    "lan",
    "internal",
    "intranet",
    "test",
    "example",
    "localhost",
  ].map((s) => s.toLowerCase()),
);

const IPV4_RE =
  /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;

const IPV6_RE =
  /^(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{1,4}$|^::(?:[0-9a-fA-F]{1,4}:){0,6}[0-9a-fA-F]{1,4}$|^(?:[0-9a-fA-F]{1,4}:){1,7}:$|^::$/;

const HOST_PORT_RE =
  /^((?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)|[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+):(\d{1,5})$/;

const DOMAIN_RE =
  /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/;

const URL_RE = /^(https?|ftp):\/\/[^\s]+$/i;

const GIT_URL_RE =
  /^(?:git@[\w.-]+:[\w./-]+(?:\.git)?|https?:\/\/[^\s]+(?:\.git)|git:\/\/[^\s]+)$/i;

const WIN_PATH_RE = /^(?:[a-zA-Z]:\\|\\\\[^\\/]+\\[^\\/]+)(?:[^<>:"|?*\n]*)$/;
const POSIX_PATH_RE = /^\/(?:[\w.@+-]+\/)*[\w.@+-]*\/?$/;

const SQL_KEYWORD_RE =
  /^(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|WITH|EXPLAIN|DESCRIBE|DESC|SHOW|USE|GRANT|REVOKE|CALL|REPLACE|MERGE|SET)\b/i;

const SHELL_FIRST_TOKENS = new Set([
  "ls",
  "cd",
  "pwd",
  "cat",
  "echo",
  "grep",
  "find",
  "curl",
  "wget",
  "ping",
  "ssh",
  "scp",
  "rsync",
  "git",
  "npm",
  "pnpm",
  "yarn",
  "cargo",
  "docker",
  "kubectl",
  "systemctl",
  "apt",
  "brew",
  "mkdir",
  "rm",
  "cp",
  "mv",
  "tar",
  "zip",
  "unzip",
  "chmod",
  "chown",
  "ps",
  "kill",
  "top",
  "htop",
  "df",
  "du",
  "head",
  "tail",
  "less",
  "vim",
  "nano",
  "python",
  "python3",
  "node",
  "go",
  "make",
  "cmake",
]);

const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/;

function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/#[^\n]*/g, " ")
    .trim();
}

/** 粗判是否像 SQL（快筛；可解析性由可选 AST 复核） */
export function looksLikeSql(text: string): boolean {
  const head = stripSqlComments(text);
  if (!head || head.length < 6) return false;
  if (isConnectionLevelSql(head)) return true;
  if (!SQL_KEYWORD_RE.test(head)) return false;
  // 至少含空格或换行，避免单单词误判
  if (!/\s/.test(head)) return false;
  return true;
}

export function isDestructiveSql(sql: string): boolean {
  const head = stripSqlComments(sql);
  return /^(DELETE|DROP|TRUNCATE|ALTER\s+TABLE.*\bDROP\b|UPDATE)\b/i.test(head);
}

function tryDetectIpv4(trimmed: string): DetectedEntity | null {
  if (!IPV4_RE.test(trimmed)) return null;
  return { kind: "ipv4", confidence: 0.98, payload: { host: trimmed } };
}

function tryDetectIpv6(trimmed: string): DetectedEntity | null {
  if (!IPV6_RE.test(trimmed) || !trimmed.includes(":")) return null;
  // 排除 host:port 形态
  if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(trimmed)) return null;
  return { kind: "ipv6", confidence: 0.9, payload: { host: trimmed } };
}

function tryDetectHostPort(trimmed: string): DetectedEntity | null {
  const m = HOST_PORT_RE.exec(trimmed);
  if (!m) return null;
  const host = m[1]!;
  const port = Number(m[2]);
  if (!Number.isFinite(port) || port < 1 || port > 65535) return null;
  const hostIsDomain = DOMAIN_RE.test(host) && isWhitelistedDomain(host);
  const hostIsIp = IPV4_RE.test(host);
  if (!hostIsDomain && !hostIsIp) return null;
  return {
    kind: "hostPort",
    confidence: 0.95,
    payload: { host, port: String(port) },
  };
}

function isWhitelistedDomain(host: string): boolean {
  const parts = host.toLowerCase().split(".");
  if (parts.length < 2) return false;
  const tld = parts[parts.length - 1]!;
  return TLD_WHITELIST.has(tld);
}

function tryDetectDomain(trimmed: string): DetectedEntity | null {
  if (!DOMAIN_RE.test(trimmed)) return null;
  if (!isWhitelistedDomain(trimmed)) return null;
  return { kind: "domain", confidence: 0.85, payload: { host: trimmed } };
}

function tryDetectUrl(trimmed: string): DetectedEntity | null {
  if (!URL_RE.test(trimmed)) return null;
  try {
    const u = new URL(trimmed);
    return {
      kind: "url",
      confidence: 0.95,
      payload: { url: trimmed, host: u.hostname, protocol: u.protocol.replace(":", "") },
    };
  } catch {
    return null;
  }
}

function tryDetectGitUrl(trimmed: string): DetectedEntity | null {
  if (!GIT_URL_RE.test(trimmed)) return null;
  return { kind: "gitUrl", confidence: 0.92, payload: { url: trimmed } };
}

function tryDetectSql(text: string): DetectedEntity | null {
  if (!looksLikeSql(text)) return null;
  let confidence = 0.75;
  // 含分号或多个关键字 → 更高置信度
  if (/;/.test(text) || /\bFROM\b|\bINTO\b|\bWHERE\b|\bVALUES\b/i.test(text)) {
    confidence = 0.9;
  }
  return {
    kind: "sql",
    confidence,
    payload: {
      sql: text.trim(),
      destructive: isDestructiveSql(text) ? "1" : "0",
    },
  };
}

function tryDetectJson(trimmed: string): DetectedEntity | null {
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return null;
  try {
    JSON.parse(trimmed);
    return { kind: "json", confidence: 0.95, payload: { json: trimmed } };
  } catch {
    return null;
  }
}

function tryDetectFilePath(trimmed: string): DetectedEntity | null {
  if (WIN_PATH_RE.test(trimmed) && /[\\/]/.test(trimmed)) {
    return { kind: "filePath", confidence: 0.88, payload: { path: trimmed } };
  }
  // POSIX：至少两段路径，避免 "/" 或 "/tmp" 单段误判过多；允许 /tmp、/etc/hosts
  if (POSIX_PATH_RE.test(trimmed) && trimmed.length >= 2 && trimmed.includes("/")) {
    // 排除纯域名误伤：域名不含 /
    return { kind: "filePath", confidence: 0.7, payload: { path: trimmed } };
  }
  return null;
}

function tryDetectShell(trimmed: string): DetectedEntity | null {
  if (trimmed.includes("\n") && trimmed.length > 200) return null;
  const first = trimmed.split(/\s+/)[0]?.toLowerCase() ?? "";
  if (!first || !SHELL_FIRST_TOKENS.has(first)) return null;
  // 单 token 无参数置信度略低
  const hasArgs = /\s/.test(trimmed);
  return {
    kind: "shellCommand",
    confidence: hasArgs ? 0.8 : 0.55,
    payload: { command: trimmed },
  };
}

function tryDetectNaturalLanguage(text: string, otherHits: DetectedEntity[]): DetectedEntity | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length < 2) return null;
  // 已有强结构化命中时，自然语言仅作补充且置信度低
  const strongKinds = new Set(["ipv4", "ipv6", "hostPort", "sql", "url", "gitUrl", "json"]);
  const hasStrong = otherHits.some((e) => strongKinds.has(e.kind));
  const hasCjk = CJK_RE.test(trimmed);
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  if (!hasCjk && wordCount < 4 && hasStrong) return null;
  if (!hasCjk && wordCount < 3) return null;
  if (hasStrong && !hasCjk) return null;
  return {
    kind: "naturalLanguage",
    confidence: hasCjk ? 0.7 : 0.45,
    payload: { text: trimmed },
  };
}

/**
 * 对一段文本做多类型检测（多命中）。
 * 输入为空返回空数组。
 */
export function detectEntities(raw: string): DetectedEntity[] {
  const text = raw.trim();
  if (!text) return [];

  // 多行 SQL / 自然语言用全文；单行网络类用首行
  const firstLine = text.split(/\r?\n/)[0]?.trim() ?? text;
  const singleLine = !/\r?\n/.test(text);

  const entities: DetectedEntity[] = [];

  const push = (e: DetectedEntity | null) => {
    if (e) entities.push(e);
  };

  // URL / Git 优先于 domain
  push(tryDetectGitUrl(firstLine));
  push(tryDetectUrl(firstLine));

  if (singleLine) {
    push(tryDetectHostPort(firstLine));
    push(tryDetectIpv4(firstLine));
    push(tryDetectIpv6(firstLine));
    // 已是 URL 时不再把 host 当独立 domain（避免重复）
    if (!entities.some((e) => e.kind === "url" || e.kind === "gitUrl")) {
      push(tryDetectDomain(firstLine));
    }
    push(tryDetectFilePath(firstLine));
    push(tryDetectShell(firstLine));
  }

  push(tryDetectJson(text));
  push(tryDetectSql(text));

  const nl = tryDetectNaturalLanguage(text, entities);
  if (nl) entities.push(nl);

  // 若完全无命中，兜底 plain
  if (entities.length === 0) {
    entities.push({
      kind: "plain",
      confidence: 0.3,
      payload: { text },
    });
  }

  return entities;
}

/** UI 类型标签文案 key 后缀 */
export function entityKindLabelKey(kind: EntityKind): string {
  return `shell.quickLauncher.entity.${kind}`;
}
