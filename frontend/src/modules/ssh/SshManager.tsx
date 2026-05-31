import { HostListPanel } from "../../components/workspace/HostListPanel";
import { HostDetailPanel } from "./components/HostDetailPanel";
import { KeysModuleView } from "./components/KeysModuleView";
import { TunnelsModuleView } from "./components/TunnelsModuleView";
import { useSshManager } from "./hooks/useSshManager";

export function SshManager() {
  const ctx = useSshManager();
  const { moduleTab, sshResources, onlineHosts, offlineHosts } = ctx;

  return (
    <div className="ssh-layout">
      {moduleTab === "hosts" && <HostListPanel resources={sshResources} />}
      {moduleTab === "hosts" ? (
        <HostDetailPanel {...ctx} />
      ) : moduleTab === "tunnels" ? (
        <TunnelsModuleView {...ctx} />
      ) : (
        <KeysModuleView {...ctx} />
      )}
      <div
        className="statusbar"
        style={{
          position: "absolute",
          left: -99999,
          width: 1,
          height: 1,
          overflow: "hidden",
        }}
        aria-hidden="true"
      >
        <span className="statusbar-item">{onlineHosts}</span>
        <span className="statusbar-item">{offlineHosts}</span>
      </div>
    </div>
  );
}
