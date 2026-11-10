import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { PanelErrorBoundary } from "./PanelErrorBoundary";

function Boom({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) throw new Error("W.filter is not a function");
  return <div>studio ok</div>;
}

function Harness() {
  const [boom, setBoom] = useState(true);
  return (
    <div>
      <div>shell chrome</div>
      <PanelErrorBoundary title="插件工作台渲染失败">
        <Boom shouldThrow={boom} />
      </PanelErrorBoundary>
      <button type="button" onClick={() => setBoom(false)}>
        recover-source
      </button>
    </div>
  );
}

describe("PanelErrorBoundary", () => {
  it("keeps surrounding chrome when a child render throws, and retry remounts after the fault is gone", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<Harness />);
    expect(screen.getByText("shell chrome")).toBeTruthy();
    expect(screen.getByText("插件工作台渲染失败")).toBeTruthy();
    expect(screen.getByText("W.filter is not a function")).toBeTruthy();
    expect(screen.queryByText("studio ok")).toBeNull();

    fireEvent.click(screen.getByText("recover-source"));
    fireEvent.click(screen.getByText("重试"));
    expect(screen.getByText("studio ok")).toBeTruthy();
    expect(screen.queryByText("插件工作台渲染失败")).toBeNull();
    spy.mockRestore();
  });
});
