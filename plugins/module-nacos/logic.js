/**
 * Nacos module L2（QuickJS）。合同：call(method, argsJson) -> JSON。
 * 网络走 host.netFetch({url, headers, method, body, insecure})。
 */
function asObj(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(String(raw));
  } catch (e) {
    return {};
  }
}

function arg(args, key, fallback) {
  var value = args[key];
  if (value === undefined || value === null || value === "") return fallback;
  return value;
}

function readSecret(plain, key) {
  var value = String(plain || "").trim();
  if (value) return value;
  if (!key) return "";
  try {
    return String(host.vaultGet(String(key)) || "").trim();
  } catch (e) {
    return "";
  }
}

function encode(value) {
  return encodeURIComponent(String(value == null ? "" : value));
}

function joinPath(contextPath, path) {
  var ctx = String(contextPath || "/nacos").trim() || "/nacos";
  if (ctx.charAt(0) !== "/") ctx = "/" + ctx;
  if (ctx.length > 1 && ctx.charAt(ctx.length - 1) === "/") ctx = ctx.slice(0, -1);
  var rest = String(path || "");
  if (rest.charAt(0) !== "/") rest = "/" + rest;
  return ctx + rest;
}

function baseUrl(args) {
  var hostName = String(arg(args, "host", "")).trim();
  if (!hostName) throw new Error("缺少 host");
  var port = Number(arg(args, "port", 8848));
  var https = arg(args, "useHttps", false) === true || arg(args, "useHttps", "") === "true";
  return (https ? "https://" : "http://") + hostName + ":" + (port || 8848);
}

function fetchRaw(url, opts) {
  opts = opts || {};
  var spec = {
    url: url,
    headers: opts.headers || {},
    insecure: opts.insecure === true,
  };
  if (opts.method) spec.method = opts.method;
  if (opts.body != null) spec.body = opts.body;
  return host.netFetch(JSON.stringify(spec));
}

function fetchJson(url, opts) {
  var text = fetchRaw(url, opts);
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (e) {
    return { raw: text };
  }
}

function tokenCacheKey(args) {
  return "tok:" + String(arg(args, "connectionId", arg(args, "host", "")));
}

function loadState() {
  try {
    return asObj(host.stateGet());
  } catch (e) {
    return {};
  }
}

function saveState(state) {
  try {
    host.stateSet(JSON.stringify(state));
  } catch (e) {}
}

function cachedToken(args) {
  var state = loadState();
  var row = state[tokenCacheKey(args)];
  if (!row || !row.token) return "";
  if (row.exp && Date.now() > Number(row.exp)) return "";
  return String(row.token);
}

function storeToken(args, token) {
  if (!token) return;
  var state = loadState();
  state[tokenCacheKey(args)] = { token: String(token), exp: Date.now() + 50 * 60 * 1000 };
  saveState(state);
}

function login(args) {
  var username = String(arg(args, "username", "")).trim();
  var password = readSecret(arg(args, "password", ""), arg(args, "passwordKey", ""));
  if (!username && !password) return { auth: "none", token: "" };
  var url = baseUrl(args) + joinPath(arg(args, "contextPath", "/nacos"), "/v1/auth/login");
  var body = "username=" + encode(username) + "&password=" + encode(password);
  var parsed = fetchJson(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body,
    insecure: arg(args, "insecure", false) === true,
  });
  var token = parsed.accessToken || parsed.token || "";
  if (!token) throw new Error(parsed.message || parsed.raw || "登录失败");
  storeToken(args, token);
  return { auth: "token", token: token };
}

function authQuery(args) {
  var token = cachedToken(args);
  if (!token) {
    var logged = login(args);
    token = logged.token;
  }
  return token ? "accessToken=" + encode(token) : "";
}

function withAuth(url, args) {
  var q = authQuery(args);
  if (!q) return url;
  return url + (url.indexOf("?") >= 0 ? "&" : "?") + q;
}

