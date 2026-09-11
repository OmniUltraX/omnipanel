/**
 * 华为云 L2（QuickJS）。SDK-HMAC-SHA256 / OBS HMAC-SHA1 走 host.hmac + host.hash，
 * 网络走 host.netFetch。
 */
var DEFAULT_REGION = "cn-north-4";
var PAGE_LIMIT = 100;
var PAGE_MAX = 500;
var IAM_HOST = "iam.myhuaweicloud.com";
var BSS_HOST = "bss.myhuaweicloud.com";
var DNS_HOST = "dns.myhuaweicloud.com";
var OBS_HOST = "obs.myhuaweicloud.com";
var SCM_HOST = "scm.cn-north-4.myhuaweicloud.com";

var REGION_LABELS = {
  "cn-north-1": "华北-北京一",
  "cn-north-4": "华北-北京四",
  "cn-north-9": "华北-乌兰察布一",
  "cn-east-2": "华东-上海二",
  "cn-east-3": "华东-上海一",
  "cn-south-1": "华南-广州",
  "cn-south-2": "华南-深圳",
  "cn-southwest-2": "西南-贵阳一",
  "ap-southeast-1": "中国-香港",
  "ap-southeast-3": "亚太-新加坡",
};

var PROJECT_CACHE = {};
var DOMAIN_CACHE = {};

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

function hmac(spec) {
  return host.hmac(JSON.stringify(spec));
}

function hashHex(alg, data) {
  return host.hash(JSON.stringify({ alg: alg, data: data, encoding: "hex" }));
}

function hmacUtf8(alg, key, data, encoding) {
  return hmac({ alg: alg, key: key, data: data, encoding: encoding || "hex" });
}

function pad(n) {
  return n < 10 ? "0" + n : String(n);
}

function utcParts(ms) {
  var d = new Date(ms);
  return {
    y: d.getUTCFullYear(),
    m: pad(d.getUTCMonth() + 1),
    d: pad(d.getUTCDate()),
    h: pad(d.getUTCHours()),
    min: pad(d.getUTCMinutes()),
    s: pad(d.getUTCSeconds()),
  };
}

function sdkDate(ms) {
  var p = utcParts(ms);
  return p.y + p.m + p.d + "T" + p.h + p.min + p.s + "Z";
}

