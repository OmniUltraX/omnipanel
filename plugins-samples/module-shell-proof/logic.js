var KNOWN = { listItems: true, getItem: true };

globalThis.call = function (method) {
  if (!KNOWN[method]) {
    throw new Error("UnknownMethod: " + method);
  }
  var state = host.stateGet();
  return JSON.stringify({ items: [], state: state });
};
