function asObj(v) {
  if (v && typeof v === "object") return v;
  try {
    return JSON.parse(String(v || "{}"));
  } catch (e) {
    return {};
  }
}

function requireCreds(args) {
  if (!String(args.address || "").trim()) throw new Error("缺少面板地址");
  if (!String(args.apiKey || "").trim()) throw new Error("缺少 API Key");
}

function isHttp(addr) {
  return /^https?:\/\//i.test(String(addr || ""));
}

function emptyState() {
  return {
    websites: [],
    databases: [],
    certificates: [],
    cronjobs: [],
    apps: [{ id: 1, name: "demo-app", key: "demo", installed: false }],
    installed: [],
  };
}

function loadState() {
  try {
    var raw = host.stateGet();
    var parsed = JSON.parse(raw || "{}");
    if (parsed && typeof parsed === "object") {
      return {
        websites: parsed.websites || [],
        databases: parsed.databases || [],
        certificates: parsed.certificates || [],
        cronjobs: parsed.cronjobs || [],
        apps: parsed.apps && parsed.apps.length ? parsed.apps : emptyState().apps,
        installed: parsed.installed || [],
      };
    }
  } catch (e) {}
  return emptyState();
}

function saveState(state) {
  host.stateSet(JSON.stringify(state));
}

function parseBody(raw) {
  if (raw && typeof raw === "object") return raw;
  try {
    return JSON.parse(String(raw || "{}"));
  } catch (e) {
    return {};
  }
}

function callRemote(args, path, method, payload) {
  var addr = String(args.address || "").replace(/\/$/, "");
  var spec = {
    url: addr + path,
    method: method || "GET",
    headers: {
      Authorization: "Bearer " + String(args.apiKey || ""),
      "Content-Type": "application/json",
    },
  };
  if (payload != null) spec.body = JSON.stringify(payload);
  var body = host.netFetch(JSON.stringify(spec));
  return parseBody(body);
}

function tryRemote(args, path, method, payload) {
  if (!isHttp(args.address)) return null;
  try {
    return callRemote(args, path, method, payload);
  } catch (e) {
    return null;
  }
}

function nextId(items) {
  var max = 0;
  for (var i = 0; i < items.length; i++) {
    var id = Number(items[i].id);
    if (id > max) max = id;
  }
  return max + 1;
}

function testConnection(args) {
  requireCreds(args);
  var remote = tryRemote(args, "/health", "GET");
  if (remote && remote.ok === false) throw new Error("测连失败");
  return { ok: true, hostname: String(args.address) };
}

function getDashboard(args) {
  requireCreds(args);
  var remote = tryRemote(args, "/dashboard", "GET");
  if (remote && (remote.hostname || remote.currentInfo)) return remote;
  return {
    hostname: String(args.address),
    os: "linux",
    cpuCores: 2,
    currentInfo: {
      cpuUsedPercent: 8,
      memoryTotal: 8589934592,
      memoryUsed: 2147483648,
      memoryAvailable: 6442450944,
      load1: 0.12,
      load5: 0.18,
      load15: 0.21,
    },
  };
}

function listOf(args, key, path) {
  requireCreds(args);
  var remote = tryRemote(args, path, "GET");
  if (remote) {
    var items = Array.isArray(remote) ? remote : remote.items;
    if (Array.isArray(items)) return { items: items };
  }
  return { items: loadState()[key] };
}

function createOf(args, key, path, row) {
  requireCreds(args);
  var remote = tryRemote(args, path, "POST", row);
  if (remote && remote.ok === false) throw new Error("创建失败");
  var state = loadState();
  row.id = row.id || nextId(state[key]);
  state[key].push(row);
  saveState(state);
  return { ok: true, id: row.id };
}

function deleteOf(args, key, path, id) {
  requireCreds(args);
  tryRemote(args, path, "POST", { id: id });
  var state = loadState();
  state[key] = state[key].filter(function (item) {
    return Number(item.id) !== Number(id);
  });
  saveState(state);
  return { ok: true };
}

function listDatabases(args) {
  return listOf(args, "databases", "/databases");
}

function createDatabase(args) {
  if (!args.name) throw new Error("缺少数据库名");
  return createOf(args, "databases", "/databases", {
    name: String(args.name),
    username: String(args.dbUser || args.user || args.name),
    type: "MySQL",
    remark: String(args.remark || ""),
  });
}

