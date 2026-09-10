/**
 * Google Cloud L2（QuickJS）。服务账号 JWT + OAuth2 Bearer，签名走 host.sign / host.encode。
 * 插件 id: omni.cloud.gcp
 */
var DEFAULT_REGION = "us-central1";
var PAGE_MAX = 500;
var TOKEN_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
var TOKEN_AUD = "https://oauth2.googleapis.com/token";
var COMPUTE_BASE = "https://compute.googleapis.com/compute/v1";
var STORAGE_BASE = "https://storage.googleapis.com/storage/v1";
var SQL_BASE = "https://sqladmin.googleapis.com/v1";

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

function b64url(data) {
  return host.encode(JSON.stringify({ data: data, encoding: "base64url" }));
}

function rs256Sign(pemKey, data) {
  return host.sign(
    JSON.stringify({ alg: "rs256", key: pemKey, data: data, encoding: "base64url" })
  );
}

function parseServiceAccount(secret, projectHint) {
  var raw = str(secret).trim();
  if (!raw) throw new Error("缺少服务账号 JSON（accessKeySecret）");
  var sa = asObj(raw);
  if (!sa.private_key || !sa.client_email) {
    throw new Error("服务账号 JSON 无效：缺少 private_key 或 client_email");
  }
  var projectId = str(sa.project_id || projectHint).trim();
  if (!projectId) throw new Error("缺少项目 ID：请在 JSON 中提供 project_id 或填写 accessKeyId");
  return {
    private_key: str(sa.private_key),
    client_email: str(sa.client_email),
    project_id: projectId,
  };
}

function credsOf(args) {
  var raw = args.credentials || args.creds || args;
  var projectHint = str(raw.accessKeyId || args.accessKeyId).trim();
  var secret = str(raw.accessKeySecret || raw.serviceAccountJson || args.accessKeySecret).trim();
  var sa = parseServiceAccount(secret, projectHint);
  var regions = raw.regions || args.regions || [];
  if (!Array.isArray(regions)) regions = [];
  var region = str(raw.region || args.region || "").trim();
  return {
    projectId: sa.project_id,
    clientEmail: sa.client_email,
    privateKey: sa.private_key,
    accessKeyId: projectHint || sa.project_id,
    accessKeySecret: secret,
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

function regionFromZone(zone) {
  var z = str(zone).trim();
  if (!z) return "";
  var parts = z.split("-");
  if (parts.length < 3) return z;
  return parts.slice(0, parts.length - 1).join("-");
}

function lastUrlSegment(url) {
  var u = str(url).replace(/\/+$/, "");
  if (!u) return "";
  var parts = u.split("/");
  return parts.length ? parts[parts.length - 1] : "";
}

function formEncode(params) {
  var parts = [];
  for (var k in params) {
    if (!Object.prototype.hasOwnProperty.call(params, k)) continue;
    parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(str(params[k])));
  }
  return parts.join("&");
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
  return parts.length ? "?" + parts.join("&") : "";
}

function netFetchJson(opts) {
  var text = host.netFetch(JSON.stringify(opts));
  if (!text) return {};
  var trimmed = str(text).replace(/^\s+/, "");
  if (trimmed.charAt(0) !== "{" && trimmed.charAt(0) !== "[") {
    throw new Error("响应非 JSON");
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error("响应无法解析为 JSON");
  }
}

function parseGcpError(body, label) {
  if (!body || typeof body !== "object") return null;
  var err = body.error || body;
  var code = jstr(err, ["code", "status"]);
  var message = jstr(err, ["message", "error_description"]);
  if (!code && !message) return null;
  return (label || "GCP") + " 失败: " + [code, message].filter(Boolean).join(" ");
}

var tokenCache = { value: "", exp: 0, key: "" };

function createJwt(sa) {
  var now = Math.floor(Date.now() / 1000);
  var header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  var payload = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: TOKEN_SCOPE,
      aud: TOKEN_AUD,
      exp: now + 3600,
      iat: now,
    })
  );
  var signingInput = header + "." + payload;
  var sig = rs256Sign(sa.private_key, signingInput);
  return signingInput + "." + sig;
}

