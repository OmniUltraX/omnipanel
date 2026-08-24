/**
 * Warpgate 导入器 L2 逻辑包（QuickJS）。
 *
 * 合同：全局 call(method, argsJson) -> JSON 字符串。
 * 能力：host.netFetch({url, headers}) —— 权限闸/prod 确认由宿主桥强制。
 *
 * 堡垒入口规则与 TS 版 mapTargets 一致：连接 host 必须是 Warpgate 入口，
 * 内网 IP 仅作展示，绝不写入候选的连接地址。
 */

function mapTarget(target) {
  return {
    pluginId: "omni.importer.warpgate",
    accountId: undefined,
    remoteId: String(target.id),
    remoteKind: target.kind,
    name: target.name,
    config: {
      host: target.bastionHost,
      port: target.bastionPort,
      user: target.username ?? "",
      via: "warpgate-bastion",
    },
  };
}

globalThis.call = function (method, argsJson) {
  if (method !== "fetchTargets") {
    throw new Error("未知方法: " + method);
  }
  let args = {};
  try {
    args = JSON.parse(argsJson || "{}");
  } catch {
    throw new Error("args 非法 JSON");
  }
  const baseUrl = String(args.baseUrl || "").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(baseUrl)) {
    throw new Error("baseUrl 必须以 http(s):// 开头");
  }
  const token = String(args.token || "");
  const headers = {};
  if (token) {
    headers["Authorization"] = "Bearer " + token;
    headers["Accept"] = "application/json";
  }
  // Warpgate HTTP API：GET /targets（宿主桥负责网络与 prod 确认）
  const body = host.netFetch(JSON.stringify({ url: baseUrl + "/targets", headers }));
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("Warpgate 返回非 JSON（请确认地址指向 Warpgate HTTP API）");
  }
  // 兼容数组或 { targets: [...] } 两种返回形态
  const targets = Array.isArray(parsed) ? parsed : Array.isArray(parsed.targets) ? parsed.targets : [];
  return JSON.stringify({
    targets: targets.map(mapTarget),
    fetchedAt: Date.now(),
  });
};
