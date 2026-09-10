/**
 * Microsoft Azure L2（QuickJS）。OAuth2 客户端凭据 + ARM Bearer，网络走 host.netFetch。
 * Plugin id: omni.cloud.azure
 */
var DEFAULT_REGION = "eastus";
var ARM_BASE = "https://management.azure.com";
var TOKEN_SCOPE = "https://management.azure.com/.default";
var PAGE_MAX = 500;

var API = {
  subscription: "2022-12-01",
  locations: "2022-12-01",
  vm: "2023-07-01",
  nsg: "2023-09-01",
  publicIp: "2023-09-01",
  disk: "2023-04-02",
  storage: "2023-01-01",
  sql: "2021-11-01",
  redis: "2023-08-01",
};

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
  return str(name).trim() ? name : fallback;
}

function credsOf(args) {
  var raw = args.credentials || args.creds || args;
  var clientId = str(
    raw.accessKeyId || raw.clientId || args.accessKeyId || args.clientId
  ).trim();
  var clientSecret = str(
    raw.accessKeySecret || raw.clientSecret || args.accessKeySecret || args.clientSecret
  ).trim();
  var tenantId = str(raw.tenantId || args.tenantId).trim();
  var subscriptionId = str(raw.subscriptionId || args.subscriptionId).trim();
  if (!clientId || !clientSecret) throw new Error("缺少 Client Id / Client Secret");
  if (!tenantId) throw new Error("缺少 Tenant Id");
  if (!subscriptionId) throw new Error("缺少 Subscription Id");
  var regions = raw.regions || args.regions || [];
  if (!Array.isArray(regions)) regions = [];
  var region = str(raw.region || args.region || "").trim();
  return {
    accessKeyId: clientId,
    accessKeySecret: clientSecret,
    tenantId: tenantId,
    subscriptionId: subscriptionId,
    region: region,
    regions: regions,
  };
}

function regionOfCreds(creds) {
  var r = str(creds.region).trim();
  return r || DEFAULT_REGION;
}

