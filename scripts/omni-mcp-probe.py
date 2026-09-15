#!/usr/bin/env python3
"""OmniMCP 直连探针：对运行中的 OmniPanel App 执行 MCP 握手、列工具、调工具。

App 必须在运行（dev 构建 :12757，release :12756）：
    python scripts/omni-mcp-probe.py [port]
    python scripts/omni-mcp-probe.py 12757 call omni_knowledge_list_documents '{}'

要点（rmcp Streamable HTTP）：
- Accept 必须含 text/event-stream；回包是 SSE，跳过 keepalive 空 data 行；
- handshake 后用返回的 mcp-session-id 头保持会话；
- 必须带 X-Omni-Module 头（master=全部工具，否则返回空列表）。
"""
import json
import sys
import urllib.request
import urllib.error

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 12757
BASE = "http://127.0.0.1:%d/mcp" % PORT
SESSION = {"id": None}


def rpc(method, params=None, rid=1):
    body = json.dumps(
        {"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}}
    ).encode()
    req = urllib.request.Request(
        BASE,
        data=body,
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "X-Omni-Module": "master",
        },
        method="POST",
    )
    if SESSION["id"]:
        req.add_header("Mcp-Session-Id", SESSION["id"])
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            sid = resp.headers.get("Mcp-Session-Id")
            if sid:
                SESSION["id"] = sid
            ctype = resp.headers.get("Content-Type", "")
            raw = resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        print("HTTP", e.code, e.read()[:500])
        raise SystemExit(1)
    if "event-stream" in ctype:
        for line in raw.splitlines():
            if line.startswith("data:"):
                payload = line[5:].strip()
                if payload:
                    return json.loads(payload)
        return {"raw": raw[:500]}
    return json.loads(raw)


def main() -> None:
    rpc(
        "initialize",
        {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "omni-mcp-probe", "version": "0"},
        },
    )
    rpc("notifications/initialized", {}, rid=100)
    if len(sys.argv) > 2 and sys.argv[2] == "call":
        tool = sys.argv[3]
        params = json.loads(sys.argv[4]) if len(sys.argv) > 4 else {}
        out = rpc("tools/call", {"name": tool, "arguments": params}, rid=3)
        print(json.dumps(out, ensure_ascii=False)[:8000])
        return
    tools = rpc("tools/list", {}, rid=2)
    names = [t["name"] for t in tools.get("result", {}).get("tools", [])]
    print("tools(%d):" % len(names))
    for name in names:
        print("  -", name)


if __name__ == "__main__":
    main()
