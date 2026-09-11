/**
 * 腾讯云 L2（QuickJS）。TC3 / COS 签名走 host.hmac + host.hash，网络走 host.netFetch。
 */
var DEFAULT_REGION = "ap-guangzhou";
var PAGE_LIMIT = 100;
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
    if (x && typeof x === "object") {
      var nested = [
        "Instance", "Item", "Items", "Domain", "Certificate", "Region", "Record",
        "Listener", "Target", "Disk", "Snapshot", "Address", "LoadBalancer",
        "SecurityGroup", "Group",
      ];
      for (var n = 0; n < nested.length; n++) {
        var y = x[nested[n]];
        if (Array.isArray(y)) return y;
        if (y && typeof y === "object" && Object.keys(y).length) return [y];
      }
    }
  }
  return [];
}

function jips(v, keys) {
  if (!v || typeof v !== "object") return "";
  for (var i = 0; i < keys.length; i++) {
    var x = v[keys[i]];
    if (Array.isArray(x)) {
      var parts = [];
      for (var k = 0; k < x.length; k++) {
        var item = x[k];
        var ip = typeof item === "string" ? item : jstr(item, ["Ip", "AddressIp"]);
        if (ip) parts.push(ip);
      }
      if (parts.length) return parts.join(",");
    }
    var direct = jstr(v, [keys[i]]);
    if (direct) return direct;
  }
  return "";
}

function hmac(spec) {
  return host.hmac(JSON.stringify(spec));
}

function hashHex(alg, data) {
  return host.hash(JSON.stringify({ alg: alg, data: data, encoding: "hex" }));
}

function hmacUtf8(alg, key, data) {
  return hmac({ alg: alg, key: key, data: data, encoding: "hex" });
}

