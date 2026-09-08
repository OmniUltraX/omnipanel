import { describe, expect, it } from "vitest";
import { canConfirmSubmit } from "./submitFormat";
import type { SubmitPreview } from "../../ipc/bindings";

function preview(partial: Partial<SubmitPreview> = {}): SubmitPreview {
  return {
    title: "[plugin-submission] omni.sample.x 0.1.0",
    body: "hello",
    repo: "OmniUltraX/omnipanel",
    remaining: 3,
    waitMs: null,
    hasToken: true,
    permissions: ["ui:selection"],
    needsManualReview: false,
    ...partial,
  };
}

describe("studio 投稿确认", () => {
  it("有预览且有 token 且未超限才可确认", () => {
    expect(canConfirmSubmit(preview())).toBe(true);
  });

  it("超限禁用", () => {
    expect(canConfirmSubmit(preview({ waitMs: 60_000, remaining: 0 }))).toBe(false);
  });

  it("无 token 不可确认", () => {
    expect(canConfirmSubmit(preview({ hasToken: false }))).toBe(false);
    expect(canConfirmSubmit(null)).toBe(false);
  });
});
