import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Select } from "../../components/ui/Select";

/* ── Types ── */

interface NetworkInterface {
  name: string;
  description: string | null;
  addresses: string[];
  is_loopback: boolean;
}

interface SnifferPacket {
  index: number;
  timestamp: string;
  src_ip: string;
  dst_ip: string;
  protocol: string;
  src_port: number | null;
  dst_port: number | null;
  length: number;
  payload_hex: string;
}

interface CaptureStats {
  total_packets: number;
  tcp_count: number;
  udp_count: number;
  icmp_count: number;
  other_count: number;
  total_bytes: number;
}

/* ── Helpers ── */

function protocolColor(proto: string): string {
  switch (proto.toUpperCase()) {
    case "TCP":
      return "#3b82f6"; // blue
    case "UDP":
      return "#22c55e"; // green
    case "ICMP":
      return "#ef4444"; // red
    case "ARP":
      return "#f59e0b"; // amber
    default:
      return "#6b7280"; // gray
  }
}

function protocolBg(proto: string): string {
  switch (proto.toUpperCase()) {
    case "TCP":
      return "rgba(59,130,246,0.12)";
    case "UDP":
      return "rgba(34,197,94,0.12)";
    case "ICMP":
      return "rgba(239,68,68,0.12)";
    case "ARP":
      return "rgba(245,158,11,0.12)";
    default:
      return "rgba(107,114,128,0.12)";
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function hexDump(hex: string): string {
  const lines: string[] = [];
  const bytes = hex.match(/.{1,2}/g) || [];
  for (let i = 0; i < bytes.length; i += 16) {
    const chunk = bytes.slice(i, i + 16);
    const offset = i.toString(16).padStart(4, "0");
    const hexPart = chunk
      .map((b, j) => (j === 8 ? ` ${b}` : b))
      .join(" ")
      .padEnd(48);
    const asciiPart = chunk
      .map((b) => {
        const n = parseInt(b, 16);
        return n >= 0x20 && n <= 0x7e ? String.fromCharCode(n) : ".";
      })
      .join("");
    lines.push(`${offset}  ${hexPart}  |${asciiPart}|`);
  }
  return lines.join("\n");
}

/* ── Component ── */

export function SnifferPanel() {
  const [interfaces, setInterfaces] = useState<NetworkInterface[]>([]);
  const [selectedIface, setSelectedIface] = useState("");
  const [filter, setFilter] = useState("");
  const [capturing, setCapturing] = useState(false);
  const [captureId, setCaptureId] = useState<string | null>(null);
  const [packets, setPackets] = useState<SnifferPacket[]>([]);
  const [stats, setStats] = useState<CaptureStats>({
    total_packets: 0,
    tcp_count: 0,
    udp_count: 0,
    icmp_count: 0,
    other_count: 0,
    total_bytes: 0,
  });
  const [selectedPacket, setSelectedPacket] = useState<SnifferPacket | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Load interfaces on mount
  useEffect(() => {
    invoke<NetworkInterface[]>("sniffer_list_interfaces")
      .then((ifaces) => {
        setInterfaces(ifaces);
        if (ifaces.length > 0 && !selectedIface) {
          setSelectedIface(ifaces[0].name);
        }
      })
      .catch((e) => console.error("Failed to list interfaces:", e));
  }, []);

  // Poll packets & stats while capturing
  useEffect(() => {
    if (capturing && captureId) {
      pollRef.current = setInterval(async () => {
        try {
          const [newPackets, newStats] = await Promise.all([
            invoke<SnifferPacket[]>("sniffer_get_packets", {
              captureId,
              limit: 2000,
            }),
            invoke<CaptureStats>("sniffer_get_stats", { captureId }),
          ]);
          setPackets(newPackets);
          setStats(newStats);
        } catch (e) {
          console.error("Poll error:", e);
        }
      }, 500);
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [capturing, captureId]);

  // Auto-scroll
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [packets, autoScroll]);

  const handleStart = useCallback(async () => {
    if (!selectedIface) return;
    try {
      const id = await invoke<string>("sniffer_start_capture", {
        iface: selectedIface,
        filter: filter || "",
      });
      setCaptureId(id);
      setCapturing(true);
      setPackets([]);
      setSelectedPacket(null);
      setStats({
        total_packets: 0,
        tcp_count: 0,
        udp_count: 0,
        icmp_count: 0,
        other_count: 0,
        total_bytes: 0,
      });
    } catch (e) {
      console.error("Start capture failed:", e);
    }
  }, [selectedIface, filter]);

  const handleStop = useCallback(async () => {
    if (!captureId) return;
    try {
      await invoke("sniffer_stop_capture", { captureId });
    } catch (e) {
      console.error("Stop capture failed:", e);
    }
    setCapturing(false);
    setCaptureId(null);
  }, [captureId]);

  const handleRefresh = useCallback(async () => {
    try {
      const ifaces = await invoke<NetworkInterface[]>("sniffer_list_interfaces");
      setInterfaces(ifaces);
      if (ifaces.length > 0 && !selectedIface) {
        setSelectedIface(ifaces[0].name);
      }
    } catch (e) {
      console.error("Refresh failed:", e);
    }
  }, [selectedIface]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        gap: "var(--sp-3)",
        padding: "var(--sp-3)",
      }}
    >
      {/* ── Toolbar ── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--sp-2)",
          flexWrap: "wrap",
        }}
      >
        {/* Interface selector */}
        <Select
          value={selectedIface}
          onChange={setSelectedIface}
          disabled={capturing}
          placeholder="No interfaces"
          style={{ minWidth: "180px" }}
          options={
            interfaces.length === 0
              ? [{ value: "", label: "No interfaces", disabled: true }]
              : interfaces.map((iface) => ({
                  value: iface.name,
                  label: `${iface.name}${iface.description ? ` — ${iface.description}` : ""}${iface.is_loopback ? " (loopback)" : ""}`,
                }))
          }
        />

        <button
          className="btn btn-ghost btn-sm"
          onClick={handleRefresh}
          disabled={capturing}
          title="Refresh interfaces"
        >
          &#x21bb;
        </button>

        {/* BPF filter */}
        <input
          className="input"
          placeholder="BPF filter (e.g. tcp port 80)"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          disabled={capturing}
          style={{
            flex: 1,
            minWidth: "200px",
            fontSize: "12px",
            background: "var(--surface-1)",
            color: "var(--text)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            padding: "6px 10px",
          }}
        />

        {/* Start / Stop */}
        <button
          className={`btn ${capturing ? "btn-danger" : "btn-primary"}`}
          onClick={capturing ? handleStop : handleStart}
          disabled={!capturing && !selectedIface}
          style={{ minWidth: "100px" }}
        >
          {capturing ? "⏹ Stop" : "▶ Start"}
        </button>
      </div>

      {/* ── Stats bar ── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--sp-3)",
          fontSize: "11px",
          color: "var(--text-muted)",
          padding: "4px 0",
          borderBottom: "1px solid var(--border)",
        }}
      >
        {capturing && (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "4px",
              color: "#ef4444",
              fontWeight: 600,
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: "#ef4444",
                animation: "pulse 1s infinite",
              }}
            />
            LIVE
          </span>
        )}
        <span>
          Packets: <strong>{stats.total_packets.toLocaleString()}</strong>
        </span>
        <span style={{ color: "#3b82f6" }}>
          TCP: {stats.tcp_count.toLocaleString()}
        </span>
        <span style={{ color: "#22c55e" }}>
          UDP: {stats.udp_count.toLocaleString()}
        </span>
        <span style={{ color: "#ef4444" }}>
          ICMP: {stats.icmp_count.toLocaleString()}
        </span>
        <span>
          Other: {stats.other_count.toLocaleString()}
        </span>
        <span style={{ marginLeft: "auto" }}>
          Total: {formatBytes(stats.total_bytes)}
        </span>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: "4px",
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={(e) => setAutoScroll(e.target.checked)}
            style={{ accentColor: "var(--accent)" }}
          />
          Auto-scroll
        </label>
      </div>

      {/* ── Main area: packet table + detail ── */}
      <div style={{ display: "flex", flex: 1, gap: "var(--sp-2)", minHeight: 0 }}>
        {/* Packet list */}
        <div
          ref={scrollRef}
          style={{
            flex: 1,
            overflow: "auto",
            background: "var(--surface-0)",
            borderRadius: "var(--radius)",
            border: "1px solid var(--border)",
            fontFamily: "var(--font-mono, 'JetBrains Mono', 'Fira Code', monospace)",
            fontSize: "11px",
          }}
        >
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              tableLayout: "fixed",
            }}
          >
            <thead>
              <tr
                style={{
                  position: "sticky",
                  top: 0,
                  background: "var(--surface-1)",
                  zIndex: 1,
                  textAlign: "left",
                }}
              >
                <th style={{ ...thStyle, width: "50px" }}>#</th>
                <th style={{ ...thStyle, width: "90px" }}>Time</th>
                <th style={{ ...thStyle, width: "130px" }}>Source</th>
                <th style={{ ...thStyle, width: "130px" }}>Destination</th>
                <th style={{ ...thStyle, width: "60px" }}>Proto</th>
                <th style={{ ...thStyle, width: "60px" }}>Src Pt</th>
                <th style={{ ...thStyle, width: "60px" }}>Dst Pt</th>
                <th style={{ ...thStyle, width: "60px" }}>Len</th>
              </tr>
            </thead>
            <tbody>
              {packets.length === 0 && (
                <tr>
                  <td
                    colSpan={8}
                    style={{
                      textAlign: "center",
                      color: "var(--text-muted)",
                      padding: "40px 0",
                      fontStyle: "italic",
                    }}
                  >
                    {capturing
                      ? "Waiting for packets…"
                      : "Click Start to begin packet capture"}
                  </td>
                </tr>
              )}
              {packets.map((pkt) => (
                <tr
                  key={pkt.index}
                  onClick={() => setSelectedPacket(pkt)}
                  style={{
                    cursor: "pointer",
                    background:
                      selectedPacket?.index === pkt.index
                        ? "var(--surface-2)"
                        : pkt.index % 2 === 0
                          ? "transparent"
                          : "rgba(255,255,255,0.02)",
                    borderLeft: `3px solid ${protocolColor(pkt.protocol)}`,
                  }}
                >
                  <td style={tdStyle}>{pkt.index}</td>
                  <td style={tdStyle}>{pkt.timestamp}</td>
                  <td style={tdStyle}>{pkt.src_ip}</td>
                  <td style={tdStyle}>{pkt.dst_ip}</td>
                  <td style={tdStyle}>
                    <span
                      style={{
                        display: "inline-block",
                        padding: "1px 6px",
                        borderRadius: "3px",
                        fontSize: "10px",
                        fontWeight: 600,
                        color: protocolColor(pkt.protocol),
                        background: protocolBg(pkt.protocol),
                      }}
                    >
                      {pkt.protocol}
                    </span>
                  </td>
                  <td style={tdStyle}>{pkt.src_port ?? "—"}</td>
                  <td style={tdStyle}>{pkt.dst_port ?? "—"}</td>
                  <td style={tdStyle}>{pkt.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Packet detail panel */}
        {selectedPacket && (
          <div
            style={{
              width: "340px",
              display: "flex",
              flexDirection: "column",
              background: "var(--surface-0)",
              borderRadius: "var(--radius)",
              border: "1px solid var(--border)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                padding: "8px 12px",
                background: "var(--surface-1)",
                borderBottom: "1px solid var(--border)",
                fontWeight: 600,
                fontSize: "12px",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <span>Packet #{selectedPacket.index}</span>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => setSelectedPacket(null)}
                style={{ padding: "0 4px", fontSize: "14px" }}
              >
                ✕
              </button>
            </div>

            {/* Packet info */}
            <div style={{ padding: "8px 12px", fontSize: "11px", lineHeight: "1.6" }}>
              <DetailRow label="Timestamp" value={selectedPacket.timestamp} />
              <DetailRow label="Source" value={`${selectedPacket.src_ip}${selectedPacket.src_port ? `:${selectedPacket.src_port}` : ""}`} />
              <DetailRow label="Destination" value={`${selectedPacket.dst_ip}${selectedPacket.dst_port ? `:${selectedPacket.dst_port}` : ""}`} />
              <DetailRow label="Protocol" value={selectedPacket.protocol} />
              <DetailRow label="Length" value={`${selectedPacket.length} bytes`} />
            </div>

            {/* Hex dump */}
            <div
              style={{
                padding: "0 12px 8px",
                flex: 1,
                overflow: "auto",
              }}
            >
              <div
                style={{
                  fontSize: "10px",
                  fontWeight: 600,
                  color: "var(--text-muted)",
                  marginBottom: "4px",
                  textTransform: "uppercase",
                }}
              >
                Hex Dump
              </div>
              <pre
                style={{
                  margin: 0,
                  padding: "8px",
                  background: "var(--surface-1)",
                  borderRadius: "var(--radius)",
                  fontSize: "11px",
                  fontFamily: "var(--font-mono, 'JetBrains Mono', monospace)",
                  whiteSpace: "pre",
                  overflow: "auto",
                  lineHeight: "1.5",
                  color: "var(--text)",
                }}
              >
                {hexDump(selectedPacket.payload_hex)}
              </pre>
            </div>
          </div>
        )}
      </div>

      {/* Pulse animation */}
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
      `}</style>
    </div>
  );
}

/* ── Sub-components ── */

const thStyle: React.CSSProperties = {
  padding: "6px 8px",
  fontWeight: 600,
  fontSize: "10px",
  textTransform: "uppercase",
  color: "var(--text-muted)",
  borderBottom: "1px solid var(--border)",
  whiteSpace: "nowrap",
};

const tdStyle: React.CSSProperties = {
  padding: "4px 8px",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between" }}>
      <span style={{ color: "var(--text-muted)" }}>{label}</span>
      <span style={{ fontWeight: 500 }}>{value}</span>
    </div>
  );
}
