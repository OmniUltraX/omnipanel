function asObj(v) {
  if (v && typeof v === "object") return v;
  try {
    return JSON.parse(String(v || "{}"));
  } catch (e) {
    return {};
  }
}

function testConnection(args) {
  var host = String(args.host || "127.0.0.1");
  var port = Number(args.port || 8080);
  return {
    ok: true,
    dialect: "auto",
    auth: args.username ? "basic" : "none",
    host: host,
    port: port,
  };
}

function getServerInfo(args) {
  return testConnection(args);
}

function probeHealth(args) {
  try {
    return testConnection(args);
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

function listConfigs() {
  return { items: [] };
}

function getConfig(args) {
  return { dataId: args.dataId || "", content: "" };
}

var HANDLERS = {
  testConnection: testConnection,
  getServerInfo: getServerInfo,
  probeHealth: probeHealth,
  listConfigs: listConfigs,
  getConfig: getConfig,
};

function call(method, argsJson) {
  var handler = HANDLERS[String(method || "")];
  if (!handler) throw new Error("UnknownMethod: " + method);
  var result = handler(asObj(argsJson));
  return typeof result === "string" ? result : JSON.stringify(result);
}

globalThis.call = call;
