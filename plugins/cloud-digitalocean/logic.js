/**
 * DigitalOcean L2（QuickJS）。Bearer Token 鉴权，网络走 host.netFetch。
 * Plugin id: omni.cloud.digitalocean
 */
var PLUGIN_ID = "omni.cloud.digitalocean";
var API_BASE = "https://api.digitalocean.com/v2";
var DEFAULT_REGION = "nyc3";
var PAGE_SIZE = 200;
var PAGE_MAX = 500;

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

function credsOf(args) {
  var raw = args.credentials || args.creds || args;
  var id = str(raw.accessKeyId || raw.label || args.accessKeyId).trim();
  var secret = str(
    raw.accessKeySecret || raw.token || raw.apiToken || args.accessKeySecret || args.token
  ).trim();
  if (!secret) throw new Error("缺少 API Token（accessKeySecret）");
  var regions = raw.regions || args.regions || [];
  if (!Array.isArray(regions)) regions = [];
  var region = str(raw.region || args.region || "").trim();
  return { accessKeyId: id, accessKeySecret: secret, region: region, regions: regions };
}

function regionOfCreds(creds) {
  var r = str(creds.region).trim();
  return r || DEFAULT_REGION;
}

function withRegion(creds, region) {
  return {
    accessKeyId: creds.accessKeyId,
    accessKeySecret: creds.accessKeySecret,
    region: region,
    regions: creds.regions,
  };
}

