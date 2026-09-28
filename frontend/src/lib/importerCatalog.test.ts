import { describe, expect, it } from "vitest";
import type { PluginListItem } from "../ipc/bindings";
import {
  findImporter,
  importerEntries,
  listActiveImporters,
  secretKeyFor,
} from "./importerCatalog";

function item(id: string, enabled = true, activated = true): PluginListItem {
  return {
    id,
    version: "0.2.0",
    kind: "importer",
    enabled,
    activated,
    source: "builtin",
  };
}

describe("importerCatalog", () => {
  it("从清单读 importer 贡献，不依赖插件 activate", () => {
    const found = findImporter("omni.importer.docker-db", "docker-db");
    expect(found?.pluginId).toBe("omni.importer.docker-db");
    expect(found?.importer.sourceKind).toBe("dockerConnections");
    expect(found?.importer.scanners?.length).toBe(10);
    expect(importerEntries(found!.importer)).toEqual(["commandPalette", "settings", "home"]);
  });

  it("仅已启用且已激活的插件出现在活动列表", () => {
    expect(listActiveImporters([item("omni.importer.docker-db", false, true)])).toEqual([]);
    expect(listActiveImporters([item("omni.importer.docker-db", true, false)])).toEqual([]);
    const active = listActiveImporters([item("omni.importer.docker-db")]);
    expect(active).toHaveLength(1);
    expect(active[0]?.importer.id).toBe("docker-db");
  });

  it("secret key 使用清单前缀（无 secret 字段时仍可生成稳定 key）", () => {
    const found = findImporter("omni.importer.docker-db", "docker-db");
    const field = found?.importer.fields?.[0] ?? {
      key: "token",
      kind: "secret" as const,
      label: "token",
      secretKeyPrefix: "src",
    };
    expect(secretKeyFor({ ...field, kind: "secret", secretKeyPrefix: "src" }, "abc")).toBe(
      "src-abc",
    );
  });
});
