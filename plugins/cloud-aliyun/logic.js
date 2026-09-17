/**
 * 阿里云 L2（QuickJS）。RPC HMAC-SHA1 走 host.hmac，网络走 host.netFetch。
 * 入参由宿主 cloud_plugin_args 注入 accessKeyId / accessKeySecret / region / regions。
 * 列表/详情形状对齐 CloudResourceRow / CloudResourceDetail（capability + fields）。
 */
var DEFAULT_REGION = "cn-hangzhou";
var SWAS_REGIONS = {
  "cn-qingdao": 1,
  "cn-beijing": 1,
  "cn-zhangjiakou": 1,
  "cn-hangzhou": 1,
  "cn-shanghai": 1,
  "cn-shenzhen": 1,
  "cn-guangzhou": 1,
  "cn-chengdu": 1,
  "cn-hongkong": 1,
  "ap-southeast-1": 1,
  "ap-southeast-3": 1,
  "us-west-1": 1,
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
  return v == null ? "" : String(v);
}

function jstr(obj, keys) {
  if (!obj || typeof obj !== "object") return "";
  for (var i = 0; i < keys.length; i++) {
    var x = obj[keys[i]];
    if (x == null) continue;
    if (typeof x === "string" || typeof x === "number" || typeof x === "boolean") return String(x);
  }
  return "";
}

function jarr(obj, path) {
  if (!obj || typeof obj !== "object") return [];
  var cur = obj;
  for (var i = 0; i < path.length; i++) {
    if (!cur || typeof cur !== "object") return [];
    cur = cur[path[i]];
  }
  if (Array.isArray(cur)) return cur;
  if (cur && typeof cur === "object") return [cur];
  return [];
}

function fieldMap(pairs) {
  var out = {};
  for (var i = 0; i < pairs.length; i++) {
    var k = pairs[i][0];
    var v = pairs[i][1];
    if (v == null || v === "") continue;
    out[k] = String(v);
  }
  return out;
}

function percentEncode(s) {
  var out = "";
  var raw = String(s == null ? "" : s);
  for (var i = 0; i < raw.length; i++) {
    var c = raw.charAt(i);
    var code = raw.charCodeAt(i);
    if (
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      (code >= 0x30 && code <= 0x39) ||
      c === "-" ||
      c === "_" ||
      c === "." ||
      c === "~"
    ) {
      out += c;
    } else {
      var bytes = unescape(encodeURIComponent(c));
      for (var b = 0; b < bytes.length; b++) {
        var hex = bytes.charCodeAt(b).toString(16).toUpperCase();
        if (hex.length < 2) hex = "0" + hex;
        out += "%" + hex;
      }
    }
  }
  return out;
}

function pad(n) {
  return n < 10 ? "0" + n : String(n);
}

function utcTimestamp() {
  var d = new Date();
  return (
    d.getUTCFullYear() +
    "-" +
    pad(d.getUTCMonth() + 1) +
    "-" +
    pad(d.getUTCDate()) +
    "T" +
    pad(d.getUTCHours()) +
    ":" +
    pad(d.getUTCMinutes()) +
    ":" +
    pad(d.getUTCSeconds()) +
    "Z"
  );
}

function nonce() {
  return String(Date.now()) + String(Math.floor(Math.random() * 1e9));
}

function hmacSha1Base64(key, data) {
  return host.hmac(
    JSON.stringify({
      alg: "sha1",
      key: key,
      data: data,
      encoding: "base64",
    }),
  );
}

function fetchText(url, headers) {
  var spec = { url: url, method: "GET" };
  if (headers) spec.headers = headers;
  return host.netFetch(JSON.stringify(spec));
}

function credsOf(args) {
  var raw = args.credentials || args.creds || args;
  var id = str(raw.accessKeyId || args.accessKeyId).trim();
  var secret = str(raw.accessKeySecret || args.accessKeySecret).trim();
  if (!id || !secret) throw new Error("缺少 AccessKey");
  var regions = raw.regions || args.regions || [];
  if (!Array.isArray(regions)) regions = [];
  var region = str(raw.region || args.region || "").trim() || DEFAULT_REGION;
  return { accessKeyId: id, accessKeySecret: secret, region: region, regions: regions };
}

