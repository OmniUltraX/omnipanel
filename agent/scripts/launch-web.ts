/**
 * 同时启动 Web API (9477) 与 dev-ui (9478)。
 */
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const agentRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const children: ChildProcess[] = [];

function spawnTracked(
  label: string,
  command: string,
  args: string[],
  cwd: string,
): ChildProcess {
  const child = spawn(command, args, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: process.env,
  });
  children.push(child);
  child.on("exit", (code, signal) => {
    if (signal) {
      console.error(`[launch-web] ${label} 被信号终止: ${signal}`);
    } else if (code && code !== 0) {
      console.error(`[launch-web] ${label} 退出码: ${code}`);
    }
    shutdown(code ?? 1);
  });
  return child;
}

function shutdown(exitCode = 0): void {
  for (const child of children) {
    if (!child.killed) {
      child.kill();
    }
  }
  process.exit(exitCode);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

console.error("[launch-web] 启动 web 模式（API 9477 + UI 9478）…");
console.error("[launch-web] 浏览器打开 http://127.0.0.1:9478");

spawnTracked("web-api", "node", ["--import", "tsx", "index.ts", "--mode", "web"], agentRoot);

setTimeout(() => {
  spawnTracked("dev-ui", "npm", ["run", "dev", "--prefix", "dev-ui"], agentRoot);
}, 800);
