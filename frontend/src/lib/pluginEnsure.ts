import {
  commands,
  type Connection,
  type PluginEnsurePendingItem,
} from "../ipc/bindings";
import { formatIpcError, unwrapCommand } from "../ipc/result";
import { t } from "../i18n";
import { showToast } from "../stores/toastStore";
import { usePluginEnsureStore } from "../stores/pluginEnsureStore";
import { isPluginActivated } from "../stores/pluginRuntimeStore";
import { resolveLegacyPluginId } from "./pluginManifests";
import { yieldToMain } from "./yieldToMain";

let inFlight: Promise<void> | null = null;
let queued = false;
let lastFinishedAt = 0;
const ENSURE_COOLDOWN_MS = 15_000;

/** 模块快照刷新 / 启动后调度：已在跑则排队；冷却期内跳过重复全量扫描。 */
export function schedulePluginEnsure(): void {
  if (inFlight) {
    queued = true;
    return;
  }
  if (lastFinishedAt > 0 && performance.now() - lastFinishedAt < ENSURE_COOLDOWN_MS) {
    return;
  }
  void runPluginEnsure();
}

export async function runPluginEnsure(approveIds: string[] = []): Promise<void> {
  if (approveIds.length === 0 && inFlight) {
    queued = true;
    await inFlight;
    return;
  }
  const run = executeEnsure(approveIds);
  if (approveIds.length === 0) {
    inFlight = run.finally(() => {
      inFlight = null;
      lastFinishedAt = performance.now();
      const replay = queued;
      queued = false;
      if (replay) {
        window.setTimeout(() => {
          lastFinishedAt = 0;
          schedulePluginEnsure();
        }, ENSURE_COOLDOWN_MS);
      }
    });
    await inFlight;
    return;
  }
  await run;
}

/** 工作台已知缺件：只装指定 id，不再顺带全量扫本机资源。 */
export async function ensureKnownPluginIds(ids: string[]): Promise<void> {
  const wanted = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
  const missing = wanted.filter((id) => !isPluginActivated(id));
  if (missing.length === 0) return;
  await installOfficialIfStillMissing(missing);
}

async function executeEnsure(approveIds: string[]): Promise<void> {
  usePluginEnsureStore.getState().setRunning(true);
  try {
    try {
      const result = await unwrapCommand(
        commands.pluginEnsureFromResources({ approveIds }),
        { quiet: true },
      );
      applyEnsureResult(result);
      return;
    } catch (err) {
      console.warn("[plugin-ensure] pluginEnsureFromResources failed:", err);
    }
    await fallbackInstallFromConnections();
  } finally {
    usePluginEnsureStore.getState().setRunning(false);
  }
}

function applyEnsureResult(result: {
  installed: Array<{ id: string; name: string }>;
  notFound: Array<{ id: string; name: string }>;
  failed: Array<{ id: string; message: string }>;
  pendingConfirm: PluginEnsurePendingItem[];
}): void {
  if (result.installed.length > 0) {
    showToast(
      t("plugins.ensure.installedToast", {
        names: result.installed.map((item) => item.name || item.id).join("、"),
      }),
      4000,
    );
  }
  if (result.notFound.length > 0) {
    showToast(
      t("plugins.ensure.notFoundToast", {
        names: result.notFound.map((item) => item.name || item.id).join("、"),
      }),
      5000,
    );
  }
  if (result.failed.length > 0) {
    const first = result.failed[0];
    const detail =
      result.failed.length === 1
        ? `${first?.id}: ${first?.message ?? ""}`
        : result.failed.map((item) => item.id).join("、");
    showToast(t("plugins.ensure.failedToast", { detail }), 5000);
  }
  usePluginEnsureStore.getState().setPending(result.pendingConfirm);
}

async function fallbackInstallFromConnections(): Promise<void> {
  try {
    const connections = await unwrapCommand(commands.connList(), { quiet: true });
    const ids = [
      ...new Set(
        (Array.isArray(connections) ? connections : [])
          .map(pluginIdFromConnection)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    await installOfficialIfStillMissing(ids);
  } catch (err) {
    console.warn("[plugin-ensure] fallback collect failed:", err);
  }
}

async function installOfficialIfStillMissing(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  let present: Set<string>;
  try {
    const items = await unwrapCommand(commands.pluginList(), { quiet: true });
    present = new Set((Array.isArray(items) ? items : []).map((item) => item.id));
  } catch {
    present = new Set();
  }
  const installed: string[] = [];
  const failed: string[] = [];
  for (const id of ids) {
    if (present.has(id) || isPluginActivated(id)) continue;
    await yieldToMain();
    try {
      await unwrapCommand(commands.pluginOfficialInstall(id), { quiet: true });
      installed.push(id);
      present.add(id);
    } catch (err) {
      try {
        await unwrapCommand(commands.pluginInstallVersion(id, null, true), { quiet: true });
        installed.push(id);
        present.add(id);
      } catch (err2) {
        failed.push(id);
        console.warn("[plugin-ensure] official install failed:", id, formatIpcError(err2) || err);
      }
    }
  }
  if (installed.length > 0) {
    showToast(
      t("plugins.ensure.installedToast", { names: installed.join("、") }),
      4000,
    );
  }
  if (failed.length > 0) {
    showToast(
      t("plugins.ensure.failedToast", { detail: failed.join("、") }),
      5000,
    );
  }
}

/** 与后端 `plugin_id_from_connection` 对齐：cloud 认 pluginId 或 provider。 */
export function pluginIdFromConnection(connection: Connection): string | null {
  let cfg: Record<string, unknown> = {};
  try {
    cfg = JSON.parse(connection.config || "{}") as Record<string, unknown>;
  } catch {
    return null;
  }
  if (connection.kind === "cloud" || connection.kind === "service") {
    const raw = String(cfg.pluginId ?? cfg.provider ?? "").trim();
    return resolveLegacyPluginId(raw);
  }
  if (connection.kind === "panel") {
    const raw = String(cfg.serviceType ?? "").trim().toLowerCase();
    if (!raw) return null;
    if (raw === "bt" || raw === "baota" || raw === "omni.panel.bt") return "omni.panel.bt";
    if (raw === "1panel" || raw === "onepanel" || raw === "omni.panel.1panel") {
      return "omni.panel.1panel";
    }
    if (raw === "hestia" || raw === "hestiacp" || raw === "omni.panel.hestia") {
      return "omni.panel.hestia";
    }
    return raw.startsWith("omni.") ? raw : null;
  }
  return null;
}
