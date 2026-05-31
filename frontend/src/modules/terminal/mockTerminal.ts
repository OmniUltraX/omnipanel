import { Terminal } from "@xterm/xterm";
import type { WorkspaceResource } from "../../lib/resourceRegistry";

export function getPromptPrefix(resource: WorkspaceResource | null) {
  const identity = resource?.subtitle?.split("@")[0] ?? "root";
  const host = resource?.name ?? "omnipanel";
  return `${identity}@${host}:~$`;
}

export function getMockCommandOutput(command: string, resourceName: string) {
  const normalized = command.trim().toLowerCase();

  if (normalized.startsWith("ssh ")) {
    return [
      `Pseudo terminal established for ${resourceName}.`,
      "Host added to known hosts.",
      "Use command packs from the right pane to continue.",
    ];
  }

  if (normalized.includes("docker ps")) {
    return [
      "NAMES            STATUS       PORTS",
      "nginx-proxy      Up 3 days    0.0.0.0:443->443/tcp",
      "app-backend      Up 3 days    0.0.0.0:8080->8080/tcp",
      "redis-cache      Up 3 days    6379/tcp",
      "postgres-main    Up 3 days    5432/tcp",
    ];
  }

  if (normalized.includes("health")) {
    return [
      "{",
      '  "status": "healthy",',
      '  "uptime": "72h14m",',
      '  "connections": 847,',
      '  "memory_mb": 1024,',
      '  "cpu_percent": 23.4',
      "}",
    ];
  }

  if (
    normalized.includes("journalctl") ||
    normalized.includes("docker logs")
  ) {
    return [
      "2026-05-26 09:12:01 [warn] upstream connection timeout",
      "2026-05-26 09:13:45 [info] 200 GET /api/users 12ms",
      "2026-05-26 09:13:46 [info] 200 GET /api/users 8ms",
      "2026-05-26 09:14:02 [warn] rate limit triggered for 45.33.32.x",
    ];
  }

  if (normalized.includes("npm run build")) {
    return [
      "> app@2.1.0 build",
      "> vite build",
      "",
      "vite v8.0.14 building for production...",
      "✓ modules transformed.",
      "dist/index.html                  0.46 kB │ gzip: 0.30 kB",
      "dist/assets/index.css            48.12 kB │ gzip: 8.94 kB",
      "dist/assets/index.js            312.47 kB │ gzip: 94.23 kB",
      "✓ built in 3.82s",
    ];
  }

  if (normalized.includes("systemctl status nginx")) {
    return [
      "● nginx.service - A high performance web server",
      "   Loaded: loaded (/lib/systemd/system/nginx.service; enabled)",
      "   Active: active (running) since Mon 2026-05-26 06:15:23 UTC; 3 days ago",
      "   Docs: man:nginx(8)",
    ];
  }

  return [`Command executed in ${resourceName} preview mode.`];
}

export function seedMockTerminal(
  term: Terminal,
  resource: WorkspaceResource | null,
  startup: string[],
) {
  const prompt = getPromptPrefix(resource);
  [
    `\x1b[90mWorkspace attached: ${resource?.name ?? "omnipanel"}\x1b[0m`,
    ...startup.map((line) => `\x1b[36m${line}\x1b[0m`),
    "",
    `\x1b[32m${prompt}\x1b[0m docker ps --format "table {{.Names}}\\t{{.Status}}\\t{{.Ports}}"`,
    "NAMES            STATUS       PORTS",
    "nginx-proxy      Up 3 days    0.0.0.0:443->443/tcp",
    "app-backend      Up 3 days    0.0.0.0:8080->8080/tcp",
    "redis-cache      Up 3 days    6379/tcp",
    "postgres-main    Up 3 days    5432/tcp",
    "",
    `\x1b[32m${prompt}\x1b[0m curl -s localhost:8080/health | jq .`,
    "{",
    '  "status": "healthy",',
    '  "uptime": "72h14m",',
    '  "connections": 847,',
    '  "memory_mb": 1024,',
    '  "cpu_percent": 23.4',
    "}",
    "",
    `\x1b[32m${prompt}\x1b[0m `,
  ].forEach((line) => term.writeln(line));
}