function uniqueRegions(ids) {
  var out = [];
  var seen = {};
  for (var i = 0; i < ids.length; i++) {
    var id = str(ids[i]).trim().toLowerCase();
    if (!id || seen[id]) continue;
    seen[id] = true;
    out.push(str(ids[i]).trim());
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

function subPath(creds) {
  return "/subscriptions/" + creds.subscriptionId;
}

function parseAzureError(body, label) {
  if (!body || typeof body !== "object") return null;
  var err = body.error || body;
  var code = jstr(err, ["code", "error"]);
  var message = jstr(err, ["message", "error_description", "errorDescription"]);
  if (!code && !message) return null;
  return (label || "Azure") + " 失败: " + [code, message].filter(Boolean).join(" ");
}

function netFetchJson(opts) {
  var text = host.netFetch(JSON.stringify(opts));
  var parsed = {};
  try {
    parsed = JSON.parse(text || "{}");
  } catch (e) {
    throw new Error("响应非 JSON");
  }
  return parsed;
}

function formEncode(params) {
  var parts = [];
  for (var k in params) {
    if (!Object.prototype.hasOwnProperty.call(params, k)) continue;
    parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(str(params[k])));
  }
  return parts.join("&");
}

function getToken(creds) {
  var url =
    "https://login.microsoftonline.com/" +
    creds.tenantId +
    "/oauth2/v2.0/token";
  var body = formEncode({
    grant_type: "client_credentials",
    client_id: creds.accessKeyId,
    client_secret: creds.accessKeySecret,
    scope: TOKEN_SCOPE,
  });
  var parsed = netFetchJson({
    url: url,
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body,
  });
  var err = parseAzureError(parsed, "获取访问令牌");
  if (err) throw new Error(err);
  var token = jstr(parsed, ["access_token"]);
  if (!token) throw new Error("获取访问令牌失败: 响应缺少 access_token");
  return token;
}

function buildUrl(pathOrUrl, query) {
  if (str(pathOrUrl).indexOf("http") === 0) return pathOrUrl;
  var path = str(pathOrUrl);
  if (!path) path = "/";
  if (path.charAt(0) !== "/") path = "/" + path;
  query = query && typeof query === "object" ? query : {};
  var keys = [];
  for (var k in query) {
    if (!Object.prototype.hasOwnProperty.call(query, k)) continue;
    if (query[k] == null) continue;
    keys.push(k);
  }
  keys.sort();
  var qs = [];
  for (var i = 0; i < keys.length; i++) {
    qs.push(encodeURIComponent(keys[i]) + "=" + encodeURIComponent(str(query[keys[i]])));
  }
  return ARM_BASE + path + (qs.length ? "?" + qs.join("&") : "");
}

function armRequest(creds, method, pathOrUrl, query, body, label) {
  var token = getToken(creds);
  var url = buildUrl(pathOrUrl, query);
  var opts = {
    url: url,
    method: method || "GET",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
  };
  if (body != null) opts.body = typeof body === "string" ? body : JSON.stringify(body);
  var parsed = netFetchJson(opts);
  var err = parseAzureError(parsed, label || method + " " + pathOrUrl);
  if (err) throw new Error(err);
  return parsed;
}

function armGet(creds, pathOrUrl, query, label) {
  return armRequest(creds, "GET", pathOrUrl, query, null, label);
}

function armPost(creds, pathOrUrl, query, body, label) {
  return armRequest(creds, "POST", pathOrUrl, query, body == null ? "" : body, label);
}

function armList(creds, path, query, label) {
  var items = [];
  var url = buildUrl(path, query);
  var guard = 0;
  while (url && guard < 50) {
    guard += 1;
    var parsed = armGet(creds, url, null, label);
    items = items.concat(jarr(parsed, ["value"]));
    url = jstr(parsed, ["nextLink", "@odata.nextLink"]);
    if (items.length >= PAGE_MAX) break;
  }
  if (items.length > PAGE_MAX) items.length = PAGE_MAX;
  return items;
}

function resourceGroupOf(id) {
  var m = str(id).match(/\/resourceGroups\/([^/]+)\/providers\//i);
  return m ? m[1] : "";
}

function resourceNameOf(id) {
  var parts = str(id).split("/");
  return parts.length ? parts[parts.length - 1] : "";
}

function mapStatus(raw) {
  var u = str(raw).trim().toLowerCase();
  if (!u) return "";
  if (u.indexOf("running") >= 0 || u === "succeeded" || u === "ready" || u === "online") return "RUNNING";
  if (u.indexOf("stopped") >= 0 || u.indexOf("deallocated") >= 0 || u === "offline") return "STOPPED";
  if (u.indexOf("starting") >= 0 || u.indexOf("creating") >= 0 || u.indexOf("updating") >= 0) return "PENDING";
  if (u.indexOf("stopping") >= 0 || u.indexOf("deallocating") >= 0) return "STOPPING";
  if (u.indexOf("restarting") >= 0 || u.indexOf("reboot") >= 0) return "REBOOTING";
  if (u.indexOf("failed") >= 0) return "FAILED";
  return str(raw).trim();
}

function vmPowerState(item) {
  var view = item && item.properties ? item.properties.instanceView : null;
  var statuses = view && Array.isArray(view.statuses) ? view.statuses : [];
  for (var i = 0; i < statuses.length; i++) {
    var code = jstr(statuses[i], ["code"]).toLowerCase();
    if (code.indexOf("powerstate/") >= 0) return code.split("/").pop();
  }
  return "";
}

function mapVm(item) {
  var id = jstr(item, ["id"]) || jstr(item, ["name"]);
  var props = item && item.properties ? item.properties : {};
  var hw = props.hardwareProfile || {};
  var storage = props.storageProfile || {};
  var osDisk = storage.osDisk || {};
  var osProfile = props.osProfile || {};
  var tags = item && item.tags ? item.tags : {};
  var zones = jarr(item, ["zones"]);
  return {
    id: id,
    name: displayName(tags.Name || jstr(item, ["name"]), resourceNameOf(id)),
    capability: "compute",
    regionId: jstr(item, ["location"]),
    status: mapStatus(vmPowerState(item) || jstr(props, ["provisioningState"])),
    fields: fieldMap([
      ["instanceType", jstr(hw, ["vmSize"])],
      ["os", jstr(osDisk, ["osType"])],
      ["zone", zones.length ? zones.join(",") : ""],
      ["hostname", jstr(osProfile, ["computerName"])],
    ]),
  };
}

function mapNsg(item) {
  var id = jstr(item, ["id"]) || jstr(item, ["name"]);
  var props = item && item.properties ? item.properties : {};
  var rules = Array.isArray(props.securityRules) ? props.securityRules : [];
  var tags = item && item.tags ? item.tags : {};
  return {
    id: id,
    name: displayName(tags.Name || jstr(item, ["name"]), resourceNameOf(id)),
    capability: "network.securityGroup",
    regionId: jstr(item, ["location"]),
    status: mapStatus(jstr(props, ["provisioningState"])),
    fields: fieldMap([
      ["description", jstr(tags, ["Description"])],
      ["ruleCount", rules.length ? String(rules.length) : ""],
    ]),
  };
}

function mapEip(item) {
  var id = jstr(item, ["id"]) || jstr(item, ["name"]);
  var props = item && item.properties ? item.properties : {};
  var tags = item && item.tags ? item.tags : {};
  var ip = jstr(props, ["ipAddress"]);
  var linked = props.ipConfiguration && props.ipConfiguration.id ? props.ipConfiguration.id : "";
  return {
    id: id,
    name: displayName(tags.Name || jstr(item, ["name"]), ip || resourceNameOf(id)),
    capability: "network.eip",
    regionId: jstr(item, ["location"]),
    status: mapStatus(jstr(props, ["provisioningState"]) || (ip ? "assigned" : "unassigned")),
    fields: fieldMap([
      ["publicIp", ip],
      ["instanceId", linked],
      ["chargeType", jstr(props.sku, ["name"])],
    ]),
  };
}

function mapDisk(item) {
  var id = jstr(item, ["id"]) || jstr(item, ["name"]);
  var props = item && item.properties ? item.properties : {};
  var tags = item && item.tags ? item.tags : {};
  var managedBy = jstr(props, ["managedBy"]) || jstr(item, ["managedBy"]);
  var zones = jarr(item, ["zones"]);
  return {
    id: id,
    name: displayName(tags.Name || jstr(item, ["name"]), resourceNameOf(id)),
    capability: "storage.disk",
    regionId: jstr(item, ["location"]),
    status: mapStatus(jstr(props, ["diskState"]) || jstr(props, ["provisioningState"])),
    fields: fieldMap([
      ["size", jstr(props, ["diskSizeGB"])],
      ["category", jstr(props.sku, ["name"])],
      ["type", jstr(props, ["osType"]) || jstr(props.creationData, ["createOption"])],
      ["zone", zones.length ? zones.join(",") : ""],
      ["instanceId", managedBy],
    ]),
  };
}

function mapStorageAccount(item) {
  var id = jstr(item, ["id"]) || jstr(item, ["name"]);
  var props = item && item.properties ? item.properties : {};
  var tags = item && item.tags ? item.tags : {};
  var name = jstr(item, ["name"]);
  var location = jstr(item, ["location"]) || jstr(props, ["primaryLocation"]);
  return {
    id: id,
    name: displayName(tags.Name || name, name),
    capability: "objectStorage",
    regionId: location,
    status: mapStatus(jstr(props, ["provisioningState"]) || jstr(props, ["statusOfPrimary"])),
    fields: fieldMap([
      ["storageClass", jstr(props.sku, ["name"]) || jstr(props, ["accessTier"])],
      ["endpoint", name && location ? name + ".blob.core.windows.net" : ""],
      ["location", location],
    ]),
  };
}

function mapSqlDatabase(db, server) {
  var id = jstr(db, ["id"]) || jstr(db, ["name"]);
  var props = db && db.properties ? db.properties : {};
  var serverProps = server && server.properties ? server.properties : {};
  var serverName = jstr(server, ["name"]);
  var tags = db && db.tags ? db.tags : {};
  var maxBytes = jstr(props, ["maxSizeBytes"]);
  var storage = "";
  if (maxBytes) {
    var gb = Math.round(Number(maxBytes) / 1073741824);
    if (!isNaN(gb) && gb > 0) storage = String(gb) + "GB";
  }
  return {
    id: id,
    name: displayName(tags.Name || jstr(db, ["name"]), resourceNameOf(id)),
    capability: "database",
    regionId: jstr(db, ["location"]) || jstr(server, ["location"]),
    status: mapStatus(jstr(props, ["status"])),
    fields: fieldMap([
      ["engine", "SQL Server"],
      ["engineVersion", jstr(serverProps, ["version"])],
      ["instanceClass", jstr(props, ["currentServiceObjectiveName", "requestedServiceObjectiveName"])],
      ["storage", storage],
      ["connectionString", serverName ? serverName + ".database.windows.net" : ""],
      ["port", "1433"],
      ["serverName", serverName],
    ]),
  };
}

function mapRedis(item, engineLabel) {
  var id = jstr(item, ["id"]) || jstr(item, ["name"]);
  var props = item && item.properties ? item.properties : {};
  var tags = item && item.tags ? item.tags : {};
  var host = jstr(props, ["hostName"]);
  var sslPort = jstr(props, ["sslPort"]);
  var port = jstr(props, ["port"]);
  return {
    id: id,
    name: displayName(tags.Name || jstr(item, ["name"]), resourceNameOf(id)),
    capability: "database.cache",
    regionId: jstr(item, ["location"]),
    status: mapStatus(jstr(props, ["provisioningState"])),
    fields: fieldMap([
      ["engine", engineLabel || "Redis"],
      ["engineVersion", jstr(props, ["redisVersion"])],
      ["instanceClass", jstr(props.sku, ["name"])],
      ["capacity", jstr(props.sku, ["capacity", "family"])],
      ["connectionString", host],
      ["port", sslPort || port || "6379"],
    ]),
  };
}

function filterByRegions(rows, regions) {
  if (!regions || !regions.length) return rows;
  var wanted = {};
  for (var i = 0; i < regions.length; i++) wanted[str(regions[i]).toLowerCase()] = true;
  var out = [];
  for (var r = 0; r < rows.length; r++) {
    var loc = str(rows[r].regionId).toLowerCase();
    if (!loc || wanted[loc]) out.push(rows[r]);
  }
  return out;
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
      var blob = (row.name + " " + row.id).toLowerCase();
      var fields = row.fields || {};
      for (var k in fields) {
        if (Object.prototype.hasOwnProperty.call(fields, k)) blob += " " + str(fields[k]).toLowerCase();
      }
      if (blob.indexOf(query) < 0) continue;
    }
    out.push(row);
  }
  return out;
}

