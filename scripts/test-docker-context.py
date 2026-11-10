#!/usr/bin/env python3
"""Prove repository-root Docker ignore rules exclude synthetic secrets and caches."""
import io
import os
from pathlib import Path
import secrets
import subprocess
import tarfile
import tempfile

name = "omnipanel-context-" + secrets.token_hex(4)
docker = os.environ.get("DOCKER_BIN", "docker")
def run(*args, binary=False):
    return subprocess.run([docker,*args],check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=not binary)
try:
    with tempfile.TemporaryDirectory(prefix=name) as tmp:
        root=Path(tmp)
        (root/'.dockerignore').write_bytes((Path(__file__).resolve().parent.parent/'.dockerignore').read_bytes())
        excluded=['.env','.env.production','frontend/.env.local','private.key','credential.pem','frontend/node_modules/cache.txt','target/cache.txt','.git/config','.ssh/id_ed25519','.cargo/credentials.toml','frontend/.npmrc','secrets/private.txt','.config/gcloud/credentials.db','state.db-wal','data/state.sqlite-shm','credentials.json','frontend/tsconfig.tsbuildinfo']
        allowed=['crates/demo/resources/SKILL.md','frontend/src/app.ts','deploy/docker/.env.example']
        for path in excluded+allowed:
            p=root/path;p.parent.mkdir(parents=True,exist_ok=True);p.write_text('synthetic-context-canary')
        (root/'Dockerfile').write_text('FROM scratch\nCOPY . /context/\n')
        run('build','-t',name,tmp)
        run('create','--name',name,name,'/noop')
        export=run('export',name,binary=True).stdout
        with tarfile.open(fileobj=io.BytesIO(export)) as tar:
            entries=set(tar.getnames())
        for path in excluded: assert 'context/'+path not in entries,path
        for path in allowed: assert 'context/'+path in entries,path
        print('PASS: synthetic secrets/caches excluded; required source and Markdown retained')
finally:
    subprocess.run([docker,'rm','-f',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    subprocess.run([docker,'image','rm',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
