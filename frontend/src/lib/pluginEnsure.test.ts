import { describe, expect, it } from "vitest";
import type { Connection } from "../ipc/bindings";
import { pluginIdFromConnection, pluginIdsFromConnection } from "./pluginEnsure";

function conn(kind: Connection["kind"], config: string): Connection {
  return { id: "c1", kind, name: "n", config };
}

describe("pluginIdFromConnection", () => {
  it("reads cloud pluginId and provider aliases", () => {
    expect(
      pluginIdFromConnection(conn("cloud", '{"pluginId":"omni.cloud.aliyun"}')),
    ).toBe("omni.cloud.aliyun");
    expect(pluginIdFromConnection(conn("cloud", '{"provider":"aliyun"}'))).toBe(
      "omni.cloud.aliyun",
    );
    expect(pluginIdFromConnection(conn("cloud", '{"provider":"tencent"}'))).toBe(
      "omni.cloud.tencent",
    );
  });

  it("reads service pluginId and panel aliases", () => {
    expect(
      pluginIdFromConnection(conn("service", '{"pluginId":"omni.module.nacos"}')),
    ).toBe("omni.module.nacos");
    expect(pluginIdFromConnection(conn("panel", '{"serviceType":"bt"}'))).toBe(
      "omni.panel.bt",
    );
    expect(pluginIdFromConnection(conn("ssh", '{"pluginId":"omni.cloud.aliyun"}'))).toBeNull();
  });
});

describe("pluginIdsFromConnection", () => {
  it("collects SSH fallback plugin ids", () => {
    expect(
      pluginIdsFromConnection(
        conn(
          "ssh",
          JSON.stringify({
            host: "1.2.3.4",
            fallbacks: [
              {
                id: "fb1",
                kind: "plugin",
                pluginId: "omni.addon.warpgate",
                gatewayId: "g1",
                targetId: "t1",
                targetName: "web",
              },
            ],
          }),
        ),
      ),
    ).toEqual(["omni.addon.warpgate"]);
  });

  it("keeps primary cloud id and dedupes fallbacks", () => {
    expect(
      pluginIdsFromConnection(
        conn(
          "cloud",
          JSON.stringify({
            pluginId: "omni.cloud.aliyun",
            fallbacks: [
              { pluginId: "omni.addon.warpgate" },
              { pluginId: "omni.addon.warpgate" },
            ],
          }),
        ),
      ).sort(),
    ).toEqual(["omni.addon.warpgate", "omni.cloud.aliyun"]);
  });
});
