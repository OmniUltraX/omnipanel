import { commands } from "../../ipc/bindings";
import { unwrapCommand } from "../../ipc/result";

const CATALOG_ENGINE_KEYS = [
  "kingbase",
  "vastbase",
  "uxdb",
  "gaussdb",
  "oceanbase",
  "tidb",
] as const;

let inFlight: Promise<void> | null = null;

/** 安装金仓 / Vastbase / UXDB / GaussDB / OceanBase / TiDB；目录无包则跳过，不阻断其余项。 */
export function ensureCatalogEngines(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    let list: { id: string }[] = [];
    try {
      list = await unwrapCommand(commands.pluginList());
    } catch {
      inFlight = null;
      return;
    }
    const have = new Set(list.map((item) => item.id));
    for (const key of CATALOG_ENGINE_KEYS) {
      const id = `omni.engine.${key}`;
      if (have.has(id)) continue;
      try {
        await unwrapCommand(commands.pluginDbxInstall(key));
        have.add(id);
      } catch (err) {
        console.warn(`[dbx] 跳过安装 ${key}:`, err);
      }
    }
  })();
  return inFlight;
}
