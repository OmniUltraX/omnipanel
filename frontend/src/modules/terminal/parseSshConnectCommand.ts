export interface ParsedSshConnectCommand {
  user: string;
  host: string;
  port: number;
  identityFile?: string;
}

const OPTIONS_WITH_VALUE = new Set([
  "-o",
  "-b",
  "-c",
  "-E",
  "-F",
  "-J",
  "-L",
  "-R",
  "-S",
  "-W",
  "-w",
  "-m",
  "-s",
  "-I",
  "-i",
  "-l",
  "-p",
]);

/** 将单行命令拆分为 token，支持单/双引号。 */
export function tokenizeShellCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === "\\" && quote === '"' && i + 1 < command.length) {
        current += command[i + 1];
        i += 1;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }

  if (quote) {
    current += quote === "'" ? "'" : '"';
  }
  if (current) {
    tokens.push(current);
  }
  return tokens;
}

function parseTarget(
  target: string,
  userOverride?: string,
  portOverride = 22,
): Pick<ParsedSshConnectCommand, "user" | "host" | "port"> | null {
  const atIdx = target.lastIndexOf("@");
  let user = userOverride ?? "root";
  let host = target.trim();

  if (atIdx >= 0) {
    user = target.slice(0, atIdx).trim() || user;
    host = target.slice(atIdx + 1).trim();
  }

  let port = portOverride;
  const hostPortMatch = host.match(/^(\[[^\]]+\]|[^:/]+):(\d+)$/);
  if (hostPortMatch) {
    host = hostPortMatch[1];
    port = Number.parseInt(hostPortMatch[2], 10) || port;
  }

  host = host.replace(/^\[|\]$/g, "").trim();
  if (!host) return null;

  return { user: user.trim() || "root", host, port };
}

/**
 * 解析「仅建立 SSH 会话」类命令，例如：
 * - ssh user@host -p 2222
 * - ssh "admin:y-d2@example.com" -p 2222（用户名可含冒号）
 * - ssh -p 2222 admin@example.com
 */
export function parseSshConnectCommand(command: string): ParsedSshConnectCommand | null {
  const trimmed = command.trim();
  if (!trimmed) return null;

  const tokens = tokenizeShellCommand(trimmed);
  if (tokens.length === 0) return null;

  const binary = tokens[0].replace(/^.*[\\/]/, "").toLowerCase();
  if (binary !== "ssh") return null;

  let port = 22;
  let userOverride: string | undefined;
  let identityFile: string | undefined;
  let target: string | undefined;
  let positionalCount = 0;

  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "-p") {
      const next = tokens[++i];
      if (!next) return null;
      port = Number.parseInt(next, 10) || 22;
      continue;
    }
    if (token === "-l") {
      const next = tokens[++i];
      if (!next) return null;
      userOverride = next;
      continue;
    }
    if (token === "-i") {
      const next = tokens[++i];
      if (!next) return null;
      identityFile = next;
      continue;
    }
    if (token.startsWith("-")) {
      const inlinePort = token.match(/^-p(\d+)$/i);
      if (inlinePort) {
        port = Number.parseInt(inlinePort[1], 10) || port;
        continue;
      }
      if (token === "-J" || token === "-W") {
        return null;
      }
      if (OPTIONS_WITH_VALUE.has(token) || token.startsWith("-o")) {
        i += 1;
        continue;
      }
      continue;
    }

    positionalCount += 1;
    if (positionalCount === 1) {
      target = token;
    } else {
      return null;
    }
  }

  if (!target) return null;

  const parsedTarget = parseTarget(target, userOverride, port);
  if (!parsedTarget) return null;

  return {
    user: parsedTarget.user,
    host: parsedTarget.host,
    port: parsedTarget.port,
    ...(identityFile ? { identityFile } : {}),
  };
}
