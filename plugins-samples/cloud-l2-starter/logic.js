function asObj(v) {
  if (v && typeof v === "object") return v;
  try {
    return JSON.parse(String(v || "{}"));
  } catch (e) {
    return {};
  }
}

var REGIONS = [
  { regionId: "cn-north-4", localName: "华北-北京四", capabilities: ["compute"] },
  { regionId: "cn-east-3", localName: "华东-上海一", capabilities: ["compute"] },
  { regionId: "cn-south-1", localName: "华南-广州", capabilities: ["compute"] },
];

var INSTANCES = [
  {
    id: "ecs-cn-north-4-demo-1",
    name: "cloud-ecs-web",
    capability: "compute",
    regionId: "cn-north-4",
    status: "Running",
    fields: {
      instanceType: "s6.large.2",
      zone: "cn-north-4a",
      publicIp: "119.3.0.8",
      privateIp: "192.168.0.21",
      os: "EulerOS 2.0",
    },
  },
  {
    id: "ecs-cn-east-3-demo-1",
    name: "cloud-ecs-api",
    capability: "compute",
    regionId: "cn-east-3",
    status: "Running",
    fields: {
      instanceType: "s6.medium.2",
      zone: "cn-east-3a",
      publicIp: "124.70.1.9",
      privateIp: "192.168.1.12",
      os: "Huawei Cloud EulerOS",
    },
  },
];

function requireCreds(args) {
  if (!String(args.accessKeyId || "").trim()) throw new Error("缺少 AccessKey Id");
  if (!String(args.accessKeySecret || "").trim()) throw new Error("缺少 AccessKey Secret");
}

function testAccount(args) {
  requireCreds(args);
  return { message: "云账户可用（样板 fixture，未调用真实 API）" };
}

function listRegions(args) {
  requireCreds(args);
  var configured = args.configured || args.regions || [];
  var items = REGIONS;
  if (configured.length) {
    var allow = {};
    for (var i = 0; i < configured.length; i++) allow[String(configured[i])] = true;
    var filtered = REGIONS.filter(function (row) {
      return allow[row.regionId];
    });
    if (filtered.length) items = filtered;
  }
  return { items: items };
}

function getAccount(args) {
  requireCreds(args);
  return {
    callerId: String(args.accessKeyId),
    currency: "CNY",
    availableAmount: "—",
  };
}

function listResources(args) {
  requireCreds(args);
  var cap = String(args.capability || "compute");
  if (cap !== "compute") return { items: [] };
  var filter = args.filter || {};
  var regions = filter.regions || [];
  var items = INSTANCES.slice();
  if (regions.length) {
    var allow = {};
    for (var i = 0; i < regions.length; i++) allow[String(regions[i])] = true;
    items = items.filter(function (row) {
      return allow[row.regionId];
    });
  }
  return { items: items };
}

function getResource(args) {
  requireCreds(args);
  var id = String(args.resourceId || args.id || "");
  for (var i = 0; i < INSTANCES.length; i++) {
    if (INSTANCES[i].id === id) return INSTANCES[i];
  }
  return {
    id: id,
    name: id,
    capability: String(args.capability || "compute"),
    regionId: String(args.region || ""),
    status: "",
    fields: {},
  };
}

var HANDLERS = {
  testAccount: testAccount,
  listRegions: listRegions,
  getAccount: getAccount,
  listResources: listResources,
  getResource: getResource,
};

function call(method, argsJson) {
  var handler = HANDLERS[String(method || "")];
  if (!handler) throw new Error("UnknownMethod: " + method);
  var result = handler(asObj(argsJson));
  return typeof result === "string" ? result : JSON.stringify(result);
}

globalThis.call = call;