function listVms(creds) {
  return armList(
    creds,
    subPath(creds) + "/providers/Microsoft.Compute/virtualMachines",
    { "api-version": API.vm },
    "列出虚拟机"
  );
}

function listNsgs(creds) {
  return armList(
    creds,
    subPath(creds) + "/providers/Microsoft.Network/networkSecurityGroups",
    { "api-version": API.nsg },
    "列出网络安全组"
  );
}

function listEips(creds) {
  return armList(
    creds,
    subPath(creds) + "/providers/Microsoft.Network/publicIPAddresses",
    { "api-version": API.publicIp },
    "列出公网 IP"
  );
}

function listDisks(creds) {
  return armList(
    creds,
    subPath(creds) + "/providers/Microsoft.Compute/disks",
    { "api-version": API.disk },
    "列出磁盘"
  );
}

function listStorageAccounts(creds) {
  return armList(
    creds,
    subPath(creds) + "/providers/Microsoft.Storage/storageAccounts",
    { "api-version": API.storage },
    "列出存储账户"
  );
}

function listSqlDatabases(creds) {
  var servers = armList(
    creds,
    subPath(creds) + "/providers/Microsoft.Sql/servers",
    { "api-version": API.sql },
    "列出 SQL 服务器"
  );
  var out = [];
  for (var i = 0; i < servers.length; i++) {
    var server = servers[i];
    var rg = resourceGroupOf(jstr(server, ["id"]));
    var serverName = jstr(server, ["name"]);
    if (!rg || !serverName) continue;
    var path =
      subPath(creds) +
      "/resourceGroups/" +
      rg +
      "/providers/Microsoft.Sql/servers/" +
      serverName +
      "/databases";
    var dbs = armList(creds, path, { "api-version": API.sql }, "列出 SQL 数据库");
    for (var d = 0; d < dbs.length; d++) {
      if (str(dbs[d].name).toLowerCase() === "master") continue;
      out.push(mapSqlDatabase(dbs[d], server));
      if (out.length >= PAGE_MAX) break;
    }
    if (out.length >= PAGE_MAX) break;
  }
  return out;
}

