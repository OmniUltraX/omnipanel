import { describe, expect, it } from "vitest";
import { parseQuickLaunchQuery, registerLauncherProvider } from "./quickLauncherMatch";

describe("parseQuickLaunchQuery", () => {
  it("keeps ssh+ and db prefix behavior", () => {
    expect(parseQuickLaunchQuery("ssh+web")).toEqual({
      kind: "ssh",
      raw: "ssh+web",
      filter: "web",
    });
    expect(parseQuickLaunchQuery("db")).toMatchObject({ kind: "db", filter: "" });
    expect(parseQuickLaunchQuery("db prod.users")).toMatchObject({
      kind: "db",
      filter: "prod.users",
      databaseHint: "prod",
      tableHint: "users",
    });
  });

  it("parses es prefix from launcher registry", () => {
    expect(parseQuickLaunchQuery("es ext:yml")).toEqual({
      kind: "es",
      raw: "es ext:yml",
      filter: "ext:yml",
    });
    registerLauncherProvider({
      prefix: "es",
      parse: (raw, filter) => ({ kind: "es", raw, filter }),
    });
    expect(parseQuickLaunchQuery("es foo").kind).toBe("es");
  });
});
