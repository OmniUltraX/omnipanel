import { describe, expect, it } from "vitest";
import {
  CATALOG_ENGINE_GROUPS,
  catalogAliasesForDbType,
  resolveCatalogEngineKey,
} from "./ensureCatalogEngines";

describe("resolveCatalogEngineKey", () => {
  it("按别名命中官方目录实有 key", () => {
    const catalog = new Set(["kingbase", "vastbase", "uxdb", "oceanbase-oracle"]);
    expect(resolveCatalogEngineKey(catalog, ["kingbase"])).toBe("kingbase");
    expect(resolveCatalogEngineKey(catalog, ["oceanbase", "oceanbase-oracle"])).toBe(
      "oceanbase-oracle",
    );
    expect(resolveCatalogEngineKey(catalog, ["gaussdb", "opengauss"])).toBeUndefined();
    expect(resolveCatalogEngineKey(catalog, ["tidb"])).toBeUndefined();
  });

  it("db_type 别名对齐目录 key", () => {
    expect(catalogAliasesForDbType("dameng")).toEqual(expect.arrayContaining(["dameng", "dm"]));
    expect(catalogAliasesForDbType("postgres")).toEqual(
      expect.arrayContaining(["postgresql", "postgres"]),
    );
    expect(catalogAliasesForDbType("mssql")).toEqual(expect.arrayContaining(["sqlserver", "mssql"]));
    expect(catalogAliasesForDbType("oceanbase")).toEqual(
      expect.arrayContaining(["oceanbase", "oceanbase-oracle"]),
    );
    expect(resolveCatalogEngineKey(new Set(["dameng", "neo4j"]), catalogAliasesForDbType("dm"))).toBe(
      "dameng",
    );
  });

  it("覆盖计划里的可选引擎组", () => {
    const keys = CATALOG_ENGINE_GROUPS.flat();
    expect(keys).toEqual(
      expect.arrayContaining([
        "kingbase",
        "vastbase",
        "uxdb",
        "gaussdb",
        "oceanbase",
        "oceanbase-oracle",
        "tidb",
      ]),
    );
  });
});
