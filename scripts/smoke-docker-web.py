#!/usr/bin/env python3
"""Real-image, localhost-only regression. Uses only synthetic keys and owned resources.
Usage: python3 scripts/smoke-docker-web.py IMAGE
Optional: DOCKER_HOST, DOCKER_BIN, OMNIPANEL_TEST_DOCKER_SOCKET (explicit Engine tests).
"""
import base64
import http.client
import json
import os
from pathlib import Path
import re
import secrets
import socket
import struct
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

IMAGE = sys.argv[1] if len(sys.argv) > 1 else "omnipanel-web:local"
DOCKER = os.environ.get("DOCKER_BIN", "docker")
PREFIX = "omnipanel-smoke-" + secrets.token_hex(4)
KEY = secrets.token_urlsafe(32)
SOCKET = os.environ.get("OMNIPANEL_TEST_DOCKER_SOCKET")
ENV = dict(os.environ, OMNIPANEL_API_KEY=KEY)
VOLUME = PREFIX + "-data"
NAME = PREFIX + "-web"
WORKER = PREFIX + "-worker"
PROJECT = PREFIX + "-compose"
NETWORK = PREFIX + "-net"
PORT = 0
COOKIE = ""
KEEP = os.environ.get("OMNIPANEL_TEST_KEEP") == "1"
SUCCEEDED = False

def docker(*args, check=True, input=None):
    return subprocess.run([DOCKER, *args], env=ENV, text=True, input=input,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=check)