function getToken(creds) {
  var cacheKey = creds.projectId + "|" + creds.clientEmail;
  var now = Math.floor(Date.now() / 1000);
  if (tokenCache.key === cacheKey && tokenCache.value && tokenCache.exp > now + 60) {
    return tokenCache.value;
  }
  var assertion = createJwt({
    private_key: creds.privateKey,
    client_email: creds.clientEmail,
  });
  var parsed = netFetchJson({
    url: TOKEN_AUD,
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formEncode({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: assertion,
    }),
  });
  var err = parseGcpError(parsed, "获取访问令牌");
  if (err) throw new Error(err);
  var token = jstr(parsed, ["access_token"]);
  if (!token) throw new Error("获取访问令牌失败: 响应缺少 access_token");
  var expiresIn = Number(jstr(parsed, ["expires_in"]) || "3600");
  tokenCache = {
    key: cacheKey,
    value: token,
    exp: now + (isNaN(expiresIn) ? 3600 : expiresIn),
  };
  return token;
}

function gcpRequest(creds, method, url, query, body, label) {
  method = str(method || "GET").toUpperCase();
  var fullUrl = str(url);
  if (fullUrl.indexOf("http") !== 0) fullUrl = COMPUTE_BASE + (fullUrl.charAt(0) === "/" ? fullUrl : "/" + fullUrl);
  fullUrl += buildQuery(query);
  var payload = body == null ? "" : typeof body === "string" ? body : JSON.stringify(body);
  var headers = {
    Authorization: "Bearer " + getToken(creds),
    Accept: "application/json",
  };
  if (payload) headers["Content-Type"] = "application/json";
  var opts = { url: fullUrl, method: method, headers: headers };
  if (payload) opts.body = payload;
  var parsed = netFetchJson(opts);
  var err = parseGcpError(parsed, label || method + " " + url);
  if (err) throw new Error(err);
  return parsed;
}

function gcpGet(creds, url, query, label) {
  return gcpRequest(creds, "GET", url, query, null, label);
}

function gcpPost(creds, url, query, body, label) {
  return gcpRequest(creds, "POST", url, query, body == null ? "" : body, label);
}

function projectPath(creds, suffix) {
  return "/projects/" + creds.projectId + suffix;
}

function paginateList(creds, baseUrl, query, listKey, label) {
  query = query && typeof query === "object" ? query : {};
  var out = [];
  var token = "";
  var guard = 0;
  while (guard < 50) {
    guard += 1;
    var q = {};
    for (var k in query) if (Object.prototype.hasOwnProperty.call(query, k)) q[k] = query[k];
    if (token) q.pageToken = token;
    q.maxResults = 500;
    var parsed = gcpGet(creds, baseUrl, q, label);
    out = out.concat(jarr(parsed, [listKey]));
    token = jstr(parsed, ["nextPageToken"]);
    if (!token || out.length >= PAGE_MAX) break;
  }
  if (out.length > PAGE_MAX) out.length = PAGE_MAX;
  return out;
}

function flattenAggregated(parsed, childKey) {
  var items = parsed && parsed.items && typeof parsed.items === "object" ? parsed.items : {};
  var out = [];
  for (var zoneKey in items) {
    if (!Object.prototype.hasOwnProperty.call(items, zoneKey)) continue;
    var bucket = items[zoneKey];
    if (!bucket || typeof bucket !== "object") continue;
    var zone = zoneKey.indexOf("/") >= 0 ? zoneKey.split("/").pop() : zoneKey;
    var children = jarr(bucket, [childKey]);
    for (var i = 0; i < children.length; i++) {
      var row = children[i];
      if (row && typeof row === "object") {
        row.__zone = zone;
        out.push(row);
      }
    }
    if (out.length >= PAGE_MAX) break;
  }
  return out;
}

function listAggregated(creds, resource, childKey, label) {
  var out = [];
  var token = "";
  var guard = 0;
  while (guard < 50) {
    guard += 1;
    var q = { maxResults: 500 };
    if (token) q.pageToken = token;
    var parsed = gcpGet(creds, projectPath(creds, "/aggregated/" + resource), q, label);
    out = out.concat(flattenAggregated(parsed, childKey));
    token = jstr(parsed, ["nextPageToken"]);
    if (!token || out.length >= PAGE_MAX) break;
  }
  if (out.length > PAGE_MAX) out.length = PAGE_MAX;
  return out;
}

function instanceIps(inst) {
  var pub = "";
  var priv = "";
  var pubs = [];
  var privs = [];
  var nics = jarr(inst, ["networkInterfaces"]);
  for (var i = 0; i < nics.length; i++) {
    var nic = nics[i];
    var pip = jstr(nic, ["networkIP"]);
    if (pip) privs.push(pip);
    var ac = nic.accessConfigs;
    if (Array.isArray(ac)) {
      for (var j = 0; j < ac.length; j++) {
        var nat = jstr(ac[j], ["natIP"]);
        if (nat) pubs.push(nat);
      }
    }
  }
  if (pubs.length) pub = pubs.join(",");
  if (privs.length) priv = privs.join(",");
  return { publicIp: pub, privateIp: priv };
}