function listRedis(creds) {
  var out = [];
  var redis = [];
  var enterprise = [];
  var redisErr = null;
  try {
    redis = armList(
      creds,
      subPath(creds) + "/providers/Microsoft.Cache/redis",
      { "api-version": API.redis },
      "列出 Redis"
    );
  } catch (e) {
    redisErr = e;
  }
  try {
    enterprise = armList(
      creds,
      subPath(creds) + "/providers/Microsoft.Cache/redisEnterprise",
      { "api-version": API.redis },
      "列出 Redis Enterprise"
    );
  } catch (e) {
    if (!redis.length && redisErr) throw redisErr;
  }
  for (var i = 0; i < redis.length; i++) out.push(mapRedis(redis[i], "Redis"));
  for (var j = 0; j < enterprise.length; j++) out.push(mapRedis(enterprise[j], "Redis Enterprise"));
  if (out.length > PAGE_MAX) out.length = PAGE_MAX;
  return out;
}

function testAccount(args) {
  var creds = credsOf(args);
  var body = armGet(creds, subPath(creds), { "api-version": API.subscription }, "验证订阅");
  var name = jstr(body, ["displayName"]);
  var state = jstr(body, ["state"]);
  if (!name && !state) return { message: "凭证有效" };
  return { message: [name, state].filter(Boolean).join(" / ") };
}

