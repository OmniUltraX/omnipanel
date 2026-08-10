#!/usr/bin/env python3
"""本地 mock MCP SSE 服务器（MCP Streamable HTTP 子集）。
仅实现 OmniPanel 用到的两个端点：
- GET/POST /mcp → initialize + tools/list + tools/call

用于验证 Web 端 MCP 外部服务桥接（mcp_list_services / mcp_call_tool / AI 工具面注入）。
"""
import json
import re
import sys
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer

TOOLS = [
    {
        "name": "mock_echo",
        "description": "返回输入文本的 echo（mock 外部 MCP 工具）",
        "inputSchema": {
            "type": "object",
            "properties": {"text": {"type": "string"}},
            "required": ["text"],
        },
    }
]

# SSE 会话（简化：内存 map，protocolVersion 校验跳过）
SESSIONS = {}


def sse_frame(data: str) -> bytes:
    return f"event: message\ndata: {data}\n\n".encode()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def _read_json(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0:
            return None
        raw = self.rfile.read(length)
        try:
            return json.loads(raw)
        except Exception:
            return None

    def _send_json(self, obj, status=200, headers=None):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        # MCP Streamable HTTP：GET /mcp 建立 SSE 流（首次返回会话 id，保持长连接）
        if self.path.startswith("/mcp"):
            sid = self.headers.get("Mcp-Session-Id")
            if not sid:
                sid = uuid.uuid4().hex
            SESSIONS[sid] = True
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Mcp-Session-Id", sid)
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.end_headers()
            # 保持连接打开（客户端依赖 SSE 长连接；请求/响应走 POST）
            try:
                while True:
                    # 定期发心跳防止代理断开
                    self.wfile.write(sse_frame(json.dumps({"jsonrpc": "2.0", "method": "notifications/ping"})))
                    self.wfile.flush()
                    import time
                    time.sleep(15)
            except (BrokenPipeError, ConnectionResetError):
                pass
            return
        self._send_json({"error": "not found"}, 404)

    def do_POST(self):
        if not self.path.startswith("/mcp"):
            self._send_json({"error": "not found"}, 404)
            return
        msg = self._read_json()
        if not msg:
            self._send_json({"jsonrpc": "2.0", "error": {"code": -32700, "message": "Parse error"}, "id": None}, 400)
            return
        method = msg.get("method")
        req_id = msg.get("id")
        sid = self.headers.get("Mcp-Session-Id")
        if method == "initialize":
            if sid:
                SESSIONS[sid] = True
            result = {
                "protocolVersion": msg.get("params", {}).get("protocolVersion", "2025-03-26"),
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "mock-mcp", "version": "1.0.0"},
            }
            self._send_json({"jsonrpc": "2.0", "result": result, "id": req_id},
                            headers={"Mcp-Session-Id": sid or uuid.uuid4().hex})
        elif method == "notifications/initialized":
            self._send_json({}, 202)
        elif method == "tools/list":
            self._send_json({"jsonrpc": "2.0", "result": {"tools": TOOLS}, "id": req_id})
        elif method == "tools/call":
            params = msg.get("params", {})
            name = params.get("name")
            args = params.get("arguments", {})
            if name == "mock_echo":
                content = [{"type": "text", "text": f"echo:{args.get('text', '')}"}]
                self._send_json({"jsonrpc": "2.0", "result": {"content": content, "isError": False}, "id": req_id})
            else:
                self._send_json({"jsonrpc": "2.0", "result": {"content": [{"type": "text", "text": f"unknown tool {name}"}], "isError": True}, "id": req_id})
        else:
            self._send_json({"jsonrpc": "2.0", "error": {"code": -32601, "message": f"Method not found: {method}"}, "id": req_id}, 404)


if __name__ == "__main__":
    import socketserver

    class ThreadingHTTPServer(socketserver.ThreadingMixIn, HTTPServer):
        daemon_threads = True

    port = int(sys.argv[1]) if len(sys.argv) > 1 else 18080
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"mock MCP SSE listening on {port}", flush=True)
    server.serve_forever()
