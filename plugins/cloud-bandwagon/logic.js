/**
 * 搬瓦工 L2（QuickJS）。KiwiVM API，veid + api_key 鉴权，网络走 host.netFetch。
 * Plugin id: omni.cloud.bandwagon
 */
var PLUGIN_ID = "omni.cloud.bandwagon";
var API_BASE = "https://api.64clouds.com/v1/";

var MANIFEST_REGIONS = [
  { regionId: "losangeles", localName: "洛杉矶" },
  { regionId: "fremont", localName: "弗里蒙特" },
  { regionId: "sanjose", localName: "圣何塞" },
  { regionId: "seattle", localName: "西雅图" },
  { regionId: "newyork", localName: "纽约" },
  { regionId: "newjersey", localName: "新泽西" },
  { regionId: "vancouver", localName: "温哥华" },
  { regionId: "toronto", localName: "多伦多" },
  { regionId: "amsterdam", localName: "阿姆斯特丹" },
  { regionId: "london", localName: "伦敦" },
  { regionId: "frankfurt", localName: "法兰克福" },
  { regionId: "hongkong", localName: "香港" },
  { regionId: "tokyo", localName: "东京" },
  { regionId: "singapore", localName: "新加坡" },
  { regionId: "sydney", localName: "悉尼" },
  { regionId: "dubai", localName: "迪拜" },
  { regionId: "miami", localName: "迈阿密" },
  { regionId: "atlanta", localName: "亚特兰大" },
  { regionId: "dallas", localName: "达拉斯" },
  { regionId: "chicago", localName: "芝加哥" },
];

var LOCATION_RULES = [
  { id: "losangeles", keys: ["los angeles", "la dc", "us, california"] },
  { id: "fremont", keys: ["fremont"] },
  { id: "sanjose", keys: ["san jose"] },
  { id: "seattle", keys: ["seattle"] },
  { id: "newyork", keys: ["new york", "nyc"] },
  { id: "newjersey", keys: ["new jersey", "us, new jersey"] },
  { id: "vancouver", keys: ["vancouver"] },
  { id: "toronto", keys: ["toronto"] },
  { id: "amsterdam", keys: ["amsterdam", "netherlands"] },
  { id: "london", keys: ["london", "united kingdom", "uk"] },
  { id: "frankfurt", keys: ["frankfurt", "germany"] },
  { id: "hongkong", keys: ["hong kong", "hongkong"] },
  { id: "tokyo", keys: ["tokyo", "japan"] },
  { id: "singapore", keys: ["singapore"] },
  { id: "sydney", keys: ["sydney", "australia"] },
  { id: "dubai", keys: ["dubai", "uae"] },
  { id: "miami", keys: ["miami", "florida"] },
  { id: "atlanta", keys: ["atlanta"] },
  { id: "dallas", keys: ["dallas"] },
  { id: "chicago", keys: ["chicago"] },
];

function asObj(v) {
  if (v && typeof v === "object") return v;
  try {
    return JSON.parse(String(v || "{}"));
  } catch (e) {
    return {};
  }
}

function str(v) {
  if (v == null) return "";
  return String(v);
}

function jstr(v, keys) {
  if (!v || typeof v !== "object") return "";
  for (var i = 0; i < keys.length; i++) {
    var x = v[keys[i]];
    if (x == null) continue;
    if (typeof x === "string" || typeof x === "number" || typeof x === "boolean") return String(x);
  }
  return "";
}

function jarr(v, keys) {
  if (!v || typeof v !== "object") return [];
  for (var i = 0; i < keys.length; i++) {
    var x = v[keys[i]];
    if (Array.isArray(x)) return x;
  }
  return [];
}

function uniqueIds(ids) {
  var out = [];
  var seen = {};
  for (var i = 0; i < ids.length; i++) {
    var id = str(ids[i]).trim();
    if (!id || seen[id]) continue;
    seen[id] = true;
    out.push(id);
  }
  return out;
}

function credsOf(args) {
  var raw = args.credentials || args.creds || args;
  var id = str(raw.accessKeyId || raw.veid || args.accessKeyId).trim();
  var secret = str(raw.accessKeySecret || raw.apiKey || args.accessKeySecret).trim();
  if (!id) throw new Error("缺少 VEID（accessKeyId）");
  if (!secret) throw new Error("缺少 API Key（accessKeySecret）");
  var regions = raw.regions || args.regions || [];
  if (!Array.isArray(regions)) regions = [];
  return { accessKeyId: id, accessKeySecret: secret, regions: regions };
}

