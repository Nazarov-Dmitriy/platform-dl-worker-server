#!/usr/bin/env python3
import argparse
import base64
import http.cookiejar
import json
import os
from pathlib import Path
import socket
import ssl
import subprocess
import tarfile
import tempfile
import urllib.request
import uuid

def run(args, data=None):
    result = subprocess.run(args, input=data, capture_output=True)
    if result.returncode:
        raise RuntimeError(result.stderr.decode(errors="replace"))
    return result.stdout

def smoke(bundle):
    assert os.geteuid() == 0
    project="worker-package-smoke-"+uuid.uuid4().hex[:12]
    os.environ["WORKER_PROJECT_NAME"]=project
    with tempfile.TemporaryDirectory(prefix="worker-package-smoke-") as temporary:
        root=Path(temporary)
        first,second=root/"first",root/"second"
        first.mkdir()
        with tarfile.open(bundle) as archive:
            archive.extractall(first,filter="data")
        active=None
        def cli(directory, *args, data=None):
            return run(["bash",str(directory/"worker"),*args],data)
        def down(directory):
            target=directory/"instance"
            return run(["docker","compose","--project-name",project,"--project-directory",str(target),"--env-file",str(target/".env"),"-f",str(target/"compose.yaml"),"down"])
        try:
            active=first
            output=cli(first,"install","--host","127.0.0.1","--login","smoke-owner","--listen-ip","127.0.0.1","--port","18090","--password-stdin",data=b"chosen-smoke-password\n").decode()
            assert str(first/"instance") in output
            assert not (first/"instance/data/.bootstrap-password").exists()
            ca=first/"instance/data/device-ca.crt"
            trust=ca.read_bytes()
            context=ssl.create_default_context(cafile=str(ca))
            cookies=http.cookiejar.CookieJar()
            opener=urllib.request.build_opener(urllib.request.HTTPSHandler(context=context),urllib.request.HTTPCookieProcessor(cookies))
            csrf=""
            def api(path, body=None, method=None):
                request=urllib.request.Request("https://127.0.0.1:18090"+path,
                    data=json.dumps(body).encode() if body is not None else None,
                    headers={"Content-Type":"application/json","X-CSRF-Token":csrf},method=method)
                with opener.open(request,timeout=10) as response:return json.load(response)
            with opener.open("https://127.0.0.1:18090/device-ca.crt",timeout=10) as response:
                assert response.read()==trust
                assert "attachment" in response.headers["Content-Disposition"]
            with opener.open("https://127.0.0.1:18090/panel/",timeout=10) as response:
                assert b'/device-ca.crt' in response.read()
            csrf=api("/api/v2/admin/session",{"login":"smoke-owner","password":"chosen-smoke-password"})["csrfToken"]
            assert all(cookie.secure for cookie in cookies)
            assert api("/api/v2/admin/connection")["host"]=="127.0.0.1"
            device=api("/api/v2/admin/devices",{"name":"smoke-device","enabled":True})
            token=api("/api/v2/admin/devices/"+device["id"]+"/tokens",{"requestId":str(uuid.uuid4())})["token"]
            def websocket():
                with socket.create_connection(("127.0.0.1",18090),timeout=10) as raw:
                    with context.wrap_socket(raw,server_hostname="127.0.0.1") as connection:
                        request=("GET /api/v2/device/connect HTTP/1.1\r\nHost: 127.0.0.1:18090\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: "+base64.b64encode(os.urandom(16)).decode()+"\r\nAuthorization: Bearer "+token+"\r\n\r\n")
                        connection.sendall(request.encode())
                        assert b" 101 " in connection.recv(2048).split(b"\r\n",1)[0]
            websocket()
            cli(first,"install")
            assert (first/"instance/data/device-ca.crt").read_bytes()==trust
            assert api("/api/v2/admin/session")["role"]=="OWNER"
            assert str(first/"instance") in cli(first,"where").decode()
            containers=run(["docker","ps","-q","--filter","label=com.docker.compose.project="+project]).decode().split()
            assert len(containers)==1, "Package must run exactly one container"
            api("/api/v2/admin/ops",{"maintenance":True},method="PUT")
            move=root/"move.tgz"
            cli(first,"export",str(move))
            assert move.stat().st_mode & 0o777==0o600
            down(first)
            active=None
            second.mkdir()
            with tarfile.open(move) as archive:archive.extractall(second,filter="fully_trusted")
            active=second
            cli(second,"install","--host","127.0.0.1")
            assert (second/"instance/data/device-ca.crt").read_bytes()==trust
            assert api("/api/v2/admin/session")["role"]=="OWNER"
            assert any(value["id"]==device["id"] for value in api("/api/v2/admin/devices")["items"])
            websocket()
            print("PASS: one container, worker install, chosen password, visible instance path, CA download in panel, TLS/WSS, reinstall and migration")
        finally:
            if active and (active/"instance/compose.yaml").exists():down(active)

if __name__=="__main__":
    parser=argparse.ArgumentParser();parser.add_argument("bundle");smoke(parser.parse_args().bundle)
