import { describe, expect, it } from "vitest";
import { parsePathParams, serializePathParams, syncPathParamsFromUrl } from "./httpPathParams";

describe("path params persistence", () => {
  it("round-trips path params json", () => {
    const pairs = [
      { key: "ioOption", value: "all", enabled: true },
      { key: "netOption", value: "all", enabled: false },
    ];
    const restored = parsePathParams(serializePathParams(pairs));
    expect(restored).toEqual(pairs);
  });

  it("restores saved values when url template matches", () => {
    const url = "/dashboard/current/:ioOption/:netOption";
    const saved = parsePathParams(
      serializePathParams([{ key: "ioOption", value: "all", enabled: true }]),
    );
    const synced = syncPathParamsFromUrl(url, saved);
    expect(synced.find((item) => item.key === "ioOption")?.value).toBe("all");
    expect(synced.find((item) => item.key === "netOption")?.value).toBe("");
  });
});
