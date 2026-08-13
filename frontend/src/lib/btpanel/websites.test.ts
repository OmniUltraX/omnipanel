import { describe, expect, it } from "vitest";
import { javaProjectRunStatus, mergeBtSitesWithJavaProjects } from "./websites";

describe("javaProjectRunStatus", () => {
  it("uses pid_info emptiness as run state", () => {
    expect(javaProjectRunStatus({ pid_info: { pid: 123 } })).toBe("1");
    expect(javaProjectRunStatus({ pid_info: "" })).toBe("0");
    expect(javaProjectRunStatus({ pid_info: null })).toBe("0");
    expect(javaProjectRunStatus({ pid_info: {} })).toBe("0");
    expect(javaProjectRunStatus({ pid_info: [] })).toBe("0");
  });

  it("falls back to boolean run/status when pid_info absent", () => {
    expect(javaProjectRunStatus({ run: true })).toBe("1");
    expect(javaProjectRunStatus({ run: false })).toBe("0");
    expect(javaProjectRunStatus({ status: true })).toBe("1");
    expect(javaProjectRunStatus({ status: false })).toBe("0");
  });
});

describe("mergeBtSitesWithJavaProjects", () => {
  it("overwrites Java site status from project_list pid_info", () => {
    const merged = mergeBtSitesWithJavaProjects(
      [{ id: 1, name: "demo", status: "1", project_type: "Java" }],
      [{ name: "demo", pid_info: null }],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]?.status).toBe("0");
    expect(merged[0]?.pid_info).toBeNull();
    expect(merged[0]?.project_type).toBe("Java");
  });

  it("appends orphan Java projects", () => {
    const merged = mergeBtSitesWithJavaProjects(
      [{ id: 1, name: "php.site", status: "1", project_type: "PHP" }],
      [{ name: "spring-app", pid_info: { pid: 42 }, port: 8080 }],
    );
    expect(merged).toHaveLength(2);
    expect(merged[1]?.name).toBe("spring-app");
    expect(merged[1]?.project_type).toBe("Java");
    expect(merged[1]?.status).toBe("1");
    expect(merged[1]?.pid_info).toEqual({ pid: 42 });
  });
});