function detectDialect(args, stateJson) {
  var locked = String(arg(args, "dialect", "auto") || "auto").toLowerCase();
  if (locked === "v1" || locked === "v2") return locked;
  var version = "";
  if (stateJson && typeof stateJson === "object") {
    version = String(stateJson.version || stateJson.serverVersion || "");
  }
  if (version.indexOf("1.") === 0) return "v1";
  if (version.indexOf("2.") === 0) return "v2";
  if (version.indexOf("3.") === 0) return "unsupported";
  return "v2";
}

function assertWritable(dialect) {
  if (dialect === "unsupported") {
    throw new Error("不受支持的 Nacos 主版本，已拒绝写入");
  }
}

function tenant(args) {
  return String(arg(args, "namespaceId", "")).trim();
}

function api(args, path, opts) {
  return fetchJson(withAuth(baseUrl(args) + joinPath(arg(args, "contextPath", "/nacos"), path), args), opts);
}

function testConnection(args) {
  var url = baseUrl(args) + joinPath(arg(args, "contextPath", "/nacos"), "/v1/console/server/state");
  var stateJson = {};
  var auth = "none";
  try {
    stateJson = fetchJson(url, { insecure: arg(args, "insecure", false) === true });
  } catch (e) {
    var logged = login(args);
    auth = logged.auth;
    stateJson = api(args, "/v1/console/server/state", {});
  }
  if (arg(args, "username", "") || arg(args, "password", "") || arg(args, "passwordKey", "")) {
    if (auth === "none") {
      try {
        auth = login(args).auth;
      } catch (e2) {
        throw e2;
      }
    }
  }
  var dialect = detectDialect(args, stateJson);
  return {
    ok: true,
    dialect: dialect,
    auth: auth === "none" && !cachedToken(args) ? "none" : "token",
    version: stateJson.version || stateJson.serverVersion || "",
  };
}

function getServerInfo(args) {
  var probed = testConnection(args);
  var nodes = [];
  try {
    nodes = listNodes(args).items || [];
  } catch (e) {
    nodes = [];
  }
  return {
    dialect: probed.dialect,
    auth: probed.auth,
    version: probed.version,
    nodeCount: nodes.length,
    healthyNodes: nodes.filter(function (n) { return n.state === "UP" || n.healthy === true; }).length,
  };
}

function listNamespaces(args) {
  var parsed = api(args, "/v1/console/namespaces", {});
  var rows = parsed.data || parsed.namespaceList || [];
  return {
    items: rows.map(function (row) {
      return {
        namespaceId: row.namespace || "",
        name: row.namespaceShowName || row.namespace || "public",
        description: row.namespaceDesc || "",
        configCount: row.configCount || 0,
      };
    }),
  };
}

function createNamespace(args) {
  assertWritable(detectDialect(args, {}));
  var body =
    "customNamespaceId=" + encode(arg(args, "namespaceId", "")) +
    "&namespaceName=" + encode(arg(args, "name", "")) +
    "&namespaceDesc=" + encode(arg(args, "description", ""));
  return { ok: api(args, "/v1/console/namespaces", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body,
  }) };
}

function updateNamespace(args) {
  assertWritable(detectDialect(args, {}));
  var body =
    "namespace=" + encode(arg(args, "namespaceId", "")) +
    "&namespaceShowName=" + encode(arg(args, "name", "")) +
    "&namespaceDesc=" + encode(arg(args, "description", ""));
  return { ok: api(args, "/v1/console/namespaces", {
    method: "PUT",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body,
  }) };
}

function deleteNamespace(args) {
  assertWritable(detectDialect(args, {}));
  return { ok: api(args, "/v1/console/namespaces?namespaceId=" + encode(arg(args, "namespaceId", "")), {
    method: "DELETE",
  }) };
}

