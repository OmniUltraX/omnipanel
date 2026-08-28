/**
 * Warpgate 导入器 L2 逻辑包（QuickJS）。
 *
 * 合同：全局 call(method, argsJson) -> JSON 字符串。
 * 网络走 host.netFetch({url, headers, insecure?})，权限闸 / prod 确认由宿主桥强制。
 *
 * 只打官方 Admin API：
 *   GET {base}/@warpgate/admin/api/targets
 *   GET {base}/@warpgate/admin/api/network/listeners
 * 鉴权：X-Warpgate-Token（并兼容 Authorization: Bearer）。
 * /targets 仅接受带 bastionHost 的夹具，避免误吃任意 JSON。
 *
 * 连接 host 必须是堡垒入口（baseUrl 主机名），内网 IP 只作展示，不写入候选。
 * 密码只来自登录密码（或 passwordKey），绝不回落到 API Token。
 */

function authHeaders(token) {
  var headers = { Accept: "application/json" };
  if (token) {
    headers["X-Warpgate-Token"] = token;
    headers.Authorization = "Bearer " + token;
  }
  return headers;
}

function isTrue(value) {
  return value === true || value === "true" || value === 1 || value === "1";
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

function hostFromBase(baseUrl) {
  var after = String(baseUrl || "").replace(/^https?:\/\//i, "");
  var hostPort = after.split("/")[0] || "";
  if (hostPort.charAt(0) === "[") {
    var end = hostPort.indexOf("]");
    return end > 0 ? hostPort.slice(1, end) : hostPort;
  }
  return hostPort.split(":")[0];
}

function portFromAddress(address) {
  var s = String(address || "");
  var i = s.lastIndexOf(":");
  if (i < 0) return 0;
  var n = Number(s.slice(i + 1));
  return n > 0 ? n : 0;
}

function defaultPort(kind) {
  if (kind === "ssh") return 2222;
  if (kind === "mysql") return 33306;
  if (kind === "postgres") return 55432;
  return 0;
}

function parseKind(raw) {
  var k = String(raw || "").toLowerCase();
  if (k === "ssh" || k === "s") return "ssh";
  if (k === "mysql" || k === "mariadb") return "mysql";
  if (k === "postgres" || k === "postgresql") return "postgres";
  return null;
}

function fetchJson(url, headers, insecure) {
  var body = host.netFetch(
    JSON.stringify({ url: url, headers: headers, insecure: insecure === true }),
  );
  try {
    return JSON.parse(body);
  } catch (e) {
    throw new Error("Warpgate 返回非 JSON（请确认地址指向 Warpgate HTTP API）");
  }
}

function asList(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.targets)) return parsed.targets;
  return null;
}

function isFixtureItem(item) {
  return !!(item && typeof item === "object" && item.bastionHost && item.kind);
}

function fetchTargetsList(baseUrl, headers, insecure) {
  try {
    var admin = asList(fetchJson(baseUrl + "/@warpgate/admin/api/targets", headers, insecure));
    if (admin) return admin;
  } catch (e) {
    var adminErr = String(e && e.message ? e.message : e);
    try {
      var raw = asList(fetchJson(baseUrl + "/targets", headers, insecure));
      var fixtures = [];
      if (raw) {
        for (var i = 0; i < raw.length; i++) {
          if (isFixtureItem(raw[i])) fixtures.push(raw[i]);
        }
      }
      if (fixtures.length > 0) return fixtures;
    } catch (e2) {
      throw new Error(adminErr);
    }
    throw new Error(adminErr);
  }
  throw new Error("无法拉取目标列表");
}

function fetchListenerPorts(baseUrl, headers, insecure) {
  var ports = {};
  try {
    var listeners = fetchJson(baseUrl + "/@warpgate/admin/api/network/listeners", headers, insecure);
    if (!Array.isArray(listeners)) return ports;
    for (var i = 0; i < listeners.length; i++) {
      var name = String((listeners[i] && listeners[i].name) || "").toLowerCase();
      var port = portFromAddress(listeners[i] && listeners[i].address);
      if (!port) continue;
      if (name.indexOf("ssh") >= 0) ports.ssh = port;
      else if (name.indexOf("mysql") >= 0 || name.indexOf("mariadb") >= 0) ports.mysql = port;
      else if (name.indexOf("postgres") >= 0) ports.postgres = port;
    }
  } catch (e) {
    /* 监听端口失败时用默认值 */
  }
  return ports;
}

