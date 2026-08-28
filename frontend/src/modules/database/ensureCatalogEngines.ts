import { commands } from "../../ipc/bindings";
import { unwrapCommand } from "../../ipc/result";

/** 每组按目录实有 key 解析；官方 registry 当前无 gaussdb / tidb，OceanBase 只有 oceanbase-oracle。 */
export const CATALOG_ENGINE_GROUPS: readonly (readonly string[])[] = [
  ["kingbase"],
  ["vastbase"],
  ["uxdb"],
  ["gaussdb", "opengauss"],
  ["oceanbase", "oceanbase-oracle"],
  ["tidb"],
];

export function resolveCatalogEngineKey(
  available: Iterable<string>,
  aliases: readonly string[],
): string | undefined {
  const have = available instanceof Set ? available : new Set(available);
  return aliases.find((key) => have.has(key));
}

let inFlight: Promise<void> | null = null;

/** 安装金仓 / Vastbase / UXDB / OceanBase 等；目录无包则跳过，不发 IPC 安装。 */
export function ensureCatalogEngines(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    let list: { id: string }[] = [];
    try {
      list = await unwrapCommand(commands.pluginList(), { quiet: true });
    } catch {
      inFlight = null;
      return;
    }
    const have = new Set(list.map((item) => item.id));

    let catalogKeys: Set<string>;
    try {
      const catalog = await unwrapCommand(commands.pluginDbxCatalog(), { quiet: true });
      catalogKeys = new Set(catalog.map((item) => item.key));
    } catch (err) {
      console.warn("[dbx] 拉取目录失败，跳过可选引擎安装:", err);
      inFlight = null;
      return;
    }

    for (const aliases of CATALOG_ENGINE_GROUPS) {
      const key = resolveCatalogEngineKey(catalogKeys, aliases);
      if (!key) {
        console.warn(`[dbx] 目录无包，跳过 ${aliases.join("/")}`);
        continue;
      }
      const id = `omni.engine.${key}`;
      if (have.has(id)) continue;
      try {
        await unwrapCommand(commands.pluginDbxInstall(key), { quiet: true });
        have.add(id);
      } catch (err) {
        console.warn(`[dbx] 跳过安装 ${key}:`, err);
      }
    }
  })();
  return inFlight;
}