function listConfigs(args) {
  var pageNo = Number(arg(args, "pageNo", 1)) || 1;
  var pageSize = Number(arg(args, "pageSize", 20)) || 20;
  var dataId = String(arg(args, "dataId", arg(args, "keyword", "")));
  var group = String(arg(args, "group", ""));
  var path =
    "/v1/cs/configs?search=blur&dataId=" + encode(dataId) +
    "&group=" + encode(group) +
    "&pageNo=" + pageNo +
    "&pageSize=" + pageSize +
    "&tenant=" + encode(tenant(args));
  var parsed = api(args, path, {});
  var items = parsed.pageItems || parsed.configs || [];
  return {
    items: items.map(function (row) {
      return {
        dataId: row.dataId,
        group: row.group,
        type: row.type || "",
        appName: row.appName || "",
      };
    }),
    total: parsed.totalCount || items.length,
  };
}

function getConfig(args) {
  var path =
    "/v1/cs/configs?dataId=" + encode(arg(args, "dataId", "")) +
    "&group=" + encode(arg(args, "group", "DEFAULT_GROUP")) +
    "&tenant=" + encode(tenant(args));
  var text = fetchRaw(withAuth(baseUrl(args) + joinPath(arg(args, "contextPath", "/nacos"), path), args), {});
  return { content: text == null ? "" : String(text), dataId: arg(args, "dataId", ""), group: arg(args, "group", "") };
}

function publishConfig(args) {
  assertWritable(detectDialect(args, {}));
  var body =
    "dataId=" + encode(arg(args, "dataId", "")) +
    "&group=" + encode(arg(args, "group", "DEFAULT_GROUP")) +
    "&content=" + encode(arg(args, "content", "")) +
    "&tenant=" + encode(tenant(args)) +
    "&type=" + encode(arg(args, "type", "text"));
  var raw = fetchRaw(withAuth(baseUrl(args) + joinPath(arg(args, "contextPath", "/nacos"), "/v1/cs/configs"), args), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body,
  });
  return { ok: String(raw).trim() === "true" || String(raw).indexOf("true") >= 0, raw: String(raw) };
}

function deleteConfig(args) {
  assertWritable(detectDialect(args, {}));
  var path =
    "/v1/cs/configs?dataId=" + encode(arg(args, "dataId", "")) +
    "&group=" + encode(arg(args, "group", "DEFAULT_GROUP")) +
    "&tenant=" + encode(tenant(args));
  var raw = fetchRaw(withAuth(baseUrl(args) + joinPath(arg(args, "contextPath", "/nacos"), path), args), {
    method: "DELETE",
  });
  return { ok: String(raw).trim() === "true" || String(raw).indexOf("true") >= 0 };
}

function listConfigHistory(args) {
  var path =
    "/v1/cs/history?search=accurate&dataId=" + encode(arg(args, "dataId", "")) +
    "&group=" + encode(arg(args, "group", "DEFAULT_GROUP")) +
    "&tenant=" + encode(tenant(args)) +
    "&pageNo=1&pageSize=20";
  var parsed = api(args, path, {});
  var items = parsed.pageItems || parsed.histories || [];
  return {
    items: items.map(function (row) {
      return {
        id: String(row.id || row.nid || ""),
        nid: String(row.nid || row.id || ""),
        lastModified: row.lastModifiedTime || row.modifyTime || "",
        srcUser: row.srcUser || "",
      };
    }),
  };
}

function getConfigHistory(args) {
  var path =
    "/v1/cs/history?dataId=" + encode(arg(args, "dataId", "")) +
    "&group=" + encode(arg(args, "group", "DEFAULT_GROUP")) +
    "&nid=" + encode(arg(args, "nid", "")) +
    "&tenant=" + encode(tenant(args));
  var parsed = api(args, path, {});
  return { content: parsed.content || parsed.data || "", nid: arg(args, "nid", "") };
}

function rollbackConfig(args) {
  var hist = getConfigHistory(args);
  args.content = hist.content;
  return publishConfig(args);
}

function listServices(args) {
  var path =
    "/v1/ns/service/list?pageNo=1&pageSize=100&namespaceId=" + encode(tenant(args));
  var parsed = api(args, path, {});
  var names = parsed.doms || parsed.serviceNames || parsed.serviceList || [];
  if (parsed.services && Array.isArray(parsed.services)) names = parsed.services;
  return {
    items: names.map(function (name) {
      if (typeof name === "string") return { serviceName: name };
      return { serviceName: name.name || name.serviceName || String(name) };
    }),
  };
}