function hmacHexKey(alg, keyHex, data) {
  return hmac({
    alg: alg,
    key: keyHex,
    data: data,
    encoding: "hex",
    keyEncoding: "hex",
  });
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

function utcDate(sec) {
  var p = utcParts(sec * 1000);
  return p.y + "-" + p.m + "-" + p.d;
}

function formatTcTimeSec(sec) {
  var p = utcParts(sec * 1000);
  return p.y + "-" + p.m + "-" + p.d + " " + p.h + ":" + p.min + ":" + p.s;
}

function formatMonitorTime(ms) {
  if (ms > 0 && ms < 1000000000000) ms *= 1000;
  var p = utcParts(ms);
  return p.y + "-" + p.m + "-" + p.d + "T" + p.h + ":" + p.min + ":" + p.s + "+08:00";
}

function credsOf(args) {
  var raw = args.credentials || args.creds || args;
  var id = str(raw.accessKeyId || raw.secretId || raw.SecretId || args.accessKeyId).trim();
  var secret = str(raw.accessKeySecret || raw.secretKey || raw.SecretKey || args.accessKeySecret).trim();
  if (!id || !secret) throw new Error("缺少 SecretId / SecretKey");
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

function parseErrorJson(body) {
  var err = (body && body.Response && body.Response.Error) || (body && body.Error);
  if (!err) return null;
  var code = jstr(err, ["Code"]);
  var message = jstr(err, ["Message"]);
  if (!code && !message) return null;
  return { code: code, message: message };
}

function tc3Call(creds, service, version, action, region, body) {
  var hostName = service + ".tencentcloudapi.com";
  var payload = body == null ? "{}" : JSON.stringify(body);
  var timestamp = Math.floor(Date.now() / 1000);
  var date = utcDate(timestamp);
  var hashedPayload = hashHex("sha256", payload);
  var canonicalHeaders =
    "content-type:application/json; charset=utf-8\nhost:" +
    hostName +
    "\nx-tc-action:" +
    action.toLowerCase() +
    "\n";
  var signedHeaders = "content-type;host;x-tc-action";
  var canonicalRequest =
    "POST\n/\n\n" + canonicalHeaders + "\n" + signedHeaders + "\n" + hashedPayload;
  var credentialScope = date + "/" + service + "/tc3_request";
  var stringToSign =
    "TC3-HMAC-SHA256\n" +
    timestamp +
    "\n" +
    credentialScope +
    "\n" +
    hashHex("sha256", canonicalRequest);
  var secretDate = hmacUtf8("sha256", "TC3" + creds.accessKeySecret, date);
  var secretService = hmacHexKey("sha256", secretDate, service);
  var secretSigning = hmacHexKey("sha256", secretService, "tc3_request");
  var signature = hmacHexKey("sha256", secretSigning, stringToSign);
  var authorization =
    "TC3-HMAC-SHA256 Credential=" +
    creds.accessKeyId +
    "/" +
    credentialScope +
    ", SignedHeaders=" +
    signedHeaders +
    ", Signature=" +
    signature;
  var headers = {
    Authorization: authorization,
    "Content-Type": "application/json; charset=utf-8",
    Host: hostName,
    "X-TC-Action": action,
    "X-TC-Version": version,
    "X-TC-Timestamp": String(timestamp),
  };
  if (str(region).trim()) headers["X-TC-Region"] = str(region).trim();
  var text = host.netFetch(
    JSON.stringify({
      url: "https://" + hostName + "/",
      method: "POST",
      headers: headers,
      body: payload,
    })
  );
  var parsed = {};
  try {
    parsed = JSON.parse(text || "{}");
  } catch (e) {
    throw new Error("腾讯云 " + action + " 响应非 JSON");
  }
  var err = parseErrorJson(parsed);
  if (err) throw new Error("腾讯云 " + action + " 失败: " + err.code + " " + err.message);
  return parsed.Response || parsed;
}

function paginate(creds, service, version, action, region, extra, listKeys) {
  extra = extra && typeof extra === "object" ? extra : {};
  var out = [];
  var offset = 0;
  while (true) {
    var body = {};
    for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) body[k] = extra[k];
    body.Offset = offset;
    body.Limit = PAGE_LIMIT;
    var resp = tc3Call(creds, service, version, action, region, body);
    var items = jarr(resp, listKeys);
    out = out.concat(items);
    if (!items.length || items.length < PAGE_LIMIT || out.length >= PAGE_MAX) break;
    offset += PAGE_LIMIT;
    if (offset >= PAGE_MAX) break;
  }
  if (out.length > PAGE_MAX) out.length = PAGE_MAX;
  return out;
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

function listCosBuckets(creds) {
  var hostName = "service.cos.myqcloud.com";
  var now = Math.floor(Date.now() / 1000);
  var keyTime = now + ";" + (now + 600);
  var httpString = "get\n/\n\nhost=" + hostName + "\n";
  var httpStringHash = hashHex("sha1", httpString);
  var stringToSign = "sha1\n" + keyTime + "\n" + httpStringHash;
  var signKey = hmacUtf8("sha1", creds.accessKeySecret, keyTime);
  var signature = hmacUtf8("sha1", signKey, stringToSign);
  var authorization =
    "q-sign-algorithm=sha1&q-ak=" +
    creds.accessKeyId +
    "&q-sign-time=" +
    keyTime +
    "&q-key-time=" +
    keyTime +
    "&q-header-list=host&q-url-param-list=&q-signature=" +
    signature;
  var text = host.netFetch(
    JSON.stringify({
      url: "https://" + hostName + "/",
      method: "GET",
      headers: { Host: hostName, Authorization: authorization },
    })
  );
  var code = xmlTag(text, "Code");
  if (code && code !== "200") {
    throw new Error("COS GetService 失败: " + code + " " + xmlTag(text, "Message"));
  }
  var blocks = xmlBlocks(text, "Bucket");
  var out = [];
  for (var i = 0; i < blocks.length; i++) {
    out.push({
      Name: xmlTag(blocks[i], "Name"),
      Location: xmlTag(blocks[i], "Location"),
      CreationDate: xmlTag(blocks[i], "CreationDate"),
    });
  }
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
  if (u === "RUNNING" || u === "ONLINE" || u === "NORMAL" || u === "AVAILABLE") return "RUNNING";
  if (u === "STOPPED" || u === "OFFLINE" || u === "SHUTDOWN" || u === "ISOLATED") return "STOPPED";
  if (u === "PENDING" || u === "STARTING" || u === "LAUNCHING" || u === "CREATING") return "PENDING";
  if (u === "STOPPING" || u === "SHUTTING_DOWN") return "STOPPING";
  if (u === "REBOOTING" || u === "RESTARTING") return "REBOOTING";
  if (u === "1" || u === "2") return "RUNNING";
  if (u === "0" || u === "4" || u === "5" || u === "-2") return "STOPPED";
  return str(raw).trim();
}

function displayName(name, fallback) {
  return str(name).trim() ? name : fallback;
}

function regionOfItem(item, fallback) {
  var id = jstr(item, ["Region", "RegionId"]);
  return id || fallback;
}

function zoneOf(item) {
  var direct = jstr(item, ["Zone", "ZoneId"]);
  if (direct) return direct;
  return item && item.Placement ? jstr(item.Placement, ["Zone"]) : "";
}

function vpcOf(item) {
  var direct = jstr(item, ["VpcId", "UniqVpcId", "VirtualPrivateCloudId"]);
  if (direct) return direct;
  return item && item.VirtualPrivateCloud ? jstr(item.VirtualPrivateCloud, ["VpcId"]) : "";
}

function sgIds(item) {
  var joined = jips(item, ["SecurityGroupIds"]);
  return joined || jstr(item, ["SecurityGroupIds"]);
}

function relatedVpc(vpcId) {
  var id = str(vpcId).trim();
  if (!id) return null;
  return { capability: "", resourceId: id, name: id, role: "vpc" };
}

function relatedSgs(ids) {
  var out = [];
  var parts = str(ids).split(",");
  for (var i = 0; i < parts.length; i++) {
    var id = parts[i].trim();
    if (!id) continue;
    out.push({
      capability: "network.securityGroup",
      resourceId: id,
      name: id,
      role: "securityGroup",
    });
  }
  return out;
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

function mapCvm(item, region) {
  var id = jstr(item, ["InstanceId"]);
  var bw = item && item.InternetAccessible ? jstr(item.InternetAccessible, ["InternetMaxBandwidthOut"]) : "";
  return {
    id: id,
    name: displayName(jstr(item, ["InstanceName"]), id),
    capability: "compute",
    regionId: regionOfItem(item, region),
    status: mapStatus(jstr(item, ["InstanceState", "Status"])),
    fields: fieldMap([
      ["publicIp", jips(item, ["PublicIpAddresses", "PublicIpAddress"])],
      ["privateIp", jips(item, ["PrivateIpAddresses", "PrivateIpAddress"])],
      ["instanceType", jstr(item, ["InstanceType"])],
      ["zone", zoneOf(item)],
      ["os", jstr(item, ["OsName", "ImageId"])],
      ["creationTime", jstr(item, ["CreatedTime", "CreationTime"])],
      ["expiredTime", jstr(item, ["ExpiredTime"])],
      ["chargeType", jstr(item, ["InstanceChargeType", "ChargeType"])],
      ["securityGroups", sgIds(item)],
      ["cpu", jstr(item, ["CPU", "Cpu"])],
      ["memory", jstr(item, ["Memory"])],
      ["hostname", jstr(item, ["Uuid", "InstanceName"])],
      ["bandwidth", bw],
      ["vpcId", vpcOf(item)],
    ]),
  };
}

function mapLite(item, region) {
  var id = jstr(item, ["InstanceId"]);
  var bw =
    item && item.InternetAccessible
      ? jstr(item.InternetAccessible, ["InternetMaxBandwidthOut"])
      : jstr(item, ["InternetMaxBandwidthOut"]);
  var disk = item && item.SystemDisk ? jstr(item.SystemDisk, ["DiskSize"]) : "";
  return {
    id: id,
    name: displayName(jstr(item, ["InstanceName"]), id),
    capability: "compute.lite",
    regionId: regionOfItem(item, region),
    status: mapStatus(jstr(item, ["InstanceState", "Status"])),
    fields: fieldMap([
      ["publicIp", jips(item, ["PublicAddresses", "PublicIpAddresses"])],
      ["privateIp", jips(item, ["PrivateAddresses", "PrivateIpAddresses"])],
      ["plan", jstr(item, ["BundleId", "InstanceType"])],
      ["imageId", jstr(item, ["BlueprintId", "ImageId"])],
      ["creationTime", jstr(item, ["CreatedTime"])],
      ["expiredTime", jstr(item, ["ExpiredTime"])],
      ["chargeType", jstr(item, ["InstanceChargeType"])],
      ["bandwidth", bw],
      ["diskSize", disk],
      ["zone", zoneOf(item)],
    ]),
  };
}

function mapSg(item, region) {
  var id = jstr(item, ["SecurityGroupId"]);
  return {
    id: id,
    name: displayName(jstr(item, ["SecurityGroupName"]), id),
    capability: "network.securityGroup",
    regionId: regionOfItem(item, region),
    status: vpcOf(item) ? "vpc" : "classic",
    fields: fieldMap([
      ["vpcId", vpcOf(item)],
      ["description", jstr(item, ["SecurityGroupDesc", "Description"])],
      ["creationTime", jstr(item, ["CreatedTime", "CreationTime"])],
      ["projectId", jstr(item, ["ProjectId"])],
    ]),
  };
}

function mapEip(item, region) {
  var id = jstr(item, ["AddressId"]);
  var ip = jstr(item, ["AddressIp"]);
  return {
    id: id,
    name: displayName(jstr(item, ["AddressName"]), ip),
    capability: "network.eip",
    regionId: regionOfItem(item, region),
    status: jstr(item, ["AddressStatus", "Status"]),
    fields: fieldMap([
      ["publicIp", ip],
      ["bandwidth", jstr(item, ["Bandwidth", "InternetMaxBandwidthOut"])],
      ["instanceId", jstr(item, ["InstanceId"])],
      ["instanceType", jstr(item, ["InstanceType"])],
      ["chargeType", jstr(item, ["InternetChargeType", "ChargeType"])],
    ]),
  };
}

function mapLb(item, region) {
  var id = jstr(item, ["LoadBalancerId"]);
  return {
    id: id,
    name: displayName(jstr(item, ["LoadBalancerName"]), id),
    capability: "network.loadBalancer",
    regionId: regionOfItem(item, region),
    status: mapStatus(jstr(item, ["Status", "LoadBalancerStatus"])),
    fields: fieldMap([
      ["publicIp", jips(item, ["LoadBalancerVips", "Address"])],
      ["addressType", jstr(item, ["LoadBalancerType", "AddressIPVersion"])],
      ["instanceClass", jstr(item, ["LoadBalancerPassToTarget", "Forward"])],
      ["bandwidth", jstr(item, ["Bandwidth", "InternetMaxBandwidthOut"])],
      ["vpcId", vpcOf(item)],
    ]),
  };
}

function nonemptyOr(value, fallback) {
  return str(value).trim() ? value : fallback;
}

function mapCdb(item, region) {
  var id = jstr(item, ["InstanceId"]);
  return {
    id: id,
    name: displayName(jstr(item, ["InstanceName"]), id),
    capability: "database",
    regionId: regionOfItem(item, region),
    status: mapStatus(jstr(item, ["Status"])),
    fields: fieldMap([
      ["engine", nonemptyOr(jstr(item, ["EngineType", "DeviceType"]), "MySQL")],
      ["engineVersion", jstr(item, ["EngineVersion"])],
      ["instanceClass", jstr(item, ["Memory", "InstanceType"])],
      ["storage", jstr(item, ["Volume", "DiskSize"])],
      ["zone", zoneOf(item)],
      ["connectionString", nonemptyOr(jstr(item, ["Vip", "WanDomain"]), jstr(item, ["UniqVpcId"]))],
      ["port", jstr(item, ["Vport", "WanPort"])],
      ["vpcId", vpcOf(item)],
      ["chargeType", jstr(item, ["PayType", "ChargeType"])],
      ["expiredTime", jstr(item, ["DeadlineTime", "ExpiredTime"])],
    ]),
  };
}

function mapRedis(item, region) {
  var id = jstr(item, ["InstanceId"]);
  return {
    id: id,
    name: displayName(jstr(item, ["InstanceName"]), id),
    capability: "database.cache",
    regionId: regionOfItem(item, region),
    status: mapStatus(jstr(item, ["Status"])),
    fields: fieldMap([
      ["engine", nonemptyOr(jstr(item, ["Type", "ProductType"]), "Redis")],
      ["engineVersion", jstr(item, ["CurrentRedisVersion", "RedisVersion"])],
      ["instanceClass", jstr(item, ["Size", "RedisShardSize"])],
      ["capacity", jstr(item, ["Size"])],
      ["zone", zoneOf(item)],
      ["connectionString", jstr(item, ["WanIp", "Vip"])],
      ["port", jstr(item, ["Port"])],
      ["vpcId", vpcOf(item)],
      ["chargeType", jstr(item, ["BillingMode", "PayMode"])],
      ["expiredTime", jstr(item, ["DeadlineTime", "ExpiredTime"])],
    ]),
  };
}

function mapDisk(item, region) {
  var id = jstr(item, ["DiskId"]);
  return {
    id: id,
    name: displayName(jstr(item, ["DiskName"]), id),
    capability: "storage.disk",
    regionId: regionOfItem(item, region),
    status: jstr(item, ["DiskState", "Status"]),
    fields: fieldMap([
      ["size", jstr(item, ["DiskSize"])],
      ["category", jstr(item, ["DiskType"])],
      ["type", jstr(item, ["DiskUsage"])],
      ["zone", zoneOf(item)],
      ["instanceId", jstr(item, ["InstanceId"])],
      ["chargeType", jstr(item, ["DiskChargeType"])],
    ]),
  };
}

function mapCos(item) {
  var name = jstr(item, ["Name"]);
  var location = jstr(item, ["Location"]);
  return {
    id: name,
    name: name,
    capability: "objectStorage",
    regionId: location,
    status: jstr(item, ["BucketType", "Location"]),
    fields: fieldMap([
      ["storageClass", jstr(item, ["BucketType"])],
      ["creationDate", jstr(item, ["CreationDate"])],
      ["endpoint", location ? "cos." + location + ".myqcloud.com" : ""],
      ["location", location],
    ]),
  };
}

function mapCert(item) {
  var id = jstr(item, ["CertificateId", "Id"]);
  return {
    id: id,
    name: displayName(jstr(item, ["Alias", "Domain"]), id),
    capability: "certs",
    regionId: "",
    status: jstr(item, ["StatusName", "Status"]),
    fields: fieldMap([
      ["domain", jstr(item, ["Domain", "SubjectAltName"])],
      ["product", jstr(item, ["ProductZhName", "ProductType"])],
      ["certType", jstr(item, ["CertType", "CertificateType"])],
      ["buyDate", jstr(item, ["CertBeginTime", "InsertTime"])],
      ["endDate", jstr(item, ["CertEndTime", "ExpireTime"])],
    ]),
  };
}

function mapDnsPod(item) {
  var name = jstr(item, ["Name", "Domain", "Punycode"]);
  return {
    id: name,
    name: name,
    capability: "domains",
    regionId: "",
    status: jstr(item, ["Status", "Grade"]),
    fields: fieldMap([
      ["domain", name],
      ["recordCount", jstr(item, ["RecordCount"])],
      ["dnsServers", jips(item, ["DnspodNs", "GradeLevel"])],
      ["type", jstr(item, ["Grade", "GradeTitle"])],
      ["instanceId", jstr(item, ["DomainId"])],
    ]),
  };
}

function mapRegDomain(item) {
  var name = jstr(item, ["DomainName", "Domain", "Punycode"]);
  return {
    id: name,
    name: name,
    capability: "domains",
    regionId: "",
    status: jstr(item, ["BuyStatus", "Status"]),
    fields: fieldMap([
      ["domain", name],
      ["type", jstr(item, ["Tld", "DomainType"])],
      ["registrationDate", jstr(item, ["CreationDate", "CreateTime"])],
      ["expirationDate", jstr(item, ["ExpirationDate", "ExpireTime", "ExpiredDate"])],
      ["instanceId", jstr(item, ["DomainId"])],
    ]),
  };
}

function mergeDomains(regs, zones) {
  var rows = [];
  var i;
  for (i = 0; i < regs.length; i++) rows.push(mapRegDomain(regs[i]));
  for (i = 0; i < zones.length; i++) {
    var mapped = mapDnsPod(zones[i]);
    if (!mapped.id) continue;
    var found = null;
    for (var r = 0; r < rows.length; r++) {
      if (rows[r].id.toLowerCase() === mapped.id.toLowerCase()) {
        found = rows[r];
        break;
      }
    }
    if (found) {
      if (mapped.fields.recordCount) found.fields.recordCount = mapped.fields.recordCount;
      if (mapped.fields.dnsServers) found.fields.dnsServers = mapped.fields.dnsServers;
      if (!str(found.status).trim()) found.status = mapped.status;
    } else {
      rows.push(mapped);
    }
  }
  return rows;
}

function mapDnsRecord(item) {
  var rr = jstr(item, ["Name", "SubDomain", "RR"]);
  return {
    id: jstr(item, ["RecordId"]),
    kind: "dnsRecord",
    name: rr,
    status: jstr(item, ["Status"]),
    fields: fieldMap([
      ["type", jstr(item, ["Type", "RecordType"])],
      ["value", jstr(item, ["Value"])],
      ["ttl", jstr(item, ["TTL"])],
      ["rr", rr],
      ["line", jstr(item, ["Line", "RecordLine"])],
    ]),
  };
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

function describeCvm(creds, ids) {
  var extra = ids && ids.length ? { InstanceIds: ids } : {};
  return paginate(creds, "cvm", "2017-03-12", "DescribeInstances", regionOfCreds(creds), extra, [
    "InstanceSet",
    "Instance",
  ]);
}

function describeLite(creds, ids) {
  var extra = ids && ids.length ? { InstanceIds: ids } : {};
  return paginate(creds, "lighthouse", "2020-03-24", "DescribeInstances", regionOfCreds(creds), extra, [
    "InstanceSet",
    "Instance",
  ]);
}

function describeSgs(creds, ids) {
  var extra = ids && ids.length ? { SecurityGroupIds: ids } : {};
  return paginate(creds, "vpc", "2017-03-12", "DescribeSecurityGroups", regionOfCreds(creds), extra, [
    "SecurityGroupSet",
    "SecurityGroup",
  ]);
}

function describeEip(creds, ids) {
  var extra = ids && ids.length ? { AddressIds: ids } : {};
  return paginate(creds, "vpc", "2017-03-12", "DescribeAddresses", regionOfCreds(creds), extra, [
    "AddressSet",
    "Address",
  ]);
}

function describeLb(creds, ids) {
  var extra = ids && ids.length ? { LoadBalancerIds: ids } : {};
  return paginate(creds, "clb", "2018-03-17", "DescribeLoadBalancers", regionOfCreds(creds), extra, [
    "LoadBalancerSet",
    "LoadBalancer",
  ]);
}

function describeCdb(creds, ids) {
  var extra = ids && ids.length ? { InstanceIds: ids } : {};
  return paginate(creds, "cdb", "2017-03-20", "DescribeDBInstances", regionOfCreds(creds), extra, [
    "Items",
    "InstanceSet",
  ]);
}

function describeRedis(creds, ids) {
  var extra = ids && ids.length ? { InstanceIds: ids } : {};
  return paginate(creds, "redis", "2018-04-12", "DescribeInstances", regionOfCreds(creds), extra, [
    "InstanceSet",
    "Instance",
  ]);
}

function describeDisks(creds, ids, instanceId) {
  var extra = {};
  if (ids && ids.length) extra.DiskIds = ids;
  if (instanceId) extra.Filters = [{ Name: "instance-id", Values: [instanceId] }];
  return paginate(creds, "cbs", "2017-03-12", "DescribeDisks", regionOfCreds(creds), extra, [
    "DiskSet",
    "Disk",
  ]);
}

function describeSnapshots(creds, diskId, instanceId) {
  var extra = {};
  if (diskId) extra.Filters = [{ Name: "disk-id", Values: [diskId] }];
  else if (instanceId) extra.Filters = [{ Name: "instance-id", Values: [instanceId] }];
  return paginate(creds, "cbs", "2017-03-12", "DescribeSnapshots", regionOfCreds(creds), extra, [
    "SnapshotSet",
    "Snapshot",
  ]);
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
  var body = tc3Call(creds, "cam", "2019-01-16", "GetUserAppId", regionOfCreds(creds), {});
  var appId = jstr(body, ["AppId"]);
  var uin = jstr(body, ["Uin", "OwnerUin"]);
  if (!appId && !uin) return { message: "凭证有效" };
  if (!uin) return { message: "AppId=" + appId };
  return { message: "AppId=" + appId + "; Uin=" + uin };
}

function listRegions(args) {
  var creds = credsOf(args);
  var configured = args.configured || args.configuredRegions || [];
  var raw = jarr(
    tc3Call(creds, "cvm", "2017-03-12", "DescribeRegions", regionOfCreds(creds), {}),
    ["RegionSet", "RegionList", "Region"]
  );
  var regions = [];
  for (var i = 0; i < raw.length; i++) {
    var rid = jstr(raw[i], ["Region", "RegionId"]);
    if (!rid) continue;
    regions.push({
      regionId: rid,
      localName: jstr(raw[i], ["RegionName", "LocalName"]),
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

function fen(body, keys) {
  var raw = jstr(body, keys);
  if (!raw) return "";
  var n = parseInt(raw, 10);
  if (!isNaN(n) && String(n) === raw) return (n / 100).toFixed(2);
  return raw;
}

function getAccount(args) {
  var creds = credsOf(args);
  var ident = tc3Call(creds, "cam", "2019-01-16", "GetUserAppId", regionOfCreds(creds), {});
  var snap = {
    callerId: jstr(ident, ["Uin", "OwnerUin"]),
    arn: jstr(ident, ["AppId"]),
    currency: "",
    availableAmount: "",
    cashAmount: "",
    creditAmount: "",
    balanceError: null,
  };
  try {
    var body = tc3Call(creds, "billing", "2018-07-09", "DescribeAccountBalance", regionOfCreds(creds), {});
    snap.currency = "CNY";
    snap.availableAmount = fen(body, ["Balance", "RealBalance"]);
    snap.cashAmount = fen(body, ["CashAccountBalance", "CashAmount"]);
    snap.creditAmount = fen(body, ["CreditAmount", "CreditBalance"]);
  } catch (e) {
    snap.balanceError = String(e.message || e);
  }
  return snap;
}

function listMergedDomains(creds) {
  var regs = [];
  var zones = [];
  var regErr = null;
  try {
    regs = paginate(creds, "domain", "2018-08-08", "DescribeDomainList", DEFAULT_REGION, {}, [
      "DomainSet",
      "DomainList",
    ]);
  } catch (e) {
    regErr = e;
  }
  try {
    zones = paginate(creds, "dnspod", "2021-03-23", "DescribeDomainList", DEFAULT_REGION, {}, [
      "DomainList",
      "DomainSet",
    ]);
  } catch (e) {
    if (!regs.length && regErr) throw regErr;
  }
  if (!regs.length && !zones.length && regErr) throw regErr;
  return mergeDomains(regs, zones);
}

function listResources(args) {
  var creds = credsOf(args);
  var cap = str(args.capability || "compute").trim();
  var filter = args.filter || {};
  var rows;
  if (cap === "compute") {
    rows = listRegional(creds, filter, function (c) {
      return describeCvm(c, []);
    }, mapCvm);
  } else if (cap === "compute.lite") {
    rows = listRegional(creds, filter, function (c) {
      return describeLite(c, []);
    }, mapLite);
  } else if (cap === "objectStorage") {
    rows = listCosBuckets(creds).map(mapCos);
    var wanted = uniqueRegions(filter.regions || []);
    if (wanted.length) {
      rows = rows.filter(function (row) {
        return wanted.indexOf(row.regionId) >= 0;
      });
    }
  } else if (cap === "domains" || cap === "dns") {
    rows = listMergedDomains(creds);
  } else if (cap === "certs") {
    rows = paginate(creds, "ssl", "2019-12-05", "DescribeCertificates", DEFAULT_REGION, {}, [
      "Certificates",
      "CertificateSet",
    ]).map(mapCert);
  } else if (cap === "network.securityGroup") {
    rows = listRegional(creds, filter, function (c) {
      return describeSgs(c, []);
    }, mapSg);
  } else if (cap === "database") {
    rows = listRegional(creds, filter, function (c) {
      return describeCdb(c, []);
    }, mapCdb);
  } else if (cap === "database.cache") {
    rows = listRegional(creds, filter, function (c) {
      return describeRedis(c, []);
    }, mapRedis);
  } else if (cap === "network.eip") {
    rows = listRegional(creds, filter, function (c) {
      return describeEip(c, []);
    }, mapEip);
  } else if (cap === "network.loadBalancer") {
    rows = listRegional(creds, filter, function (c) {
      return describeLb(c, []);
    }, mapLb);
  } else if (cap === "storage.disk") {
    rows = listRegional(creds, filter, function (c) {
      return describeDisks(c, [], "");
    }, mapDisk);
  } else {
    throw new Error("腾讯云本期未实现能力: " + cap);
  }
  return { items: applyFilter(rows, filter) };
}

function snapshotChild(item) {
  return {
    id: jstr(item, ["SnapshotId"]),
    kind: "snapshot",
    name: displayName(jstr(item, ["SnapshotName"]), jstr(item, ["SnapshotId"])),
    status: jstr(item, ["SnapshotState", "Status"]),
    fields: fieldMap([
      ["creationTime", jstr(item, ["CreatedTime", "CreationTime"])],
      ["size", jstr(item, ["DiskSize"])],
      ["progress", jstr(item, ["Percent", "Progress"])],
      ["type", jstr(item, ["SnapshotType", "DiskUsage"])],
      ["sourceDisk", jstr(item, ["DiskId"])],
    ]),
  };
}

function attachDisksToDetail(detail, disks) {
  if (disks.length) detail.fields.diskCount = String(disks.length);
  for (var i = 0; i < disks.length; i++) {
    var id = jstr(disks[i], ["DiskId"]);
    if (!id) continue;
    var name = displayName(jstr(disks[i], ["DiskName"]), id);
    var size = jstr(disks[i], ["DiskSize"]);
    var usage = jstr(disks[i], ["DiskUsage"]);
    var label = [name, size ? size + "GB" : "", usage].filter(Boolean).join(" · ");
    detail.related.push({
      capability: "storage.disk",
      resourceId: id,
      name: label,
      role: "disk",
    });
  }
}

function getResource(args) {
  var creds = credsOf(args);
  var cap = str(args.capability).trim();
  var id = str(args.resourceId || args.id).trim();
  if (!id) throw new Error("缺少资源 id");
  var region = str(args.regionId || args.region).trim() || regionOfCreds(creds);
  var scoped = withRegion(creds, region);
  if (cap === "compute") {
    var item = firstOrThrow(describeCvm(scoped, [id]), id, "CVM 实例");
    var detail = fromRow(
      mapCvm(item, region),
      "https://console.cloud.tencent.com/cvm/instance/detail?rid=&id=" + id + "&regionId=" + region
    );
    detail.related = relatedSgs(detail.fields.securityGroups);
    var vpc = relatedVpc(detail.fields.vpcId);
    if (vpc) detail.related.push(vpc);
    detail.metricIds = ["CPUUtilization", "memory_usedutilization", "InternetInRate", "InternetOutRate", "DiskReadBPS", "DiskWriteBPS"];
    detail.extra = item;
    try {
      var disks = describeDisks(scoped, [], id);
      attachDisksToDetail(detail, disks);
      var snaps = describeSnapshots(scoped, "", id);
      if (snaps.length) detail.fields.snapshotCount = String(snaps.length);
      for (var s = 0; s < snaps.length; s++) detail.children.push(snapshotChild(snaps[s]));
    } catch (e) {}
    return detail;
  }
  if (cap === "compute.lite") {
    item = firstOrThrow(describeLite(scoped, [id]), id, "轻量实例");
    detail = fromRow(
      mapLite(item, region),
      "https://console.cloud.tencent.com/lighthouse/instance/detail?rid=&id=" + id + "&regionId=" + region
    );
    detail.metricIds = ["CPUUtilization", "memory_usedutilization", "InternetInRate", "InternetOutRate", "DiskReadBPS", "DiskWriteBPS"];
    detail.extra = item;
    try {
      var rulesBody = tc3Call(scoped, "lighthouse", "2020-03-24", "DescribeFirewallRules", region, {
        InstanceId: id,
        Offset: 0,
        Limit: 100,
      });
      var rules = jarr(rulesBody, ["FirewallRuleSet", "FirewallRules"]);
      for (var i = 0; i < rules.length; i++) {
        detail.rules.push({
          id: jstr(rules[i], ["FirewallRuleId", "Id"]),
          direction: "ingress",
          protocol: jstr(rules[i], ["Protocol"]).toLowerCase(),
          portRange: jstr(rules[i], ["Port"]),
          cidr: jstr(rules[i], ["CidrBlock", "SourceCidrIp"]),
          sourceGroupId: "",
          policy: jstr(rules[i], ["Action"]).toLowerCase(),
          priority: "",
          nicType: "internet",
          description: jstr(rules[i], ["FirewallRuleDescription", "Description"]),
        });
      }
    } catch (e) {}
    return detail;
  }
  if (cap === "objectStorage") {
    var buckets = listCosBuckets(creds);
    var found = null;
    for (i = 0; i < buckets.length; i++) {
      if (jstr(buckets[i], ["Name"]) === id) found = buckets[i];
    }
    if (!found) throw new Error("未找到 Bucket: " + id);
    var row = mapCos(found);
    return fromRow(
      row,
      "https://console.cloud.tencent.com/cos/bucket?bucket=" + row.id + "&region=" + row.regionId
    );
  }
  if (cap === "domains" || cap === "dns") {
    var regs = [];
    var zones = [];
    try {
      regs = paginate(creds, "domain", "2018-08-08", "DescribeDomainList", DEFAULT_REGION, {}, [
        "DomainSet",
        "DomainList",
      ]);
    } catch (e) {}
    try {
      zones = paginate(creds, "dnspod", "2021-03-23", "DescribeDomainList", DEFAULT_REGION, {}, [
        "DomainList",
        "DomainSet",
      ]);
    } catch (e) {}
    var reg = null;
    var zone = null;
    for (i = 0; i < regs.length; i++) {
      if (
        jstr(regs[i], ["DomainName", "Domain", "Punycode"]).toLowerCase() === id.toLowerCase() ||
        jstr(regs[i], ["DomainId"]) === id
      ) {
        reg = regs[i];
      }
    }
    for (i = 0; i < zones.length; i++) {
      if (
        jstr(zones[i], ["Name", "Domain", "Punycode"]).toLowerCase() === id.toLowerCase() ||
        jstr(zones[i], ["DomainId"]) === id
      ) {
        zone = zones[i];
      }
    }
    var zoneName =
      (zone && jstr(zone, ["Name", "Domain", "Punycode"])) ||
      (reg && jstr(reg, ["DomainName", "Domain"])) ||
      id;
    var records = [];
    if (zoneName) {
      try {
        var recs = paginate(
          creds,
          "dnspod",
          "2021-03-23",
          "DescribeRecordList",
          DEFAULT_REGION,
          { Domain: zoneName },
          ["RecordList", "RecordSet"]
        );
        for (i = 0; i < recs.length; i++) records.push(mapDnsRecord(recs[i]));
      } catch (e) {}
    }
    if (reg) {
      detail = fromRow(
        mapRegDomain(reg),
        "https://console.cloud.tencent.com/domain/detail?domain=" + jstr(reg, ["DomainName", "Domain"])
      );
    } else if (zone) {
      detail = fromRow(
        mapDnsPod(zone),
        "https://console.cloud.tencent.com/cns/detail?domain=" + jstr(zone, ["Name", "Domain"])
      );
    } else {
      throw new Error("未找到域名: " + id);
    }
    if (zone) {
      var mapped = mapDnsPod(zone);
      if (mapped.fields.recordCount) detail.fields.recordCount = mapped.fields.recordCount;
      if (mapped.fields.dnsServers) detail.fields.dnsServers = mapped.fields.dnsServers;
    }
    detail.children = records;
    return detail;
  }
  if (cap === "certs") {
    var certs = paginate(creds, "ssl", "2019-12-05", "DescribeCertificates", DEFAULT_REGION, {}, [
      "Certificates",
      "CertificateSet",
    ]);
    found = null;
    for (i = 0; i < certs.length; i++) {
      if (jstr(certs[i], ["CertificateId", "Id", "Domain"]) === id) found = certs[i];
    }
    if (!found) throw new Error("未找到证书: " + id);
    return fromRow(mapCert(found), "https://console.cloud.tencent.com/ssl");
  }
  if (cap === "network.securityGroup") {
    item = firstOrThrow(describeSgs(scoped, [id]), id, "安全组");
    var policyBody = {};
    try {
      policyBody = tc3Call(scoped, "vpc", "2017-03-12", "DescribeSecurityGroupPolicies", region, {
        SecurityGroupId: id,
      });
    } catch (e) {}
    var set = policyBody.SecurityGroupPolicySet || policyBody;
    var sgRules = [];
    var ingress = jarr(set, ["Ingress"]);
    var egress = jarr(set, ["Egress"]);
    for (i = 0; i < ingress.length; i++) {
      sgRules.push({
        id: jstr(ingress[i], ["PolicyIndex"]),
        direction: "ingress",
        protocol: jstr(ingress[i], ["Protocol"]).toLowerCase(),
        portRange: jstr(ingress[i], ["Port"]),
        cidr: jstr(ingress[i], ["CidrBlock", "Ipv6CidrBlock"]),
        sourceGroupId: jstr(ingress[i], ["SecurityGroupId"]),
        policy: jstr(ingress[i], ["Action"]).toLowerCase(),
        priority: jstr(ingress[i], ["PolicyIndex"]),
        nicType: "",
        description: jstr(ingress[i], ["PolicyDescription", "Description"]),
      });
    }
    for (i = 0; i < egress.length; i++) {
      sgRules.push({
        id: jstr(egress[i], ["PolicyIndex"]),
        direction: "egress",
        protocol: jstr(egress[i], ["Protocol"]).toLowerCase(),
        portRange: jstr(egress[i], ["Port"]),
        cidr: jstr(egress[i], ["CidrBlock", "Ipv6CidrBlock"]),
        sourceGroupId: jstr(egress[i], ["SecurityGroupId"]),
        policy: jstr(egress[i], ["Action"]).toLowerCase(),
        priority: jstr(egress[i], ["PolicyIndex"]),
        nicType: "",
        description: jstr(egress[i], ["PolicyDescription", "Description"]),
      });
    }
    var sgRow = mapSg(item, region);
    if (sgRules.length) sgRow.fields.ruleCount = String(sgRules.length);
    detail = fromRow(
      sgRow,
      "https://console.cloud.tencent.com/vpc/security-group/detail?rid=&id=" + id + "&regionId=" + region
    );
    detail.rules = sgRules;
    detail.extra = item;
    return detail;
  }
  if (cap === "database") {
    item = firstOrThrow(describeCdb(scoped, [id]), id, "CDB 实例");
    detail = fromRow(
      mapCdb(item, region),
      "https://console.cloud.tencent.com/cdb/instance/detail?rid=&id=" + id + "&regionId=" + region
    );
    detail.metricIds = ["CPUUtilization", "memory_usedutilization", "DiskReadBPS", "DiskWriteBPS"];
    detail.logKinds = ["slow"];
    vpc = relatedVpc(detail.fields.vpcId);
    if (vpc) detail.related.push(vpc);
    detail.extra = item;
    try {
      var groups = jarr(
        tc3Call(scoped, "cdb", "2017-03-20", "DescribeDBSecurityGroups", region, { InstanceId: id }),
        ["Groups", "SecurityGroup"]
      );
      for (i = 0; i < groups.length; i++) {
        detail.rules.push({
          id: jstr(groups[i], ["SecurityGroupId"]),
          direction: "ingress",
          protocol: "all",
          portRange: "ALL",
          cidr: "",
          sourceGroupId: jstr(groups[i], ["SecurityGroupId"]),
          policy: "accept",
          priority: "",
          nicType: "securityGroup",
          description: jstr(groups[i], ["SecurityGroupName"]),
        });
      }
    } catch (e) {}
    return detail;
  }
  if (cap === "database.cache") {
    item = firstOrThrow(describeRedis(scoped, [id]), id, "Redis 实例");
    detail = fromRow(
      mapRedis(item, region),
      "https://console.cloud.tencent.com/redis/instance/manage?rid=&id=" + id + "&regionId=" + region
    );
    detail.metricIds = ["CPUUtilization", "memory_usedutilization", "InternetInRate", "InternetOutRate"];
    detail.logKinds = ["slow"];
    vpc = relatedVpc(detail.fields.vpcId);
    if (vpc) detail.related.push(vpc);
    detail.extra = item;
    return detail;
  }
  if (cap === "network.eip") {
    item = firstOrThrow(describeEip(scoped, [id]), id, "EIP");
    var eipRow = mapEip(item, region);
    detail = fromRow(
      eipRow,
      "https://console.cloud.tencent.com/vpc/eip?rid=&id=" + id + "&regionId=" + region
    );
    detail.metricIds = ["InternetInRate", "InternetOutRate"];
    var instanceId = eipRow.fields.instanceId || "";
    var instanceType = (eipRow.fields.instanceType || "").toUpperCase();
    if (instanceId) {
      detail.related.push({
        capability: instanceType.indexOf("CLB") >= 0 || instanceType.indexOf("LB") >= 0 ? "network.loadBalancer" : "compute",
        resourceId: instanceId,
        name: instanceId,
        role: "instance",
      });
    }
    detail.extra = item;
    return detail;
  }
  if (cap === "network.loadBalancer") {
    item = firstOrThrow(describeLb(scoped, [id]), id, "CLB");
    detail = fromRow(
      mapLb(item, region),
      "https://console.cloud.tencent.com/clb/detail?rid=&id=" + id + "&regionId=" + region
    );
    detail.metricIds = ["InternetInRate", "InternetOutRate"];
    vpc = relatedVpc(detail.fields.vpcId);
    if (vpc) detail.related.push(vpc);
    try {
      var listeners = jarr(
        tc3Call(scoped, "clb", "2018-03-17", "DescribeListeners", region, { LoadBalancerId: id }),
        ["Listeners", "ListenerSet"]
      );
      for (i = 0; i < listeners.length; i++) {
        var lid = jstr(listeners[i], ["ListenerId"]);
        detail.children.push({
          id: lid,
          kind: "listener",
          name: displayName(jstr(listeners[i], ["ListenerName"]), lid),
          status: jstr(listeners[i], ["Status"]),
          fields: fieldMap([
            ["protocol", jstr(listeners[i], ["Protocol"])],
            ["port", jstr(listeners[i], ["Port"])],
          ]),
        });
      }
      var targets = jarr(
        tc3Call(scoped, "clb", "2018-03-17", "DescribeTargets", region, { LoadBalancerId: id }),
        ["Listeners", "ListenerSet"]
      );
      for (i = 0; i < targets.length; i++) {
        var tg = jarr(targets[i], ["Targets", "TargetSet"]);
        for (var t = 0; t < tg.length; t++) {
          var tid = jstr(tg[t], ["InstanceId", "PrivateIpAddresses"]);
          detail.children.push({
            id: tid,
            kind: "backend",
            name: displayName(jstr(tg[t], ["InstanceName"]), tid),
            status: jstr(tg[t], ["HealthStatus"]),
            fields: fieldMap([
              ["port", jstr(tg[t], ["Port"])],
              ["weight", jstr(tg[t], ["Weight"])],
              ["privateIp", jips(tg[t], ["PrivateIpAddresses"])],
            ]),
          });
        }
      }
    } catch (e) {}
    detail.extra = item;
    return detail;
  }
  if (cap === "storage.disk") {
    item = firstOrThrow(describeDisks(scoped, [id], ""), id, "云盘");
    var diskRow = mapDisk(item, region);
    detail = fromRow(
      diskRow,
      "https://console.cloud.tencent.com/cvm/cbs/detail?rid=&id=" + id + "&regionId=" + region
    );
    instanceId = diskRow.fields.instanceId || "";
    if (instanceId) {
      detail.related.push({
        capability: "compute",
        resourceId: instanceId,
        name: instanceId,
        role: "instance",
      });
    }
    try {
      snaps = describeSnapshots(scoped, id, "");
      if (snaps.length) detail.fields.snapshotCount = String(snaps.length);
      for (s = 0; s < snaps.length; s++) detail.children.push(snapshotChild(snaps[s]));
    } catch (e) {}
    detail.extra = item;
    return detail;
  }
  throw new Error("腾讯云本期未实现能力: " + cap);
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
  if (cap === "compute" && name === "start") {
    tc3Call(scoped, "cvm", "2017-03-12", "StartInstances", region, { InstanceIds: [id] });
  } else if (cap === "compute" && name === "stop") {
    tc3Call(scoped, "cvm", "2017-03-12", "StopInstances", region, { InstanceIds: [id] });
  } else if (cap === "compute" && name === "reboot") {
    tc3Call(scoped, "cvm", "2017-03-12", "RebootInstances", region, { InstanceIds: [id] });
  } else if (cap === "compute" && (name === "attach" || name === "detach")) {
    var groupId = param(action, "securityGroupId");
    if (!groupId) throw new Error("缺少安全组 id");
    tc3Call(
      scoped,
      "cvm",
      "2017-03-12",
      name === "attach" ? "AssociateSecurityGroups" : "DisassociateSecurityGroups",
      region,
      { InstanceIds: [id], SecurityGroupIds: [groupId] }
    );
  } else if (cap === "compute.lite" && name === "start") {
    tc3Call(scoped, "lighthouse", "2020-03-24", "StartInstances", region, { InstanceIds: [id] });
  } else if (cap === "compute.lite" && name === "stop") {
    tc3Call(scoped, "lighthouse", "2020-03-24", "StopInstances", region, { InstanceIds: [id] });
  } else if (cap === "compute.lite" && name === "reboot") {
    tc3Call(scoped, "lighthouse", "2020-03-24", "RebootInstances", region, { InstanceIds: [id] });
  } else if (cap === "compute.lite" && (name === "authorizerule" || name === "revokerule")) {
    var rule = {
      Protocol: nonemptyOr(param(action, "protocol").toUpperCase(), "TCP"),
      Port: nonemptyOr(param(action, "portRange"), "ALL"),
      CidrBlock: nonemptyOr(param(action, "cidr"), "0.0.0.0/0"),
      Action: nonemptyOr(param(action, "policy").toUpperCase(), "ACCEPT"),
    };
    if (param(action, "description")) rule.FirewallRuleDescription = param(action, "description");
    tc3Call(
      scoped,
      "lighthouse",
      "2020-03-24",
      name === "authorizerule" ? "CreateFirewallRules" : "DeleteFirewallRules",
      region,
      { InstanceId: id, FirewallRules: [rule] }
    );
  } else if (cap === "network.securityGroup" && (name === "authorizerule" || name === "revokerule")) {
    var setKey = param(action, "direction").toLowerCase() === "egress" ? "Egress" : "Ingress";
    var policy = { Action: nonemptyOr(param(action, "policy").toUpperCase(), "ACCEPT") };
    if (param(action, "ruleId") && !isNaN(parseInt(param(action, "ruleId"), 10))) {
      policy.PolicyIndex = parseInt(param(action, "ruleId"), 10);
    }
    if (param(action, "protocol")) policy.Protocol = param(action, "protocol").toUpperCase();
    if (param(action, "portRange")) policy.Port = param(action, "portRange");
    if (param(action, "cidr")) policy.CidrBlock = param(action, "cidr");
    if (param(action, "description")) policy.PolicyDescription = param(action, "description");
    if (param(action, "sourceGroupId")) policy.SecurityGroupId = param(action, "sourceGroupId");
    var set = {};
    set[setKey] = [policy];
    tc3Call(
      scoped,
      "vpc",
      "2017-03-12",
      name === "authorizerule" ? "CreateSecurityGroupPolicies" : "DeleteSecurityGroupPolicies",
      region,
      { SecurityGroupId: id, SecurityGroupPolicySet: set }
    );
  } else if (cap === "database" && name === "start") {
    tc3Call(scoped, "cdb", "2017-03-20", "StartDBInstances", region, { InstanceIds: [id] });
  } else if (cap === "database" && name === "stop") {
    tc3Call(scoped, "cdb", "2017-03-20", "StopDBInstances", region, { InstanceIds: [id] });
  } else if (cap === "database" && name === "reboot") {
    tc3Call(scoped, "cdb", "2017-03-20", "RestartDBInstances", region, { InstanceIds: [id] });
  } else if (cap === "database" && (name === "authorizerule" || name === "revokerule")) {
    groupId = param(action, "securityGroupId");
    if (!groupId) throw new Error("缺少安全组 id");
    var ids = [];
    try {
      var g = jarr(
        tc3Call(scoped, "cdb", "2017-03-20", "DescribeDBSecurityGroups", region, { InstanceId: id }),
        ["Groups", "SecurityGroup"]
      );
      for (var gi = 0; gi < g.length; gi++) {
        var gid = jstr(g[gi], ["SecurityGroupId"]);
        if (gid) ids.push(gid);
      }
    } catch (e) {}
    if (name === "authorizerule") {
      if (ids.indexOf(groupId) < 0) ids.push(groupId);
    } else {
      ids = ids.filter(function (x) {
        return x !== groupId;
      });
    }
    tc3Call(scoped, "cdb", "2017-03-20", "ModifyDBInstanceSecurityGroups", region, {
      InstanceId: id,
      SecurityGroupIds: ids,
    });
  } else if ((cap === "domains" || cap === "dns") && (name === "addrecord" || name === "updaterecord" || name === "deletercord" || name === "deleterecord")) {
    var domain = id;
    if (name === "addrecord") {
      var rr = param(action, "rr");
      var rtype = param(action, "type");
      var value = param(action, "value");
      if (!rr || !rtype || !value) throw new Error("解析记录需要主机记录、类型与记录值");
      var addBody = {
        Domain: domain,
        SubDomain: rr,
        RecordType: rtype.toUpperCase(),
        RecordLine: nonemptyOr(param(action, "line"), "默认"),
        Value: value,
      };
      if (param(action, "ttl") && !isNaN(parseInt(param(action, "ttl"), 10))) {
        addBody.TTL = parseInt(param(action, "ttl"), 10);
      }
      tc3Call(creds, "dnspod", "2021-03-23", "CreateRecord", DEFAULT_REGION, addBody);
    } else if (name === "updaterecord") {
      var recordId = param(action, "recordId");
      if (!recordId) throw new Error("缺少记录 id");
      var upd = {
        Domain: domain,
        RecordId: parseInt(recordId, 10) || 0,
        SubDomain: nonemptyOr(param(action, "rr"), "@"),
        RecordType: nonemptyOr(param(action, "type").toUpperCase(), "A"),
        RecordLine: nonemptyOr(param(action, "line"), "默认"),
        Value: param(action, "value"),
      };
      if (param(action, "ttl") && !isNaN(parseInt(param(action, "ttl"), 10))) {
        upd.TTL = parseInt(param(action, "ttl"), 10);
      }
      tc3Call(creds, "dnspod", "2021-03-23", "ModifyRecord", DEFAULT_REGION, upd);
    } else {
      recordId = param(action, "recordId");
      if (!recordId) throw new Error("缺少记录 id");
      tc3Call(creds, "dnspod", "2021-03-23", "DeleteRecord", DEFAULT_REGION, {
        Domain: domain,
        RecordId: parseInt(recordId, 10) || 0,
      });
    }
  } else if (cap === "database.cache" && (name === "reboot" || name === "start" || name === "stop")) {
    if (name !== "reboot") throw new Error("Redis 仅支持重启");
    tc3Call(scoped, "redis", "2018-04-12", "RestartInstance", region, { InstanceId: id });
  } else if (cap === "network.eip" && name === "attach") {
    var inst = param(action, "instanceId");
    if (!inst) throw new Error("缺少要绑定的实例 id");
    tc3Call(scoped, "vpc", "2017-03-12", "AssociateAddress", region, { AddressId: id, InstanceId: inst });
  } else if (cap === "network.eip" && name === "detach") {
    tc3Call(scoped, "vpc", "2017-03-12", "DisassociateAddress", region, { AddressId: id });
  } else if (cap === "network.eip" && name === "modifybandwidth") {
    var bandwidth = param(action, "bandwidth");
    if (!bandwidth) throw new Error("请填写带宽");
    var n = parseInt(bandwidth, 10) || 1;
    try {
      tc3Call(scoped, "vpc", "2017-03-12", "ModifyAddressInternetChargeType", region, {
        AddressId: id,
        InternetMaxBandwidthOut: n,
      });
    } catch (e) {
      tc3Call(scoped, "vpc", "2017-03-12", "ModifyAddressesBandwidth", region, {
        AddressIds: [id],
        InternetMaxBandwidthOut: n,
      });
    }
  } else if (cap === "network.loadBalancer" && (name === "start" || name === "stop")) {
    throw new Error("CLB 不支持该操作");
  } else if (cap === "storage.disk" && (name === "attach" || name === "detach")) {
    inst = param(action, "instanceId");
    if (name === "attach" && !inst) throw new Error("缺少要挂载的实例 id");
    var diskBody = { DiskIds: [id] };
    if (inst) diskBody.InstanceId = inst;
    tc3Call(scoped, "cbs", "2017-03-12", name === "attach" ? "AttachDisks" : "DetachDisks", region, diskBody);
  } else if ((cap === "storage.disk" || cap === "compute") && name === "createsnapshot") {
    var diskId = param(action, "diskId") || id;
    if (!diskId) throw new Error("缺少云盘 id");
    var snapBody = { DiskId: diskId };
    if (param(action, "snapshotName")) snapBody.SnapshotName = param(action, "snapshotName");
    tc3Call(scoped, "cbs", "2017-03-12", "CreateSnapshot", region, snapBody);
  } else {
    throw new Error("不支持的动作: " + cap + "/" + name);
  }
  return { ok: true, message: name + " 已提交" };
}

function metricName(cap, id) {
  var table = {
    compute: {
      CPUUtilization: "CpuUsage",
      memory_usedutilization: "MemUsage",
      InternetInRate: "WanIntraffic",
      InternetOutRate: "WanOuttraffic",
      DiskReadBPS: "DiskReadTraffic",
      DiskWriteBPS: "DiskWriteTraffic",
    },
    "compute.lite": {
      CPUUtilization: "CpuUsage",
      memory_usedutilization: "MemUsage",
      InternetInRate: "WanIntraffic",
      InternetOutRate: "WanOuttraffic",
      DiskReadBPS: "DiskReadTraffic",
      DiskWriteBPS: "DiskWriteTraffic",
    },
    database: {
      CPUUtilization: "CpuUseRate",
      memory_usedutilization: "MemoryUseRate",
      DiskReadBPS: "RealCapacity",
      DiskWriteBPS: "VolumeRate",
    },
    "database.cache": {
      CPUUtilization: "CpuUsMin",
      memory_usedutilization: "MemUtil",
      InternetInRate: "InFlow",
      InternetOutRate: "OutFlow",
    },
    "network.eip": { InternetInRate: "Intraffic", InternetOutRate: "Outtraffic" },
    "network.loadBalancer": { InternetInRate: "Intraffic", InternetOutRate: "Outtraffic" },
  };
  return table[cap] && table[cap][id];
}

function metricNs(cap) {
  return {
    compute: "QCE/CVM",
    "compute.lite": "QCE/LIGHTHOUSE",
    database: "QCE/CDB",
    "database.cache": "QCE/REDIS",
    "network.loadBalancer": "QCE/LB_PUBLIC",
    "network.eip": "QCE/LB",
  }[cap];
}

function metricDim(cap) {
  if (cap === "database") return "InstanceId";
  if (cap === "database.cache") return "instanceid";
  if (cap === "network.loadBalancer") return "vip";
  if (cap === "network.eip") return "eip";
  return "InstanceId";
}

function defaultMetrics(cap) {
  if (cap === "compute" || cap === "compute.lite") {
    return ["CPUUtilization", "memory_usedutilization", "InternetInRate", "InternetOutRate", "DiskReadBPS", "DiskWriteBPS"];
  }
  if (cap === "database") return ["CPUUtilization", "memory_usedutilization", "DiskReadBPS", "DiskWriteBPS"];
  if (cap === "database.cache") return ["CPUUtilization", "memory_usedutilization", "InternetInRate", "InternetOutRate"];
  if (cap === "network.eip" || cap === "network.loadBalancer") return ["InternetInRate", "InternetOutRate"];
  return [];
}

function metricLabel(id) {
  return {
    CPUUtilization: "CPU",
    memory_usedutilization: "内存",
    InternetInRate: "公网入",
    InternetOutRate: "公网出",
    DiskReadBPS: "磁盘读",
    DiskWriteBPS: "磁盘写",
  }[id] || id;
}

function metricUnit(id) {
  if (id === "CPUUtilization" || id === "memory_usedutilization") return "%";
  if (id === "InternetInRate" || id === "InternetOutRate") return "bps";
  if (id === "DiskReadBPS" || id === "DiskWriteBPS") return "B/s";
  return "";
}

function parseMonitor(body) {
  var points = [];
  var series = jarr(body, ["DataPoints", "DataPoint"]);
  for (var i = 0; i < series.length; i++) {
    var ts = Array.isArray(series[i].Timestamps) ? series[i].Timestamps : [];
    var vs = Array.isArray(series[i].Values) ? series[i].Values : [];
    for (var k = 0; k < ts.length && k < vs.length; k++) {
      var tsRaw = Number(ts[k]) || 0;
      if (tsRaw <= 0) continue;
      points.push({
        tsMs: tsRaw > 1000000000000 ? tsRaw : tsRaw * 1000,
        value: Number(vs[k]) || 0,
      });
    }
  }
  points.sort(function (a, b) {
    return a.tsMs - b.tsMs;
  });
  return points;
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
  var query = args.query || {};
  var now = Date.now();
  var endMs = Number(query.endMs) > 0 ? Number(query.endMs) : now;
  var startMs = Number(query.startMs) > 0 ? Number(query.startMs) : endMs - 3600000;
  var period = Number(query.periodSec) > 0 ? Number(query.periodSec) : 60;
  var ids = query.metricIds && query.metricIds.length ? query.metricIds : defaultMetrics(cap);
  var dim = metricDim(cap);
  var out = [];
  for (var i = 0; i < ids.length; i++) {
    var mid = ids[i];
    var tcName = metricName(cap, mid);
    var body = null;
    if (tcName) {
      try {
        body = tc3Call(scoped, "monitor", "2018-07-24", "GetMonitorData", region, {
          Namespace: ns,
          MetricName: tcName,
          Period: period,
          StartTime: formatMonitorTime(startMs),
          EndTime: formatMonitorTime(endMs),
          Instances: [{ Dimensions: [{ Name: dim, Value: id }] }],
        });
      } catch (e) {
        body = null;
      }
    }
    out.push({
      id: mid,
      label: metricLabel(mid),
      unit: metricUnit(mid),
      points: parseMonitor(body || {}),
    });
  }
  return out;
}

function logWindowSec(query) {
  var now = Math.floor(Date.now() / 1000);
  function toSec(ts) {
    ts = Number(ts) || 0;
    return ts > 1000000000000 ? Math.floor(ts / 1000) : ts;
  }
  var end = toSec(query.endMs);
  if (end <= 0) end = now;
  if (end > now) end = now;
  var start = toSec(query.startMs);
  if (start <= 0) start = end - 86400;
  if (start >= end) start = end - 3600;
  return { start: start, end: end };
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

function parseSlowLogs(kind, body, page) {
  var items = jarr(body, ["Items", "Data", "InstanceSlowLogDetail", "SlowLogData", "Slowlogs"]);
  var entries = [];
  for (var i = 0; i < items.length; i++) {
    var sql = jstr(items[i], ["SqlText", "Sql", "Command", "Query"]);
    var ts = jstr(items[i], ["Timestamp", "ExecuteTime", "QueryTime", "Date"]);
    entries.push({
      id: jstr(items[i], ["Database", "UserHost", "Client"]) + ":" + i,
      tsMs: parseLogTs(ts),
      severity: "slow",
      summary: sql.slice(0, 240),
      fields: fieldMap([
        ["host", jstr(items[i], ["UserHost", "Client", "HostAddress"])],
        ["db", jstr(items[i], ["Database", "Db"])],
        ["queryTimes", jstr(items[i], ["QueryTime", "Duration", "QueryTimes"])],
        ["lockTimes", jstr(items[i], ["LockTime"])],
        ["sql", sql],
      ]),
    });
  }
  var total = parseInt(jstr(body, ["TotalCount", "Total", "TotalNum"]), 10);
  if (isNaN(total)) total = entries.length;
  return { kind: kind, total: total, page: page, entries: entries };
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
  var win = logWindowSec(query);
  var body;
  if (cap === "database") {
    var extra = {
      InstanceId: id,
      StartTime: formatTcTimeSec(win.start),
      EndTime: formatTcTimeSec(win.end),
      Offset: (page - 1) * pageSize,
      Limit: pageSize,
    };
    if (str(query.dbName).trim()) extra.Database = str(query.dbName).trim();
    body = tc3Call(scoped, "cdb", "2017-03-20", "DescribeSlowLogs", region, extra);
    return parseSlowLogs("slow", body, page);
  }
  if (cap === "database.cache") {
    body = tc3Call(scoped, "redis", "2018-04-12", "DescribeSlowLog", region, {
      InstanceId: id,
      BeginTime: formatTcTimeSec(win.start),
      EndTime: formatTcTimeSec(win.end),
      MinQueryTime: 0,
      Limit: pageSize,
      Offset: (page - 1) * pageSize,
    });
    return parseSlowLogs("slow", body, page);
  }
  throw new Error("该能力不支持日志查询: " + cap);
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
