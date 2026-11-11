import { describe, expect, it } from "vitest";
import { classifyLoginQrcodeError, LOGIN_QRCODE_ERROR_I18N_KEY } from "./loginQrcodeError";

describe("classifyLoginQrcodeError", () => {
  it("maps DNS lookup failures", () => {
    const err = new Error(
      "获取登录二维码失败：error sending request for url (https://mp.99.protected.fun/api/login/qrcode): dns error: failed to lookup address information",
    );
    expect(classifyLoginQrcodeError(err)).toBe("dns");
    expect(LOGIN_QRCODE_ERROR_I18N_KEY.dns).toBe("userCenter.login.networkDns");
  });

  it("maps timeouts", () => {
    expect(classifyLoginQrcodeError(new Error("operation timed out"))).toBe("timeout");
    expect(classifyLoginQrcodeError({ message: "error sending request", code: "timeout" })).toBe(
      "timeout",
    );
  });

  it("maps generic connection failures", () => {
    expect(classifyLoginQrcodeError(new Error("error trying to connect: connection refused"))).toBe(
      "network",
    );
  });

  it("keeps unknown server errors as unknown", () => {
    expect(classifyLoginQrcodeError(new Error("二维码响应缺少 login_id"))).toBe("unknown");
  });
});
