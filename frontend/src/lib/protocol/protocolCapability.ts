import type { ProtocolTabKey } from "../protocolLabConfig";

/**
 * Protocol Host 合同草图（capability 描述）。
 *
 * 后续 UI 填槽：侧栏 / 面板组件可挂到 `sidebar` / `panel` 槽位；
 * 本刀只定义元数据与可见性，**不**把 ProtocolPanel 改成全动态 switch。
 */
export interface ProtocolCapability {
  /** 与现有 ProtocolTabKey 对齐 */
  id: ProtocolTabKey;
  /** i18n key，如 `protocol.tabs.http` */
  labelKey: string;
  /** 是否允许用户在设置中开关（可控协议） */
  controllable?: boolean;
  /** 默认是否启用（可控协议的默认 open） */
  enabledByDefault?: boolean;
  /** 开发中锁定：可见但不可启用 */
  devLocked?: boolean;
  /** 始终显示，不受用户设置控制 */
  alwaysVisible?: boolean;
  /**
   * 侧栏槽位（草图）：后续可挂 React 组件 key / 懒加载路径。
   * 当前仅占位，不接真实渲染。
   */
  sidebar?: string;
  /**
   * 主面板槽位（草图）：同上。
   */
  panel?: string;
}