function uniqueRegions(ids) {
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

function regionsToScan(creds, filter) {
  var listed = uniqueRegions((filter && filter.regions) || []);
  if (listed.length) return listed;
  var configured = uniqueRegions(creds.regions || []);
  if (configured.length) return configured;
  return [regionOfCreds(creds)];
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

function parseDoError(body, path, method) {
  if (!body || typeof body !== "object") return null;
  var msg = jstr(body, ["message"]);
  var id = jstr(body, ["id", "error"]);
  var messages = body.messages;
  if (Array.isArray(messages) && messages.length) {
    var parts = [];
    for (var i = 0; i < messages.length; i++) {
      if (typeof messages[i] === "string") parts.push(messages[i]);
      else parts.push(jstr(messages[i], ["message", "detail", "error"]));
    }
    msg = msg || parts.filter(Boolean).join("; ");
  }
  if (!msg && !id) return null;
  return { code: id, message: msg || id };
}

function doRequest(creds, method, path, query, body) {
  method = str(method || "GET").toUpperCase();
  var url = API_BASE + path;
  var qs = buildQuery(query);
  if (qs) url += "?" + qs;
  var payload = body == null ? "" : typeof body === "string" ? body : JSON.stringify(body);
  var headers = {
    Authorization: "Bearer " + creds.accessKeySecret,
    Accept: "application/json",
  };
  if (payload) headers["Content-Type"] = "application/json";
  var spec = { url: url, method: method, headers: headers };
  if (payload) spec.body = payload;
  var text = host.netFetch(JSON.stringify(spec));
  if (!text) return {};
  var trimmed = str(text).replace(/^\s+/, "");
  if (trimmed.charAt(0) !== "{" && trimmed.charAt(0) !== "[") {
    throw new Error("DigitalOcean " + method + " " + path + " 响应非 JSON");
  }
  var parsed = {};
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error("DigitalOcean " + method + " " + path + " 响应无法解析");
  }
  var err = parseDoError(parsed, path, method);
  if (err) throw new Error("DigitalOcean " + path + " 失败: " + (err.code ? err.code + " " : "") + err.message);
  return parsed;
}

function doGet(creds, path, query) {
  return doRequest(creds, "GET", path, query || {}, null);
}

function doPost(creds, path, body) {
  return doRequest(creds, "POST", path, {}, body);
}

function paginate(creds, path, query, listKey) {
  query = query && typeof query === "object" ? query : {};
  var out = [];
  var page = 1;
  while (true) {
    var q = {};
    for (var k in query) if (Object.prototype.hasOwnProperty.call(query, k)) q[k] = query[k];
    q.page = page;
    q.per_page = PAGE_SIZE;
    var resp = doGet(creds, path, q);
    var items = jarr(resp, [listKey]);
    out = out.concat(items);
    var next = resp.links && resp.links.pages ? jstr(resp.links.pages, ["next"]) : "";
    if (!items.length || items.length < PAGE_SIZE || !next || out.length >= PAGE_MAX) break;
    page += 1;
    if (page > 50) break;
  }
  if (out.length > PAGE_MAX) out.length = PAGE_MAX;
  return out;
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

function mapStatus(raw) {
  var u = str(raw).trim().toLowerCase();
  if (u === "active" || u === "online" || u === "running" || u === "available" || u === "in-use") return "RUNNING";
  if (u === "off" || u === "stopped" || u === "shutdown" || u === "archive") return "STOPPED";
  if (u === "new" || u === "creating" || u === "pending" || u === "building") return "PENDING";
  if (u === "rebooting" || u === "restarting") return "REBOOTING";
  if (u === "error" || u === "failed") return "ERROR";
  return str(raw).trim();
}

function displayName(name, fallback) {
  return str(name).trim() ? str(name).trim() : fallback;
}

function regionSlug(item, fallback) {
  if (item && item.region && typeof item.region === "object") {
    var slug = jstr(item.region, ["slug"]);
    if (slug) return slug;
  }
  return jstr(item, ["region", "region_slug"]) || fallback || "";
}

function dropletIps(droplet) {
  var pub = [];
  var priv = [];
  var nets = droplet && droplet.networks;
  if (nets && typeof nets === "object") {
    var v4 = jarr(nets, ["v4"]);
    for (var i = 0; i < v4.length; i++) {
      var ip = jstr(v4[i], ["ip_address"]);
      if (!ip) continue;
      if (str(v4[i].type).toLowerCase() === "public") pub.push(ip);
      else priv.push(ip);
    }
  }
  return { publicIp: pub.join(","), privateIp: priv.join(",") };
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

function mapDroplet(item, region) {
  var id = jstr(item, ["id"]);
  var ips = dropletIps(item);
  var size = item.size && typeof item.size === "object" ? item.size : {};
  var image = item.image && typeof item.image === "object" ? item.image : {};
  return {
    id: id,
    name: displayName(jstr(item, ["name"]), id),
    capability: "compute",
    regionId: regionSlug(item, region),
    status: mapStatus(jstr(item, ["status"])),
    fields: fieldMap([
      ["publicIp", ips.publicIp],
      ["privateIp", ips.privateIp],
      ["instanceType", jstr(size, ["slug", "description"])],
      ["zone", regionSlug(item, region)],
      ["os", jstr(image, ["distribution", "name"])],
      ["creationTime", jstr(item, ["created_at"])],
      ["vcpu", jstr(size, ["vcpus"])],
      ["memory", jstr(size, ["memory"])],
      ["disk", jstr(size, ["disk"])],
      ["tags", Array.isArray(item.tags) ? item.tags.join(",") : ""],
    ]),
  };
}

function mapLoadBalancer(item, region) {
  var id = jstr(item, ["id"]);
  return {
    id: id,
    name: displayName(jstr(item, ["name"]), id),
    capability: "network.loadBalancer",
    regionId: regionSlug(item, region),
    status: mapStatus(jstr(item, ["status"])),
    fields: fieldMap([
      ["publicIp", jstr(item, ["ip"])],
      ["addressType", jstr(item, ["type"])],
      ["algorithm", jstr(item, ["algorithm"])],
      ["vpcId", jstr(item, ["vpc_uuid"])],
      ["creationTime", jstr(item, ["created_at"])],
    ]),
  };
}

function mapVolume(item, region) {
  var id = jstr(item, ["id"]);
  var dropletIds = Array.isArray(item.droplet_ids) ? item.droplet_ids.join(",") : "";
  return {
    id: id,
    name: displayName(jstr(item, ["name"]), id),
    capability: "storage.disk",
    regionId: regionSlug(item, region),
    status: mapStatus(jstr(item, ["status"])),
    fields: fieldMap([
      ["size", jstr(item, ["size_gigabytes"])],
      ["category", jstr(item, ["filesystem_type"])],
      ["type", jstr(item, ["type"])],
      ["zone", regionSlug(item, region)],
      ["instanceId", dropletIds],
      ["creationTime", jstr(item, ["created_at"])],
    ]),
  };
}

function mapDatabase(item, region) {
  var id = jstr(item, ["id"]);
  var conn = item.connection && typeof item.connection === "object" ? item.connection : {};
  return {
    id: id,
    name: displayName(jstr(item, ["name"]), id),
    capability: "database",
    regionId: regionSlug(item, region),
    status: mapStatus(jstr(item, ["status"])),
    fields: fieldMap([
      ["engine", jstr(item, ["engine"])],
      ["engineVersion", jstr(item, ["version"])],
      ["instanceClass", jstr(item, ["size"])],
      ["storage", jstr(item, ["storage_size_mib"])],
      ["connectionString", jstr(conn, ["host", "uri"])],
      ["port", jstr(conn, ["port"])],
      ["zone", regionSlug(item, region)],
      ["creationTime", jstr(item, ["created_at"])],
    ]),
  };
}

function mapSpace(item) {
  var name = jstr(item, ["name"]);
  var region = jstr(item, ["region", "region_slug"]);
  return {
    id: name,
    name: name,
    capability: "objectStorage",
    regionId: region,
    status: "",
    fields: fieldMap([
      ["creationDate", jstr(item, ["created_at"])],
      ["endpoint", region ? region + ".digitaloceanspaces.com" : "digitaloceanspaces.com"],
      ["location", region],
    ]),
  };
}

function listSpacesBuckets(creds) {
  try {
    var resp = doGet(creds, "/spaces", {});
    var items = jarr(resp, ["spaces", "buckets"]);
    if (items.length) return items;
  } catch (e) {}
  return [];
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
  var wanted = uniqueRegions(regions || []);
  if (!wanted.length) return rows;
  return rows.filter(function (row) {
    return !row.regionId || wanted.indexOf(row.regionId) >= 0;
  });
}

function listRegional(creds, filter, fetch, mapRow) {
  var regions = regionsToScan(creds, filter);
  var out = [];
  var lastErr = null;
  var ok = 0;
  for (var i = 0; i < regions.length; i++) {
    try {
      var items = fetch(withRegion(creds, regions[i]), regions[i]);
      ok += 1;
      for (var k = 0; k < items.length; k++) out.push(mapRow(items[k], regions[i]));
    } catch (e) {
      lastErr = e;
    }
  }
  if (!ok && lastErr) throw lastErr;
  return out;
}

function firstOrThrow(items, id, label) {
  if (!items || !items.length) throw new Error("未找到" + label + ": " + id);
  return items[0];
}

function param(action, key) {
  var params = action.params || {};
  return str(params[key] || action[key] || "").trim();
}

function testAccount(args) {
  var creds = credsOf(args);
  var body = doGet(creds, "/account");
  var acct = body.account || {};
  var email = jstr(acct, ["email"]);
  var status = jstr(acct, ["status"]);
  if (!email && !status) return { message: "凭证有效" };
  if (!email) return { message: "账户状态: " + status };
  return { message: email + (status ? " (" + status + ")" : "") };
}

function listRegions(args) {
  var creds = credsOf(args);
  var configured = args.configured || args.configuredRegions || [];
  var raw = jarr(doGet(creds, "/regions"), ["regions"]);
  var regions = [];
  for (var i = 0; i < raw.length; i++) {
    if (raw[i] && raw[i].available === false) continue;
    var rid = jstr(raw[i], ["slug"]);
    if (!rid) continue;
    regions.push({
      regionId: rid,
      localName: jstr(raw[i], ["name"]),
      capabilities: [],
    });
  }
  var wanted = uniqueRegions(configured);
  if (wanted.length) {
    var filtered = [];
    var seen = {};
    for (var r = 0; r < regions.length; r++) {
      for (var w = 0; w < wanted.length; w++) {
        if (wanted[w] === regions[r].regionId) {
          filtered.push(regions[r]);
          seen[wanted[w]] = true;
        }
      }
    }
    for (w = 0; w < wanted.length; w++) {
      if (!seen[wanted[w]]) {
        filtered.push({ regionId: wanted[w], localName: "", capabilities: [] });
      }
    }
    regions = filtered;
  }
  return { items: regions };
}

function getAccount(args) {
  var creds = credsOf(args);
  var body = doGet(creds, "/account");
  var acct = body.account || {};
  var snap = {
    callerId: jstr(acct, ["email"]),
    arn: jstr(acct, ["status"]),
    currency: "USD",
    availableAmount: "",
    cashAmount: "",
    creditAmount: "",
    balanceError: null,
  };
  try {
    var bal = doGet(creds, "/customers/my/balance");
    snap.availableAmount = jstr(bal, ["account_balance", "month_to_date_balance"]);
    snap.cashAmount = jstr(bal, ["month_to_date_usage"]);
    snap.creditAmount = jstr(acct, ["uuid"]);
  } catch (e) {
    snap.balanceError = String(e.message || e);
    snap.creditAmount = jstr(acct, ["uuid"]);
  }
  return snap;
}

function listDroplets(creds, region) {
  var query = region ? { region: region } : {};
  return paginate(creds, "/droplets", query, "droplets");
}

function listLoadBalancers(creds, region) {
  var query = region ? { region: region } : {};
  return paginate(creds, "/load_balancers", query, "load_balancers");
}

function listVolumes(creds, region) {
  var query = region ? { region: region } : {};
  return paginate(creds, "/volumes", query, "volumes");
}

function listAllRegional(creds, filter, listFn, mapRow) {
  var scan = regionsToScan(creds, filter);
  var configured = uniqueRegions((filter && filter.regions) || creds.regions || []);
  if (configured.length === 1) {
    return listFn(creds, configured[0]).map(function (item) {
      return mapRow(item, configured[0]);
    });
  }
  if (configured.length > 1) {
    return listRegional(creds, filter, listFn, mapRow);
  }
  return listFn(creds, "").map(function (item) {
    return mapRow(item, regionSlug(item, regionOfCreds(creds)));
  }).filter(function (row) {
    return !row.regionId || scan.indexOf(row.regionId) >= 0;
  });
}

function listDatabases(creds) {
  return paginate(creds, "/databases", {}, "databases");
}

function listResources(args) {
  var creds = credsOf(args);
  var cap = str(args.capability || "compute").trim();
  var filter = args.filter || {};
  var rows;
  if (cap === "compute") {
    rows = listAllRegional(creds, filter, listDroplets, mapDroplet);
  } else if (cap === "network.loadBalancer") {
    rows = listAllRegional(creds, filter, listLoadBalancers, mapLoadBalancer);
  } else if (cap === "storage.disk") {
    rows = listAllRegional(creds, filter, listVolumes, mapVolume);
  } else if (cap === "database") {
    rows = listDatabases(creds).map(function (item) {
      return mapDatabase(item, regionSlug(item, regionOfCreds(creds)));
    });
    rows = filterByRegions(rows, filter.regions || creds.regions || []);
  } else if (cap === "objectStorage") {
    rows = listSpacesBuckets(creds).map(mapSpace);
    rows = filterByRegions(rows, filter.regions || creds.regions || []);
  } else {
    throw new Error("DigitalOcean 本期未实现能力: " + cap);
  }
  return { items: applyFilter(rows, filter) };
}

function getResource(args) {
  var creds = credsOf(args);
  var cap = str(args.capability).trim();
  var id = str(args.resourceId || args.id).trim();
  if (!id) throw new Error("缺少资源 id");
  var region = str(args.regionId || args.region).trim() || regionOfCreds(creds);
  var scoped = withRegion(creds, region);
  if (cap === "compute") {
    var body = doGet(scoped, "/droplets/" + id);
    var item = body.droplet || body;
    var row = mapDroplet(item, region);
    return fromRow(row, "https://cloud.digitalocean.com/droplets/" + id);
  }
  if (cap === "network.loadBalancer") {
    body = doGet(scoped, "/load_balancers/" + id);
    item = body.load_balancer || body;
    row = mapLoadBalancer(item, region);
    return fromRow(row, "https://cloud.digitalocean.com/networking/load_balancers/" + id);
  }
  if (cap === "storage.disk") {
    body = doGet(scoped, "/volumes/" + id);
    item = body.volume || body;
    row = mapVolume(item, region);
    return fromRow(row, "https://cloud.digitalocean.com/volumes/" + id);
  }
  if (cap === "database") {
    body = doGet(scoped, "/databases/" + id);
    item = body.database || body;
    row = mapDatabase(item, region);
    return fromRow(row, "https://cloud.digitalocean.com/databases/" + id);
  }
  if (cap === "objectStorage") {
    var buckets = listSpacesBuckets(creds).map(mapSpace);
    row = firstOrThrow(
      buckets.filter(function (x) {
        return x.id === id;
      }),
      id,
      "Spaces 桶"
    );
    return fromRow(row, "https://cloud.digitalocean.com/spaces/" + id);
  }
  throw new Error("DigitalOcean 本期未实现能力: " + cap);
}

function dropletActionType(name) {
  var n = str(name).trim().toLowerCase();
  if (n === "start" || n === "power_on") return "power_on";
  if (n === "stop" || n === "power_off") return "power_off";
  if (n === "reboot") return "reboot";
  return "";
}

function invokeAction(args) {
  var creds = credsOf(args);
  var action = args.action && typeof args.action === "object" ? args.action : args;
  var name = str(action.name).trim().toLowerCase();
  var id = str(action.resourceId).trim();
  if (!id) throw new Error("缺少资源 id");
  var region = str(action.regionId).trim() || regionOfCreds(creds);
  var scoped = withRegion(creds, region);
  var cap = str(action.capability).trim();
  if (cap === "compute") {
    var actionType = dropletActionType(name);
    if (!actionType) throw new Error("不支持的动作: " + cap + "/" + name);
    doPost(scoped, "/droplets/" + id + "/actions", { type: actionType });
    return { ok: true, message: actionType + " 已提交" };
  }
  throw new Error("不支持的动作: " + cap + "/" + name);
}

function getMetrics(args) {
  var cap = str(args.capability).trim();
  throw new Error("DigitalOcean 该能力不支持监控: " + cap);
}

function queryLogs(args) {
  var query = args.query || {};
  return {
    kind: str(query.kind || "slow"),
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
