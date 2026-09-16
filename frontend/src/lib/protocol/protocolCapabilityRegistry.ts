import {
  ALL_PROTOCOL_TABS,
  CONTROLLABLE_PROTOCOL_TABS,
  DEFAULT_CONTROLLABLE_PROTOCOL_STATUS,
  DEV_LOCKED_PROTOCOL_TABS,
  ALWAYS_VISIBLE_PROTOCOL_TABS,
  resolveProtocolTabStatus,
  type ControllableProtocolTabKey,
  type ProtocolTabKey,
  type ProtocolTabStatus,
} from "../protocolLabConfig";
import type { ProtocolCapability } from "./protocolCapability";

/**
 * 内置 Protocol Host capability 注册表。
 *
 * 从 `protocolLabConfig` 的 tab 列表包装而来；可见性规则仍委托现有 resolve 函数，
 * 避免本刀大改 ProtocolPanel。后续可在此扩展 sidebar/panel 槽位与插件贡献。
 */
const BUILTIN_SIDEBAR: Partial<Record<ProtocolTabKey, string>> = {
  http: "ProtocolHttpSidebar",
};

const BUILTIN_PANEL: Partial<Record<ProtocolTabKey, string>> = {
  http: "HttpRequestPanel",
  mqtt: "MqttPanel",
  pubsub: "RedisPubSubPanel",
  serial: "SerialPanel",
  grpc: "GrpcPanel",
  sniffer: "SnifferPanel",
  modbus: "ModbusPanel",
};

function buildBuiltinCapability(id: ProtocolTabKey): ProtocolCapability {
  const controllable = (CONTROLLABLE_PROTOCOL_TABS as readonly string[]).includes(id);
  const controllableKey = id as ControllableProtocolTabKey;
  return {
    id,
    labelKey: `protocol.tabs.${id}`,
    controllable,
    enabledByDefault: controllable
      ? DEFAULT_CONTROLLABLE_PROTOCOL_STATUS[controllableKey] === "open"
      : undefined,
    devLocked: DEV_LOCKED_PROTOCOL_TABS.includes(id),
    alwaysVisible: ALWAYS_VISIBLE_PROTOCOL_TABS.includes(id),
    sidebar: BUILTIN_SIDEBAR[id],
    panel: BUILTIN_PANEL[id],
  };
}

/** 内置注册表（按 ALL_PROTOCOL_TABS 顺序） */
export const PROTOCOL_CAPABILITY_REGISTRY: readonly ProtocolCapability[] =
  ALL_PROTOCOL_TABS.map(buildBuiltinCapability);

export function getProtocolCapability(id: ProtocolTabKey): ProtocolCapability | undefined {
  return PROTOCOL_CAPABILITY_REGISTRY.find((c) => c.id === id);
}

export function listProtocolCapabilities(): readonly ProtocolCapability[] {
  return PROTOCOL_CAPABILITY_REGISTRY;
}

/**
 * 按用户设置解析 capability 可见性（Host 合同草图入口）。
 * ProtocolPanel 可小步改用本函数判断可见 tab，而不必立刻动态渲染 panel。
 */
export function resolveProtocolCapabilityStatus(
  capability: ProtocolCapability,
  userStatus: Record<ControllableProtocolTabKey, "open" | "closed">,
): ProtocolTabStatus {
  return resolveProtocolTabStatus(capability.id, userStatus);
}

export function getVisibleProtocolCapabilities(
  userStatus: Record<ControllableProtocolTabKey, "open" | "closed">,
): ProtocolCapability[] {
  return PROTOCOL_CAPABILITY_REGISTRY.filter(
    (cap) => resolveProtocolCapabilityStatus(cap, userStatus) === "open",
  );
}

export function getVisibleProtocolCapabilityIds(
  userStatus: Record<ControllableProtocolTabKey, "open" | "closed">,
): ProtocolTabKey[] {
  return getVisibleProtocolCapabilities(userStatus).map((c) => c.id);
}