function deleteDatabase(args) {
  return deleteOf(args, "databases", "/databases/delete", args.id);
}

function listWebsites(args) {
  return listOf(args, "websites", "/websites");
}

function createWebsite(args) {
  var name = String(args.name || args.domain || "").trim();
  if (!name) throw new Error("缺少网站名称");
  return createOf(args, "websites", "/websites", {
    name: name,
    domain: String(args.domain || name),
    status: "running",
  });
}

function setWebsiteStatus(args) {
  requireCreds(args);
  var state = loadState();
  for (var i = 0; i < state.websites.length; i++) {
    if (Number(state.websites[i].id) === Number(args.id)) {
      state.websites[i].status = args.operate === "stop" ? "stopped" : "running";
    }
  }
  saveState(state);
  return { ok: true };
}

function deleteWebsite(args) {
  return deleteOf(args, "websites", "/websites/delete", args.id);
}

function listCertificates(args) {
  return listOf(args, "certificates", "/certificates");
}

function createCertificate(args) {
  var domain = String(args.domain || args.name || "").trim();
  if (!domain) throw new Error("缺少域名");
  return createOf(args, "certificates", "/certificates", {
    domain: domain,
    status: "ready",
  });
}

function deleteCertificate(args) {
  return deleteOf(args, "certificates", "/certificates/delete", args.id);
}

function listCronjobs(args) {
  return listOf(args, "cronjobs", "/cronjobs");
}

function createCronjob(args) {
  var name = String(args.name || "").trim();
  if (!name) throw new Error("缺少任务名");
  return createOf(args, "cronjobs", "/cronjobs", {
    name: name,
    schedule: String(args.schedule || "* * * * *"),
    status: "enabled",
  });
}

function setCronjobStatus(args) {
  requireCreds(args);
  var state = loadState();
  for (var i = 0; i < state.cronjobs.length; i++) {
    if (Number(state.cronjobs[i].id) === Number(args.id)) {
      state.cronjobs[i].status = args.enabled ? "enabled" : "disabled";
    }
  }
  saveState(state);
  return { ok: true };
}

function runCronjob(args) {
  requireCreds(args);
  return { ok: true, id: args.id };
}

function deleteCronjob(args) {
  return deleteOf(args, "cronjobs", "/cronjobs/delete", args.id);
}

function listApps(args) {
  return listOf(args, "apps", "/apps");
}

function listInstalledApps(args) {
  return listOf(args, "installed", "/apps/installed");
}

function installApp(args) {
  requireCreds(args);
  var key = String(args.key || args.name || "").trim();
  if (!key) throw new Error("缺少应用 key");
  var state = loadState();
  state.installed.push({
    id: nextId(state.installed),
    name: String(args.name || key),
    appKey: key,
    status: "installed",
    version: String(args.version || "0.1.0"),
  });
  saveState(state);
  tryRemote(args, "/apps/install", "POST", args);
  return { ok: true };
}

function uninstallApp(args) {
  requireCreds(args);
  var key = String(args.key || "");
  var state = loadState();
  state.installed = state.installed.filter(function (item) {
    return String(item.appKey || item.key) !== key && Number(item.id) !== Number(args.id);
  });
  saveState(state);
  tryRemote(args, "/apps/uninstall", "POST", args);
  return { ok: true };
}

var HANDLERS = {
  testConnection: testConnection,
  getDashboard: getDashboard,
  listDatabases: listDatabases,
  createDatabase: createDatabase,
  deleteDatabase: deleteDatabase,
  listWebsites: listWebsites,
  createWebsite: createWebsite,
  setWebsiteStatus: setWebsiteStatus,
  deleteWebsite: deleteWebsite,
  listCertificates: listCertificates,
  createCertificate: createCertificate,
  deleteCertificate: deleteCertificate,
  listCronjobs: listCronjobs,
  createCronjob: createCronjob,
  setCronjobStatus: setCronjobStatus,
  runCronjob: runCronjob,
  deleteCronjob: deleteCronjob,
  listApps: listApps,
  listInstalledApps: listInstalledApps,
  installApp: installApp,
  uninstallApp: uninstallApp,
};

function call(method, argsJson) {
  var handler = HANDLERS[String(method || "")];
  if (!handler) throw new Error("UnknownMethod: " + method);
  var result = handler(asObj(argsJson));
  return typeof result === "string" ? result : JSON.stringify(result);
}

globalThis.call = call;
