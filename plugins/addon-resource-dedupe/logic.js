// 扫描和合并都在宿主里做。插件只把计划传进去，拿回分组和清理结果。
globalThis.call = function (method, argsJson) {
  if (method === "scan") return host.resourcesScan();
  if (method === "apply") return host.resourcesApply(argsJson || "{}");
  throw new Error("未知方法: " + method);
};
