import { describe, expect, it } from "vitest";
import {
  buildChangePasswordSql,
  buildCreateUserSql,
  buildGrantSql,
  buildSetLoginEnabledSql,
} from "./userSql";

describe("userSql", () => {
  it("builds mysql create / password / lock", () => {
    expect(buildCreateUserSql("mysql", "alice", "s3cret", "%")).toBe(
      "CREATE USER 'alice'@'%' IDENTIFIED BY 's3cret'",
    );
    expect(buildChangePasswordSql("mysql", "alice", "n", "localhost")).toBe(
      "ALTER USER 'alice'@'localhost' IDENTIFIED BY 'n'",
    );
    expect(buildSetLoginEnabledSql("mysql", "alice", false, "%")).toBe(
      "ALTER USER 'alice'@'%' ACCOUNT LOCK",
    );
    expect(buildSetLoginEnabledSql("mysql", "alice", true, "%")).toBe(
      "ALTER USER 'alice'@'%' ACCOUNT UNLOCK",
    );
  });

  it("builds postgres create / password / login", () => {
    expect(buildCreateUserSql("postgresql", "app", "s3cret")).toBe(
      'CREATE ROLE "app" WITH LOGIN PASSWORD \'s3cret\'',
    );
    expect(buildChangePasswordSql("postgres", "app", "x")).toBe(
      'ALTER ROLE "app" PASSWORD \'x\'',
    );
    expect(buildSetLoginEnabledSql("postgresql", "app", false)).toBe(
      'ALTER ROLE "app" NOLOGIN',
    );
  });

  it("builds grant sql per engine", () => {
    expect(
      buildGrantSql("mysql", {
        name: "alice",
        host: "%",
        privileges: ["SELECT", "INSERT"],
        scopeKind: "database",
        database: "demo",
        withGrantOption: true,
      }),
    ).toBe("GRANT SELECT, INSERT ON `demo`.* TO 'alice'@'%' WITH GRANT OPTION");

    expect(
      buildGrantSql("postgres", {
        name: "app",
        privileges: ["CONNECT", "TEMPORARY"],
        scopeKind: "database",
        database: "postgres",
      }),
    ).toBe('GRANT CONNECT, TEMPORARY ON DATABASE "postgres" TO "app"');
  });
});
