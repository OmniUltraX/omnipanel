/**
 * AWS L2（QuickJS）。SigV4 签名走 host.hmac + host.hash，网络走 host.netFetch。
 * 插件 id: omni.cloud.aws
 */
var DEFAULT_REGION = "us-east-1";
var PAGE_LIMIT = 100;
var PAGE_MAX = 500;
var EC2_VERSION = "2016-11-15";
var STS_VERSION = "2011-06-15";
var ELASTICACHE_VERSION = "2015-02-02";
var RDS_TARGET_PREFIX = "AmazonRDSv20120601.";

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

function amzDate(ms) {
  var p = utcParts(ms);
  return p.y + p.m + p.d + "T" + p.h + p.min + p.s + "Z";
}

function scopeDate(ms) {
  var p = utcParts(ms);
  return p.y + p.m + p.d;
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
  if (raw === "/") return "/";
  var parts = raw.split("/");
  var enc = [];
  for (var i = 0; i < parts.length; i++) {
    if (!parts[i]) continue;
    enc.push(uriEncode(parts[i], true));
  }
  return "/" + enc.join("/");
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
  var id = str(raw.accessKeyId || raw.secretId || args.accessKeyId).trim();
  var secret = str(raw.accessKeySecret || raw.secretKey || args.accessKeySecret).trim();
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

function svcHost(service, region) {
  if (service === "s3") return "s3.amazonaws.com";
  return service + "." + region + ".amazonaws.com";
}

function signRegion(service, region) {
  if (service === "s3") return DEFAULT_REGION;
  return region || DEFAULT_REGION;
}

function awsSignedRequest(creds, service, region, method, path, query, extraHeaders, body, contentType, label) {
  method = str(method || "GET").toUpperCase();
  path = path || "/";
  query = query && typeof query === "object" ? query : {};
  body = body == null ? "" : str(body);
  contentType = str(contentType || (body ? "application/x-www-form-urlencoded; charset=utf-8" : "application/x-www-form-urlencoded"));
  var signReg = signRegion(service, region);
  var hostName = svcHost(service, signReg === DEFAULT_REGION && service === "s3" ? DEFAULT_REGION : region);
  var now = Date.now();
  var amz = amzDate(now);
  var date = scopeDate(now);
  var headers = {
    Host: hostName,
    "X-Amz-Date": amz,
  };
  if (body) headers["Content-Type"] = contentType;
  if (extraHeaders && typeof extraHeaders === "object") {
    for (var hk in extraHeaders) {
      if (Object.prototype.hasOwnProperty.call(extraHeaders, hk)) headers[hk] = extraHeaders[hk];
    }
  }
  var signedNames = [];
  for (var h in headers) {
    if (Object.prototype.hasOwnProperty.call(headers, h)) signedNames.push(h.toLowerCase());
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
    hashHex("sha256", body);
  var credentialScope = date + "/" + signReg + "/" + service + "/aws4_request";
  var stringToSign = "AWS4-HMAC-SHA256\n" + amz + "\n" + credentialScope + "\n" + hashHex("sha256", canonicalRequest);
  var secretDate = hmacUtf8("sha256", "AWS4" + creds.accessKeySecret, date);
  var secretRegion = hmacHexKey("sha256", secretDate, signReg);
  var secretService = hmacHexKey("sha256", secretRegion, service);
  var secretSigning = hmacHexKey("sha256", secretService, "aws4_request");
  var signature = hmacHexKey("sha256", secretSigning, stringToSign);
  headers.Authorization =
    "AWS4-HMAC-SHA256 Credential=" +
    creds.accessKeyId +
    "/" +
    credentialScope +
    ", SignedHeaders=" +
    signedHeaders +
    ", Signature=" +
    signature;
  var spec = {
    url: "https://" + hostName + path + buildQuery(query),
    method: method,
    headers: headers,
  };
  if (body) spec.body = body;
  var text = host.netFetch(JSON.stringify(spec));
  return text || "";
}

function formEncode(params) {
  params = params && typeof params === "object" ? params : {};
  var keys = [];
  for (var k in params) {
    if (Object.prototype.hasOwnProperty.call(params, k) && params[k] != null) keys.push(k);
  }
  keys.sort();
  var parts = [];
  for (var i = 0; i < keys.length; i++) {
    parts.push(uriEncode(keys[i], true) + "=" + uriEncode(str(params[keys[i]]), true));
  }
  return parts.join("&");
}

function filterParam(name, values) {
  var out = {};
  if (!values || !values.length) return out;
  out["Filter.1.Name"] = name;
  for (var i = 0; i < values.length; i++) out["Filter.1.Value." + (i + 1)] = values[i];
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

function parseAwsXmlError(xml) {
  var code = xmlTag(xml, "Code");
  var message = xmlTag(xml, "Message");
  if (!code && !message) return null;
  return { code: code, message: message };
}

function parseAwsJsonError(body) {
  if (!body || typeof body !== "object") return null;
  var code = jstr(body, ["__type", "Code", "code"]);
  var message = jstr(body, ["Message", "message"]);
  if (!code && !message) return null;
  if (code.indexOf("#") >= 0) code = code.split("#").pop();
  return { code: code, message: message };
}

function awsQueryCall(creds, service, region, action, version, params, label) {
  label = label || action;
  var bodyParams = { Action: action, Version: version };
  params = params && typeof params === "object" ? params : {};
  for (var k in params) {
    if (Object.prototype.hasOwnProperty.call(params, k)) bodyParams[k] = params[k];
  }
  var payload = formEncode(bodyParams);
  var xml = awsSignedRequest(
    creds,
    service,
    region,
    "POST",
    "/",
    {},
    {},
    payload,
    "application/x-www-form-urlencoded; charset=utf-8",
    label
  );
  var err = parseAwsXmlError(xml);
  if (err) throw new Error("AWS " + label + " 失败: " + err.code + " " + err.message);
  if (xml.indexOf("<Error>") >= 0 || xml.indexOf("<ErrorResponse>") >= 0) {
    err = parseAwsXmlError(xml);
    if (err) throw new Error("AWS " + label + " 失败: " + err.code + " " + err.message);
  }
  return xml;
}

function awsJsonCall(creds, service, region, target, payload, label) {
  label = label || target;
  var body = payload == null ? "{}" : JSON.stringify(payload);
  var text = awsSignedRequest(
    creds,
    service,
    region,
    "POST",
    "/",
    {},
    { "X-Amz-Target": target, "Content-Type": "application/x-amz-json-1.0" },
    body,
    "application/x-amz-json-1.0",
    label
  );
  var parsed = {};
  try {
    parsed = JSON.parse(text || "{}");
  } catch (e) {
    throw new Error("AWS " + label + " 响应非 JSON");
  }
  var err = parseAwsJsonError(parsed);
  if (err) throw new Error("AWS " + label + " 失败: " + err.code + " " + err.message);
  return parsed;
}

function queryNextToken(xml) {
  return xmlTag(xml, "nextToken") || xmlTag(xml, "NextToken") || xmlTag(xml, "marker") || xmlTag(xml, "Marker");
}

function paginateQuery(creds, service, region, action, version, extra, extractItems, label) {
  extra = extra && typeof extra === "object" ? extra : {};
  var out = [];
  var token = "";
  while (true) {
    var params = {};
    for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) params[k] = extra[k];
    params.MaxResults = PAGE_LIMIT;
    if (token) params.NextToken = token;
    var xml = awsQueryCall(creds, service, region, action, version, params, label || action);
    var items = extractItems(xml);
    out = out.concat(items);
    token = queryNextToken(xml);
    if (!items.length || !token || out.length >= PAGE_MAX) break;
    if (out.length >= PAGE_MAX) break;
  }
  if (out.length > PAGE_MAX) out.length = PAGE_MAX;
  return out;
}

function paginateJson(creds, service, region, target, extra, listKey, label) {
  extra = extra && typeof extra === "object" ? extra : {};
  var out = [];
  var marker = "";
  while (true) {
    var body = {};
    for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) body[k] = extra[k];
    body.MaxRecords = PAGE_LIMIT;
    if (marker) body.Marker = marker;
    var resp = awsJsonCall(creds, service, region, target, body, label || target);
    var items = jarr(resp, [listKey]);
    out = out.concat(items);
    marker = jstr(resp, ["Marker", "NextMarker"]);
    if (!items.length || !marker || out.length >= PAGE_MAX) break;
    if (out.length >= PAGE_MAX) break;
  }
  if (out.length > PAGE_MAX) out.length = PAGE_MAX;
  return out;
}

function extractInstances(xml) {
  var out = [];
  var idx = xml.indexOf("<reservationSet>");
  if (idx < 0) return out;
  var end = xml.indexOf("</reservationSet>", idx);
  var section = xml.slice(idx, end);
  var reservations = xmlBlocks(section, "item");
  for (var i = 0; i < reservations.length; i++) {
    var instIdx = reservations[i].indexOf("<instancesSet>");
    if (instIdx < 0) continue;
    var instEnd = reservations[i].indexOf("</instancesSet>", instIdx);
    var instances = xmlBlocks(reservations[i].slice(instIdx, instEnd), "item");
    for (var j = 0; j < instances.length; j++) {
      if (xmlTag(instances[j], "instanceId")) out.push(instances[j]);
    }
  }
  return out;
}

function extractFlatItems(xml, containerTags) {
  var containers = containerTags || ["securityGroupInfo", "addressesSet", "volumeSet", "cacheClusters", "item"];
  var out = [];
  var c;
  for (c = 0; c < containers.length; c++) {
    var tag = containers[c];
    if (tag === "item") {
      out = xmlBlocks(xml, "item");
      if (out.length) return out;
      continue;
    }
    var idx = xml.indexOf("<" + tag + ">");
    if (idx < 0) continue;
    var end = xml.indexOf("</" + tag + ">", idx);
    out = xmlBlocks(xml.slice(idx, end), "item");
    if (out.length) return out;
  }
  return out;
}

function tagNameFromXml(block) {
  var idx = block.indexOf("<tagSet>");
  if (idx < 0) return "";
  var end = block.indexOf("</tagSet>", idx);
  if (end < 0) return "";
  var tagSection = block.slice(idx, end);
  var items = xmlBlocks(tagSection, "item");
  for (var i = 0; i < items.length; i++) {
    if (xmlTag(items[i], "key") === "Name") return xmlTag(items[i], "value");
  }
  return "";
}

function instanceIps(block) {
  var pub = xmlTag(block, "ipAddress");
  var priv = xmlTag(block, "privateIpAddress");
  var pubs = [];
  var privs = [];
  var nicIdx = block.indexOf("<networkInterfaceSet>");
  if (nicIdx >= 0) {
    var nicEnd = block.indexOf("</networkInterfaceSet>", nicIdx);
    var nicBlock = block.slice(nicIdx, nicEnd);
    var nics = xmlBlocks(nicBlock, "item");
    for (var i = 0; i < nics.length; i++) {
      var p = xmlTag(nics[i], "privateIpAddress");
      if (p) privs.push(p);
      var assocIdx = nics[i].indexOf("<association>");
      if (assocIdx >= 0) {
        var assocEnd = nics[i].indexOf("</association>", assocIdx);
        var pip = xmlTag(nics[i].slice(assocIdx, assocEnd), "publicIp");
        if (pip) pubs.push(pip);
      }
    }
  }
  if (pubs.length) pub = pubs.join(",");
  if (privs.length) priv = privs.join(",");
  return { publicIp: pub, privateIp: priv };
}

function sgIdsFromXml(block) {
  var ids = [];
  var idx = block.indexOf("<groupSet>");
  if (idx < 0) return "";
  var end = block.indexOf("</groupSet>", idx);
  var section = block.slice(idx, end);
  var items = xmlBlocks(section, "item");
  for (var i = 0; i < items.length; i++) {
    var id = xmlTag(items[i], "groupId");
    if (id) ids.push(id);
  }
  return ids.join(",");
}

function listS3Buckets(creds) {
  var xml = awsSignedRequest(creds, "s3", DEFAULT_REGION, "GET", "/", {}, {}, "", "", "ListBuckets");
  var err = parseAwsXmlError(xml);
  if (err) throw new Error("S3 ListBuckets 失败: " + err.code + " " + err.message);
  var blocks = xmlBlocks(xml, "Bucket");
  var out = [];
  for (var i = 0; i < blocks.length; i++) {
    out.push({
      Name: xmlTag(blocks[i], "Name"),
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
  if (u === "RUNNING" || u === "ACTIVE" || u === "AVAILABLE" || u === "INUSE" || u === "IN-USE") return "RUNNING";
  if (u === "STOPPED" || u === "STOPPING" || u === "SHUTTING-DOWN" || u === "TERMINATED" || u === "INACTIVE") return "STOPPED";
  if (u === "PENDING" || u === "CREATING" || u === "MODIFYING" || u === "BACKING-UP") return "PENDING";
  if (u === "REBOOTING" || u === "REBOOTING-CLUSTER") return "REBOOTING";
  if (u === "DELETING" || u === "DELETED") return "STOPPED";
  return str(raw).trim();
}

function displayName(name, fallback) {
  return str(name).trim() ? name : fallback;
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

function mapEc2(xmlBlock, region) {
  var id = xmlTag(xmlBlock, "instanceId");
  var ips = instanceIps(xmlBlock);
  var stateBlock = xmlBlock.indexOf("<instanceState>") >= 0 ? xmlBlock : "";
  var status = stateBlock ? xmlTag(xmlBlock.slice(xmlBlock.indexOf("<instanceState>")), "name") : xmlTag(xmlBlock, "name");
  var placementIdx = xmlBlock.indexOf("<placement>");
  var zone = "";
  var az = "";
  if (placementIdx >= 0) {
    var placementEnd = xmlBlock.indexOf("</placement>", placementIdx);
    az = xmlTag(xmlBlock.slice(placementIdx, placementEnd), "availabilityZone");
    zone = az;
  }
  return {
    id: id,
    name: displayName(tagNameFromXml(xmlBlock), id),
    capability: "compute",
    regionId: region,
    status: mapStatus(status),
    fields: fieldMap([
      ["publicIp", ips.publicIp],
      ["privateIp", ips.privateIp],
      ["instanceType", xmlTag(xmlBlock, "instanceType")],
      ["zone", zone],
      ["os", xmlTag(xmlBlock, "imageId")],
      ["creationTime", xmlTag(xmlBlock, "launchTime")],
      ["chargeType", xmlTag(xmlBlock, "instanceLifecycle")],
      ["securityGroups", sgIdsFromXml(xmlBlock)],
      ["vpcId", xmlTag(xmlBlock, "vpcId")],
      ["hostname", tagNameFromXml(xmlBlock)],
    ]),
  };
}

function mapSgXml(block, region) {
  var id = xmlTag(block, "groupId");
  return {
    id: id,
    name: displayName(xmlTag(block, "groupName"), id),
    capability: "network.securityGroup",
    regionId: region,
    status: xmlTag(block, "vpcId") ? "vpc" : "classic",
    fields: fieldMap([
      ["vpcId", xmlTag(block, "vpcId")],
      ["description", xmlTag(block, "groupDescription") || xmlTag(block, "description")],
      ["creationTime", ""],
    ]),
  };
}

function mapEipXml(block, region) {
  var id = xmlTag(block, "allocationId") || xmlTag(block, "publicIp");
  var ip = xmlTag(block, "publicIp");
  return {
    id: id,
    name: displayName(xmlTag(block, "tagName"), ip || id),
    capability: "network.eip",
    regionId: region,
    status: xmlTag(block, "domain") || (xmlTag(block, "instanceId") ? "in-use" : "available"),
    fields: fieldMap([
      ["publicIp", ip],
      ["bandwidth", ""],
      ["instanceId", xmlTag(block, "instanceId")],
      ["chargeType", xmlTag(block, "domain")],
    ]),
  };
}

function mapVolumeXml(block, region) {
  var id = xmlTag(block, "volumeId");
  var attachments = xmlBlocks(block, "item");
  var instanceId = "";
  for (var i = 0; i < attachments.length; i++) {
    if (xmlTag(attachments[i], "volumeId") === id || attachments[i].indexOf("<instanceId>") >= 0) {
      instanceId = xmlTag(attachments[i], "instanceId");
      if (instanceId) break;
    }
  }
  if (!instanceId) {
    var attachIdx = block.indexOf("<attachmentSet>");
    if (attachIdx >= 0) {
      var attachEnd = block.indexOf("</attachmentSet>", attachIdx);
      instanceId = xmlTag(block.slice(attachIdx, attachEnd), "instanceId");
    }
  }
  return {
    id: id,
    name: displayName(tagNameFromXml(block), id),
    capability: "storage.disk",
    regionId: region,
    status: mapStatus(xmlTag(block, "status")),
    fields: fieldMap([
      ["size", xmlTag(block, "size")],
      ["category", xmlTag(block, "volumeType")],
      ["type", xmlTag(block, "volumeType")],
      ["zone", xmlTag(block, "availabilityZone")],
      ["instanceId", instanceId],
      ["chargeType", ""],
    ]),
  };
}

function mapS3(item) {
  var name = jstr(item, ["Name"]);
  return {
    id: name,
    name: name,
    capability: "objectStorage",
    regionId: DEFAULT_REGION,
    status: "",
    fields: fieldMap([
      ["creationDate", jstr(item, ["CreationDate"])],
      ["endpoint", "s3.amazonaws.com"],
      ["location", DEFAULT_REGION],
    ]),
  };
}

function mapRds(item, region) {
  var id = jstr(item, ["DBInstanceIdentifier"]);
  var endpoint = item.Endpoint || {};
  return {
    id: id,
    name: displayName(jstr(item, ["DBName"]), id),
    capability: "database",
    regionId: region,
    status: mapStatus(jstr(item, ["DBInstanceStatus"])),
    fields: fieldMap([
      ["engine", jstr(item, ["Engine"])],
      ["engineVersion", jstr(item, ["EngineVersion"])],
      ["instanceClass", jstr(item, ["DBInstanceClass"])],
      ["storage", jstr(item, ["AllocatedStorage"])],
      ["zone", jstr(item, ["AvailabilityZone"])],
      ["connectionString", jstr(endpoint, ["Address"])],
      ["port", jstr(endpoint, ["Port"])],
      ["vpcId", item.DBSubnetGroup ? jstr(item.DBSubnetGroup, ["VpcId"]) : ""],
      ["chargeType", ""],
    ]),
  };
}

function mapCacheXml(block, region) {
  var id = xmlTag(block, "cacheClusterId");
  var cfg = block.indexOf("<configurationEndpoint>") >= 0 ? block : "";
  var endpoint = "";
  var port = "";
  if (cfg) {
    var cfgIdx = block.indexOf("<configurationEndpoint>");
    var cfgEnd = block.indexOf("</configurationEndpoint>", cfgIdx);
    var cfgBlock = block.slice(cfgIdx, cfgEnd);
    endpoint = xmlTag(cfgBlock, "address");
    port = xmlTag(cfgBlock, "port");
  }
  var nodeIdx = block.indexOf("<cacheNodes>");
  if (!endpoint && nodeIdx >= 0) {
    var nodeEnd = block.indexOf("</cacheNodes>", nodeIdx);
    var nodeBlock = block.slice(nodeIdx, nodeEnd);
    var nodes = xmlBlocks(nodeBlock, "item");
    if (nodes.length) {
      endpoint = xmlTag(nodes[0], "endpoint");
      if (!endpoint) {
        var epIdx = nodes[0].indexOf("<endpoint>");
        if (epIdx >= 0) {
          var epEnd = nodes[0].indexOf("</endpoint>", epIdx);
          endpoint = xmlTag(nodes[0].slice(epIdx, epEnd), "address");
          port = xmlTag(nodes[0].slice(epIdx, epEnd), "port");
        }
      }
    }
  }
  return {
    id: id,
    name: displayName(id, id),
    capability: "database.cache",
    regionId: region,
    status: mapStatus(xmlTag(block, "cacheClusterStatus")),
    fields: fieldMap([
      ["engine", xmlTag(block, "engine") || "Redis"],
      ["engineVersion", xmlTag(block, "engineVersion")],
      ["instanceClass", xmlTag(block, "cacheNodeType")],
      ["capacity", xmlTag(block, "numCacheNodes")],
      ["connectionString", endpoint],
      ["port", port],
      ["zone", ""],
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

function describeInstances(creds, ids) {
  var extra = {};
  if (ids && ids.length) {
    var fp = filterParam("instance-id", ids);
    for (var k in fp) extra[k] = fp[k];
  }
  return paginateQuery(creds, "ec2", regionOfCreds(creds), "DescribeInstances", EC2_VERSION, extra, extractInstances, "DescribeInstances");
}

function describeSecurityGroups(creds, ids) {
  var extra = {};
  if (ids && ids.length) {
    var fp = filterParam("group-id", ids);
    for (var k in fp) extra[k] = fp[k];
  }
  return paginateQuery(
    creds,
    "ec2",
    regionOfCreds(creds),
    "DescribeSecurityGroups",
    EC2_VERSION,
    extra,
    function (xml) {
      return extractFlatItems(xml, ["securityGroupInfo"]);
    },
    "DescribeSecurityGroups"
  );
}

function describeAddresses(creds, ids) {
  var extra = {};
  if (ids && ids.length) {
    var fp = filterParam("allocation-id", ids);
    for (var k in fp) extra[k] = fp[k];
  }
  return paginateQuery(
    creds,
    "ec2",
    regionOfCreds(creds),
    "DescribeAddresses",
    EC2_VERSION,
    extra,
    function (xml) {
      return extractFlatItems(xml, ["addressesSet"]);
    },
    "DescribeAddresses"
  );
}

function describeVolumes(creds, ids) {
  var extra = {};
  if (ids && ids.length) {
    var fp = filterParam("volume-id", ids);
    for (var k in fp) extra[k] = fp[k];
  }
  return paginateQuery(
    creds,
    "ec2",
    regionOfCreds(creds),
    "DescribeVolumes",
    EC2_VERSION,
    extra,
    function (xml) {
      return extractFlatItems(xml, ["volumeSet"]);
    },
    "DescribeVolumes"
  );
}

function describeDbInstances(creds, ids) {
  var extra = {};
  if (ids && ids.length) extra.DBInstanceIdentifier = ids[0];
  return paginateJson(
    creds,
    "rds",
    regionOfCreds(creds),
    RDS_TARGET_PREFIX + "DescribeDBInstances",
    extra,
    "DBInstances",
    "DescribeDBInstances"
  );
}

function describeCacheClusters(creds, ids) {
  var extra = { ShowCacheNodeInfo: "true" };
  if (ids && ids.length) extra.CacheClusterId = ids[0];
  return paginateQuery(
    creds,
    "elasticache",
    regionOfCreds(creds),
    "DescribeCacheClusters",
    ELASTICACHE_VERSION,
    extra,
    function (xml) {
      return extractFlatItems(xml, ["cacheClusters"]);
    },
    "DescribeCacheClusters"
  );
}

function firstOrThrow(items, id, label) {
  if (!items || !items.length) throw new Error("未找到" + label + ": " + id);
  return items[0];
}

function param(action, key) {
  var params = action.params || {};
  return str(params[key] || action[key] || "").trim();
}

function getCallerIdentity(creds, region) {
  var xml = awsQueryCall(creds, "sts", region || DEFAULT_REGION, "GetCallerIdentity", STS_VERSION, {}, "GetCallerIdentity");
  return {
    account: xmlTag(xml, "Account"),
    arn: xmlTag(xml, "Arn"),
    userId: xmlTag(xml, "UserId"),
  };
}

function testAccount(args) {
  var creds = credsOf(args);
  var ident = getCallerIdentity(creds, regionOfCreds(creds));
  if (!ident.account && !ident.arn) return { message: "凭证有效" };
  if (!ident.account) return { message: "ARN=" + ident.arn };
  return { message: "Account=" + ident.account + "; ARN=" + ident.arn };
}

function listRegions(args) {
  var creds = credsOf(args);
  var configured = args.configured || args.configuredRegions || [];
  var xml = awsQueryCall(
    creds,
    "ec2",
    regionOfCreds(creds),
    "DescribeRegions",
    EC2_VERSION,
    { AllRegions: "true" },
    "DescribeRegions"
  );
  var raw = extractFlatItems(xml, ["regionInfo"]);
  var regions = [];
  for (var i = 0; i < raw.length; i++) {
    var rid = xmlTag(raw[i], "regionName");
    if (!rid) continue;
    regions.push({
      regionId: rid,
      localName: xmlTag(raw[i], "regionName"),
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
  var ident = getCallerIdentity(creds, regionOfCreds(creds));
  return {
    callerId: ident.account || ident.userId || "",
    arn: ident.arn || "",
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
  var rows;
  if (cap === "compute") {
    rows = listRegional(creds, filter, function (c) {
      return describeInstances(c, []);
    }, mapEc2);
  } else if (cap === "network.securityGroup") {
    rows = listRegional(creds, filter, function (c) {
      return describeSecurityGroups(c, []);
    }, mapSgXml);
  } else if (cap === "network.eip") {
    rows = listRegional(creds, filter, function (c) {
      return describeAddresses(c, []);
    }, mapEipXml);
  } else if (cap === "storage.disk") {
    rows = listRegional(creds, filter, function (c) {
      return describeVolumes(c, []);
    }, mapVolumeXml);
  } else if (cap === "objectStorage") {
    rows = listS3Buckets(creds).map(mapS3);
    var wanted = uniqueRegions(filter.regions || []);
    if (wanted.length) {
      rows = rows.filter(function (row) {
        return wanted.indexOf(row.regionId) >= 0;
      });
    }
  } else if (cap === "database") {
    rows = listRegional(creds, filter, function (c) {
      return describeDbInstances(c, []);
    }, mapRds);
  } else if (cap === "database.cache") {
    rows = listRegional(creds, filter, function (c) {
      return describeCacheClusters(c, []);
    }, mapCacheXml);
  } else {
    throw new Error("AWS 本期未实现能力: " + cap);
  }
  return { items: applyFilter(rows, filter) };
}

function ec2ConsoleUrl(region, id) {
  return "https://console.aws.amazon.com/ec2/home?region=" + region + "#InstanceDetails:instanceId=" + id;
}

function sgRuleFromXml(block, direction) {
  return {
    id: xmlTag(block, "ruleId") || xmlTag(block, "securityGroupRuleId"),
    direction: direction,
    protocol: (xmlTag(block, "ipProtocol") || "all").toLowerCase(),
    portRange:
      xmlTag(block, "fromPort") && xmlTag(block, "toPort")
        ? xmlTag(block, "fromPort") + "-" + xmlTag(block, "toPort")
        : xmlTag(block, "fromPort") || "ALL",
    cidr: xmlTag(block, "cidrIp") || xmlTag(block, "cidrIpv6"),
    sourceGroupId: xmlTag(block, "groupId") || xmlTag(block, "userIdGroupPair"),
    policy: "accept",
    priority: "",
    nicType: "",
    description: xmlTag(block, "description"),
  };
}

function sgRulesFromXml(block) {
  var rules = [];
  var sections = [
    ["ipPermissions", "ingress"],
    ["ipPermissionsEgress", "egress"],
  ];
  for (var s = 0; s < sections.length; s++) {
    var tag = sections[s][0];
    var dir = sections[s][1];
    var idx = block.indexOf("<" + tag + ">");
    if (idx < 0) continue;
    var end = block.indexOf("</" + tag + ">", idx);
    var section = block.slice(idx, end);
    var items = xmlBlocks(section, "item");
    for (var i = 0; i < items.length; i++) rules.push(sgRuleFromXml(items[i], dir));
  }
  return rules;
}

function getResource(args) {
  var creds = credsOf(args);
  var cap = str(args.capability).trim();
  var id = str(args.resourceId || args.id).trim();
  if (!id) throw new Error("缺少资源 id");
  var region = str(args.regionId || args.region).trim() || regionOfCreds(creds);
  var scoped = withRegion(creds, region);
  if (cap === "compute") {
    var xmlItem = firstOrThrow(describeInstances(scoped, [id]), id, "EC2 实例");
    var row = mapEc2(xmlItem, region);
    var detail = fromRow(row, ec2ConsoleUrl(region, id));
    var sgs = row.fields.securityGroups || "";
    if (sgs) {
      var parts = sgs.split(",");
      for (var i = 0; i < parts.length; i++) {
        if (parts[i]) {
          detail.related.push({
            capability: "network.securityGroup",
            resourceId: parts[i],
            name: parts[i],
            role: "securityGroup",
          });
        }
      }
    }
    if (row.fields.vpcId) {
      detail.related.push({
        capability: "",
        resourceId: row.fields.vpcId,
        name: row.fields.vpcId,
        role: "vpc",
      });
    }
    detail.metricIds = [
      "CPUUtilization",
      "memory_usedutilization",
      "InternetInRate",
      "InternetOutRate",
      "DiskReadBPS",
      "DiskWriteBPS",
    ];
    detail.extra = { instanceId: id };
    try {
      var vols = describeVolumes(scoped, []);
      var attached = 0;
      for (var v = 0; v < vols.length; v++) {
        var volXml = vols[v];
        var attachIdx = volXml.indexOf("<attachmentSet>");
        if (attachIdx < 0) continue;
        var attachEnd = volXml.indexOf("</attachmentSet>", attachIdx);
        var instId = xmlTag(volXml.slice(attachIdx, attachEnd), "instanceId");
        if (instId === id) {
          attached += 1;
          var volId = xmlTag(volXml, "volumeId");
          detail.related.push({
            capability: "storage.disk",
            resourceId: volId,
            name: displayName(tagNameFromXml(volXml), volId),
            role: "disk",
          });
        }
      }
      if (attached) detail.fields.diskCount = String(attached);
    } catch (e) {}
    return detail;
  }
  if (cap === "network.securityGroup") {
    var sgXml = firstOrThrow(describeSecurityGroups(scoped, [id]), id, "安全组");
    var sgRow = mapSgXml(sgXml, region);
    var sgRules = sgRulesFromXml(sgXml);
    if (sgRules.length) sgRow.fields.ruleCount = String(sgRules.length);
    detail = fromRow(
      sgRow,
      "https://console.aws.amazon.com/ec2/home?region=" + region + "#SecurityGroup:groupId=" + id
    );
    detail.rules = sgRules;
    detail.extra = { groupId: id };
    return detail;
  }
  if (cap === "network.eip") {
    var eipXml = firstOrThrow(describeAddresses(scoped, [id]), id, "弹性 IP");
    var eipRow = mapEipXml(eipXml, region);
    detail = fromRow(
      eipRow,
      "https://console.aws.amazon.com/ec2/home?region=" + region + "#Addresses:"
    );
    detail.metricIds = ["InternetInRate", "InternetOutRate"];
    if (eipRow.fields.instanceId) {
      detail.related.push({
        capability: "compute",
        resourceId: eipRow.fields.instanceId,
        name: eipRow.fields.instanceId,
        role: "instance",
      });
    }
    detail.extra = { allocationId: id };
    return detail;
  }
  if (cap === "storage.disk") {
    var diskXml = firstOrThrow(describeVolumes(scoped, [id]), id, "EBS 卷");
    var diskRow = mapVolumeXml(diskXml, region);
    detail = fromRow(
      diskRow,
      "https://console.aws.amazon.com/ec2/home?region=" + region + "#VolumeDetails:volumeId=" + id
    );
    if (diskRow.fields.instanceId) {
      detail.related.push({
        capability: "compute",
        resourceId: diskRow.fields.instanceId,
        name: diskRow.fields.instanceId,
        role: "instance",
      });
    }
    detail.extra = { volumeId: id };
    return detail;
  }
  if (cap === "objectStorage") {
    var buckets = listS3Buckets(creds).map(mapS3);
    var found = null;
    for (i = 0; i < buckets.length; i++) {
      if (buckets[i].id === id) found = buckets[i];
    }
    if (!found) throw new Error("未找到 S3 桶: " + id);
    return fromRow(found, "https://s3.console.aws.amazon.com/s3/buckets/" + id);
  }
  if (cap === "database") {
    var dbItem = firstOrThrow(describeDbInstances(scoped, [id]), id, "RDS 实例");
    detail = fromRow(
      mapRds(dbItem, region),
      "https://console.aws.amazon.com/rds/home?region=" + region + "#database:id=" + id
    );
    detail.metricIds = ["CPUUtilization", "memory_usedutilization"];
    detail.logKinds = ["slow"];
    detail.extra = dbItem;
    return detail;
  }
  if (cap === "database.cache") {
    var cacheXml = firstOrThrow(describeCacheClusters(scoped, [id]), id, "ElastiCache 集群");
    detail = fromRow(
      mapCacheXml(cacheXml, region),
      "https://console.aws.amazon.com/elasticache/home?region=" + region + "#redis-details:id=" + id
    );
    detail.metricIds = ["CPUUtilization", "memory_usedutilization"];
    detail.extra = { cacheClusterId: id };
    return detail;
  }
  throw new Error("AWS 本期未实现能力: " + cap);
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
    awsQueryCall(scoped, "ec2", region, "StartInstances", EC2_VERSION, { "InstanceId.1": id }, "StartInstances");
  } else if (cap === "compute" && name === "stop") {
    awsQueryCall(scoped, "ec2", region, "StopInstances", EC2_VERSION, { "InstanceId.1": id }, "StopInstances");
  } else if (cap === "compute" && name === "reboot") {
    awsQueryCall(scoped, "ec2", region, "RebootInstances", EC2_VERSION, { "InstanceId.1": id }, "RebootInstances");
  } else {
    throw new Error("不支持的动作: " + cap + "/" + name);
  }
  return { ok: true, message: name + " 已提交" };
}

function getMetrics(args) {
  return [];
}

function queryLogs(args) {
  throw new Error("AWS 本期不支持日志查询");
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
