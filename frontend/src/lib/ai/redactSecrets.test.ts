import { describe, expect, it } from "vitest";
import { redactEnvArray, redactSecretsInText } from "./redactSecrets";

describe("redactSecretsInText", () => {
  it("redacts MYSQL_PASSWORD env lines in JSON", () => {
    const input = JSON.stringify({
      env: ["PATH=/bin", "MYSQL_PASSWORD=s3cret", "OK=1"],
    });
    const out = redactSecretsInText(input);
    expect(out).toContain("MYSQL_PASSWORD=***");
    expect(out).toContain("PATH=/bin");
    expect(out).not.toContain("s3cret");
  });

  it("redacts sk- tokens", () => {
    const out = redactSecretsInText("token sk-abcdefghijklmnopqrstuvwxyz here");
    expect(out).toContain("***");
    expect(out).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
  });

  it("redacts password object keys", () => {
    const out = redactSecretsInText(JSON.stringify({ password: "x", host: "h" }));
    expect(out).toContain("***");
    expect(out).toContain('"host"');
    expect(out).not.toContain('"x"');
  });
});

describe("redactEnvArray", () => {
  it("masks secret env keys", () => {
    expect(redactEnvArray(["FOO=1", "API_KEY=abc"])).toEqual(["FOO=1", "API_KEY=***"]);
  });
});