function listInstances(args) {
  var path =
    "/v1/ns/instance/list?serviceName=" + encode(arg(args, "serviceName", "") || arg(args, "parentId", "")) +
    "&namespaceId=" + encode(tenant(args));
  var parsed = api(args, path, {});
  var hosts = parsed.hosts || parsed.instances || [];
  return {
    items: hosts.map(function (row) {
      return {
        ip: row.ip,
        port: row.port,
        healthy: row.healthy === true,
        weight: row.weight,
        enabled: row.enabled !== false,
        instanceId: row.instanceId || (row.ip + ":" + row.port),
      };
    }),
  };
}

function updateInstance(args) {
  assertWritable(detectDialect(args, {}));
  var body =
    "serviceName=" + encode(arg(args, "serviceName", "")) +
    "&ip=" + encode(arg(args, "ip", "")) +
    "&port=" + encode(arg(args, "port", "")) +
    "&namespaceId=" + encode(tenant(args)) +
    "&weight=" + encode(arg(args, "weight", 1)) +
    "&enabled=" + encode(arg(args, "enabled", true));
  var raw = fetchRaw(withAuth(baseUrl(args) + joinPath(arg(args, "contextPath", "/nacos"), "/v1/ns/instance"), args), {
    method: "PUT",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body,
  });
  return { ok: String(raw).trim() === "ok" || String(raw).indexOf("ok") >= 0 || String(raw).indexOf("true") >= 0 };
}

function listNodes(args) {
  try {
    var parsed = api(args, "/v1/ns/operator/metrics", {});
    var nodes = parsed.nodes || parsed.servers || [];
    return {
      items: nodes.map(function (row) {
        if (typeof row === "string") return { address: row, state: "UP", healthy: true };
        return {
          address: row.ip || row.address || row.site || JSON.stringify(row),
          state: row.state || (row.healthy === false ? "DOWN" : "UP"),
          healthy: row.healthy !== false,
        };
      }),
    };
  } catch (e) {
    return { items: [] };
  }
}

function listItems(args) {
  var cap = String(args.capabilityId || "");
  if (cap === "namespace") return listNamespaces(args);
  if (cap === "config") return listConfigs(args);
  if (cap === "discovery") {
    return args.parentId ? listInstances({ ...args, serviceName: args.parentId }) : listServices(args);
  }
  if (cap === "cluster") return listNodes(args);
  return { items: [] };
}

function probeHealth(args) {
  try {
    var probed = testConnection(args);
    return { ok: probed.ok !== false, dialect: probed.dialect, auth: probed.auth, version: probed.version };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

var HANDLERS = {
  testConnection: testConnection,
  getServerInfo: getServerInfo,
  listNamespaces: listNamespaces,
  createNamespace: createNamespace,
  updateNamespace: updateNamespace,
  deleteNamespace: deleteNamespace,
  listConfigs: listConfigs,
  getConfig: getConfig,
  publishConfig: publishConfig,
  deleteConfig: deleteConfig,
  listConfigHistory: listConfigHistory,
  getConfigHistory: getConfigHistory,
  rollbackConfig: rollbackConfig,
  listServices: listServices,
  getService: listInstances,
  listInstances: listInstances,
  updateInstance: updateInstance,
  listNodes: listNodes,
  listItems: listItems,
  probeHealth: probeHealth,
  omni_nacos_list_namespaces: listNamespaces,
  omni_nacos_get_config: getConfig,
  omni_nacos_search_configs: listConfigs,
  omni_nacos_list_services: listServices,
};

function call(method, argsJson) {
  var handler = HANDLERS[String(method || "")];
  if (!handler) throw new Error("UnknownMethod: " + method);
  var result = handler(asObj(argsJson));
  return typeof result === "string" ? result : JSON.stringify(result);
}

globalThis.call = call;
