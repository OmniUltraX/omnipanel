/**
 * HestiaCP L2（QuickJS）。REST：POST /api/，form-urlencoded。
 * 鉴权：hash=ACCESS_KEY:SECRET_KEY（密钥栏整段填入），或 user + password。
 * 默认自签 TLS → insecure: true。
 */
function asObj(v) {
  if (v && typeof v === "object") return v;
  try {
    return JSON.parse(String(v || "{}"));
  } catch (e) {
    return {};
  }
}

function str(v) {
  return v == null ? "" : String(v).trim();
}

function requireCreds(args) {
  if (!str(args.address)) throw new Error("缺少面板地址");
  if (!str(args.apiKey)) throw new Error("缺少 API 密钥（Access Key:Secret 或登录密码）");
}

function panelUser(args) {
  return str(args.panelUser) || "admin";
}

function looksLikeIpOrLocal(host) {
  var h = String(host || "").replace(/^\[/, "").replace(/\]$/, "");
  if (!h || h.toLowerCase() === "localhost") return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return true;
  if (h.indexOf(":") >= 0) return true;
  return false;
}

function hostHasPort(hostPort) {
  if (!hostPort) return false;
  if (hostPort.charAt(0) === "[") return hostPort.indexOf("]:") >= 0;
  var parts = hostPort.split(":");
  return parts.length === 2 && parts[1] !== "";
}

function normalizeAddress(addr) {
  var s = str(addr).replace(/\/+$/, "");
  if (!s) return s;
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  var scheme = /^https?:\/\//i.exec(s)[0];
  var rest = s.slice(scheme.length);
  var hostPort = rest.split("/")[0];
  if (!hostHasPort(hostPort) && looksLikeIpOrLocal(hostPort)) {
    s = scheme + hostPort + ":8083" + rest.slice(hostPort.length);
  }
  return s.replace(/\/+$/, "");
}

function apiUrl(addr) {
  return normalizeAddress(addr) + "/api/";
}

function encodeForm(fields) {
  var parts = [];
  var keys = Object.keys(fields);
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    if (fields[key] == null) continue;
    parts.push(encodeURIComponent(key) + "=" + encodeURIComponent(String(fields[key])));
  }
  return parts.join("&");
}

function authFields(args) {
  var key = str(args.apiKey);
  if (key.indexOf("hash=") === 0) key = key.slice(5).trim();
  var user = panelUser(args);
  if (key.indexOf(":") >= 0) return { hash: key };
  return { user: user, password: key };
}

function hestiaError(text) {
  var msg = str(text).replace(/\s+/g, " ");
  if (msg.length > 280) msg = msg.slice(0, 280);
  return msg || "Hestia API 调用失败";
}

function parseHestia(body, expectCode) {
  var text = String(body == null ? "" : body).trim();
  if (!text) throw new Error("Hestia 返回空响应");
  if (/<html/i.test(text)) throw new Error("面板未开启 API，或地址不是 /api/ 入口");
  if (expectCode) {
    if (/^0\s*$/.test(text)) return { ok: true };
    throw new Error(hestiaError(text));
  }
  if (text.charAt(0) === "{" || text.charAt(0) === "[") {
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error("Hestia JSON 解析失败");
    }
  }
  throw new Error(hestiaError(text));
}

function apiCall(args, cmd, argv, opts) {
  opts = opts || {};
  var fields = authFields(args);
  fields.cmd = cmd;
  var list = argv || [];
  for (var i = 0; i < list.length; i++) {
    fields["arg" + (i + 1)] = list[i];
  }
  if (opts.returncode) fields.returncode = "yes";
  var spec = {
    url: apiUrl(args.address),
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: encodeForm(fields),
    insecure: true,
  };
  var body = host.netFetch(JSON.stringify(spec));
  return parseHestia(body, opts.returncode === true);
}

function tryApi(args, cmd, argv) {
  try {
    return apiCall(args, cmd, argv || []);
  } catch (e) {
    return null;
  }
}

