#!/usr/bin/env python3
"""本地 mock S3 服务器（MinIO 兼容子集）：
支持 ListObjectsV2 / PUT / GET / DELETE / HEAD / GET(Range) / multipart
（InitiateMultipartUpload / UploadPart / CompleteMultipartUpload / AbortMultipartUpload），
path-style 寻址。
用于验证 omnipanel-s3 rust-s3 路径（localhost + path-style）。
"""
import json
import os
import re
import sys
import threading
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs

BUCKET = "test-bucket"
DATA_DIR = "/tmp/mock-s3-data"
# multipart 上传中的分片存储目录：{DATA_DIR}/.multipart/{upload_id}/part-{n}
MULTIPART_DIR = os.path.join(DATA_DIR, ".multipart")
os.makedirs(DATA_DIR, exist_ok=True)
os.makedirs(MULTIPART_DIR, exist_ok=True)

XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>'


def xml_escape(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def list_objects_xml(prefix, delimiter, continuation_token, max_keys):
    # 收集所有对象
    objects = []
    for root, _, files in os.walk(DATA_DIR):
        if os.path.join(DATA_DIR, ".multipart") in root or root == MULTIPART_DIR:
            continue
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

    def _send_bytes(self, data, status=200, content_type="application/octet-stream", headers=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def _send_empty(self, status=200, headers=None):
        self.send_response(status)
        self.send_header("Content-Length", "0")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()

    # ── multipart 辅助 ──────────────────────────────────────────────

    def _multipart_dir(self, upload_id):
        return os.path.join(MULTIPART_DIR, upload_id)

    def _read_part(self, upload_id, part_number):
        full = os.path.join(self._multipart_dir(upload_id), f"part-{part_number}")
        if os.path.isfile(full):
            with open(full, "rb") as f:
                return f.read()
        return None

    def _assemble_multipart(self, upload_id):
        """按 partNumber 升序拼接全部已上传分片，返回 (bytes, parts)。"""
        d = self._multipart_dir(upload_id)
        if not os.path.isdir(d):
            return None, []
        parts = []
        for name in os.listdir(d):
            m = re.match(r"part-(\d+)$", name)
            if m:
                parts.append((int(m.group(1)), os.path.join(d, name)))
        parts.sort(key=lambda x: x[0])
        chunks = []
        for _, full in parts:
            with open(full, "rb") as f:
                chunks.append(f.read())
        return b"".join(chunks), [(n, full) for n, full in parts]

    def _handle_multipart(self, key, q, method):
        """返回 True 表示已处理 multipart 请求（uploads / uploadId）。"""
        # `?uploads` 是无值 flag，parse_qs 会丢弃，须从原始 query 判断
        raw_query = urlparse(self.path).query
        uploads = "uploads" in raw_query
        upload_id = (q.get("uploadId") or [None])[0]
        part_number = (q.get("partNumber") or [None])[0]

        # POST ?uploads → InitiateMultipartUpload
        if uploads and method == "POST":
            uid = uuid.uuid4().hex
            os.makedirs(self._multipart_dir(uid), exist_ok=True)
            self._send_xml(XML_HEADER + f"""<InitiateMultipartUploadResult>
  <Bucket>{BUCKET}</Bucket>
  <Key>{xml_escape(key)}</Key>
  <UploadId>{uid}</UploadId>
</InitiateMultipartUploadResult>""")
            return True

        if not upload_id:
            return False

        # DELETE ?uploadId → AbortMultipartUpload
        if method == "DELETE":
            import shutil
            shutil.rmtree(self._multipart_dir(upload_id), ignore_errors=True)
            self._send_empty(204)
            return True

        # PUT ?uploadId&partNumber → UploadPart
        if method == "PUT" and part_number:
            length = int(self.headers.get("Content-Length", "0"))
            data = self.rfile.read(length) if length > 0 else b""
            d = self._multipart_dir(upload_id)
            os.makedirs(d, exist_ok=True)
            with open(os.path.join(d, f"part-{part_number}"), "wb") as f:
                f.write(data)
            self._send_empty(200, headers={"ETag": f'"part-{part_number}"'})
            return True

        # POST ?uploadId → CompleteMultipartUpload
        if method == "POST":
            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(length) if length > 0 else b""
            # 解析 <Part><PartNumber>n</PartNumber><ETag>..</ETag></Part>
            nums = [int(m) for m in re.findall(r"<PartNumber>(\d+)</PartNumber>", body.decode())]
            data, _ = self._assemble_multipart(upload_id)
            if data is None:
                self._send_xml(XML_HEADER + "<Error><Code>NoSuchUpload</Code></Error>", 404)
                return True
            full = os.path.join(DATA_DIR, key)
            os.makedirs(os.path.dirname(full) or ".", exist_ok=True)
            with open(full, "wb") as f:
                f.write(data)
            import shutil
            shutil.rmtree(self._multipart_dir(upload_id), ignore_errors=True)
            etag = f'"{"-".join(str(n) for n in nums)}"'
            self._send_xml(XML_HEADER + f"""<CompleteMultipartUploadResult>
  <Location>http://127.0.0.1:{self.server.server_port}/{BUCKET}/{xml_escape(key)}</Location>
  <Bucket>{BUCKET}</Bucket>
  <Key>{xml_escape(key)}</Key>
  <ETag>{etag}</ETag>
</CompleteMultipartUploadResult>""")
            return True

        return False

    # ── HTTP verbs ──────────────────────────────────────────────────

    def do_GET(self):
        key, q = self._parse_path()
        if "list-type" in q:
            prefix = q.get("prefix", [""])[0]
            delimiter = q.get("delimiter", [None])[0]
            token = q.get("continuation-token", [None])[0]
            max_keys = int(q.get("max-keys", ["1000"])[0])
            self._send_xml(XML_HEADER + list_objects_xml(prefix, delimiter, token, max_keys))
            return
        # GET object（支持 Range）
        full = os.path.join(DATA_DIR, key)
        if not os.path.isfile(full):
            self._send_xml(XML_HEADER + "<Error><Code>NoSuchKey</Code><Message>Not Found</Message></Error>", 404)
            return
        with open(full, "rb") as f:
            content = f.read()
        range_hdr = self.headers.get("Range")
        if range_hdr:
            m = re.match(r"bytes=(\d+)-(\d*)", range_hdr)
            if m:
                start = int(m.group(1))
                end_str = m.group(2)
                end = int(end_str) if end_str else len(content) - 1
                end = min(end, len(content) - 1)
                if start > end:
                    self._send_xml(XML_HEADER + "<Error><Code>InvalidRange</Code></Error>", 416)
                    return
                chunk = content[start:end + 1]
                self._send_bytes(chunk, 206, headers={"Content-Range": f"bytes {start}-{end}/{len(content)}"})
                return
        self._send_bytes(content)

    def do_PUT(self):
        key, q = self._parse_path()
        if self._handle_multipart(key, q, "PUT"):
            return
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
                self._send_empty(200)
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
        self._send_empty(200)

    def do_POST(self):
        key, q = self._parse_path()
        if self._handle_multipart(key, q, "POST"):
            return
        self._send_xml(XML_HEADER + "<Error><Code>MethodNotAllowed</Code></Error>", 405)

    def do_DELETE(self):
        key, q = self._parse_path()
        if self._handle_multipart(key, q, "DELETE"):
            return
        full = os.path.join(DATA_DIR, key)
        if os.path.isfile(full):
            os.remove(full)
        self._send_empty(204)

    def do_HEAD(self):
        key, q = self._parse_path()
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
