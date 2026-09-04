function asObj(v) {
  if (v && typeof v === "object") return v;
  try {
    return JSON.parse(String(v || "{}"));
  } catch (e) {
    return {};
  }
}

function fetchTargets(args) {
  var base = String(args.baseUrl || args.address || "").trim();
  if (!base) throw new Error("缺少地址");
  var token = String(args.token || "").trim();
  if (!token) throw new Error("缺少令牌");
  var host = base.replace(/^https?:\/\//i, "").replace(/\/.*$/, "") || "starter.local";
  var name = String(args.name || host || "Starter SSH").trim();
  return {
    targets: [
      {
        pluginId: "omni.importer.starter",
        remoteId: "starter-ssh-" + host,
        remoteKind: "ssh",
        name: name,
        config: {
          host: host,
          port: 22,
          user: "root",
        },
      },
    ],
  };
}

var HANDLERS = { fetchTargets: fetchTargets };

function call(method, argsJson) {
  var handler = HANDLERS[String(method || "")];
  if (!handler) throw new Error("UnknownMethod: " + method);
  var result = handler(asObj(argsJson));
  return typeof result === "string" ? result : JSON.stringify(result);
}

globalThis.call = call;
