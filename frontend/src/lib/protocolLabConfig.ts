/** 协议实验室 ModuleSegmentDock 分段 Tab 标识 */
export type ProtocolTabKey =
  | "http"
  | "mqtt"
  | "pubsub"
  | "serial"
  | "grpc"
  | "sniffer"
  | "modbus";

export type ProtocolTabStatus = "open" | "closed" | "disabled";

/** 用户可在设置中开关的协议 */
export type ControllableProtocolTabKey = "http" | "mqtt" | "pubsub";

export const ALL_PROTOCOL_TABS: ProtocolTabKey[] = [
  "http",
  "mqtt",
  "pubsub",
  "serial",
  "grpc",
  "sniffer",
  "modbus",
];

export const CONTROLLABLE_PROTOCOL_TABS: ControllableProtocolTabKey[] = [
  "http",
  "mqtt",
  "pubsub",
];

/** 开发中、暂不可启用的协议 */
export const DEV_LOCKED_PROTOCOL_TABS: ProtocolTabKey[] = ["serial", "grpc", "modbus"];

/** 始终显示、不受设置控制的协议 */
export const ALWAYS_VISIBLE_PROTOCOL_TABS: ProtocolTabKey[] = ["sniffer"];

export const DEFAULT_CONTROLLABLE_PROTOCOL_STATUS: Record<
  ControllableProtocolTabKey,
  "open" | "closed"
> = {
  http: "open",
  mqtt: "open",
  pubsub: "open",
};

export function isDevLockedProtocolTab(key: ProtocolTabKey): boolean {
  return DEV_LOCKED_PROTOCOL_TABS.includes(key);
}

export function isAlwaysVisibleProtocolTab(key: ProtocolTabKey): boolean {
  return ALWAYS_VISIBLE_PROTOCOL_TABS.includes(key);
}

export function resolveProtocolTabStatus(
  key: ProtocolTabKey,
  userStatus: Record<ControllableProtocolTabKey, "open" | "closed">,
): ProtocolTabStatus {
  if (isDevLockedProtocolTab(key)) {
    return "disabled";
  }
  if (isAlwaysVisibleProtocolTab(key)) {
    return "open";
  }
  return userStatus[key as ControllableProtocolTabKey] ?? "open";
}

export function getVisibleProtocolTabs(
  userStatus: Record<ControllableProtocolTabKey, "open" | "closed">,
): ProtocolTabKey[] {
  return ALL_PROTOCOL_TABS.filter(
    (key) => resolveProtocolTabStatus(key, userStatus) === "open",
  );
}

export function isSupportedProtocolTabKey(value: string): value is ProtocolTabKey {
  return ALL_PROTOCOL_TABS.includes(value as ProtocolTabKey);
}

export function normalizeControllableProtocolStatus(
  raw: Partial<Record<ControllableProtocolTabKey, "open" | "closed">> | undefined,
): Record<ControllableProtocolTabKey, "open" | "closed"> {
  return {
    http: raw?.http === "closed" ? "closed" : "open",
    mqtt: raw?.mqtt === "closed" ? "closed" : "open",
    pubsub: raw?.pubsub === "closed" ? "closed" : "open",
  };
}