function listRegions(args) {
  var creds = credsOf(args);
  var configured = args.configured || args.configuredRegions || [];
  var raw = armGet(
    creds,
    subPath(creds) + "/locations",
    { "api-version": API.locations },
    "列出区域"
  );
  var items = jarr(raw, ["value"]);
  var regions = [];
  for (var i = 0; i < items.length; i++) {
    var rid = jstr(items[i], ["name"]);
    if (!rid) continue;
    regions.push({
      regionId: rid,
      localName: jstr(items[i], ["regionalDisplayName", "displayName"]),
      capabilities: [],
    });
  }
  var wanted = uniqueRegions(configured);
  if (wanted.length) {
    var filtered = [];
    var seen = {};
    for (var r = 0; r < regions.length; r++) {
      for (var w = 0; w < wanted.length; w++) {
        if (wanted[w].toLowerCase() === regions[r].regionId.toLowerCase()) {
          filtered.push(regions[r]);
          seen[wanted[w].toLowerCase()] = true;
        }
      }
    }
    for (w = 0; w < wanted.length; w++) {
      if (!seen[wanted[w].toLowerCase()]) {
        filtered.push({ regionId: wanted[w], localName: "", capabilities: [] });
      }
    }
    regions = filtered;
  }
  return { items: regions };
}