function rpcCall(creds, endpoint, version, action, extra) {
  var params = {};
  params.Format = "JSON";
  params.Version = version;
  params.AccessKeyId = creds.accessKeyId;
  params.SignatureMethod = "HMAC-SHA1";
  params.Timestamp = utcTimestamp();
  params.SignatureVersion = "1.0";
  params.SignatureNonce = nonce();
  params.Action = action;
  extra = extra || {};
  var keys = Object.keys(extra);
  for (var i = 0; i < keys.length; i++) {
    params[keys[i]] = String(extra[keys[i]]);
  }
  var sorted = Object.keys(params).sort();
  var parts = [];
  for (var j = 0; j < sorted.length; j++) {
    var k = sorted[j];
    parts.push(percentEncode(k) + "=" + percentEncode(params[k]));
  }
  var canonical = parts.join("&");
  var stringToSign =
    "GET&" + percentEncode("/") + "&" + percentEncode(canonical);
  var signature = hmacSha1Base64(creds.accessKeySecret + "&", stringToSign);
  var base = String(endpoint || "").replace(/\/+$/, "");
  var url = base + "?" + canonical + "&Signature=" + percentEncode(signature);
  var text = fetchText(url);
  var body = {};
  try {
    body = JSON.parse(text || "{}");
  } catch (e) {
    body = { raw: text };
  }
  var code = str(body.Code || body.code);
  if (
    code &&
    code !== "200" &&
    code.toLowerCase() !== "ok" &&
    code.toLowerCase() !== "success"
  ) {
    throw new Error(
      "阿里云 " + action + " 失败: " + code + " " + str(body.Message || body.message || ""),
    );
  }
  return body;
}

function regionList(creds, filter) {
  var regions = [];
  if (filter && Array.isArray(filter.regions) && filter.regions.length) {
    for (var i = 0; i < filter.regions.length; i++) {
      var r = str(filter.regions[i]).trim();
      if (r) regions.push(r);
    }
  }
  if (!regions.length && creds.regions && creds.regions.length) {
    for (var j = 0; j < creds.regions.length; j++) {
      var rr = str(creds.regions[j]).trim();
      if (rr) regions.push(rr);
    }
  }
  if (!regions.length) regions.push(creds.region || DEFAULT_REGION);
  return regions;
}

function fromRow(row) {
  return {
    id: row.id,
    name: row.name,
    capability: row.capability,
    regionId: row.regionId || "",
    status: row.status || "",
    fields: row.fields || {},
    extra: null,
    consoleUrl: null,
    related: [],
    rules: [],
    metricIds: [],
    logKinds: [],
    children: [],
  };
}

function mapEcs(inst, region) {
  var pubs = jarr(inst, ["PublicIpAddress", "IpAddress"]);
  var privs = jarr(inst, ["VpcAttributes", "PrivateIpAddress", "IpAddress"]);
  var pub = "";
  if (pubs.length) {
    pub = typeof pubs[0] === "string" ? pubs[0] : jstr(pubs[0], ["IpAddress", "Ip"]);
  }
  var pri = "";
  if (privs.length) {
    pri = typeof privs[0] === "string" ? privs[0] : jstr(privs[0], ["IpAddress", "Ip"]);
  }
  var id = jstr(inst, ["InstanceId"]);
  var sgs = jarr(inst, ["SecurityGroupIds", "SecurityGroupId"]);
  var sgStr = "";
  for (var i = 0; i < sgs.length; i++) {
    var sg = typeof sgs[i] === "string" ? sgs[i] : jstr(sgs[i], ["SecurityGroupId"]);
    if (sg) sgStr = sgStr ? sgStr + "," + sg : sg;
  }
  return {
    id: id,
    name: jstr(inst, ["InstanceName"]) || id,
    capability: "compute",
    regionId: region,
    status: jstr(inst, ["Status"]),
    fields: fieldMap([
      ["publicIp", pub],
      ["privateIp", pri],
      ["instanceType", jstr(inst, ["InstanceType"])],
      ["zone", jstr(inst, ["ZoneId"])],
      ["os", jstr(inst, ["OSName"])],
      ["creationTime", jstr(inst, ["CreationTime"])],
      ["expiredTime", jstr(inst, ["ExpiredTime"])],
      ["chargeType", jstr(inst, ["InstanceChargeType"])],
      ["securityGroups", sgStr],
      ["cpu", jstr(inst, ["Cpu"])],
      ["memory", jstr(inst, ["Memory"])],
      ["hostname", jstr(inst, ["HostName"])],
      ["vpcId", jstr(inst, ["VpcId"]) || jstr(jarr(inst, ["VpcAttributes"])[0] || {}, ["VpcId"])],
    ]),
  };
}

