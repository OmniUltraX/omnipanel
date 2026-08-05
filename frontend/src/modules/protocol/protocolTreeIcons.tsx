import type { ProtocolTabKey } from "../../lib/protocolLabConfig";
import httpIcon from "../../assets/icons/http.svg";

const DEFAULT_ICON_PROPS = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  width: 14,
  height: 14,
  "aria-hidden": true,
} as const;

/** HTTP 请求树节点品牌图标 */
export function ProtocolTreeHttpIcon({ size = 14 }: { size?: number }) {
  return (
    <img
      src={httpIcon}
      alt=""
      width={size}
      height={size}
      className="proto-tree-protocol-icon"
      aria-hidden
      draggable={false}
    />
  );
}

/** 其他协议暂用的默认图标（后续可按协议替换） */
export function ProtocolTreeDefaultIcon({ size = 14 }: { size?: number }) {
  return (
    <svg {...DEFAULT_ICON_PROPS} width={size} height={size}>
      <path d="M8 10a4 4 0 0 1 8 0v1" />
      <rect x="6" y="11" width="12" height="8" rx="2" />
      <path d="M12 15v2" />
    </svg>
  );
}

export function ProtocolTreeProtocolIcon({
  protocol,
  size = 14,
}: {
  protocol: ProtocolTabKey;
  size?: number;
}) {
  if (protocol === "http") {
    return <ProtocolTreeHttpIcon size={size} />;
  }
  return <ProtocolTreeDefaultIcon size={size} />;
}
