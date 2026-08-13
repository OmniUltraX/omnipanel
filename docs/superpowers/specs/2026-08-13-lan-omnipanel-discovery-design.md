# 局域网 OmniPanel 客户端发现（UDP）

## 目标

第一期：扫描当前局域网内其它 OmniPanel 桌面客户端，在弹窗中展示列表（显示名、IP、版本、操作系统）。不建立连接、不传数据、不做配对。

## 非目标

- 连接 / 配对 / 传文件 / 远程控制
- 加密与鉴权
- 跨网段、VPN 穿透、云中继
- 设置里自定义发现端口（第一期用固定候选列表）
- 绕过传输层的 L2/Raw 发包

## 行为约定

| 角色 | 行为 |
|------|------|
| 被扫方 | 应用进程运行期间常驻应答；可被发现 |
| 扫描方 | 仅当「扫描弹窗」处于打开/激活状态时发探测并维护列表；关闭即停止 |

展示字段：设备显示名、IP、OmniPanel 版本、OS（windows / macos / linux）。

## 方案选型

采用**自定义 UDP 广播**（不用 mDNS、不用整网段 HTTP 端口扫描）。

端口冲突策略：主端口 + 短备用列表（见下）。扫描方使用临时端口（`:0`），不占用固定端口。

## 协议与端口

### 端口候选（被扫方按序 bind）

`38451` → `38452` → `38453`

- 绑定到第一个成功的端口，记为 `listenPort`
- 三者皆失败：本机「不可被发现」，打日志；可选非阻断提示；不阻塞应用启动

### 报文（UTF-8 JSON over UDP）

Probe（扫描方 → 广播，发往每个候选端口）：

```json
{ "v": 1, "t": "probe", "id": "<scanner-instance-uuid>" }
```

Announce（被扫方 → 单播回扫描方 UDP 源地址）：

```json
{
  "v": 1,
  "t": "announce",
  "id": "<instance-uuid>",
  "name": "<显示名，默认主机名>",
  "version": "<app semver>",
  "os": "windows" | "macos" | "linux"
}
```

### 规则

- 依赖 `"v"` + `"t"` 识别；未知版本或非法 JSON 丢弃
- 扫描方向 `255.255.255.255` 发 probe；实现允许时同时向本机各网卡广播地址发送
- `instanceId`：安装后持久化（本地配置生成一次），进程重启不变，便于列表稳定去重
- 列表按 `id` 去重 upsert
- 忽略本机 `announce`（`id == 本机 instanceId`）；并过滤源 IP 属于本机地址的包
- IP 取 UDP 包源地址，不信任报文内自报 IP
- 第一期明文，无加密
- responder 三端口皆失败时：`lan_discovery_status.responderOk = false`，扫描弹窗顶部展示非阻断提示

## 生命周期

### Responder（常驻）

1. 应用启动完成后后台启动
2. 按候选端口 bind；失败则降级
3. 收包：合法 `probe` → 向源地址回 `announce`
4. 应用退出关闭 socket
5. 与本机 scanner 使用不同 socket；scanner 不占用候选固定端口

### Scanner（弹窗会话）

1. 打开弹窗 → `start_scan`：bind `:0`，立即发一轮 probe（候选端口 × 广播地址），之后约每 2s 一轮
2. 收到 `announce` → upsert；记录 `lastSeen`
3. `lastSeen` 超过约 6s（约 3 轮未更新）→ 从列表移除
4. 关闭弹窗 → `stop_scan`：停定时器、关临时 socket；清空列表（避免陈旧）

## 后端 API（Tauri）

模块建议名：`lan_discovery`。命令均 `Result<T, OmniError>`，走 specta `commands.*`。

| 命令 | 作用 |
|------|------|
| `lan_discovery_start_scan` | 开始扫描 |
| `lan_discovery_stop_scan` | 停止扫描 |
| `lan_discovery_list_peers` | 返回当前 peers 快照 |
| `lan_discovery_status` | `{ responderOk, listenPort?, error? }` |

App Event：`lan-discovery-peers`  
Payload：`{ peers: [{ id, name, ip, version, os, lastSeen }] }`  
有变更即推送。常量写入 `frontend/src/ipc/events.ts`。

## 前端

- 组件：`LanDiscoveryScanDialog`（基于现有 `Modal`）
  - 打开：`start_scan` + `listen(lan-discovery-peers)`
  - 关闭 / unmount：`stop_scan` + 取消订阅
  - 列表展示 name / ip / version / os；扫描中轻量 loading
  - 空态与 responder 失败时的非阻断提示
- 入口：第一期做成受控弹窗（`open` / `onClose`）；挂载到设置或命令面板可另定
- i18n：中英同步

## 测试

- 单元：报文解析、自过滤、过期移除
- 手工：两台同网；弹窗开/关是否停 probe；占满 38451 时落到 38452 仍能互发现

## 后续可扩展（不在本期）

- 设置开关「允许被发现」
- 可配置端口 / 更长备用列表
- `v: 2` 增加配对 / 能力位
- mDNS 作为补充发现通道
