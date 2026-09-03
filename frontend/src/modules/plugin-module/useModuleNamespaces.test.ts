import { describe, expect, it } from "vitest";
import {
  isPublicNamespace,
  namespaceIdFromSelect,
  namespaceSelectValue,
  PUBLIC_NAMESPACE_SELECT,
} from "./moduleNamespaces";

describe("namespace select mapping", () => {
  it("把空 id 映射为 public 哨兵，往返保持空字符串", () => {
    expect(namespaceSelectValue("")).toBe(PUBLIC_NAMESPACE_SELECT);
    expect(namespaceIdFromSelect(PUBLIC_NAMESPACE_SELECT)).toBe("");
    expect(namespaceSelectValue("dev")).toBe("dev");
    expect(namespaceIdFromSelect("dev")).toBe("dev");
    expect(isPublicNamespace("")).toBe(true);
    expect(isPublicNamespace("dev")).toBe(false);
  });
});