function instanceLabelName(inst) {
  var labels = inst && inst.labels ? inst.labels : {};
  if (labels.name) return labels.name;
  return jstr(inst, ["name"]);
}

function mapStatus(raw) {
  var u = str(raw).trim().toUpperCase();
  if (!u) return "";
  if (u === "RUNNING" || u === "READY" || u === "ACTIVE" || u === "AVAILABLE") return "RUNNING";
  if (u === "STOPPED" || u === "TERMINATED" || u === "SUSPENDED") return "STOPPED";
  if (u === "PROVISIONING" || u === "STAGING" || u === "CREATING" || u === "PENDING") return "PENDING";
  if (u === "STOPPING" || u === "DELETING") return "STOPPING";
  if (u === "REPAIRING" || u === "REBOOTING") return "REBOOTING";
  return str(raw).trim();
}

function mapInstance(inst) {
  var zone = str(inst.__zone || inst.zone || "").trim();
  if (zone.indexOf("/") >= 0) zone = lastUrlSegment(zone);
  var id = jstr(inst, ["id", "name"]) || lastUrlSegment(jstr(inst, ["selfLink"]));
  var name = jstr(inst, ["name"]) || id;
  var ips = instanceIps(inst);
  var regionId = regionFromZone(zone);
  var machineType = lastUrlSegment(jstr(inst, ["machineType"]));
  var disks = jarr(inst, ["disks"]);
  var bootDisk = disks.length ? disks[0] : {};
  return {
    id: name,
    name: displayName(instanceLabelName(inst), name),
    capability: "compute",
    regionId: regionId,
    status: mapStatus(jstr(inst, ["status"])),
    fields: fieldMap([
      ["publicIp", ips.publicIp],
      ["privateIp", ips.privateIp],
      ["instanceType", machineType],
      ["zone", zone],
      ["os", lastUrlSegment(jstr(bootDisk, ["licenses", "source"])) || jstr(bootDisk, ["source"])],
      ["creationTime", jstr(inst, ["creationTimestamp"])],
      ["chargeType", jstr(inst.scheduling, ["preemptible"]) === "true" ? "preemptible" : "standard"],
      ["securityGroups", inst.tags && Array.isArray(inst.tags.items) ? inst.tags.items.join(",") : ""],
      ["hostname", jstr(inst, ["hostname"])],
    ]),
    __zone: zone,
  };
}

function mapFirewall(fw) {
  var id = jstr(fw, ["id", "name"]) || lastUrlSegment(jstr(fw, ["selfLink"]));
  var name = jstr(fw, ["name"]) || id;
  var allowed = jarr(fw, ["allowed"]);
  var denied = jarr(fw, ["denied"]);
  return {
    id: name,
    name: displayName(name, id),
    capability: "network.securityGroup",
    regionId: "global",
    status: jstr(fw, ["disabled"]) === "true" ? "disabled" : "enabled",
    fields: fieldMap([
      ["description", jstr(fw, ["description"])],
      ["vpcId", lastUrlSegment(jstr(fw, ["network"]))],
      ["ruleCount", String(allowed.length + denied.length)],
      ["creationTime", jstr(fw, ["creationTimestamp"])],
    ]),
  };
}

function mapDisk(disk) {
  var zone = str(disk.__zone || disk.zone || "").trim();
  if (zone.indexOf("/") >= 0) zone = lastUrlSegment(zone);
  var id = jstr(disk, ["id", "name"]) || lastUrlSegment(jstr(disk, ["selfLink"]));
  var name = jstr(disk, ["name"]) || id;
  var users = jarr(disk, ["users"]);
  var instanceId = users.length ? lastUrlSegment(users[0]) : "";
  return {
    id: name,
    name: displayName(name, id),
    capability: "storage.disk",
    regionId: regionFromZone(zone),
    status: mapStatus(jstr(disk, ["status"])),
    fields: fieldMap([
      ["size", jstr(disk, ["sizeGb"])],
      ["category", jstr(disk, ["type"])],
      ["type", jstr(disk.type, ["name"]) || lastUrlSegment(jstr(disk, ["type"]))],
      ["zone", zone],
      ["instanceId", instanceId],
    ]),
    __zone: zone,
  };
}

