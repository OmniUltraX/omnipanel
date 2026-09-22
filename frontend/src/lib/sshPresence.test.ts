import { describe, expect, it } from "vitest";
import { sshCommandIsCritical, sshCommandNeedsPresence } from "./sshPresence";

describe("sshCommandIsCritical", () => {
  it("matches backend critical patterns", () => {
    expect(sshCommandIsCritical("sudo rm -rf /var/lib")).toBe(true);
    expect(sshCommandIsCritical("ls -la /var/lib")).toBe(false);
    expect(sshCommandIsCritical("dd if=/dev/zero of=/dev/sda")).toBe(true);
    expect(
      sshCommandIsCritical("rm -rf '/tmp/omni' && mkdir -p '/tmp/omni'"),
    ).toBe(true);
  });

  it("treats commandGuard critical as needing presence", () => {
    expect(sshCommandNeedsPresence("rm -rf /tmp/x")).toBe(true);
    expect(sshCommandNeedsPresence("echo ok")).toBe(false);
  });
});