function writeOk(args, cmd, argv) {
  apiCall(args, cmd, argv || [], { returncode: true });
  return { ok: true };
}

function mapObject(obj, fn) {
  var items = [];
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return items;
  var keys = Object.keys(obj);
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    var row = obj[key];
    items.push(fn(key, row && typeof row === "object" ? row : {}));
  }
  return items;
}

function numericId(s) {
  var h = 0;
  var text = String(s || "");
  for (var i = 0; i < text.length; i++) {
    h = ((h << 5) - h + text.charCodeAt(i)) | 0;
  }
  var n = Math.abs(h);
  return n || 1;
}

function pick(row, keys) {
  for (var i = 0; i < keys.length; i++) {
    var v = row[keys[i]];
    if (v != null && String(v).trim() !== "") return v;
  }
  return "";
}

function yes(v) {
  var s = str(v).toLowerCase();
  return s === "yes" || s === "true" || s === "1";
}

function stripUserPrefix(user, name) {
  var n = str(name);
  var prefix = user + "_";
  if (n.indexOf(prefix) === 0) return n.slice(prefix.length);
  return n;
}

function parseLoad(raw) {
  var text = str(raw).replace(/,/g, " ").replace(/\//g, " ");
  var parts = text.split(/\s+/).filter(Boolean);
  var a = parseFloat(parts[0]);
  var b = parseFloat(parts[1]);
  var c = parseFloat(parts[2]);
  return {
    load1: isFinite(a) ? a : 0,
    load5: isFinite(b) ? b : 0,
    load15: isFinite(c) ? c : 0,
  };
}

function toBytes(raw) {
  var n = Number(raw);
  if (!isFinite(n) || n < 0) return 0;
  if (n > 1e12) return Math.round(n);
  if (n > 1e7) return Math.round(n * 1024);
  return Math.round(n * 1024 * 1024);
}

function parseUptimeSecs(raw) {
  var text = str(raw);
  var n = parseFloat(text);
  if (!isFinite(n) || n < 0) return 0;
  if (text.indexOf(".") >= 0 || n > 10000) return Math.round(n);
  return Math.round(n * 86400);
}

function parseSchedule(raw) {
  var parts = str(raw).split(/\s+/).filter(Boolean);
  if (parts.length < 5) throw new Error("计划格式应为：分 时 日 月 周");
  return {
    min: parts[0],
    hour: parts[1],
    day: parts[2],
    month: parts[3],
    wday: parts[4],
  };
}

function siteNameOf(args) {
  return str(args.siteName || args.domain || args.name || args.hash);
}

function testConnection(args) {
  requireCreds(args);
  var user = panelUser(args);
  var info = tryApi(args, "v-list-sys-info", ["json"]);
  var hostname = "";
  if (info && typeof info === "object") {
    hostname = str(info.HOSTNAME || info.hostname);
  }
  var profile = apiCall(args, "v-list-user", [user, "json"]);
  if (!hostname && profile && typeof profile === "object") {
    hostname = str(profile.NAME || profile.LOGIN || user);
  }
  return { ok: true, hostname: hostname || normalizeAddress(args.address) };
}

function getDashboard(args) {
  requireCreds(args);
  var info = tryApi(args, "v-list-sys-info", ["json"]) || {};
  var mem = tryApi(args, "v-list-sys-memory-status", ["json"]) || {};
  var load = parseLoad(info.LOADAVERAGE || info.LOAD_AVERAGE);
  var memBlock = mem.MEMORY && typeof mem.MEMORY === "object" ? mem.MEMORY : mem;
  var total = toBytes(memBlock.TOTAL || memBlock.total);
  var used = toBytes(memBlock.USED || memBlock.used);
  var available = toBytes(memBlock.AVAILABLE || memBlock.FREE || memBlock.free);
  if (!available && total) available = Math.max(0, total - used);
  var hostname = str(info.HOSTNAME || info.hostname);
  if (!hostname) {
    var profile = tryApi(args, "v-list-user", [panelUser(args), "json"]) || {};
    hostname = str(profile.NAME || args.address);
  }
  return {
    hostname: hostname || normalizeAddress(args.address),
    os: str(info.OS || info.os),
    platformVersion: str(info.VERSION || info.version),
    cpuCores: 1,
    currentInfo: {
      uptime: parseUptimeSecs(info.UPTIME || info.uptime),
      load1: load.load1,
      load5: load.load5,
      load15: load.load15,
      cpuUsedPercent: 0,
      memoryTotal: total,
      memoryUsed: used,
      memoryAvailable: available,
    },
  };
}

function listWebsites(args) {
  requireCreds(args);
  var user = panelUser(args);
  var data = apiCall(args, "v-list-web-domains", [user, "json"]);
  var search = str(args.search).toLowerCase();
  var items = mapObject(data, function (domain, row) {
    var suspended = yes(row.SUSPENDED);
    var sslOn = yes(row.SSL) || yes(row.LETSENCRYPT);
    var item = {
      id: numericId(domain),
      name: domain,
      domain: domain,
      siteName: domain,
      status: suspended ? "stopped" : "running",
      type: str(row.TPL || row.BACKEND || "default"),
      path: "/home/" + user + "/web/" + domain + "/" + (str(row.DOCUMENTROOT) || "public_html"),
      ip: str(row.IP),
      aliases: str(row.ALIAS),
      ssl: sslOn,
      protocol: sslOn ? "HTTPS" : "HTTP",
      letsencrypt: yes(row.LETSENCRYPT),
    };
    return item;
  });
  if (search) {
    items = items.filter(function (item) {
      return String(item.domain).toLowerCase().indexOf(search) >= 0;
    });
  }
  return { items: items };
}

function createWebsite(args) {
  requireCreds(args);
  var domain = str(args.domain || args.name);
  if (!domain) throw new Error("缺少域名");
  var argv = [panelUser(args), domain];
  var ip = str(args.ip);
  if (ip) argv.push(ip);
  return writeOk(args, "v-add-web-domain", argv);
}

function setWebsiteStatus(args) {
  requireCreds(args);
  var domain = siteNameOf(args);
  if (!domain) throw new Error("缺少网站域名");
  var cmd = args.operate === "stop" ? "v-suspend-web-domain" : "v-unsuspend-web-domain";
  return writeOk(args, cmd, [panelUser(args), domain]);
}

function deleteWebsite(args) {
  requireCreds(args);
  var domain = siteNameOf(args);
  if (!domain) throw new Error("缺少网站域名");
  return writeOk(args, "v-delete-web-domain", [panelUser(args), domain]);
}

function listDatabases(args) {
  requireCreds(args);
  var data = apiCall(args, "v-list-databases", [panelUser(args), "json"]);
  return {
    items: mapObject(data, function (key, row) {
      var name = str(row.DATABASE || key);
      return {
        id: numericId(name),
        name: name,
        username: str(row.DBUSER || row.USER || ""),
        type: str(row.TYPE || "mysql"),
        remark: str(row.HOST),
        charset: str(row.CHARSET),
      };
    }),
  };
}

function createDatabase(args) {
  requireCreds(args);
  var user = panelUser(args);
  var name = stripUserPrefix(user, args.name);
  if (!name) throw new Error("缺少数据库名");
  var dbUser = stripUserPrefix(user, args.dbUser || args.user || name);
  var password = str(args.password);
  if (!password) throw new Error("缺少数据库密码");
  var argv = [user, name, dbUser, password];
  var type = str(args.type);
  if (type) argv.push(type);
  return writeOk(args, "v-add-database", argv);
}

function deleteDatabase(args) {
  requireCreds(args);
  var name = str(args.name);
  if (!name) throw new Error("缺少数据库名");
  return writeOk(args, "v-delete-database", [panelUser(args), name]);
}

function listCertificates(args) {
  requireCreds(args);
  var user = panelUser(args);
  var data = apiCall(args, "v-list-web-domains", [user, "json"]);
  var items = [];
  mapObject(data, function (domain, row) {
    if (!yes(row.SSL) && !yes(row.LETSENCRYPT)) return null;
    items.push({
      id: numericId(domain),
      name: domain,
      domain: domain,
      hash: domain,
      status: yes(row.LETSENCRYPT) ? "letsencrypt" : "ssl",
      provider: yes(row.LETSENCRYPT) ? "letsencrypt" : "manual",
    });
    return null;
  });
  return { items: items };
}

function createCertificate(args) {
  requireCreds(args);
  var domain = str(args.domain || args.name);
  if (!domain) throw new Error("缺少域名");
  var argv = [panelUser(args), domain];
  var aliases = str(args.aliases);
  if (aliases) argv.push(aliases);
  return writeOk(args, "v-add-letsencrypt-domain", argv);
}

function deleteCertificate(args) {
  requireCreds(args);
  var domain = str(args.hash || args.domain || args.name || args.siteName);
  if (!domain) throw new Error("缺少证书域名");
  return writeOk(args, "v-delete-web-domain-ssl", [panelUser(args), domain]);
}

function listCronjobs(args) {
  requireCreds(args);
  var data = apiCall(args, "v-list-cron-jobs", [panelUser(args), "json"]);
  return {
    items: mapObject(data, function (key, row) {
      var job = Number(row.JOB || key);
      if (!isFinite(job)) job = numericId(key);
      var cmd = str(row.CMD || row.COMMAND);
      return {
        id: job,
        name: cmd || "cron-" + job,
        schedule: [row.MIN, row.HOUR, row.DAY, row.MONTH, row.WDAY].map(str).join(" "),
        status: yes(row.SUSPENDED) ? "disabled" : "enabled",
        type: "cron",
        command: cmd,
      };
    }),
  };
}

function createCronjob(args) {
  requireCreds(args);
  var command = str(args.command || args.name);
  if (!command) throw new Error("缺少命令");
  var spec = parseSchedule(args.schedule);
  return writeOk(args, "v-add-cron-job", [
    panelUser(args),
    spec.min,
    spec.hour,
    spec.day,
    spec.month,
    spec.wday,
    command,
  ]);
}

function setCronjobStatus(args) {
  requireCreds(args);
  var id = args.id;
  if (id == null || id === "") throw new Error("缺少任务 ID");
  var cmd = args.enabled ? "v-unsuspend-cron-job" : "v-suspend-cron-job";
  return writeOk(args, cmd, [panelUser(args), String(id)]);
}

function deleteCronjob(args) {
  requireCreds(args);
  var id = args.id;
  if (id == null || id === "") throw new Error("缺少任务 ID");
  return writeOk(args, "v-delete-cron-job", [panelUser(args), String(id)]);
}

var HANDLERS = {
  testConnection: testConnection,
  getDashboard: getDashboard,
  listWebsites: listWebsites,
  createWebsite: createWebsite,
  setWebsiteStatus: setWebsiteStatus,
  deleteWebsite: deleteWebsite,
  listDatabases: listDatabases,
  createDatabase: createDatabase,
  deleteDatabase: deleteDatabase,
  listCertificates: listCertificates,
  createCertificate: createCertificate,
  deleteCertificate: deleteCertificate,
  listCronjobs: listCronjobs,
  createCronjob: createCronjob,
  setCronjobStatus: setCronjobStatus,
  deleteCronjob: deleteCronjob,
};

function call(method, argsJson) {
  var handler = HANDLERS[String(method || "")];
  if (!handler) throw new Error("UnknownMethod: " + method);
  var result = handler(asObj(argsJson));
  return typeof result === "string" ? result : JSON.stringify(result);
}

globalThis.call = call;
