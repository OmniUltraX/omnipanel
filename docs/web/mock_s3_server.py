#!/usr/bin/env python3
"""本地 mock S3 服务器（MinIO 兼容子集）：
支持 ListObjectsV2 / PUT / GET / DELETE / HEAD，path-style 寻址。
用于验证 omnipanel-s3 rust-s3 路径（localhost + path-style）。
"""
import json
import os
import re
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs

BUCKET = "test-bucket"
DATA_DIR = "/tmp/mock-s3-data"
os.makedirs(DATA_DIR, exist_ok=True)

XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>'

def xml_escape(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")

def list_objects_xml(prefix, delimiter, continuation_token, max_keys):
    # 收集所有对象
    objects = []
    for root, _, files in os.walk(DATA_DIR):
        for f in files:
            full = os.path.join(root, f)
            rel = os.path.relpath(full, DATA_DIR).replace(os.sep, "/")
            if not rel.startswith(prefix):
                continue
            size = os.path.getsize(full)
            objects.append({"key": rel, "size": size})
    objects.sort(key=lambda o: o["key"])

    # delimiter=/ 时提取 CommonPrefixes
    contents = []
    common = set()
    for o in objects:
        rest = o["key"][len(prefix):]
        if delimiter and delimiter in rest:
            cp = prefix + rest.split(delimiter)[0] + delimiter
            common.add(cp)
        else:
            contents.append(o)

    # 分页
    truncated = False
    next_token = None
    if max_keys and len(contents) + len(common) > max_keys:
        truncated = True
        # 简化：next token 用 last key
        all_keys = sorted([c["key"] for c in contents] + sorted(common))
        next_token = all_keys[max_keys - 1]

    contents_xml = "\n".join(
        f"<Contents><Key>{xml_escape(o['key'])}</Key><Size>{o['size']}</Size>"
        f"<LastModified>2026-01-01T00:00:00.000Z</LastModified>"
        f"<ETag>&quot;abc&quot;</ETag><StorageClass>STANDARD</StorageClass></Contents>"
        for o in contents
    )
    common_xml = "\n".join(
        f"<CommonPrefixes><Prefix>{xml_escape(cp)}</Prefix></CommonPrefixes>"
        for cp in sorted(common)
    )
    token_xml = (
        f"<NextContinuationToken>{xml_escape(next_token)}</NextContinuationToken>"
        if next_token else ""
    )
    return f"""<ListBucketResult>
  <Name>{BUCKET}</Name>
  <Prefix>{xml_escape(prefix)}</Prefix>
  <KeyCount>{len(contents) + len(common)}</KeyCount>
  <MaxKeys>{max_keys or 1000}</MaxKeys>
  <IsTruncated>{'true' if truncated else 'false'}</IsTruncated>
  {token_xml}
  {contents_xml}
  {common_xml}
</ListBucketResult>"""

class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def _parse_path(self):
        parsed = urlparse(self.path)
        p = parsed.path
        # path-style: /{bucket}/{key}
        if p.startswith("/" + BUCKET + "/"):
            key = p[len(BUCKET) + 2:]
        elif p == "/" + BUCKET:
            key = ""
        else:
            key = p.lstrip("/")
        return key, parse_qs(parsed.query)

    def _send_xml(self, xml, status=200):
        body = xml.encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/xml")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_bytes(self, data, status=200, content_type="application/octet-stream"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        key, q = self._parse_path()
        if "list-type" in q:
            prefix = q.get("prefix", [""])[0]
            delimiter = q.get("delimiter", [None])[0]
            token = q.get("continuation-token", [None])[0]
            max_keys = int(q.get("max-keys", ["1000"])[0])
            self._send_xml(XML_HEADER + list_objects_xml(prefix, delimiter, token, max_keys))
            return
        # GET object
        full = os.path.join(DATA_DIR, key)
        if os.path.isfile(full):
            with open(full, "rb") as f:
                self._send_bytes(f.read())
        else:
            self._send_xml(XML_HEADER + "<Error><Code>NoSuchKey</Code><Message>Not Found</Message></Error>", 404)

    def do_PUT(self):
        key, _ = self._parse_path()
        if not key:
            self._send_xml(XML_HEADER + "<Error><Code>InvalidKey</Code></Error>", 400)
            return
        # S3 服务端拷贝（CopyObject）：x-amz-copy-source: /<bucket>/<key>
        copy_source = self.headers.get("x-amz-copy-source")
        if copy_source:
            src = copy_source.lstrip("/")
            if src.startswith(BUCKET + "/"):
                src = src[len(BUCKET) + 1:]
            src_full = os.path.join(DATA_DIR, src)
            if os.path.isfile(src_full):
                with open(src_full, "rb") as f:
                    content = f.read()
                full = os.path.join(DATA_DIR, key)
                os.makedirs(os.path.dirname(full), exist_ok=True)
                with open(full, "wb") as f:
                    f.write(content)
                self.send_response(200)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            else:
                self._send_xml(XML_HEADER + "<Error><Code>NoSuchKey</Code><Message>copy source missing</Message></Error>", 404)
                return
        # 兼容 rust-s3 空 body PUT：无 Content-Length 时按 0 处理
        length = int(self.headers.get("Content-Length", "0"))
        if length > 0:
            data = self.rfile.read(length)
        else:
            data = b""
        full = os.path.join(DATA_DIR, key)
        # 目录 marker（key 以 / 结尾）：写占位文件 .dir-marker
        if key.endswith("/") or data == b"":
            parent = os.path.dirname(full)
            os.makedirs(parent, exist_ok=True)
            marker = os.path.join(parent, ".dir-marker")
            with open(marker, "wb") as f:
                f.write(data)
        else:
            os.makedirs(os.path.dirname(full), exist_ok=True)
            with open(full, "wb") as f:
                f.write(data)
        self.send_response(200)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_DELETE(self):
        key, _ = self._parse_path()
        full = os.path.join(DATA_DIR, key)
        if os.path.isfile(full):
            os.remove(full)
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_HEAD(self):
        key, _ = self._parse_path()
        full = os.path.join(DATA_DIR, key)
        if os.path.isfile(full):
            self.send_response(200)
            self.send_header("Content-Length", str(os.path.getsize(full)))
            self.end_headers()
        else:
            self.send_response(404)
            self.end_headers()

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 19000
    server = HTTPServer(("127.0.0.1", port), Handler)
    print(f"mock S3 listening on {port}, bucket={BUCKET}", flush=True)
    server.serve_forever()
