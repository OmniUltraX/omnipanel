export type DangerLevel = "low" | "medium" | "high" | "critical";

export interface DangerPattern {
  pattern: RegExp;
  level: DangerLevel;
  desc: string;
  platform?: "windows" | "unix" | "all";
}

const DANGEROUS_PATTERNS: DangerPattern[] = [
  // Critical — data destruction
  {
    pattern: /rm\s+(-[a-zA-Z]*[rf]+|--recursive|--force)\s/i,
    level: "critical",
    desc: "Recursive/forced file deletion",
    platform: "unix",
  },
  {
    pattern: />\s*\/dev\/sd[a-z]/i,
    level: "critical",
    desc: "Direct disk write",
    platform: "unix",
  },
  {
    pattern: /mkfs\./i,
    level: "critical",
    desc: "Format filesystem",
    platform: "unix",
  },
  {
    pattern: /dd\s+.*of=\/dev/i,
    level: "critical",
    desc: "Direct disk write (dd)",
    platform: "unix",
  },
  {
    pattern: /:\(\)\{\s*:\|:&\s*\};:/i,
    level: "critical",
    desc: "Fork bomb",
    platform: "unix",
  },
  {
    pattern: /Remove-Item\s+.*-Recurse\s+.*-Force/i,
    level: "critical",
    desc: "Recursive forced deletion",
    platform: "windows",
  },
  {
    pattern: /Format-Volume/i,
    level: "critical",
    desc: "Format volume",
    platform: "windows",
  },

  // High — database destruction
  {
    pattern: /DROP\s+(TABLE|DATABASE|SCHEMA)\s/i,
    level: "high",
    desc: "SQL destructive operation",
  },
  {
    pattern: /DELETE\s+FROM\s+\w+\s*$/i,
    level: "high",
    desc: "SQL DELETE without WHERE clause",
  },
  {
    pattern: /TRUNCATE\s+TABLE\s/i,
    level: "high",
    desc: "SQL TRUNCATE table",
  },

  // Medium — risky operations
  {
    pattern: /chmod\s+777\s/i,
    level: "medium",
    desc: "Overly permissive file permissions",
    platform: "unix",
  },
  {
    pattern: /curl.*\|\s*(ba)?sh/i,
    level: "medium",
    desc: "Pipe remote script to shell",
    platform: "unix",
  },
  {
    pattern: /wget.*\|\s*(ba)?sh/i,
    level: "medium",
    desc: "Pipe remote script to shell",
    platform: "unix",
  },
  {
    pattern: /iptables\s+-F/i,
    level: "medium",
    desc: "Flush all firewall rules",
    platform: "unix",
  },

  // Low — worth noting
  {
    pattern: /sudo\s+rm/i,
    level: "high",
    desc: "Delete with root privileges",
    platform: "unix",
  },
  {
    pattern: /git\s+push\s+.*--force/i,
    level: "medium",
    desc: "Force push to remote",
  },
  {
    pattern: /git\s+reset\s+.*--hard/i,
    level: "medium",
    desc: "Hard reset (discards changes)",
  },
];

export interface DangerCheckResult {
  safe: boolean;
  level: DangerLevel;
  matches: Array<{ desc: string; level: DangerLevel }>;
}

export function checkCommand(
  command: string,
  envTag?: string
): DangerCheckResult {
  const matches: Array<{ desc: string; level: DangerLevel }> = [];

  for (const rule of DANGEROUS_PATTERNS) {
    if (rule.platform && rule.platform !== (cfg.windows ? "windows" : "unix")) {
      continue;
    }
    if (rule.pattern.test(command)) {
      matches.push({ desc: rule.desc, level: rule.level });
    }
  }

  if (matches.length === 0) {
    return { safe: true, level: "low", matches: [] };
  }

  // Upgrade level in production environment
  const order: DangerLevel[] = ["low", "medium", "high", "critical"];
  let maxLevel: DangerLevel = "low";
  for (const m of matches) {
    if (order.indexOf(m.level) > order.indexOf(maxLevel)) {
      maxLevel = m.level;
    }
  }

  if (envTag === "prod" && maxLevel !== "critical") {
    const idx = order.indexOf(maxLevel);
    maxLevel = order[Math.min(idx + 1, order.length - 1)];
  }

  return { safe: false, level: maxLevel, matches };
}

// Simple platform detection
const cfg = { windows: navigator.platform?.includes("Win") || false };