function allVeids(creds) {
  var ids = [];
  var parts = str(creds.accessKeyId).split(",");
  for (var i = 0; i < parts.length; i++) {
    var v = str(parts[i]).trim();
    if (v) ids.push(v);
  }
  var extra = creds.regions || [];
  for (var j = 0; j < extra.length; j++) {
    var e = str(extra[j]).trim();
    if (e) ids.push(e);
  }
  return uniqueIds(ids);
}

function buildQuery(query) {
  query = query && typeof query === "object" ? query : {};
  var keys = [];
  for (var k in query) {
    if (!Object.prototype.hasOwnProperty.call(query, k)) continue;
    if (query[k] == null || str(query[k]) === "") continue;
    keys.push(k);
  }
  keys.sort();
  var parts = [];
  for (var i = 0; i < keys.length; i++) {
    parts.push(encodeURIComponent(keys[i]) + "=" + encodeURIComponent(str(query[keys[i]])));
  }
  return parts.join("&");
}

function parseBwError(body, action) {
  if (!body || typeof body !== "object") return null;
  var err = body.error;
  if (err == null || err === 0 || err === "0") return null;
  var msg = jstr(body, ["message", "msg"]);
  if (!msg) msg = "错误码 " + err;
  return { code: String(err), message: msg };
}

function bwRequest(creds, veid, method, action, extraQuery) {
  method = str(method || "GET").toUpperCase();
  var query = { veid: veid, api_key: creds.accessKeySecret };
  extraQuery = extraQuery && typeof extraQuery === "object" ? extraQuery : {};
  for (var k in extraQuery) {
    if (!Object.prototype.hasOwnProperty.call(extraQuery, k)) continue;
    if (extraQuery[k] == null || str(extraQuery[k]) === "") continue;
    query[k] = extraQuery[k];
  }
  var url = API_BASE + action;
  var qs = buildQuery(query);
  if (qs) url += "?" + qs;
  var spec = { url: url, method: method, headers: { Accept: "application/json" } };
  var text = host.netFetch(JSON.stringify(spec));
  if (!text) return {};
  var trimmed = str(text).replace(/^\s+/, "");
  if (trimmed.charAt(0) !== "{" && trimmed.charAt(0) !== "[") {
    throw new Error("搬瓦工 " + action + " 响应非 JSON");
  }
  var parsed = {};
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error("搬瓦工 " + action + " 响应无法解析");
  }
  var apiErr = parseBwError(parsed, action);
  if (apiErr) {
    throw new Error("搬瓦工 " + action + " 失败: " + (apiErr.code ? apiErr.code + " " : "") + apiErr.message);
  }
  return parsed;
}

function bwGet(creds, veid, action) {
  return bwRequest(creds, veid, "GET", action, null);
}

function bwPost(creds, veid, action) {
  return bwRequest(creds, veid, "POST", action, null);
}

function mapLocation(nodeLocation) {
  var loc = str(nodeLocation).trim().toLowerCase();
  if (!loc) return "";
  for (var i = 0; i < LOCATION_RULES.length; i++) {
    var rule = LOCATION_RULES[i];
    for (var j = 0; j < rule.keys.length; j++) {
      if (loc.indexOf(rule.keys[j]) >= 0) return rule.id;
    }
  }
  return "";
}

function regionLabel(regionId) {
  for (var i = 0; i < MANIFEST_REGIONS.length; i++) {
    if (MANIFEST_REGIONS[i].regionId === regionId) return MANIFEST_REGIONS[i].localName;
  }
  return regionId;
}

function joinIps(list) {
  if (!Array.isArray(list)) return "";
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var ip = str(list[i]).trim();
    if (ip) out.push(ip);
  }
  return out.join(",");
}

