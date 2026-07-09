import { describe, expect, it } from "vitest";
import { buildHttpCurlCommand } from "./httpCurlCommand";

describe("buildHttpCurlCommand", () => {
  it("builds curl with method, url, headers and body", () => {
    const curl = buildHttpCurlCommand({
      method: "POST",
      url: "http://example.com/api/v2/test",
      headers: { "Content-Type": "application/json" },
      queryParams: { page: "1" },
      body: '{"ok":true}',
    });
    expect(curl).toContain("curl -X POST");
    expect(curl).toContain("http://example.com/api/v2/test?page=1");
    expect(curl).toContain("Content-Type: application/json");
    expect(curl).toContain("-d ");
  });
});
