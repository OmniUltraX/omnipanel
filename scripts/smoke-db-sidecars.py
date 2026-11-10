#!/usr/bin/env python3
"""Exercise the packaged DB engine executables without a database or credentials."""
import json
from pathlib import Path
import subprocess
import sys


def smoke(bin_dir):
    for engine in ("clickhouse", "mongodb", "redis"):
        binary = bin_dir / f"omnipanel-engine-{engine}"
        requests = [
            {"jsonrpc": "2.0", "id": 1, "method": "handshake", "params": {}},
            {"jsonrpc": "2.0", "id": 2, "method": "disconnect", "params": {}},
        ]
        result = subprocess.run(
            [str(binary.resolve())],
            input="\n".join(map(json.dumps, requests)) + "\n",
            capture_output=True,
            text=True,
            timeout=15,
            check=True,
        )
        responses = [json.loads(line) for line in result.stdout.splitlines()]
        assert len(responses) == 2, (engine, responses)
        assert responses[0]["id"] == 1, (engine, responses)
        assert responses[0]["result"]["engine"] == engine, (engine, responses)
        assert responses[0]["result"]["protocolVersion"] == 1, (engine, responses)
        assert responses[1]["id"] == 2, (engine, responses)
        assert responses[1]["result"]["bye"] is True, (engine, responses)
        print(f"{engine}: handshake + clean disconnect PASS")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python3 scripts/smoke-db-sidecars.py <packaged-bin-dir>")
    smoke(Path(sys.argv[1]))