function mapSwas(inst, region) {
  var id = jstr(inst, ["InstanceId"]);
  return {
    id: id,
    name: jstr(inst, ["InstanceName"]) || id,
    capability: "compute.lite",
    regionId: region,
    status: jstr(inst, ["Status"]),
    fields: fieldMap([
      ["publicIp", jstr(inst, ["PublicIpAddress"])],
      ["privateIp", jstr(inst, ["PrivateIpAddress"])],
      ["plan", jstr(inst, ["PlanId"]) || jstr(inst, ["InstancePlan"])],
      ["imageId", jstr(inst, ["ImageId"])],
      ["creationTime", jstr(inst, ["CreationTime"])],
      ["expiredTime", jstr(inst, ["ExpiredTime"])],
      ["chargeType", jstr(inst, ["ChargeType"])],
    ]),
  };
}

function listEcs(creds, region) {
  var endpoint = "https://ecs." + region + ".aliyuncs.com/";
  var out = [];
  var page = 1;
  while (page <= 20) {
    var body = rpcCall(creds, endpoint, "2014-05-26", "DescribeInstances", {
      RegionId: region,
      PageNumber: String(page),
      PageSize: "100",
    });
    var items = jarr(body, ["Instances", "Instance"]);
    for (var i = 0; i < items.length; i++) out.push(mapEcs(items[i], region));
    var total = Number(body.TotalCount || 0);
    if (!items.length || out.length >= total) break;
    page += 1;
  }
  return out;
}

function listSwas(creds, region) {
  if (!SWAS_REGIONS[region]) return [];
  var endpoint = "https://swas." + region + ".aliyuncs.com/";
  try {
    var body = rpcCall(creds, endpoint, "2020-06-01", "ListInstances", {
      RegionId: region,
      PageNumber: "1",
      PageSize: "100",
    });
    var items = jarr(body, ["Instances", "Instance"]);
    var out = [];
    for (var i = 0; i < items.length; i++) out.push(mapSwas(items[i], region));
    return out;
  } catch (e) {
    return [];
  }
}

function listOss(creds) {
  var dateHdr = new Date().toUTCString();
  var resource = "/";
  var stringToSign = "GET\n\n\n" + dateHdr + "\n" + resource;
  var authorization =
    "OSS " +
    creds.accessKeyId +
    ":" +
    hmacSha1Base64(creds.accessKeySecret, stringToSign);
  var xml = fetchText("https://oss.aliyuncs.com/", {
    Date: dateHdr,
    Authorization: authorization,
  });
  var out = [];
  var re =
    /<Bucket>[\s\S]*?<Name>([^<]+)<\/Name>[\s\S]*?<Location>([^<]*)<\/Location>[\s\S]*?<CreationDate>([^<]*)<\/CreationDate>[\s\S]*?<\/Bucket>/g;
  var m;
  while ((m = re.exec(String(xml || "")))) {
    var loc = m[2] || "";
    var region = loc.replace(/^oss-/, "");
    out.push({
      id: m[1],
      name: m[1],
      capability: "objectStorage",
      regionId: region,
      status: "Available",
      fields: fieldMap([
        ["storageClass", "Standard"],
        ["creationDate", m[3] || ""],
        ["location", loc],
        ["endpoint", region ? "https://" + m[1] + ".oss-" + region + ".aliyuncs.com" : ""],
      ]),
    });
  }
  return out;
}

function listDomains(creds) {
  var body = rpcCall(creds, "https://domain.aliyuncs.com/", "2018-01-29", "QueryDomainList", {
    PageNum: "1",
    PageSize: "100",
  });
  var items = jarr(body, ["Data", "Domain"]);
  var out = [];
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    var name = jstr(it, ["DomainName"]);
    var id = jstr(it, ["InstanceId"]) || name;
    out.push({
      id: id,
      name: name,
      capability: "domains",
      regionId: "global",
      status: jstr(it, ["DomainStatus"]),
      fields: fieldMap([
        ["type", jstr(it, ["DomainType"])],
        ["registrationDate", jstr(it, ["RegistrationDate"])],
        ["expirationDate", jstr(it, ["ExpirationDate"])],
      ]),
    });
  }
  return out;
}