def request(path, data=None, method=None, headers=None):
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}{path}",
        data=json.dumps(data).encode() if data is not None else None,
        method=method, headers={"Content-Type":"application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=15) as res:
            return res.status, res.headers, res.read()
    except urllib.error.HTTPError as err:
        return err.code, err.headers, err.read()

def invoke(cmd, args=None):
    status, _, body = request("/ipc/invoke", {"cmd":cmd,"args":args or {}}, headers={"Cookie":COOKIE})
    assert status == 200, (cmd, status)
    result=json.loads(body)
    assert result.get("ok"), (cmd,result.get("error"))
    return result.get("data")

def wait_ready():
    for _ in range(150):
        try:
            code,_,_=request("/healthz")
            if code == 200: return
        except (OSError, urllib.error.URLError): pass
        time.sleep(.2)
    raise AssertionError("healthz did not become ready")

def start():
    args=["run","-d","--name",NAME,"--network",NETWORK,"-p",f"127.0.0.1:{PORT}:8899","-e","OMNIPANEL_API_KEY","-v",f"{VOLUME}:/data"]
    if SOCKET: args += ["-v",f"{SOCKET}:/var/run/docker.sock"]
    docker(*args,IMAGE)
    wait_ready()

def login():
    global COOKIE
    status,headers,body=request("/ipc/auth",{"api_key":KEY},headers={"Origin":f"http://127.0.0.1:{PORT}"})
    assert status == 200
    raw=headers.get("Set-Cookie","")
    assert "HttpOnly" in raw and "SameSite=Strict" in raw and "Max-Age=" in raw
    assert KEY not in raw and KEY.encode() not in body
    assert headers.get("Cache-Control") == "no-store"
    COOKIE=raw.split(';')[0]

def ws_handshake(cookie="",origin=None,query=""):
    s=socket.create_connection(("127.0.0.1",PORT),timeout=5)
    key=base64.b64encode(secrets.token_bytes(16)).decode()
    headers=[f"GET /ipc/events{query} HTTP/1.1",f"Host: 127.0.0.1:{PORT}","Connection: Upgrade","Upgrade: websocket","Sec-WebSocket-Version: 13",f"Sec-WebSocket-Key: {key}"]
    if cookie: headers.append("Cookie: "+cookie)
    if origin: headers.append("Origin: "+origin)
    s.sendall(("\r\n".join(headers)+"\r\n\r\n").encode())
    response=b""
    while b"\r\n\r\n" not in response: response+=s.recv(1)
    return s,int(response.split(b" ")[1])

def ws_frame(s):
    def read(n):
        data=b""
        while len(data)<n:
            part=s.recv(n-len(data))
            if not part: raise EOFError("closed WebSocket")
            data+=part
        return data
    _,second=read(2);length=second&127
    if length==126:length=struct.unpack("!H",read(2))[0]
    elif length==127:length=struct.unpack("!Q",read(8))[0]
    return json.loads(read(length))

def main():
    global PORT,COOKIE,SUCCEEDED
    with socket.socket() as free:
        free.bind(("127.0.0.1",0));PORT=free.getsockname()[1]
    # Fail closed, even without a key. Never print the random key or cookie.
    refused=docker("run","--rm","--network","none","-e","OMNIPANEL_API_KEY=",IMAGE,check=False)
    assert refused.returncode != 0 and "Set OMNIPANEL_API_KEY" in refused.stderr, "image failed to reject missing API key correctly"
    blank=docker("run","--rm","--network","none","-e","OMNIPANEL_API_KEY=   ",IMAGE,check=False)
    assert blank.returncode != 0 and "Set OMNIPANEL_API_KEY" in blank.stderr, "whitespace key silently disabled auth"
    docker("network","create",NETWORK)
    start()
    health=json.loads(request('/healthz')[2]);assert health['status']=='ok'
    status,_,html=request('/');assert status==200 and KEY.encode() not in html
    assert b"omnipanel-runtime-config.js" not in html
    assert request('/omnipanel-runtime-config.js')[0]==404
    for path in re.findall(rb'(?:src|href)="(/assets/[^"]+)"',html):
        status,_,body=request(path.decode());assert status==200 and KEY.encode() not in body
    assert request('/ipc/invoke',{'cmd':'list_shells'})[0]==401
    assert request('/ipc/invoke',{'cmd':'list_shells'},headers={'Authorization':'Bearer wrong'})[0]==401
    assert request('/ipc/auth',{'api_key':'wrong'})[0]==401
    assert request('/ipc/auth',{'api_key':KEY},headers={'Origin':'https://evil.example'})[0]==403
    assert request('/ipc/auth',method='OPTIONS',headers={'Origin':'https://evil.example','Access-Control-Request-Method':'POST'})[0]==403
    assert request('/ipc/status')[0]==401
    state=json.loads(request('/ipc/auth')[2]);assert state=={'required':True,'authenticated':False}
    login()
    assert request('/ipc/status',headers={'Cookie':COOKIE})[0]==200
    assert request('/ipc/invoke',{'cmd':'list_shells'},headers={'Authorization':'Bearer '+KEY})[0]==200
    assert request('/ipc/invoke',{'cmd':'list_shells'},headers={'Cookie':COOKIE,'Origin':'https://evil.example'})[0]==403
    for cookie,origin,query,expected in [("",None,"",401),("",None,"?token="+KEY,401),("omnipanel_session=wrong",None,"",401),(COOKIE,"https://evil.example","",403)]:
        ws,code=ws_handshake(cookie,origin,query);ws.close();assert code==expected,("WS",code,expected)
    ws,code=ws_handshake(COOKIE,f"http://127.0.0.1:{PORT}");assert code==101
    assert invoke('list_shells')
    tid=invoke('create_terminal',{'cols':80,'rows':24})
    invoke('write_terminal',{'id':tid,'data':list(b'printf "OMNIPANEL_%s_OK\\n" DOCKER_PTY\r')})
    saw_event=False
    for _ in range(30):
        event=ws_frame(ws)
        if event.get('event')=='terminal-output':saw_event=True;break
    assert saw_event
    for _ in range(40):
        snapshot=base64.b64decode(invoke('terminal_snapshot',{'id':tid})).decode(errors='replace')
        if 'OMNIPANEL_DOCKER_PTY_OK' in snapshot: break
        time.sleep(.1)
    assert 'OMNIPANEL_DOCKER_PTY_OK' in snapshot
    invoke('close_terminal',{'id':tid});ws.close()
    conns=invoke('file_list_connections');assert any(c['id']=='file-local' for c in conns)
    assert 'entries' in invoke('file_list_dir',{'connectionId':'file-local','path':'/data'})
    db={'id':'smoke-sqlite','name':'Smoke SQLite','db_type':'sqlite','host':'','port':0,'user':'','password':'','database':'/data/smoke.sqlite'}
    invoke('db_save_connection',{'connection':db})
    result=invoke('db_execute_query',{'connection':db,'sql':'SELECT 42 AS smoke','runId':'smoke-select'})
    assert result['rows']==[[42]]
    invoke('db_execute_query',{'connection':db,'sql':'CREATE TABLE smoke_persist (value INTEGER)','runId':'smoke-create'})
    invoke('db_execute_query',{'connection':db,'sql':'INSERT INTO smoke_persist VALUES (42)','runId':'smoke-insert'})
    fake=dict(db,id='smoke-secret',name='Synthetic credential',db_type='postgres',host='127.0.0.1',port=65432,database='test-only',password='synthetic-'+secrets.token_hex(16))
    invoke('db_save_connection',{'connection':fake})
    assert invoke('db_get_connection_secret',{'id':fake['id']})==fake['password']
    assert docker('exec',NAME,'stat','-c','%a','/data/omnipd/secrets/db-password-smoke-secret.secret').stdout.strip()=='600'
    docker('exec',NAME,'sh','-c','printf marker > /data/smoke-marker')
    cli=docker('exec',NAME,'docker','--version');assert 'Docker version' in cli.stdout
    compose=docker('exec',NAME,'docker','compose','version');assert 'Compose version' in compose.stdout
    if SOCKET:
        engine=invoke('docker_get_local_engine_status');assert engine['running']
        invoke('docker_list_containers',{'connectionId':'docker-local'})
        cli_result=invoke('docker_host_run_cli',{'connectionId':'docker-local','command':'docker version','progressChannel':'smoke-progress'})
        assert cli_result.get('exitCode')==0,cli_result
        worker=docker('create','--name',WORKER,'--network','none','--tmpfs','/data','--entrypoint','/bin/sh',IMAGE,'-c','echo OWNED_WORKER; sleep 300').stdout.strip()
        invoke('docker_container_action',{'connectionId':'docker-local','containerId':worker,'action':'start'})
        assert docker('inspect',worker,'--format','{{.State.Running}}').stdout.strip()=='true'
        invoke('docker_container_action',{'connectionId':'docker-local','containerId':worker,'action':'stop'})
        docker('rm',worker)
        content=json.dumps({'services':{'probe':{'image':IMAGE,'entrypoint':['/bin/sh','-c'],'command':['echo OMNIPANEL_COMPOSE_OK; sleep 300'],'network_mode':'none','tmpfs':['/data'],'pull_policy':'never'}}})
        docker('exec','-i',NAME,'sh','-c','mkdir -p /tmp/smoke-compose; cat > /tmp/smoke-compose/compose.json',input=content)
        req={'project':PROJECT,'services':[],'detached':True,'configFile':'/tmp/smoke-compose/compose.json','workingDir':'/tmp/smoke-compose'}
        for action in ['up','logs','down']:
            payload={'connectionId':'docker-local','action':action,'request':req}
            if action=='down':
                status,_,body=request('/ipc/invoke',{'cmd':'docker_compose_action','args':payload},headers={'Cookie':COOKIE})
                denied=json.loads(body)
                assert status==200 and not denied.get('ok') and 'Permission' in denied.get('error','')
                grant=invoke('presence_issue_typed',{'action':'docker.compose.down','target':'docker-local|'+PROJECT,'typed':PROJECT})
                payload['presenceToken']=grant['token']
            result=invoke('docker_compose_action',payload)
            assert result.get('exitCode')==0,(action,result)
            if action=='logs':
                for _ in range(30):
                    if 'OMNIPANEL_COMPOSE_OK' in result.get('stdoutExcerpt',''):break
                    time.sleep(.1)
                    result=invoke('docker_compose_action',{'connectionId':'docker-local','action':'logs','request':req})
                assert 'OMNIPANEL_COMPOSE_OK' in result.get('stdoutExcerpt','')
    else:
        assert not invoke('docker_get_local_engine_status')['running'], 'default image unexpectedly accessed an Engine'
    # Logout revokes access; no URI key fallback.
    old=COOKIE
    revoked_ws,code=ws_handshake(COOKIE,f'http://127.0.0.1:{PORT}');assert code==101
    assert request('/ipc/auth',method='DELETE',headers={'Cookie':COOKIE,'Origin':f'http://127.0.0.1:{PORT}'})[0]==204
    assert request('/ipc/invoke',{'cmd':'list_shells'},headers={'Cookie':old})[0]==401
    denied_ws,code=ws_handshake(old,f'http://127.0.0.1:{PORT}');denied_ws.close();assert code==401
    revoked_ws.settimeout(35)
    try:
        assert revoked_ws.recv(1)==b'', 'revoked WebSocket remained usable'
    except ConnectionResetError:
        pass
    finally:
        revoked_ws.close()
    login()
    docker('restart','-t','1',NAME);wait_ready()
    assert request('/ipc/invoke',{'cmd':'list_shells'},headers={'Cookie':COOKIE})[0]==401
    login()
    assert invoke('db_get_connection_secret',{'id':fake['id']})==fake['password']
    assert any(c['id']==db['id'] for c in invoke('db_list_connections'))
    assert invoke('db_execute_query',{'connection':db,'sql':'SELECT value FROM smoke_persist','runId':'smoke-restart-read'})['rows']==[[42]]
    prior_logs=docker('logs',NAME)
    assert KEY not in prior_logs.stdout+prior_logs.stderr, 'API key leaked into request logs before recreation'
    assert fake['password'] not in prior_logs.stdout+prior_logs.stderr, 'synthetic stored credential leaked into logs'
    docker('rm','-f',NAME);start();login()
    assert invoke('db_get_connection_secret',{'id':fake['id']})==fake['password']
    assert docker('exec',NAME,'sh','-c','test "$(cat /data/smoke-marker)" = marker').returncode==0
    assert invoke('db_execute_query',{'connection':db,'sql':'SELECT value FROM smoke_persist','runId':'smoke-recreate-read'})['rows']==[[42]]
    logs=docker('logs',NAME)
    assert KEY not in logs.stdout+logs.stderr, 'API key leaked into request logs'
    assert KEY not in docker('exec',NAME,'cat','/proc/1/cmdline').stdout, 'API key leaked into process arguments'
    info=json.loads(docker('image','inspect',IMAGE).stdout)[0]
    print(json.dumps({'result':'PASS','image':IMAGE,'image_id':info['Id'],'version_label':info['Config'].get('Labels',{}).get('org.opencontainers.image.version'),'health':health,'engine_compose_tested':bool(SOCKET),'browser_rendering_tested':False,'localhost':f'http://127.0.0.1:{PORT}','container':NAME if KEEP else 'cleaned'},indent=2))
    if KEEP:
        # Synthetic test key only, protected file for parent-led GUI acceptance; never print it.
        path=Path(os.environ.get('OMNIPANEL_TEST_KEY_FILE','/tmp/omnipanel-smoke-ui-key'))
        fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
        os.fchmod(fd,0o600)
        with os.fdopen(fd,'w') as f:f.write(KEY)
    SUCCEEDED = True

try:
    main()
finally:
    if not KEEP or not SUCCEEDED:
        docker('exec',NAME,'docker','compose','-p',PROJECT,'-f','/tmp/smoke-compose/compose.json','down','-v',check=False)
        docker('rm','-f','-v',NAME,WORKER,check=False)
        docker('volume','rm',VOLUME,check=False)
        docker('network','rm',NETWORK,check=False)