function uriEncode(s, encodeSlash) {
  var out = encodeURIComponent(str(s))
    .replace(/!/g, "%21")
    .replace(/'/g, "%27")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29")
    .replace(/\*/g, "%2A");
  if (!encodeSlash) out = out.replace(/%2F/g, "/");
  return out;
}

function canonicalUri(path) {
  var raw = str(path || "/");
  if (raw.charAt(0) !== "/") raw = "/" + raw;
  var parts = raw.split("/");
  var enc = [];
  for (var i = 0; i < parts.length; i++) {
    if (!parts[i]) continue;
    enc.push(uriEncode(parts[i], true));
  }
  var uri = "/" + enc.join("/");
  if (uri.charAt(uri.length - 1) !== "/") uri += "/";
  return uri;
}

function canonicalQuery(query) {
  query = query && typeof query === "object" ? query : {};
  var keys = [];
  for (var k in query) {
    if (!Object.prototype.hasOwnProperty.call(query, k)) continue;
    if (query[k] == null) continue;
    keys.push(k);
  }
  keys.sort();
  var parts = [];
  for (var i = 0; i < keys.length; i++) {
    parts.push(uriEncode(keys[i], true) + "=" + uriEncode(str(query[keys[i]]), true));
  }
  return parts.join("&");
}

function buildQuery(query) {
  var qs = canonicalQuery(query);
  return qs ? "?" + qs : "";
}

function credsOf(args) {
  var raw = args.credentials || args.creds || args;
  var id = str(raw.accessKeyId || raw.ak || args.accessKeyId).trim();
  var secret = str(raw.accessKeySecret || raw.sk || args.accessKeySecret).trim();
  if (!id || !secret) throw new Error("缺少 AccessKey Id / AccessKey Secret");
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

function parseHwError(body) {
  if (!body || typeof body !== "object") return null;
  var err = body.error;
  if (err && typeof err === "object") {
    var code = jstr(err, ["code", "error_code"]);
    var message = jstr(err, ["message", "error_msg"]);
    if (code || message) return { code: code, message: message };
  }
  var code2 = jstr(body, ["error_code", "code"]);
  var msg2 = jstr(body, ["error_msg", "message"]);
  if (code2 || msg2) return { code: code2, message: msg2 };
  return null;
}

function hwCall(creds, hostName, method, path, query, body, projectId) {
  method = str(method || "GET").toUpperCase();
  var payload = body == null ? "" : typeof body === "string" ? body : JSON.stringify(body);
  var date = sdkDate(Date.now());
  var headers = {
    "Content-Type": "application/json",
    Host: hostName,
    "X-Sdk-Date": date,
  };
  if (projectId) headers["X-Project-Id"] = projectId;
  var signedNames = [];
  for (var hk in headers) {
    if (Object.prototype.hasOwnProperty.call(headers, hk)) signedNames.push(hk.toLowerCase());
  }
  signedNames.sort();
  var canonicalHeaders = "";
  for (var i = 0; i < signedNames.length; i++) {
    var name = signedNames[i];
    var value = "";
    for (var hk2 in headers) {
      if (hk2.toLowerCase() === name) {
        value = str(headers[hk2]).replace(/^\s+|\s+$/g, "");
        break;
      }
    }
    canonicalHeaders += name + ":" + value + "\n";
  }
  var signedHeaders = signedNames.join(";");
  var canonicalRequest =
    method +
    "\n" +
    canonicalUri(path) +
    "\n" +
    canonicalQuery(query) +
    "\n" +
    canonicalHeaders +
    "\n" +
    signedHeaders +
    "\n" +
    hashHex("sha256", payload);
  var stringToSign = "SDK-HMAC-SHA256\n" + date + "\n" + hashHex("sha256", canonicalRequest);
  var signature = hmacUtf8("sha256", creds.accessKeySecret, stringToSign, "hex");
  headers.Authorization =
    "SDK-HMAC-SHA256 Access=" +
    creds.accessKeyId +
    ", SignedHeaders=" +
    signedHeaders +
    ", Signature=" +
    signature;
  var spec = {
    url: "https://" + hostName + path + buildQuery(query),
    method: method,
    headers: headers,
  };
  if (payload) spec.body = payload;
  var text = host.netFetch(JSON.stringify(spec));
  if (!text) return {};
  var trimmed = str(text).replace(/^\s+/, "");
  if (trimmed.charAt(0) !== "{" && trimmed.charAt(0) !== "[") return { _raw: text };
  var parsed = {};
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error("华为云响应非 JSON: " + hostName + path);
  }
  var err = parseHwError(parsed);
  if (err) throw new Error("华为云失败: " + (err.code || "") + " " + (err.message || ""));
  return parsed;
}

function xmlTag(xml, tag) {
  var open = "<" + tag + ">";
  var close = "</" + tag + ">";
  var start = xml.indexOf(open);
  if (start < 0) return "";
  start += open.length;
  var end = xml.indexOf(close, start);
  if (end < 0) return "";
  return xml.slice(start, end).trim();
}

function xmlBlocks(xml, tag) {
  var open = "<" + tag + ">";
  var close = "</" + tag + ">";
  var out = [];
  var rest = xml;
  while (true) {
    var start = rest.indexOf(open);
    if (start < 0) break;
    var after = rest.slice(start + open.length);
    var end = after.indexOf(close);
    if (end < 0) break;
    out.push(after.slice(0, end));
    rest = after.slice(end + close.length);
  }
  return out;
}

function svcHost(service, region) {
  return service + "." + region + ".myhuaweicloud.com";
}

function listProjects(creds) {
  var key = creds.accessKeyId;
  if (PROJECT_CACHE[key]) return PROJECT_CACHE[key];
  var body;
  try {
    body = hwCall(creds, IAM_HOST, "GET", "/v3/auth/projects", {}, null, "");
  } catch (e) {
    body = hwCall(creds, IAM_HOST, "GET", "/v3/projects", {}, null, "");
  }
  var items = jarr(body, ["projects"]);
  var out = [];
  for (var i = 0; i < items.length; i++) {
    if (items[i] && items[i].enabled === false) continue;
    var id = jstr(items[i], ["id"]);
    var name = jstr(items[i], ["name"]);
    if (!id) continue;
    out.push({
      id: id,
      name: name,
      domainId: jstr(items[i], ["domain_id"]),
    });
  }
  if (!out.length) throw new Error("未拿到华为云项目，请确认 AK/SK 有 IAM 权限");
  PROJECT_CACHE[key] = out;
  return out;
}

function projectForRegion(creds, region) {
  var rid = str(region || regionOfCreds(creds)).trim();
  var projects = listProjects(creds);
  for (var i = 0; i < projects.length; i++) {
    if (projects[i].name === rid) return projects[i];
  }
  for (i = 0; i < projects.length; i++) {
    if (projects[i].name.indexOf("-") >= 0) return projects[i];
  }
  return projects[0];
}

function domainIdOf(creds) {
  var key = creds.accessKeyId;
  if (DOMAIN_CACHE[key]) return DOMAIN_CACHE[key];
  var projects = listProjects(creds);
  for (var i = 0; i < projects.length; i++) {
    if (projects[i].domainId) {
      DOMAIN_CACHE[key] = projects[i].domainId;
      return projects[i].domainId;
    }
  }
  var body = hwCall(creds, IAM_HOST, "GET", "/v3/auth/domains", {}, null, "");
  var domains = jarr(body, ["domains"]);
  var id = domains.length ? jstr(domains[0], ["id"]) : "";
  DOMAIN_CACHE[key] = id;
  return id;
}

function paginate(creds, hostName, path, query, projectId, listKeys) {
  query = query && typeof query === "object" ? query : {};
  var offset = 1;
  if (query.offset != null && str(query.offset) !== "") {
    offset = parseInt(query.offset, 10);
    if (isNaN(offset)) offset = 1;
  }
  var out = [];
  while (true) {
    var q = {};
    for (var k in query) if (Object.prototype.hasOwnProperty.call(query, k)) q[k] = query[k];
    q.limit = String(PAGE_LIMIT);
    q.offset = String(offset);
    var resp = hwCall(creds, hostName, "GET", path, q, null, projectId);
    var items = jarr(resp, listKeys);
    out = out.concat(items);
    if (!items.length || items.length < PAGE_LIMIT || out.length >= PAGE_MAX) break;
    offset += PAGE_LIMIT;
    if (offset >= PAGE_MAX) break;
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
  var u = str(raw).trim().toUpperCase();
  if (
    u === "ACTIVE" ||
    u === "RUNNING" ||
    u === "ONLINE" ||
    u === "NORMAL" ||
    u === "AVAILABLE" ||
    u === "UP" ||
    u === "ACTIVE_STANDBY"
  )
    return "RUNNING";
  if (u === "SHUTOFF" || u === "STOPPED" || u === "OFFLINE" || u === "DOWN" || u === "FROZEN") return "STOPPED";
  if (u === "BUILD" || u === "PENDING" || u === "CREATING" || u === "RESTORING") return "PENDING";
  if (u === "REBOOT" || u === "REBOOTING" || u === "HARD_REBOOT" || u === "RESTARTING") return "REBOOTING";
  if (u === "ERROR" || u === "FAILED") return "ERROR";
  return str(raw).trim();
}

function displayName(name, fallback) {
  return str(name).trim() ? str(name).trim() : fallback;
}

function ecsIps(server) {
  var pub = [];
  var priv = [];
  var addrs = server && server.addresses;
  if (addrs && typeof addrs === "object") {
    for (var net in addrs) {
      if (!Object.prototype.hasOwnProperty.call(addrs, net)) continue;
      var list = addrs[net];
      if (!Array.isArray(list)) continue;
      for (var i = 0; i < list.length; i++) {
        var a = list[i] || {};
        var ip = str(a.addr || a.ip_address).trim();
        if (!ip) continue;
        var typ = str(a["OS-EXT-IPS:type"] || a.type).toLowerCase();
        if (typ === "floating") pub.push(ip);
        else priv.push(ip);
      }
    }
  }
  var access = jstr(server || {}, ["accessIPv4", "accessIPv6"]);
  if (access && pub.indexOf(access) < 0 && priv.indexOf(access) < 0) pub.push(access);
  return { publicIp: pub.join(","), privateIp: priv.join(",") };
}

function isFlexusServer(server) {
  var tags = server && server.tags;
  if (Array.isArray(tags)) {
    for (var i = 0; i < tags.length; i++) {
      var t = str(tags[i]);
      if (t.indexOf("_sys_type_hcss_l") >= 0 || t.indexOf("hcss.l") >= 0) return true;
    }
  }
  var meta = (server && server.metadata) || {};
  var blob = JSON.stringify(meta);
  return blob.indexOf("_sys_type_hcss_l") >= 0 || blob.indexOf("hcss.l-instance") >= 0;
}

function sgIdsOf(server) {
  var groups = (server && server.security_groups) || [];
  var ids = [];
  if (Array.isArray(groups)) {
    for (var i = 0; i < groups.length; i++) {
      var id = typeof groups[i] === "string" ? groups[i] : jstr(groups[i], ["id", "name"]);
      if (id) ids.push(id);
    }
  }
  return ids.join(",");
}

function flavorOf(item) {
  if (!item) return "";
  if (item.flavor && typeof item.flavor === "object") {
    return jstr(item.flavor, ["id", "name", "original_name"]);
  }
  return jstr(item, ["flavor_id", "flavor", "flavor_ref"]);
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

function mapEcs(item, region, capability) {
  var id = jstr(item, ["id"]);
  var ips = ecsIps(item);
  var az = jstr(item, ["OS-EXT-AZ:availability_zone", "availability_zone"]);
  var os =
    (item.metadata && jstr(item.metadata, ["os_type", "image_name", "metering.image_name"])) ||
    jstr(item, ["image_name"]);
  var charge = item.metadata ? jstr(item.metadata, ["charging_mode", "metering.order_id"]) : "";
  return {
    id: id,
    name: displayName(jstr(item, ["name"]), id),
    capability: capability || "compute",
    regionId: region,
    status: mapStatus(jstr(item, ["status", "vm_state"])),
    fields: fieldMap([
      ["publicIp", ips.publicIp],
      ["privateIp", ips.privateIp],
      ["instanceType", flavorOf(item)],
      ["plan", flavorOf(item)],
      ["zone", az],
      ["os", os],
      ["creationTime", jstr(item, ["created", "created_at"])],
      ["chargeType", charge],
      ["securityGroups", sgIdsOf(item)],
      ["vpcId", item.metadata ? jstr(item.metadata, ["vpc_id"]) : ""],
      ["hostname", jstr(item, ["OS-EXT-SRV-ATTR:hostname", "name"])],
    ]),
  };
}

function mapSg(item, region) {
  var id = jstr(item, ["id"]);
  return {
    id: id,
    name: displayName(jstr(item, ["name"]), id),
    capability: "network.securityGroup",
    regionId: region,
    status: jstr(item, ["vpc_id"]) ? "vpc" : "",
    fields: fieldMap([
      ["vpcId", jstr(item, ["vpc_id"])],
      ["description", jstr(item, ["description"])],
      ["creationTime", jstr(item, ["created_at", "create_time"])],
    ]),
  };
}

function mapEip(item, region) {
  var id = jstr(item, ["id"]);
  var ip = jstr(item, ["public_ip_address", "public_ipv6_address"]);
  return {
    id: id,
    name: displayName(jstr(item, ["alias", "name"]), ip || id),
    capability: "network.eip",
    regionId: region,
    status: jstr(item, ["status"]),
    fields: fieldMap([
      ["publicIp", ip],
      ["bandwidth", jstr(item, ["bandwidth_size", "bandwidth_name"])],
      ["instanceId", jstr(item, ["port_id"])],
      ["chargeType", jstr(item, ["bandwidth_share_type", "type"])],
      ["type", jstr(item, ["type"])],
    ]),
  };
}

function mapLb(item, region) {
  var id = jstr(item, ["id"]);
  return {
    id: id,
    name: displayName(jstr(item, ["name"]), id),
    capability: "network.loadBalancer",
    regionId: region,
    status: mapStatus(jstr(item, ["operating_status", "provisioning_status"])),
    fields: fieldMap([
      ["publicIp", jstr(item, ["vip_address", "floating_ip_address"])],
      ["addressType", jstr(item, ["ip_target_enable", "guaranteed"])],
      ["instanceClass", jstr(item, ["l4_flavor_id", "l7_flavor_id"])],
      ["vpcId", jstr(item, ["vpc_id"])],
    ]),
  };
}

function mapRds(item, region) {
  var id = jstr(item, ["id"]);
  var ds = item.datastore || {};
  var volume = item.volume || {};
  var pub = Array.isArray(item.public_ips) ? item.public_ips.join(",") : jstr(item, ["public_ips"]);
  var priv = Array.isArray(item.private_ips) ? item.private_ips.join(",") : jstr(item, ["private_ips"]);
  return {
    id: id,
    name: displayName(jstr(item, ["name"]), id),
    capability: "database",
    regionId: region,
    status: mapStatus(jstr(item, ["status"])),
    fields: fieldMap([
      ["engine", jstr(ds, ["type"])],
      ["engineVersion", jstr(ds, ["version"])],
      ["instanceClass", jstr(item, ["flavor_ref", "cpu"])],
      ["storage", jstr(volume, ["size"])],
      ["connectionString", pub || priv],
      ["port", jstr(item, ["port"])],
      ["chargeType", item.charge_info ? jstr(item.charge_info, ["charge_mode"]) : jstr(item, ["charge_mode"])],
      ["vpcId", jstr(item, ["vpc_id"])],
      ["zone", Array.isArray(item.nodes) && item.nodes[0] ? jstr(item.nodes[0], ["availability_zone"]) : ""],
    ]),
  };
}

function mapDcs(item, region) {
  var id = jstr(item, ["instance_id", "id"]);
  return {
    id: id,
    name: displayName(jstr(item, ["name"]), id),
    capability: "database.cache",
    regionId: region,
    status: mapStatus(jstr(item, ["status"])),
    fields: fieldMap([
      ["engine", nonemptyOr(jstr(item, ["engine", "spec_code"]), "Redis")],
      ["engineVersion", jstr(item, ["engine_version"])],
      ["instanceClass", jstr(item, ["spec_code", "capacity"])],
      ["capacity", jstr(item, ["capacity", "max_memory"])],
      ["connectionString", jstr(item, ["ip", "domain_name"])],
      ["port", jstr(item, ["port"])],
      ["chargeType", jstr(item, ["charging_mode", "billing_mode"])],
      ["vpcId", jstr(item, ["vpc_id"])],
      ["zone", jstr(item, ["az_codes"]) || (Array.isArray(item.available_zones) ? item.available_zones.join(",") : "")],
    ]),
  };
}

function mapDisk(item, region) {
  var id = jstr(item, ["id"]);
  var inst = "";
  if (Array.isArray(item.attachments) && item.attachments[0]) {
    inst = jstr(item.attachments[0], ["server_id", "instance_id"]);
  }
  return {
    id: id,
    name: displayName(jstr(item, ["name", "display_name"]), id),
    capability: "storage.disk",
    regionId: region,
    status: jstr(item, ["status"]),
    fields: fieldMap([
      ["size", jstr(item, ["size"])],
      ["category", jstr(item, ["volume_type"])],
      ["type", jstr(item, ["bootable"]) === "true" ? "system" : "data"],
      ["zone", jstr(item, ["availability_zone"])],
      ["instanceId", inst],
      ["chargeType", item.metadata ? jstr(item.metadata, ["orderID", "charging_mode"]) : ""],
    ]),
  };
}

function mapZone(item) {
  var id = jstr(item, ["id"]);
  var name = jstr(item, ["name"]);
  return {
    id: id,
    name: displayName(name, id),
    capability: "domains",
    regionId: "",
    status: jstr(item, ["status"]),
    fields: fieldMap([
      ["type", jstr(item, ["zone_type", "email"])],
      ["recordCount", jstr(item, ["record_num", "ttl"])],
      ["registrationDate", jstr(item, ["created_at"])],
      ["expirationDate", ""],
    ]),
  };
}

function mapCert(item) {
  var id = jstr(item, ["id", "certificate_id"]);
  return {
    id: id,
    name: displayName(jstr(item, ["name"]), id),
    capability: "certs",
    regionId: "",
    status: jstr(item, ["status"]),
    fields: fieldMap([
      ["domain", jstr(item, ["domain", "domain_name"])],
      ["product", jstr(item, ["brand", "type"])],
      ["certType", jstr(item, ["certificate_type", "type"])],
      ["endDate", jstr(item, ["expire_time", "not_after"])],
    ]),
  };
}

function mapObs(item) {
  var name = jstr(item, ["Name"]);
  var loc = jstr(item, ["Location"]);
  return {
    id: name,
    name: name,
    capability: "objectStorage",
    regionId: loc,
    status: "",
    fields: fieldMap([
      ["storageClass", "STANDARD"],
      ["creationDate", jstr(item, ["CreationDate"])],
      ["endpoint", loc ? "obs." + loc + ".myhuaweicloud.com" : OBS_HOST],
    ]),
  };
}

function nonemptyOr(value, fallback) {
  return str(value).trim() ? str(value) : fallback;
}

function listRegional(creds, filter, fetch, mapRow) {
  var regions = regionsToScan(creds, filter);
  var out = [];
  var lastErr = null;
  var ok = 0;
  for (var i = 0; i < regions.length; i++) {
    try {
      var items = fetch(withRegion(creds, regions[i]));
      ok += 1;
      for (var k = 0; k < items.length; k++) out.push(mapRow(items[k], regions[i]));
    } catch (e) {
      lastErr = e;
    }
  }
  if (!ok && lastErr) throw lastErr;
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
      var blob = (str(row.name) + " " + str(row.id) + " " + JSON.stringify(row.fields || {})).toLowerCase();
      if (blob.indexOf(query) < 0) continue;
    }
    out.push(row);
  }
  return out;
}

function regionalGet(creds, service, path, query, listKeys) {
  var region = regionOfCreds(creds);
  var project = projectForRegion(creds, region);
  return paginate(creds, svcHost(service, region), path.replace("{project_id}", project.id), query || {}, project.id, listKeys);
}

function regionalCall(creds, service, method, path, query, body) {
  var region = regionOfCreds(creds);
  var project = projectForRegion(creds, region);
  var p = path.replace("{project_id}", project.id);
  return hwCall(creds, svcHost(service, region), method, p, query || {}, body, project.id);
}

function listEcs(creds) {
  return regionalGet(creds, "ecs", "/v1/{project_id}/cloudservers/detail", { offset: 1 }, ["servers"]);
}

function listSgs(creds) {
  return regionalGet(creds, "vpc", "/v1/{project_id}/security-groups", { offset: 1 }, ["security_groups"]);
}

function listEips(creds) {
  return regionalGet(creds, "vpc", "/v1/{project_id}/publicips", { offset: 1 }, ["publicips"]);
}

function listLbs(creds) {
  var region = regionOfCreds(creds);
  var project = projectForRegion(creds, region);
  return paginate(
    creds,
    svcHost("elb", region),
    "/v3/" + project.id + "/elb/loadbalancers",
    { offset: 0 },
    project.id,
    ["loadbalancers"]
  );
}

function listRds(creds) {
  var region = regionOfCreds(creds);
  var project = projectForRegion(creds, region);
  return paginate(
    creds,
    svcHost("rds", region),
    "/v3/" + project.id + "/instances",
    { offset: 0 },
    project.id,
    ["instances"]
  );
}

function listDcs(creds) {
  var region = regionOfCreds(creds);
  var project = projectForRegion(creds, region);
  return paginate(
    creds,
    svcHost("dcs", region),
    "/v2/" + project.id + "/instances",
    { offset: 0 },
    project.id,
    ["instances"]
  );
}

function listDisks(creds) {
  return regionalGet(creds, "evs", "/v2/{project_id}/cloudvolumes/detail", { offset: 1 }, ["volumes"]);
}

function listObsBuckets(creds) {
  var date = new Date().toUTCString();
  var stringToSign = "GET\n\n\n" + date + "\n/";
  var signature = hmacUtf8("sha1", creds.accessKeySecret, stringToSign, "base64");
  var text = host.netFetch(
    JSON.stringify({
      url: "https://" + OBS_HOST + "/",
      method: "GET",
      headers: {
        Host: OBS_HOST,
        Date: date,
        Authorization: "OBS " + creds.accessKeyId + ":" + signature,
      },
    })
  );
  var code = xmlTag(text, "Code");
  if (code) throw new Error("OBS ListBuckets 失败: " + code + " " + xmlTag(text, "Message"));
  var blocks = xmlBlocks(text, "Bucket");
  var out = [];
  for (var i = 0; i < blocks.length; i++) {
    out.push({
      Name: xmlTag(blocks[i], "Name"),
      Location: xmlTag(blocks[i], "Location") || xmlTag(blocks[i], "LocationConstraint"),
      CreationDate: xmlTag(blocks[i], "CreationDate"),
    });
  }
  return out;
}

function listDnsZones(creds) {
  var project = projectForRegion(creds, regionOfCreds(creds));
  return paginate(creds, DNS_HOST, "/v2/zones", { type: "public", offset: 0 }, project.id, ["zones"]);
}

function listCerts(creds) {
  var project = projectForRegion(creds, DEFAULT_REGION);
  try {
    return paginate(creds, SCM_HOST, "/v3/scm/certificates", { offset: 0 }, project.id, [
      "certificates",
    ]);
  } catch (e) {
    return [];
  }
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
  var projects = listProjects(creds);
  var names = [];
  for (var i = 0; i < projects.length && i < 4; i++) names.push(projects[i].name || projects[i].id);
  return { message: "凭证有效；项目 " + projects.length + " 个（" + names.join(", ") + "）" };
}

function listRegions(args) {
  var creds = credsOf(args);
  var configured = args.configured || args.configuredRegions || [];
  var projects = listProjects(creds);
  var regions = [];
  var seen = {};
  for (var i = 0; i < projects.length; i++) {
    var rid = projects[i].name;
    if (!rid || rid.indexOf("-") < 0 || seen[rid]) continue;
    seen[rid] = true;
    regions.push({
      regionId: rid,
      localName: REGION_LABELS[rid] || "",
      capabilities: [],
    });
  }
  var wanted = uniqueRegions(configured);
  if (wanted.length) {
    var filtered = [];
    var have = {};
    for (var r = 0; r < regions.length; r++) {
      for (var w = 0; w < wanted.length; w++) {
        if (wanted[w] === regions[r].regionId) {
          filtered.push(regions[r]);
          have[wanted[w]] = true;
        }
      }
    }
    for (w = 0; w < wanted.length; w++) {
      if (!have[wanted[w]]) {
        filtered.push({
          regionId: wanted[w],
          localName: REGION_LABELS[wanted[w]] || "",
          capabilities: [],
        });
      }
    }
    regions = filtered;
  }
  return { items: regions };
}

function getAccount(args) {
  var creds = credsOf(args);
  var projects = listProjects(creds);
  var snap = {
    callerId: domainIdOf(creds) || projects[0].domainId || creds.accessKeyId,
    arn: projects[0] ? projects[0].name : "",
    currency: "",
    availableAmount: "",
    cashAmount: "",
    creditAmount: "",
    balanceError: null,
  };
  try {
    var body = hwCall(creds, BSS_HOST, "POST", "/v2/accounts/customer-accounts/balances", {}, {}, "");
    var bals = jarr(body, ["account_balances"]);
    if (bals.length) {
      snap.currency = jstr(bals[0], ["currency"]) || "CNY";
      snap.availableAmount = jstr(bals[0], ["amount"]);
      snap.cashAmount = jstr(bals[0], ["amount"]);
      for (var i = 0; i < bals.length; i++) {
        if (String(bals[i].account_type) === "1") snap.cashAmount = jstr(bals[i], ["amount"]);
        if (String(bals[i].account_type) === "2") snap.creditAmount = jstr(bals[i], ["amount"]);
      }
    }
  } catch (e) {
    snap.balanceError = String(e.message || e);
  }
  return snap;
}

function listResources(args) {
  var creds = credsOf(args);
  var cap = str(args.capability || "compute").trim();
  var filter = args.filter || {};
  var rows;
  if (cap === "compute") {
    rows = listRegional(
      creds,
      filter,
      function (c) {
        return listEcs(c).filter(function (s) {
          return !isFlexusServer(s);
        });
      },
      function (item, region) {
        return mapEcs(item, region, "compute");
      }
    );
  } else if (cap === "compute.lite") {
    rows = listRegional(
      creds,
      filter,
      function (c) {
        return listEcs(c).filter(isFlexusServer);
      },
      function (item, region) {
        return mapEcs(item, region, "compute.lite");
      }
    );
  } else if (cap === "network.securityGroup") {
    rows = listRegional(creds, filter, listSgs, mapSg);
  } else if (cap === "network.eip") {
    rows = listRegional(creds, filter, listEips, mapEip);
  } else if (cap === "network.loadBalancer") {
    rows = listRegional(creds, filter, listLbs, mapLb);
  } else if (cap === "database") {
    rows = listRegional(creds, filter, listRds, mapRds);
  } else if (cap === "database.cache") {
    rows = listRegional(creds, filter, listDcs, mapDcs);
  } else if (cap === "storage.disk") {
    rows = listRegional(creds, filter, listDisks, mapDisk);
  } else if (cap === "objectStorage") {
    rows = listObsBuckets(creds).map(mapObs);
    var wanted = uniqueRegions(filter.regions || []);
    if (wanted.length) {
      rows = rows.filter(function (row) {
        return wanted.indexOf(row.regionId) >= 0;
      });
    }
  } else if (cap === "domains" || cap === "dns") {
    rows = listDnsZones(creds).map(mapZone);
  } else if (cap === "certs") {
    rows = listCerts(creds).map(mapCert);
  } else {
    throw new Error("华为云本期未实现能力: " + cap);
  }
  return { items: applyFilter(rows, filter) };
}

function sgRules(item) {
  var raw = jarr(item, ["security_group_rules"]);
  var out = [];
  for (var i = 0; i < raw.length; i++) {
    var r = raw[i];
    out.push({
      id: jstr(r, ["id"]),
      kind: "sgRule",
      name: jstr(r, ["direction"]) + " " + jstr(r, ["protocol"]),
      status: jstr(r, ["ethertype"]),
      fields: fieldMap([
        ["direction", jstr(r, ["direction"])],
        ["protocol", jstr(r, ["protocol"])],
        ["portRange", nonemptyOr(jstr(r, ["port_range_min"]), "") + "-" + nonemptyOr(jstr(r, ["port_range_max"]), "")],
        ["cidr", jstr(r, ["remote_ip_prefix"])],
        ["ethertype", jstr(r, ["ethertype"])],
        ["description", jstr(r, ["description"])],
      ]),
    });
  }
  return out;
}

function dnsRecords(creds, zoneId) {
  var project = projectForRegion(creds, regionOfCreds(creds));
  var items = paginate(
    creds,
    DNS_HOST,
    "/v2/zones/" + zoneId + "/recordsets",
    { offset: 0 },
    project.id,
    ["recordsets"]
  );
  var out = [];
  for (var i = 0; i < items.length; i++) {
    var rec = items[i];
    var values = Array.isArray(rec.records) ? rec.records.join(",") : jstr(rec, ["records"]);
    out.push({
      id: jstr(rec, ["id"]),
      kind: "dnsRecord",
      name: jstr(rec, ["name"]),
      status: jstr(rec, ["status"]),
      fields: fieldMap([
        ["type", jstr(rec, ["type"])],
        ["value", values],
        ["ttl", jstr(rec, ["ttl"])],
        ["rr", jstr(rec, ["name"])],
      ]),
    });
  }
  return out;
}

function getResource(args) {
  var creds = credsOf(args);
  var cap = str(args.capability).trim();
  var id = str(args.resourceId || args.id).trim();
  if (!id) throw new Error("缺少资源 id");
  var region = str(args.regionId || args.region).trim() || regionOfCreds(creds);
  var scoped = withRegion(creds, region);
  var consoleBase = "https://console.huaweicloud.com/";
  if (cap === "compute" || cap === "compute.lite") {
    var server = regionalCall(scoped, "ecs", "GET", "/v1/{project_id}/cloudservers/" + id, {}, null);
    var item = server.server || server;
    var row = mapEcs(item, region, cap);
    var detail = fromRow(row, consoleBase + "ecm/ecs/manager/vm/detail?instanceId=" + id + "&region=" + region);
    detail.related = [];
    var sgs = sgIdsOf(item).split(",");
    for (var i = 0; i < sgs.length; i++) {
      if (sgs[i]) detail.related.push({ capability: "network.securityGroup", resourceId: sgs[i], name: sgs[i], role: "sg" });
    }
    detail.metricIds = [
      "CPUUtilization",
      "memory_usedutilization",
      "InternetInRate",
      "InternetOutRate",
      "DiskReadBPS",
      "DiskWriteBPS",
    ];
    detail.extra = item;
    try {
      var disks = listDisks(scoped);
      var attached = 0;
      for (var d = 0; d < disks.length; d++) {
        var atts = disks[d].attachments || [];
        for (var a = 0; a < atts.length; a++) {
          if (jstr(atts[a], ["server_id"]) === id) {
            attached += 1;
            detail.related.push({
              capability: "storage.disk",
              resourceId: jstr(disks[d], ["id"]),
              name: displayName(jstr(disks[d], ["name"]), jstr(disks[d], ["id"])),
              role: "disk",
            });
          }
        }
      }
      if (attached) detail.fields.diskCount = String(attached);
    } catch (e) {}
    return detail;
  }
  if (cap === "network.securityGroup") {
    item = firstOrThrow(
      listSgs(scoped).filter(function (x) {
        return jstr(x, ["id"]) === id;
      }),
      id,
      "安全组"
    );
    detail = fromRow(mapSg(item, region), consoleBase + "vpc/security-group");
    detail.rules = sgRules(item);
    detail.extra = item;
    return detail;
  }
  if (cap === "network.eip") {
    item = firstOrThrow(
      listEips(scoped).filter(function (x) {
        return jstr(x, ["id"]) === id;
      }),
      id,
      "弹性公网 IP"
    );
    detail = fromRow(mapEip(item, region), consoleBase + "vpc/eip");
    detail.metricIds = ["InternetInRate", "InternetOutRate"];
    detail.extra = item;
    return detail;
  }
  if (cap === "network.loadBalancer") {
    item = firstOrThrow(
      listLbs(scoped).filter(function (x) {
        return jstr(x, ["id"]) === id;
      }),
      id,
      "负载均衡"
    );
    detail = fromRow(mapLb(item, region), consoleBase + "elb");
    detail.metricIds = ["InternetInRate", "InternetOutRate"];
    detail.extra = item;
    return detail;
  }
  if (cap === "database") {
    item = firstOrThrow(
      listRds(scoped).filter(function (x) {
        return jstr(x, ["id"]) === id;
      }),
      id,
      "RDS 实例"
    );
    detail = fromRow(mapRds(item, region), consoleBase + "rds");
    detail.metricIds = ["CPUUtilization", "memory_usedutilization"];
    detail.logKinds = ["slow"];
    detail.extra = item;
    return detail;
  }
  if (cap === "database.cache") {
    item = firstOrThrow(
      listDcs(scoped).filter(function (x) {
        return jstr(x, ["instance_id", "id"]) === id;
      }),
      id,
      "DCS 实例"
    );
    detail = fromRow(mapDcs(item, region), consoleBase + "dcs");
    detail.metricIds = ["CPUUtilization", "memory_usedutilization"];
    detail.extra = item;
    return detail;
  }
  if (cap === "storage.disk") {
    item = firstOrThrow(
      listDisks(scoped).filter(function (x) {
        return jstr(x, ["id"]) === id;
      }),
      id,
      "云硬盘"
    );
    detail = fromRow(mapDisk(item, region), consoleBase + "evs");
    detail.extra = item;
    return detail;
  }
  if (cap === "objectStorage") {
    var buckets = listObsBuckets(creds).map(mapObs);
    item = firstOrThrow(
      buckets.filter(function (x) {
        return x.id === id;
      }),
      id,
      "OBS 桶"
    );
    return fromRow(item, consoleBase + "obs");
  }
  if (cap === "domains" || cap === "dns") {
    var zones = listDnsZones(creds);
    item = firstOrThrow(
      zones.filter(function (x) {
        return jstr(x, ["id"]) === id;
      }),
      id,
      "DNS 域名"
    );
    detail = fromRow(mapZone(item), consoleBase + "dns");
    try {
      detail.children = dnsRecords(creds, id);
      detail.fields.recordCount = String(detail.children.length);
    } catch (e) {}
    detail.extra = item;
    return detail;
  }
  if (cap === "certs") {
    var certs = listCerts(creds);
    item = firstOrThrow(
      certs.filter(function (x) {
        return jstr(x, ["id", "certificate_id"]) === id;
      }),
      id,
      "证书"
    );
    return fromRow(mapCert(item), consoleBase + "scm");
  }
  throw new Error("华为云本期未实现能力: " + cap);
}

function parsePortRange(raw) {
  var s = nonemptyOr(raw, "1-65535");
  if (s.toUpperCase() === "ALL") return { min: 1, max: 65535 };
  var parts = s.split("-");
  var min = parseInt(parts[0], 10);
  var max = parts.length > 1 ? parseInt(parts[1], 10) : min;
  if (isNaN(min)) min = 1;
  if (isNaN(max)) max = min;
  return { min: min, max: max };
}

function primaryPortId(creds, instanceId) {
  var ports = regionalGet(creds, "vpc", "/v1/{project_id}/ports", { device_id: instanceId, offset: 1 }, ["ports"]);
  if (!ports.length) throw new Error("未找到实例网卡: " + instanceId);
  return jstr(ports[0], ["id"]);
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
  if ((cap === "compute" || cap === "compute.lite") && (name === "start" || name === "stop" || name === "reboot")) {
    var body = {};
    if (name === "start") body["os-start"] = { servers: [{ id: id }] };
    else if (name === "stop") body["os-stop"] = { type: "SOFT", servers: [{ id: id }] };
    else body.reboot = { type: "SOFT", servers: [{ id: id }] };
    regionalCall(scoped, "ecs", "POST", "/v1/{project_id}/cloudservers/action", {}, body);
  } else if ((cap === "compute" || cap === "compute.lite") && name === "createsnapshot") {
    var diskId = param(action, "diskId");
    if (!diskId) {
      var disks = listDisks(scoped);
      for (var i = 0; i < disks.length; i++) {
        var atts = disks[i].attachments || [];
        for (var a = 0; a < atts.length; a++) {
          if (jstr(atts[a], ["server_id"]) === id && str(disks[i].bootable) === "true") {
            diskId = jstr(disks[i], ["id"]);
          }
        }
      }
    }
    if (!diskId) throw new Error("缺少云盘 id");
    regionalCall(scoped, "evs", "POST", "/v2/{project_id}/cloudsnapshots", {}, {
      snapshot: { volume_id: diskId, name: nonemptyOr(param(action, "snapshotName"), "snap-" + diskId.slice(0, 8)) },
    });
  } else if (cap === "network.securityGroup" && (name === "authorizerule" || name === "revokerule")) {
    if (name === "revokerule") {
      var ruleId = param(action, "ruleId");
      if (!ruleId) throw new Error("缺少规则 id");
      regionalCall(scoped, "vpc", "DELETE", "/v1/{project_id}/security-group-rules/" + ruleId, {}, null);
    } else {
      var ports = parsePortRange(param(action, "portRange"));
      regionalCall(scoped, "vpc", "POST", "/v1/{project_id}/security-group-rules", {}, {
        security_group_rule: {
          security_group_id: id,
          direction: nonemptyOr(param(action, "direction").toLowerCase(), "ingress"),
          ethertype: "IPv4",
          protocol: nonemptyOr(param(action, "protocol").toLowerCase(), "tcp"),
          port_range_min: ports.min,
          port_range_max: ports.max,
          remote_ip_prefix: nonemptyOr(param(action, "cidr"), "0.0.0.0/0"),
          description: param(action, "description"),
        },
      });
    }
  } else if (cap === "network.eip" && name === "attach") {
    var inst = param(action, "instanceId");
    if (!inst) throw new Error("缺少要绑定的实例 id");
    regionalCall(scoped, "vpc", "PUT", "/v1/{project_id}/publicips/" + id, {}, {
      publicip: { port_id: primaryPortId(scoped, inst) },
    });
  } else if (cap === "network.eip" && name === "detach") {
    regionalCall(scoped, "vpc", "PUT", "/v1/{project_id}/publicips/" + id, {}, { publicip: { port_id: null } });
  } else if (cap === "network.eip" && name === "modifybandwidth") {
    var bandwidth = param(action, "bandwidth");
    if (!bandwidth) throw new Error("请填写带宽");
    var eips = listEips(scoped);
    var eip = firstOrThrow(
      eips.filter(function (x) {
        return jstr(x, ["id"]) === id;
      }),
      id,
      "弹性公网 IP"
    );
    var bwId = jstr(eip, ["bandwidth_id"]);
    if (!bwId) throw new Error("该 EIP 没有独立带宽 id");
    regionalCall(scoped, "vpc", "PUT", "/v2.0/{project_id}/bandwidths/" + bwId, {}, {
      bandwidth: { size: parseInt(bandwidth, 10) || 1 },
    });
  } else if (cap === "network.loadBalancer" && (name === "start" || name === "stop")) {
    throw new Error("ELB 不支持该操作");
  } else if (cap === "database" && (name === "start" || name === "stop" || name === "reboot")) {
    var actionBody = {};
    if (name === "reboot") actionBody.restart = {};
    else if (name === "start") actionBody.start = {};
    else actionBody.stop = {};
    regionalCall(scoped, "rds", "POST", "/v3/{project_id}/instances/" + id + "/action", {}, actionBody);
  } else if (cap === "database.cache" && name === "reboot") {
    regionalCall(scoped, "dcs", "PUT", "/v2/{project_id}/instances/" + id + "/restart", {}, {});
  } else if (cap === "database.cache" && (name === "start" || name === "stop")) {
    throw new Error("DCS 仅支持重启");
  } else if (cap === "storage.disk" && name === "attach") {
    inst = param(action, "instanceId");
    if (!inst) throw new Error("缺少要挂载的实例 id");
    regionalCall(scoped, "evs", "POST", "/v2/{project_id}/cloudvolumes/" + id + "/action", {}, {
      "os-attach": { instance_id: inst },
    });
  } else if (cap === "storage.disk" && name === "detach") {
    regionalCall(scoped, "evs", "POST", "/v2/{project_id}/cloudvolumes/" + id + "/action", {}, { "os-detach": {} });
  } else if (cap === "storage.disk" && name === "createsnapshot") {
    regionalCall(scoped, "evs", "POST", "/v2/{project_id}/cloudsnapshots", {}, {
      snapshot: { volume_id: id, name: nonemptyOr(param(action, "snapshotName"), "snap-" + id.slice(0, 8)) },
    });
  } else if ((cap === "domains" || cap === "dns") && (name === "addrecord" || name === "updaterecord" || name === "deleterecord" || name === "deletercord")) {
    var project = projectForRegion(creds, regionOfCreds(creds));
    if (name === "addrecord") {
      var rr = param(action, "rr");
      var rtype = param(action, "type");
      var value = param(action, "value");
      if (!rr || !rtype || !value) throw new Error("解析记录需要主机记录、类型与记录值");
      var zone = firstOrThrow(
        listDnsZones(creds).filter(function (x) {
          return jstr(x, ["id"]) === id;
        }),
        id,
        "DNS 域名"
      );
      var fqdn = rr === "@" ? jstr(zone, ["name"]) : rr + "." + jstr(zone, ["name"]);
      hwCall(
        creds,
        DNS_HOST,
        "POST",
        "/v2/zones/" + id + "/recordsets",
        {},
        {
          name: fqdn,
          type: rtype.toUpperCase(),
          records: [value],
          ttl: parseInt(param(action, "ttl"), 10) || 300,
        },
        project.id
      );
    } else if (name === "updaterecord") {
      var recordId = param(action, "recordId");
      if (!recordId) throw new Error("缺少记录 id");
      hwCall(
        creds,
        DNS_HOST,
        "PUT",
        "/v2/zones/" + id + "/recordsets/" + recordId,
        {},
        {
          name: param(action, "rr") || undefined,
          type: param(action, "type") ? param(action, "type").toUpperCase() : undefined,
          records: param(action, "value") ? [param(action, "value")] : undefined,
          ttl: param(action, "ttl") ? parseInt(param(action, "ttl"), 10) : undefined,
        },
        project.id
      );
    } else {
      recordId = param(action, "recordId");
      if (!recordId) throw new Error("缺少记录 id");
      hwCall(creds, DNS_HOST, "DELETE", "/v2/zones/" + id + "/recordsets/" + recordId, {}, null, project.id);
    }
  } else {
    throw new Error("不支持的动作: " + cap + "/" + name);
  }
  return { ok: true, message: name + " 已提交" };
}

function metricNs(cap) {
  if (cap === "compute" || cap === "compute.lite") return "SYS.ECS";
  if (cap === "database") return "SYS.RDS";
  if (cap === "database.cache") return "SYS.DCS";
  if (cap === "network.eip") return "SYS.VPC";
  if (cap === "network.loadBalancer") return "SYS.ELB";
  return "";
}

function metricName(cap, id) {
  var table = {
    CPUUtilization: "cpu_util",
    memory_usedutilization: "mem_util",
    InternetInRate: "network_incoming_bytes_rate_inband",
    InternetOutRate: "network_outgoing_bytes_rate_inband",
    DiskReadBPS: "disk_read_bytes_rate",
    DiskWriteBPS: "disk_write_bytes_rate",
  };
  if (cap === "database") {
    table.CPUUtilization = "rds001_cpu_util";
    table.memory_usedutilization = "rds002_mem_util";
  }
  if (cap === "database.cache") {
    table.CPUUtilization = "cpu_usage";
    table.memory_usedutilization = "memory_usage";
  }
  if (cap === "network.eip") {
    table.InternetInRate = "downstream_bandwidth";
    table.InternetOutRate = "upstream_bandwidth";
  }
  return table[id] || "";
}

function metricDim(cap) {
  if (cap === "compute" || cap === "compute.lite") return "instance_id";
  if (cap === "database") return "rds_cluster_id";
  if (cap === "database.cache") return "dcs_instance_id";
  if (cap === "network.eip") return "publicip_id";
  if (cap === "network.loadBalancer") return "lbaas_instance_id";
  return "instance_id";
}

function defaultMetrics(cap) {
  if (cap === "compute" || cap === "compute.lite") {
    return [
      "CPUUtilization",
      "memory_usedutilization",
      "InternetInRate",
      "InternetOutRate",
      "DiskReadBPS",
      "DiskWriteBPS",
    ];
  }
  return ["CPUUtilization", "memory_usedutilization"];
}

function metricLabel(id) {
  var labels = {
    CPUUtilization: "CPU",
    memory_usedutilization: "内存",
    InternetInRate: "入网",
    InternetOutRate: "出网",
    DiskReadBPS: "磁盘读",
    DiskWriteBPS: "磁盘写",
  };
  return labels[id] || id;
}

function metricUnit(id) {
  if (id === "CPUUtilization" || id === "memory_usedutilization") return "%";
  return "";
}

function getMetrics(args) {
  var creds = credsOf(args);
  var cap = str(args.capability).trim();
  var id = str(args.resourceId || args.id).trim();
  if (!id) throw new Error("缺少资源 id");
  var ns = metricNs(cap);
  if (!ns) throw new Error("该能力不支持监控: " + cap);
  var region = str(args.regionId || args.region).trim() || regionOfCreds(creds);
  var scoped = withRegion(creds, region);
  var project = projectForRegion(scoped, region);
  var query = args.query || {};
  var now = Date.now();
  var endMs = Number(query.endMs) > 0 ? Number(query.endMs) : now;
  var startMs = Number(query.startMs) > 0 ? Number(query.startMs) : endMs - 3600000;
  var period = Number(query.periodSec) > 0 ? Number(query.periodSec) : 300;
  var ids = query.metricIds && query.metricIds.length ? query.metricIds : defaultMetrics(cap);
  var dim = metricDim(cap);
  var out = [];
  for (var i = 0; i < ids.length; i++) {
    var mid = ids[i];
    var cesName = metricName(cap, mid);
    var points = [];
    if (cesName) {
      try {
        var resp = hwCall(
          scoped,
          svcHost("ces", region),
          "GET",
          "/V1.0/" + project.id + "/metric-data",
          {
            namespace: ns,
            metric_name: cesName,
            from: String(startMs),
            to: String(endMs),
            period: String(period),
            filter: "average",
            "dim.0": dim + "," + id,
          },
          null,
          project.id
        );
        var dps = jarr(resp, ["datapoints"]);
        for (var p = 0; p < dps.length; p++) {
          var ts = Number(dps[p].timestamp) || 0;
          var val = dps[p].average != null ? Number(dps[p].average) : Number(dps[p].max);
          if (!isNaN(val)) points.push({ tsMs: ts, value: val });
        }
      } catch (e) {}
    }
    out.push({ id: mid, label: metricLabel(mid), unit: metricUnit(mid), points: points });
  }
  return out;
}

function parseLogTs(raw) {
  var trimmed = str(raw).trim();
  if (!trimmed) return 0;
  var n = parseInt(trimmed, 10);
  if (String(n) === trimmed) return n > 1000000000000 ? n : n * 1000;
  var m = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return 0;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

function queryLogs(args) {
  var creds = credsOf(args);
  var cap = str(args.capability).trim();
  var id = str(args.resourceId || args.id).trim();
  if (!id) throw new Error("缺少资源 id");
  var region = str(args.regionId || args.region).trim() || regionOfCreds(creds);
  var scoped = withRegion(creds, region);
  var query = args.query || {};
  var page = Number(query.page) > 0 ? Number(query.page) : 1;
  var pageSize = Number(query.pageSize) > 0 ? Math.min(Number(query.pageSize), 100) : 50;
  if (cap !== "database") return { kind: str(query.kind || "slow"), total: 0, page: page, entries: [] };
  var now = new Date();
  var end = now.toISOString().slice(0, 19);
  var startDate = new Date(now.getTime() - 86400000).toISOString().slice(0, 19);
  var entries = [];
  try {
    var body = regionalCall(
      scoped,
      "rds",
      "GET",
      "/v3/{project_id}/instances/" + id + "/slowlog",
      { start_date: startDate, end_date: end, limit: String(pageSize), offset: String((page - 1) * pageSize) },
      null
    );
    var items = jarr(body, ["slowlog_list", "slow_log_list"]);
    for (var i = 0; i < items.length; i++) {
      var sql = jstr(items[i], ["query_sample", "sql", "query"]);
      entries.push({
        id: jstr(items[i], ["database", "users"]) + ":" + i,
        tsMs: parseLogTs(jstr(items[i], ["start_time", "execute_time"])),
        severity: "slow",
        summary: sql.slice(0, 240),
        fields: fieldMap([
          ["db", jstr(items[i], ["database"])],
          ["queryTimes", jstr(items[i], ["query_time", "query_time_num"])],
          ["sql", sql],
        ]),
      });
    }
    var total = parseInt(jstr(body, ["total_record", "total"]), 10);
    if (isNaN(total)) total = entries.length;
    return { kind: "slow", total: total, page: page, entries: entries };
  } catch (e) {
    return { kind: "slow", total: 0, page: page, entries: [] };
  }
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