function listCerts(creds) {
  var body = rpcCall(creds, "https://cas.aliyuncs.com/", "2020-04-07", "ListUserCertificateOrder", {
    CurrentPage: "1",
    ShowSize: "50",
    OrderType: "CERT",
  });
  var items = jarr(body, ["CertificateOrderList", "CertificateOrder"]);
  var out = [];
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    var id = jstr(it, ["OrderId"]) || jstr(it, ["CertificateId"]);
    out.push({
      id: id,
      name: jstr(it, ["Name"]) || jstr(it, ["Domain"]) || id,
      capability: "certs",
      regionId: "global",
      status: jstr(it, ["Status"]),
      fields: fieldMap([
        ["domain", jstr(it, ["Domain"])],
        ["product", jstr(it, ["ProductCode", "ProductName"])],
        ["certType", jstr(it, ["CertType"])],
        ["endDate", jstr(it, ["EndDate"])],
      ]),
    });
  }
  return out;
}

function listSg(creds, region) {
  var endpoint = "https://ecs." + region + ".aliyuncs.com/";
  var body = rpcCall(creds, endpoint, "2014-05-26", "DescribeSecurityGroups", {
    RegionId: region,
    PageNumber: "1",
    PageSize: "100",
  });
  var items = jarr(body, ["SecurityGroups", "SecurityGroup"]);
  var out = [];
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    var id = jstr(it, ["SecurityGroupId"]);
    out.push({
      id: id,
      name: jstr(it, ["SecurityGroupName"]) || id,
      capability: "network.securityGroup",
      regionId: region,
      status: "Available",
      fields: fieldMap([
        ["vpcId", jstr(it, ["VpcId"])],
        ["description", jstr(it, ["Description"])],
        ["creationTime", jstr(it, ["CreationTime"])],
      ]),
    });
  }
  return out;
}

function listRds(creds, region) {
  var endpoint = "https://rds.aliyuncs.com/";
  try {
    var body = rpcCall(creds, endpoint, "2014-08-15", "DescribeDBInstances", {
      RegionId: region,
      PageNumber: "1",
      PageSize: "100",
    });
    var items = jarr(body, ["Items", "DBInstance"]);
    var out = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var id = jstr(it, ["DBInstanceId"]);
      out.push({
        id: id,
        name: jstr(it, ["DBInstanceDescription"]) || id,
        capability: "database",
        regionId: region,
        status: jstr(it, ["DBInstanceStatus"]),
        fields: fieldMap([
          ["engine", jstr(it, ["Engine"])],
          ["engineVersion", jstr(it, ["EngineVersion"])],
          ["instanceClass", jstr(it, ["DBInstanceClass"])],
          ["connectionString", jstr(it, ["ConnectionString"])],
          ["port", jstr(it, ["Port"])],
          ["expiredTime", jstr(it, ["ExpireTime"])],
          ["chargeType", jstr(it, ["PayType"])],
        ]),
      });
    }
    return out;
  } catch (e) {
    return [];
  }
}

function listRegional(creds, filter, fn) {
  var regions = regionList(creds, filter);
  var out = [];
  for (var i = 0; i < regions.length; i++) {
    try {
      var rows = fn(creds, regions[i]);
      for (var j = 0; j < rows.length; j++) out.push(rows[j]);
    } catch (e) {
      /* skip region */
    }
  }
  return out;
}

function testAccount(args) {
  var creds = credsOf(args);
  var ident = rpcCall(creds, "https://sts.aliyuncs.com/", "2015-04-01", "GetCallerIdentity", {});
  var accountId = jstr(ident, ["AccountId"]);
  var arn = jstr(ident, ["Arn"]);
  if (!accountId && !arn) return "凭证有效";
  if (!arn) return "AccountId=" + accountId;
  return "AccountId=" + accountId + "; Arn=" + arn;
}