function getAccount(args) {
  var creds = credsOf(args);
  var body = armGet(creds, subPath(creds), { "api-version": API.subscription }, "获取订阅");
  return {
    callerId: creds.tenantId,
    arn: jstr(body, ["subscriptionId"]) || creds.subscriptionId,
    displayName: jstr(body, ["displayName"]),
    state: jstr(body, ["state"]),
    tenantId: creds.tenantId,
    subscriptionId: creds.subscriptionId,
    currency: "",
    availableAmount: "",
    cashAmount: "",
    creditAmount: "",
    balanceError: null,
  };
}

function listResources(args) {
  var creds = credsOf(args);
  var cap = str(args.capability || "compute").trim();
  var filter = args.filter || {};
  var regions = regionsToScan(creds, filter);
  var rows = [];

  if (cap === "compute") {
    rows = listVms(creds).map(mapVm);
  } else if (cap === "network.securityGroup") {
    rows = listNsgs(creds).map(mapNsg);
  } else if (cap === "network.eip") {
    rows = listEips(creds).map(mapEip);
  } else if (cap === "storage.disk") {
    rows = listDisks(creds).map(mapDisk);
  } else if (cap === "objectStorage") {
    rows = listStorageAccounts(creds).map(mapStorageAccount);
  } else if (cap === "database") {
    rows = listSqlDatabases(creds);
  } else if (cap === "database.cache") {
    rows = listRedis(creds);
  } else {
    throw new Error("Azure 本期未实现能力: " + cap);
  }

  rows = filterByRegions(rows, regions);
  return { items: applyFilter(rows, filter) };
}

function parseVmResource(creds, id, action) {
  var full = str(id).trim();
  if (!full) throw new Error("缺少资源 id");
  var m = full.match(
    /\/subscriptions\/[^/]+\/resourceGroups\/([^/]+)\/providers\/Microsoft\.Compute\/virtualMachines\/([^/]+)/i
  );
  if (m) {
    return { resourceGroup: m[1], name: m[2] };
  }
  var rg = str(
    (action && action.params && action.params.resourceGroup) || action.resourceGroup
  ).trim();
  if (!rg) throw new Error("请提供完整虚拟机资源 ID，或附带 resourceGroup");
  return { resourceGroup: rg, name: full };
}

function vmActionPath(creds, id, action) {
  var parsed = parseVmResource(creds, id, action);
  return (
    subPath(creds) +
    "/resourceGroups/" +
    parsed.resourceGroup +
    "/providers/Microsoft.Compute/virtualMachines/" +
    parsed.name
  );
}

function invokeAction(args) {
  var creds = credsOf(args);
  var action = args.action && typeof args.action === "object" ? args.action : args;
  var name = str(action.name).trim().toLowerCase();
  var id = str(action.resourceId).trim();
  if (!id) throw new Error("缺少资源 id");
  var cap = str(action.capability).trim();

  if (cap === "compute" && (name === "start" || name === "stop" || name === "reboot")) {
    var path = vmActionPath(creds, id, action);
    var suffix = name === "start" ? "/start" : name === "stop" ? "/deallocate" : "/restart";
    var labels = { start: "启动虚拟机", stop: "停止虚拟机", reboot: "重启虚拟机" };
    armPost(creds, path + suffix, { "api-version": API.vm }, "", labels[name]);
    return { ok: true, message: name + " 已提交" };
  }

  throw new Error("不支持的动作: " + cap + "/" + name);
}

var HANDLERS = {
  testAccount: testAccount,
  listRegions: listRegions,
  getAccount: getAccount,
  listResources: listResources,
  invokeAction: invokeAction,
};

function call(method, argsJson) {
  var handler = HANDLERS[String(method || "")];
  if (!handler) throw new Error("UnknownMethod: " + method);
  var result = handler(asObj(argsJson));
  return typeof result === "string" ? result : JSON.stringify(result);
}

globalThis.call = call;
