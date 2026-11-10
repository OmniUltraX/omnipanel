import { afterEach, describe, expect, it, vi } from "vitest";
import { webAuthStatus, webLogin, webLogout } from "./webAuth";

afterEach(() => vi.unstubAllGlobals());
describe("Web authentication transport", () => {
  it("posts credentials only to the same-origin login endpoint, without persistence or URL tokens", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true }); vi.stubGlobal("fetch", fetch);
    const beforeLocal = localStorage.length; const beforeSession = sessionStorage.length;
    await webLogin("synthetic-only");
    expect(fetch).toHaveBeenCalledWith("/ipc/auth", expect.objectContaining({ method: "POST", credentials: "same-origin", cache: "no-store", body: JSON.stringify({ api_key: "synthetic-only" }) }));
    expect(localStorage.length).toBe(beforeLocal); expect(sessionStorage.length).toBe(beforeSession);
  });
  it("does not accept rejected credentials", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));
    await expect(webLogin("wrong")).rejects.toThrow("Invalid API key");
  });
  it("queries auth state without caching secrets", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: () => ({ required: true, authenticated: false }) }); vi.stubGlobal("fetch", fetch);
    expect(await webAuthStatus()).toEqual({ required: true, authenticated: false });
    expect(fetch).toHaveBeenCalledWith("/ipc/auth", { credentials: "same-origin", cache: "no-store" });
  });
  it("reports logout network/HTTP failure instead of pretending to lock", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    await expect(webLogout()).rejects.toThrow("Logout failed");
  });
});