function mapStatus(info) {
  if (info && (info.suspended === 1 || info.suspended === "1" || info.suspended === true)) {
    return "SUSPENDED";
  }
  var raw = jstr(info, ["ve_status", "vz_status"]);
  if (!raw && info && info.vz_status && typeof info.vz_status === "object") {
    raw = jstr(info.vz_status, ["status", "state"]);
  }
  var u = str(raw).trim().toLowerCase();
  if (u === "running" || u === "online") return "RUNNING";
  if (u === "stopped" || u === "off" || u === "shutdown") return "STOPPED";
  if (u === "starting" || u === "pending") return "PENDING";
  if (u === "rebooting" || u === "restarting") return "REBOOTING";
  if (u === "error" || u === "failed") return "ERROR";
  return str(raw).trim() || "UNKNOWN";
}

function fieldMap(pairs) {
  var out = {};
  for (var i = 0; i < pairs.length; i++) {
    var k = pairs[i][0];
    var v = str(pairs[i][1]).trim();
    if (v) out[k] = v;
  }
  return out;
}

function displayName(name, fallback) {
  return str(name).trim() ? str(name).trim() : fallback;
}

function mapService(veid, info) {
  var regionId = mapLocation(jstr(info, ["node_location"]));
  var publicIp = joinIps(jarr(info, ["ip_addresses"]));
  var privateIp = joinIps(jarr(info, ["private_ip_addresses"]));
  var hostname = jstr(info, ["hostname", "live_hostname"]);
  return {
    id: veid,
    name: displayName(hostname, "VEID-" + veid),
    capability: "compute",
    regionId: regionId,
    status: mapStatus(info),
    fields: fieldMap([
      ["region", regionId ? regionLabel(regionId) : jstr(info, ["node_location"])],
      ["publicIp", publicIp],
      ["privateIp", privateIp],
      ["os", jstr(info, ["os"])],
      ["plan", jstr(info, ["plan"])],
      ["nodeAlias", jstr(info, ["node_alias"])],
      ["nodeLocation", jstr(info, ["node_location"])],
      ["vmType", jstr(info, ["vm_type"])],
      ["email", jstr(info, ["email"])],
      ["sshPort", jstr(info, ["ssh_port"])],
    ]),
  };
}

function fromRow(row, consoleUrl) {
  return {
    id: row.id,
    name: row.name,
    capability: row.capability,
    regionId: row.regionId || "",
    status: row.status || "",
    fields: row.fields || {},
    extra: null,
    consoleUrl: consoleUrl || null,
    related: [],
    rules: [],
    metricIds: [],
    logKinds: [],
    children: [],
  };
}

function applyFilter(rows, filter) {
  filter = filter || {};
  var status = str(filter.status).trim();
  var query = str(filter.query).trim().toLowerCase();
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (status && str(row.status).toLowerCase() !== status.toLowerCase()) continue;
    if (query) {
      var blob = (str(row.name) + " " + str(row.id) + " " + JSON.stringify(row.fields || {})).toLowerCase();
      if (blob.indexOf(query) < 0) continue;
    }
    out.push(row);
  }
  return out;
}

function filterByRegions(rows, regions) {
  var wanted = uniqueIds(regions || []);
  if (!wanted.length) return rows;
  return rows.filter(function (row) {
    return !row.regionId || wanted.indexOf(row.regionId) >= 0;
  });
}

function firstVeid(creds) {
  var ids = allVeids(creds);
  if (!ids.length) throw new Error("未配置 VEID");
  return ids[0];
}

function testAccount(args) {
  var creds = credsOf(args);
  var veid = firstVeid(creds);
  var info = bwGet(creds, veid, "getServiceInfo");
  var hostname = jstr(info, ["hostname"]);
  var email = jstr(info, ["email"]);
  var plan = jstr(info, ["plan"]);
  var parts = ["VEID " + veid];
  if (hostname) parts.push(hostname);
  if (plan) parts.push(plan);
  if (email) parts.push("(" + email + ")");
  return { message: parts.join(" · ") };
}

function listRegions(args) {
  var configured = args.configured || args.configuredRegions || [];
  var wanted = uniqueIds(configured);
  var regions = [];
  for (var i = 0; i < MANIFEST_REGIONS.length; i++) {
    regions.push({
      regionId: MANIFEST_REGIONS[i].regionId,
      localName: MANIFEST_REGIONS[i].localName,
      capabilities: ["compute"],
    });
  }
  if (wanted.length) {
    var filtered = [];
    var seen = {};
    for (var r = 0; r < regions.length; r++) {
      if (wanted.indexOf(regions[r].regionId) >= 0) {
        filtered.push(regions[r]);
        seen[regions[r].regionId] = true;
      }
    }
    for (var w = 0; w < wanted.length; w++) {
      if (!seen[wanted[w]]) {
        filtered.push({ regionId: wanted[w], localName: regionLabel(wanted[w]), capabilities: ["compute"] });
      }
    }
    regions = filtered;
  }
  return { items: regions };
}