function listRegions(args) {
  var creds = credsOf(args);
  var configured = args.configured || args.configuredRegions || [];
  if (!Array.isArray(configured)) configured = [];
  var body = rpcCall(creds, "https://ecs.aliyuncs.com/", "2014-05-26", "DescribeRegions", {
    AcceptLanguage: "zh-CN",
  });
  var items = jarr(body, ["Regions", "Region"]);
  var out = [];
  for (var i = 0; i < items.length; i++) {
    var id = jstr(items[i], ["RegionId"]);
    if (!id) continue;
    var caps = [];
    if (!configured.length || configured.indexOf(id) >= 0) {
      caps.push("compute");
      if (SWAS_REGIONS[id]) caps.push("compute.lite");
    }
    out.push({
      regionId: id,
      localName: jstr(items[i], ["LocalName"]) || id,
      capabilities: caps,
    });
  }
  if (!out.length) {
    out.push({
      regionId: DEFAULT_REGION,
      localName: DEFAULT_REGION,
      capabilities: ["compute", "compute.lite"],
    });
  }
  return { items: out };
}

function getAccount(args) {
  var creds = credsOf(args);
  var ident = rpcCall(creds, "https://sts.aliyuncs.com/", "2015-04-01", "GetCallerIdentity", {});
  var snap = {
    callerId: jstr(ident, ["AccountId"]),
    arn: jstr(ident, ["Arn"]),
    currency: "",
    availableAmount: "",
    cashAmount: "",
    creditAmount: "",
    balanceError: null,
  };
  try {
    var bal = rpcCall(
      creds,
      "https://business.aliyuncs.com/",
      "2017-12-14",
      "QueryAccountBalance",
      {},
    );
    var data = bal.Data || bal;
    snap.availableAmount = jstr(data, ["AvailableAmount"]);
    snap.cashAmount = jstr(data, ["AvailableCashAmount", "CashAmount"]);
    snap.creditAmount = jstr(data, ["CreditAmount"]);
    snap.currency = jstr(data, ["Currency"]);
  } catch (e) {
    snap.balanceError = str(e && e.message ? e.message : e);
  }
  return snap;
}

function listResources(args) {
  var creds = credsOf(args);
  var capability = str(args.capability || "").trim();
  var filter = asObj(args.filter);
  var rows = [];
  if (capability === "compute") rows = listRegional(creds, filter, listEcs);
  else if (capability === "compute.lite") rows = listRegional(creds, filter, listSwas);
  else if (capability === "objectStorage") rows = listOss(creds);
  else if (capability === "domains" || capability === "dns") rows = listDomains(creds);
  else if (capability === "certs") rows = listCerts(creds);
  else if (capability === "network.securityGroup") rows = listRegional(creds, filter, listSg);
  else if (capability === "database") rows = listRegional(creds, filter, listRds);
  else rows = [];
  return { items: rows };
}

function getResource(args) {
  var list = listResources(args);
  var id = str(args.resourceId || "").trim();
  var items = list.items || [];
  for (var i = 0; i < items.length; i++) {
    if (items[i].id === id) return fromRow(items[i]);
  }
  throw new Error("资源不存在: " + id);
}

function invokeAction(args) {
  var creds = credsOf(args);
  var action = asObj(args.action);
  var name = str(action.name || action.kind || "").trim().toLowerCase();
  var resourceId = str(action.resourceId || args.resourceId || "").trim();
  var region = str(action.regionId || action.region || creds.region || DEFAULT_REGION).trim();
  var capability = str(action.capability || "").trim();
  if (!resourceId) throw new Error("缺少 resourceId");
  var map = {
    start: "StartInstance",
    stop: "StopInstance",
    reboot: "RebootInstance",
  };
  var rpcAction = map[name];
  if (!rpcAction) throw new Error("不支持的动作: " + name);
  var endpoint =
    capability === "compute.lite"
      ? "https://swas." + region + ".aliyuncs.com/"
      : "https://ecs." + region + ".aliyuncs.com/";
  var version = capability === "compute.lite" ? "2020-06-01" : "2014-05-26";
  rpcCall(creds, endpoint, version, rpcAction, { InstanceId: resourceId });
  return { ok: true, message: name + " " + resourceId };
}

function getMetrics(args) {
  return { items: [] };
}

function queryLogs(args) {
  return { items: [], nextToken: null, truncated: false };
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
