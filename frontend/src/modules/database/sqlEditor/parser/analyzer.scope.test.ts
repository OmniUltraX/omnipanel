import { describe, expect, it } from "vitest";
import { analyzeStatementAtOffset } from "./analyzer";

describe("analyzeStatementAtOffset", () => {
  const nestedSql = `
SELECT
  t3.template
FROM
  (
    SELECT
      eb.name,
      eb.grade
    FROM
      edu_book eb
  ) t3
`;

  it("resolves physical table alias inside nested subquery", () => {
    const offset = nestedSql.indexOf("eb.name");
    expect(offset).toBeGreaterThan(0);

    const scoped = analyzeStatementAtOffset(nestedSql, offset, "mysql");
    expect(scoped?.aliasMap.get("eb")?.tableName.toLowerCase()).toBe("edu_book");
  });
});