function getAccount(args) {
  var creds = credsOf(args);
  var veid = firstVeid(creds);
  var info = bwGet(creds, veid, "getServiceInfo");
  var email = jstr(info, ["email"]);
  var planMonthly = Number(jstr(info, ["plan_monthly_data"])) || 0;
  var dataUsed = Number(jstr(info, ["data_counter"])) || 0;
  var multiplier = Number(jstr(info, ["monthly_data_multiplier"])) || 1;
  var resetAt = Number(jstr(info, ["data_next_reset"])) || 0;
  return {
    callerId: email || "VEID " + veid,
    arn: jstr(info, ["plan"]),
    currency: "USD",
    availableAmount: planMonthly ? String(Math.max(planMonthly * multiplier - dataUsed * multiplier, 0)) : "",
    cashAmount: dataUsed ? String(dataUsed * multiplier) : "",
    creditAmount: resetAt ? String(resetAt) : "",
    balanceError: null,
  };
}

function listResources(args) {
  var creds = credsOf(args);
  var cap = str(args.capability || "compute").trim();
  if (cap !== "compute") throw new Error("搬瓦工本期未实现能力: " + cap);
  var filter = args.filter || {};
  var veids = allVeids(creds);
  if (!veids.length) throw new Error("未配置 VEID");
  var rows = [];
  var lastErr = null;
  var ok = 0;
  for (var i = 0; i < veids.length; i++) {
    try {
      var info = bwGet(creds, veids[i], "getLiveServiceInfo");
      rows.push(mapService(veids[i], info));
      ok += 1;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!ok && lastErr) throw lastErr;
  rows = filterByRegions(rows, filter.regions || []);
  return { items: applyFilter(rows, filter) };
}

function getResource(args) {
  var creds = credsOf(args);
  var cap = str(args.capability).trim();
  if (cap !== "compute") throw new Error("搬瓦工本期未实现能力: " + cap);
  var id = str(args.resourceId || args.id).trim();
  if (!id) throw new Error("缺少资源 id");
  var info = bwGet(creds, id, "getLiveServiceInfo");
  var row = mapService(id, info);
  return fromRow(row, "https://kiwivm.64clouds.com/" + id + "/");
}

function lifecycleAction(name) {
  var n = str(name).trim().toLowerCase();
  if (n === "start") return "start";
  if (n === "stop") return "stop";
  if (n === "reboot" || n === "restart") return "restart";
  return "";
}

function invokeAction(args) {
  var creds = credsOf(args);
  var action = args.action && typeof args.action === "object" ? args.action : args;
  var name = str(action.name).trim().toLowerCase();
  var id = str(action.resourceId).trim();
  if (!id) throw new Error("缺少资源 id");
  var cap = str(action.capability).trim();
  if (cap !== "compute") throw new Error("不支持的动作: " + cap + "/" + name);
  var apiAction = lifecycleAction(name);
  if (!apiAction) throw new Error("不支持的动作: " + cap + "/" + name);
  bwPost(creds, id, apiAction);
  return { ok: true, message: apiAction + " 已提交" };
}

function getMetrics(args) {
  var cap = str(args.capability).trim();
  throw new Error("搬瓦工该能力不支持监控: " + cap);
}

function queryLogs(args) {
  var query = args.query || {};
  return {
    kind: str(query.kind || "audit"),
    total: 0,
    page: Number(query.page) > 0 ? Number(query.page) : 1,
    entries: [],
  };
}

var HANDLERS = {
  testAccount: testAccount,
  listRegions: listRegions,
  getAccount: getAccount,
  listResources: listResources,
  getResource: getResource,
  invokeAction: invokeAction,
  getMetrics: getMetrics,
  queryLogs: queryLogs,
};

function call(method, argsJson) {
  var handler = HANDLERS[String(method || "")];
  if (!handler) throw new Error("UnknownMethod: " + method);
  var result = handler(asObj(argsJson));
  return typeof result === "string" ? result : JSON.stringify(result);
}

globalThis.call = call;
