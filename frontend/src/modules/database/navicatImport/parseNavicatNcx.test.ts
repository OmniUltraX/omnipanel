import { describe, expect, it } from "vitest";
import { buildNavicatImportPreview } from "./buildImportPreview";
import { parseNavicatNcx } from "./parseNavicatNcx";

const SAMPLE_NCX = `<?xml version="1.0" encoding="UTF-8"?>
<Connections Ver="1.5">
  <Connection ConnectionName="local-mysql" ConnType="MYSQL" Host="localhost" Port="3306" UserName="root" Password="E191AF42327478CC5F143EF279EC4D81" SavePassword="true" SSL="false" Remarks="" />
  <Connection ConnectionName="legacy-pg" ConnType="POSTGRESQL" Host="10.0.0.2" Port="5432" Database="postgres" UserName="odoo" Password="" SavePassword="false" SSL="false" Remarks="" />
  <Connection ConnectionName="unsupported-oracle" ConnType="ORACLE" Host="127.0.0.1" Port="1521" UserName="scott" Password="" SavePassword="false" Remarks="" />
</Connections>`;

describe("parseNavicatNcx", () => {
  it("parses connection attributes from NCX", () => {
    const items = parseNavicatNcx(SAMPLE_NCX);
    expect(items).toHaveLength(3);
    expect(items[0]?.name).toBe("local-mysql");
    expect(items[0]?.connType).toBe("MYSQL");
    expect(items[0]?.host).toBe("localhost");
    expect(items[1]?.database).toBe("postgres");
  });
});

describe("buildNavicatImportPreview", () => {
  it("marks unsupported engines and importable mysql/pg entries", () => {
    const rawItems = parseNavicatNcx(SAMPLE_NCX);
    const preview = buildNavicatImportPreview(rawItems, ["secret", "", ""], []);
    expect(preview[0]?.importable).toBe(true);
    expect(preview[1]?.importable).toBe(true);
    expect(preview[2]?.importable).toBe(false);
    expect(preview[2]?.issues).toContain("unsupported_engine");
  });
});