function mapBucket(item) {
  var name = jstr(item, ["name"]);
  var location = jstr(item, ["location"]) || jstr(item, ["locationType"]);
  return {
    id: name,
    name: name,
    capability: "objectStorage",
    regionId: location.toLowerCase() === "us" ? DEFAULT_REGION : location,
    status: jstr(item, ["iamConfiguration", "uniformBucketLevelAccess", "enabled"]) === "true" ? "uniform" : "",
    fields: fieldMap([
      ["creationDate", jstr(item, ["timeCreated"])],
      ["endpoint", "storage.googleapis.com"],
      ["location", location],
      ["storageClass", jstr(item, ["storageClass"])],
    ]),
  };
}

function mapSqlInstance(item) {
  var name = jstr(item, ["name"]);
  var regionId = jstr(item, ["region"]) || jstr(item, ["gceZone"]);
  if (regionId.indexOf("/") >= 0) regionId = lastUrlSegment(regionId);
  regionId = regionFromZone(regionId) || regionId;
  var connection = "";
  if (item.ipAddresses && Array.isArray(item.ipAddresses)) {
    for (var i = 0; i < item.ipAddresses.length; i++) {
      if (jstr(item.ipAddresses[i], ["type"]) === "PRIMARY") {
        connection = jstr(item.ipAddresses[i], ["ipAddress"]);
        break;
      }
    }
  }
  return {
    id: name,
    name: displayName(name, name),
    capability: "database",
    regionId: regionId,
    status: mapStatus(jstr(item, ["state"])),
    fields: fieldMap([
      ["engine", jstr(item, ["databaseVersion"])],
      ["engineVersion", jstr(item, ["databaseInstalledVersion"])],
      ["instanceClass", jstr(item.settings, ["tier"])],
      ["storage", jstr(item.settings, ["dataDiskSizeGb"])],
      ["zone", jstr(item, ["gceZone"])],
      ["connectionString", connection],
      ["port", "3306"],
      ["chargeType", jstr(item.settings, ["activationPolicy"])],
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
    extra: row.extra || null,
    consoleUrl: consoleUrl || null,
    related: [],
    rules: row.rules || [],
    metricIds: row.metricIds || [],
    logKinds: row.logKinds || [],
    children: [],
  };
}

function filterByRegions(rows, regions) {
  if (!regions || !regions.length) return rows;
  var wanted = {};
  for (var i = 0; i < regions.length; i++) wanted[str(regions[i]).toLowerCase()] = true;
  var out = [];
  for (var r = 0; r < rows.length; r++) {
    var loc = str(rows[r].regionId).toLowerCase();
    if (!loc || loc === "global" || wanted[loc]) out.push(rows[r]);
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
      var blob = (str(row.name) + " " + str(row.id)).toLowerCase();
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

function listInstances(creds) {
  return listAggregated(creds, "instances", "instances", "列出虚拟机");
}

function listFirewalls(creds) {
  return paginateList(
    creds,
    projectPath(creds, "/global/firewalls"),
    {},
    "items",
    "列出防火墙规则"
  );
}

function listDisks(creds) {
  return listAggregated(creds, "disks", "disks", "列出磁盘");
}

function listBuckets(creds) {
  var parsed = gcpGet(
    creds,
    STORAGE_BASE + "/b",
    { project: creds.projectId, maxResults: PAGE_MAX },
    "列出存储桶"
  );
  return jarr(parsed, ["items"]);
}

function listSqlInstances(creds) {
  var parsed = gcpGet(
    creds,
    SQL_BASE + projectPath(creds, "/instances"),
    {},
    "列出 Cloud SQL 实例"
  );
  return jarr(parsed, ["items"]);
}

function findInstance(creds, name, regionId) {
  var items = listInstances(creds);
  for (var i = 0; i < items.length; i++) {
    var row = mapInstance(items[i]);
    if (row.id !== name && row.name !== name) continue;
    if (regionId && row.regionId !== regionId) continue;
    return { raw: items[i], row: row };
  }
  return null;
}

function findDisk(creds, name, regionId) {
  var items = listDisks(creds);
  for (var i = 0; i < items.length; i++) {
    var row = mapDisk(items[i]);
    if (row.id !== name && row.name !== name) continue;
    if (regionId && row.regionId !== regionId) continue;
    return { raw: items[i], row: row };
  }
  return null;
}

function firewallRulesFromItem(fw) {
  var rules = [];
  var fwName = jstr(fw, ["name"]) || "rule";
  var allowed = jarr(fw, ["allowed"]);
  var denied = jarr(fw, ["denied"]);
  var sources = jarr(fw, ["sourceRanges"]);
  var cidr = sources.length ? sources.join(",") : "";
  var direction = jstr(fw, ["direction"]) || "INGRESS";
  for (var i = 0; i < allowed.length; i++) {
    var a = allowed[i];
    rules.push({
      id: fwName + "-allow-" + i,
      direction: direction.toLowerCase(),
      protocol: jstr(a, ["IPProtocol"]) || "all",
      portRange: Array.isArray(a.ports) ? a.ports.join(",") : "ALL",
      cidr: cidr,
      sourceGroupId: "",
      policy: "accept",
      priority: jstr(fw, ["priority"]),
      nicType: "",
      description: jstr(fw, ["description"]),
    });
  }
  for (var j = 0; j < denied.length; j++) {
    var d = denied[j];
    rules.push({
      id: fwName + "-deny-" + j,
      direction: direction.toLowerCase(),
      protocol: jstr(d, ["IPProtocol"]) || "all",
      portRange: Array.isArray(d.ports) ? d.ports.join(",") : "ALL",
      cidr: cidr,
      sourceGroupId: "",
      policy: "deny",
      priority: jstr(fw, ["priority"]),
      nicType: "",
      description: jstr(fw, ["description"]),
    });
  }
  return rules;
}

function testAccount(args) {
  var creds = credsOf(args);
  var parsed = gcpGet(creds, projectPath(creds, ""), {}, "验证项目");
  var name = jstr(parsed, ["name"]);
  var pid = jstr(parsed, ["id"]) || creds.projectId;
  if (!name && !pid) return { message: "凭证有效" };
  return { message: "Project=" + pid + (name ? "; Name=" + name : "") };
}

function listRegions(args) {
  var creds = credsOf(args);
  var configured = args.configured || args.configuredRegions || [];
  var raw = gcpGet(creds, projectPath(creds, "/regions"), {}, "列出区域");
  var items = jarr(raw, ["items"]);
  var regions = [];
  for (var i = 0; i < items.length; i++) {
    var rid = jstr(items[i], ["name"]);
    if (!rid) continue;
    regions.push({
      regionId: rid,
      localName: jstr(items[i], ["description"]) || rid,
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
  var parsed = gcpGet(creds, projectPath(creds, ""), {}, "获取项目信息");
  return {
    callerId: creds.projectId,
    arn: creds.clientEmail,
    displayName: jstr(parsed, ["name"]),
    state: "",
    projectId: creds.projectId,
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
    rows = listInstances(creds).map(mapInstance);
  } else if (cap === "network.securityGroup") {
    rows = listFirewalls(creds).map(mapFirewall);
  } else if (cap === "storage.disk") {
    rows = listDisks(creds).map(mapDisk);
  } else if (cap === "objectStorage") {
    rows = listBuckets(creds).map(mapBucket);
  } else if (cap === "database") {
    rows = listSqlInstances(creds).map(mapSqlInstance);
  } else {
    throw new Error("GCP 本期未实现能力: " + cap);
  }

  rows = filterByRegions(rows, regions);
  return { items: applyFilter(rows, filter) };
}

function instanceConsoleUrl(creds, zone, name) {
  return (
    "https://console.cloud.google.com/compute/instancesDetail/zones/" +
    zone +
    "/instances/" +
    name +
    "?project=" +
    creds.projectId
  );
}

function getResource(args) {
  var creds = credsOf(args);
  var cap = str(args.capability).trim();
  var id = str(args.resourceId || args.id).trim();
  if (!id) throw new Error("缺少资源 id");
  var region = str(args.regionId || args.region).trim() || regionOfCreds(creds);

  if (cap === "compute") {
    var found = findInstance(creds, id, region);
    if (!found) throw new Error("未找到虚拟机: " + id);
    var row = found.row;
    var zone = row.__zone || row.fields.zone;
    var detail = fromRow(row, instanceConsoleUrl(creds, zone, row.id));
    detail.extra = { zone: zone, instance: row.id };
    detail.metricIds = ["compute.googleapis.com/instance/cpu/utilization"];
    return detail;
  }

  if (cap === "network.securityGroup") {
    var fws = listFirewalls(creds);
    var fw = null;
    for (var i = 0; i < fws.length; i++) {
      if (jstr(fws[i], ["name"]) === id) {
        fw = fws[i];
        break;
      }
    }
    if (!fw) throw new Error("未找到防火墙规则: " + id);
    var fwRow = mapFirewall(fw);
    var rules = firewallRulesFromItem(fw);
    fwRow.rules = rules;
    var fwDetail = fromRow(
      fwRow,
      "https://console.cloud.google.com/networking/firewalls/details/" + id + "?project=" + creds.projectId
    );
    fwDetail.rules = rules;
    fwDetail.extra = { name: id };
    return fwDetail;
  }

  if (cap === "storage.disk") {
    var diskFound = findDisk(creds, id, region);
    if (!diskFound) throw new Error("未找到磁盘: " + id);
    var diskRow = diskFound.row;
    var diskZone = diskRow.__zone || diskRow.fields.zone;
    var diskDetail = fromRow(
      diskRow,
      "https://console.cloud.google.com/compute/disksDetail/zones/" +
        diskZone +
        "/disks/" +
        diskRow.id +
        "?project=" +
        creds.projectId
    );
    if (diskRow.fields.instanceId) {
      diskDetail.related.push({
        capability: "compute",
        resourceId: diskRow.fields.instanceId,
        name: diskRow.fields.instanceId,
        role: "instance",
      });
    }
    diskDetail.extra = { zone: diskZone, disk: diskRow.id };
    return diskDetail;
  }

  if (cap === "objectStorage") {
    var buckets = listBuckets(creds).map(mapBucket);
    var bucket = null;
    for (var b = 0; b < buckets.length; b++) {
      if (buckets[b].id === id) bucket = buckets[b];
    }
    if (!bucket) throw new Error("未找到存储桶: " + id);
    return fromRow(
      bucket,
      "https://console.cloud.google.com/storage/browser/" + id + "?project=" + creds.projectId
    );
  }

  if (cap === "database") {
    var sqlItems = listSqlInstances(creds);
    var sql = null;
    for (var s = 0; s < sqlItems.length; s++) {
      if (jstr(sqlItems[s], ["name"]) === id) sql = sqlItems[s];
    }
    if (!sql) throw new Error("未找到 Cloud SQL 实例: " + id);
    var sqlRow = mapSqlInstance(sql);
    var sqlDetail = fromRow(
      sqlRow,
      "https://console.cloud.google.com/sql/instances/" + id + "/overview?project=" + creds.projectId
    );
    sqlDetail.metricIds = ["cloudsql.googleapis.com/database/cpu/utilization"];
    sqlDetail.logKinds = ["slow"];
    sqlDetail.extra = { instance: id };
    return sqlDetail;
  }

  throw new Error("GCP 本期未实现能力: " + cap);
}

function resolveInstanceZone(creds, action, id) {
  var zone = str(
    (action.params && action.params.zone) || action.zone || action.regionId
  ).trim();
  if (zone && zone.indexOf("-") >= 0 && /-[a-z]$/.test(zone)) return zone;
  var region = str(action.regionId).trim() || regionOfCreds(creds);
  var found = findInstance(creds, id, region);
  if (!found) throw new Error("未找到虚拟机: " + id);
  return found.row.__zone || found.row.fields.zone;
}

function invokeAction(args) {
  var creds = credsOf(args);
  var action = args.action && typeof args.action === "object" ? args.action : args;
  var name = str(action.name).trim().toLowerCase();
  var id = str(action.resourceId).trim();
  if (!id) throw new Error("缺少资源 id");
  var cap = str(action.capability).trim();

  if (cap === "compute" && (name === "start" || name === "stop" || name === "reset" || name === "reboot")) {
    var zone = resolveInstanceZone(creds, action, id);
    var op = name === "reboot" ? "reset" : name;
    var suffix = op === "start" ? "/start" : op === "stop" ? "/stop" : "/reset";
    var labels = { start: "启动虚拟机", stop: "停止虚拟机", reset: "重置虚拟机", reboot: "重置虚拟机" };
    gcpPost(
      creds,
      projectPath(creds, "/zones/" + zone + "/instances/" + id + suffix),
      {},
      "",
      labels[name] || labels[op]
    );
    return { ok: true, message: (name === "reboot" ? "reset" : name) + " 已提交" };
  }

  throw new Error("不支持的动作: " + cap + "/" + name);
}

function getMetrics(args) {
  return [];
}

function queryLogs(args) {
  throw new Error("GCP 本期不支持日志查询");
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