function protocolUser(loginUser, targetName, kind) {
  var user = String(loginUser || "").trim();
  var target = String(targetName || "").trim();
  if (user && (user.indexOf(":") >= 0 || user.indexOf("#") >= 0)) {
    return user;
  }
  if (user && target) {
    return kind === "mysql" || kind === "postgres" ? user + "#" + target : user + ":" + target;
  }
  return user || target;
}

function fetchLoginUser(baseUrl, headers, insecure) {
  var urls = [baseUrl + "/@warpgate/api/info", baseUrl + "/@warpgate/admin/api/info"];
  for (var i = 0; i < urls.length; i++) {
    try {
      var info = fetchJson(urls[i], headers, insecure);
      var user =
        (info && (info.username || info.user)) ||
        (info && info.user_info && info.user_info.username);
      if (user) return String(user);
    } catch (e) {
      /* 继续试下一个 */
    }
  }
  return "";
}

function skippedEntry(raw) {
  var options = raw && raw.options && typeof raw.options === "object" ? raw.options : raw || {};
  return {
    name: String((raw && raw.name) || (raw && raw.id) || ""),
    kind: String(options.kind || (raw && raw.kind) || (raw && raw.protocol) || "unknown"),
  };
}

globalThis.call = function (method, argsJson) {
  if (method !== "fetchTargets") {
    throw new Error("未知方法: " + method);
  }
  var args = {};
  try {
    args = JSON.parse(argsJson || "{}");
  } catch (e) {
    throw new Error("args 非法 JSON");
  }
  var baseUrl = String(args.baseUrl || "").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(baseUrl)) {
    throw new Error("baseUrl 必须以 http(s):// 开头");
  }
  var token = readSecret(args.token, args.tokenKey);
  if (!token) {
    throw new Error("请填写 API Token");
  }
  var password = readSecret(args.password, args.passwordKey);
  var insecure = isTrue(args.insecureTls) || isTrue(args.insecure);
  var pluginId = String(args.pluginId || "omni.importer.warpgate").trim() || "omni.importer.warpgate";
  var accountId = String(args.accountId || args.sourceId || "").trim() || undefined;
  var headers = authHeaders(token);
  var bastionHost = hostFromBase(baseUrl);
  if (!bastionHost) {
    throw new Error("无法从 baseUrl 解析堡垒主机");
  }
  var loginUser = String(args.loginUser || "").trim() || fetchLoginUser(baseUrl, headers, insecure);
  var ports = fetchListenerPorts(baseUrl, headers, insecure);
  var rawList = fetchTargetsList(baseUrl, headers, insecure);
  var targets = [];
  var skipped = [];

  function mapTarget(target) {
    var config = {
      host: target.bastionHost,
      port: target.bastionPort,
      user: protocolUser(target.loginUser, target.name, target.kind),
      via: "warpgate-bastion",
    };
    if (target.password) config.password = target.password;
    return {
      pluginId: pluginId,
      accountId: accountId,
      remoteId: String(target.id),
      remoteKind: target.kind,
      name: target.name,
      config: config,
    };
  }

  function normalizeTarget(raw) {
    if (!raw || typeof raw !== "object") return null;
    if (raw.bastionHost && raw.kind) {
      var fixtureKind = parseKind(raw.kind);
      if (!fixtureKind) return null;
      return mapTarget({
        id: raw.id,
        name: raw.name || String(raw.id),
        kind: fixtureKind,
        bastionHost: raw.bastionHost,
        bastionPort: Number(raw.bastionPort) || defaultPort(fixtureKind),
        loginUser: raw.loginUser || raw.username || loginUser,
        password: raw.password || password,
      });
    }
    var options = raw.options && typeof raw.options === "object" ? raw.options : raw;
    var kind = parseKind(options.kind || raw.kind || options.protocol);
    if (!kind) return null;
    return mapTarget({
      id: raw.id || raw.name,
      name: raw.name || String(raw.id || ""),
      kind: kind,
      bastionHost: bastionHost,
      bastionPort: ports[kind] || defaultPort(kind),
      loginUser: raw.loginUser || loginUser,
      password: password,
    });
  }

  for (var i = 0; i < rawList.length; i++) {
    var mapped = normalizeTarget(rawList[i]);
    if (mapped) targets.push(mapped);
    else if (rawList[i] && typeof rawList[i] === "object") skipped.push(skippedEntry(rawList[i]));
  }
  return JSON.stringify({
    targets: targets,
    skipped: skipped,
    loginUser: loginUser,
    fetchedAt: Date.now(),
  });
};
