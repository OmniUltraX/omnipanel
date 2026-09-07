import { describe, expect, it, beforeEach } from "vitest";
import { useContext, useState } from "react";
import { render, screen, act } from "@testing-library/react";
import {
  UNSAFE_LocationContext,
  type Location,
  type NavigationType,
} from "react-router-dom";
import { FrozenLocationWhenSuspended } from "./FrozenLocationWhenSuspended";

function Probe() {
  const ctx = useContext(UNSAFE_LocationContext);
  return <span data-testid="path">{ctx?.location.pathname ?? ""}</span>;
}

let mountSerial = 0;

function MountProbe() {
  const [serial] = useState(() => {
    mountSerial += 1;
    return mountSerial;
  });
  return <span data-testid="mount-serial">{String(serial)}</span>;
}

describe("FrozenLocationWhenSuspended", () => {
  beforeEach(() => {
    mountSerial = 0;
  });

  it("切到 suspend 后仍读冻结 pathname，且子树不 remount", () => {
    const location: Location = {
      pathname: "/module/terminal",
      search: "",
      hash: "",
      state: null,
      key: "t1",
    };
    const liveCtx = {
      location,
      navigationType: "POP" as NavigationType,
    };

    function Harness() {
      const [suspended, setSuspended] = useState(false);

      return (
        <UNSAFE_LocationContext.Provider value={liveCtx}>
          <button type="button" onClick={() => setSuspended(true)}>
            suspend
          </button>
          <FrozenLocationWhenSuspended
            suspended={suspended}
            panelId="terminal-test-freeze"
          >
            <Probe />
            <MountProbe />
          </FrozenLocationWhenSuspended>
        </UNSAFE_LocationContext.Provider>
      );
    }

    render(<Harness />);
    expect(screen.getByTestId("path").textContent).toBe("/module/terminal");
    expect(screen.getByTestId("mount-serial").textContent).toBe("1");

    liveCtx.location = {
      ...location,
      pathname: "/module/ssh",
      key: "t2",
    };

    act(() => {
      screen.getByText("suspend").click();
    });

    expect(screen.getByTestId("path").textContent).toBe("/module/terminal");
    // 若仍用 LiveBranch/FrozenBranch 切换，MountProbe 会变成 2
    expect(screen.getByTestId("mount-serial").textContent).toBe("1");
  });
});
