#!/usr/bin/env python3
"""Disposable root/Linux smoke test. Never points at the website or its database."""
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


def command(args):
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode:
        raise RuntimeError(result.stderr.decode(errors="replace"))
    return result.stdout


def smoke(bundle):
    assert os.geteuid() == 0, "Run only as root on disposable Linux test host"
    assert not command(["docker", "ps", "-aq", "--filter", "label=com.docker.compose.project=worker-dispatcher"]).strip(), "A real instance already exists"
    with tempfile.TemporaryDirectory(prefix="worker-smoke-") as temporary:
        root = Path(temporary)
        release, first, second = root / "release", root / "first", root / "second"
        release.mkdir()
        with tarfile.open(bundle) as archive:
            archive.extractall(release, filter="data")
        base = ["--host", "127.0.0.1", "--listen-ip", "127.0.0.1", "--port", "18090", "--no-renew-timer"]
        active = None
        def compose(target, *args):
            return command(["docker", "compose", "--project-directory", str(target),
                            "--env-file", str(target / ".env"), "-f", str(target / "compose.yaml"), *args])
        def install(source, target):
            nonlocal active
            active = target
            command(["bash", str(source / "install.sh"), "--dir", str(target), *base])
        try:
            install(release, first)
            password = (first / "initial-owner-password").read_text().strip()
            ca = first / "device-ca.crt"
            trust = ca.read_bytes()
            context = ssl.create_default_context(cafile=str(ca))
            cookies = http.cookiejar.CookieJar()
            opener = urllib.request.build_opener(urllib.request.HTTPSHandler(context=context), urllib.request.HTTPCookieProcessor(cookies))
            csrf = ""
            def api(path, body=None, method=None):
                request = urllib.request.Request("https://127.0.0.1:18090" + path,
                    data=json.dumps(body).encode() if body is not None else None,
                    headers={"Content-Type":"application/json", "X-CSRF-Token":csrf}, method=method)
                with opener.open(request, timeout=10) as response:
                    return json.load(response)
            csrf = api("/api/v2/admin/session", {"login":"owner", "password":password})["csrfToken"]
            assert all(cookie.secure for cookie in cookies), "Admin cookie is not Secure"
            device = api("/api/v2/admin/devices", {"name":"smoke-device", "enabled":True})
            token = api("/api/v2/admin/devices/" + device["id"] + "/tokens", {"requestId":str(uuid.uuid4())})["token"]
            def handshake():
                with socket.create_connection(("127.0.0.1",18090), timeout=10) as raw:
                    with context.wrap_socket(raw, server_hostname="127.0.0.1") as connection:
                        request = ("GET /api/v2/device/connect HTTP/1.1\r\nHost: 127.0.0.1:18090\r\n" +
                            "Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n" +
                            "Sec-WebSocket-Key: " + base64.b64encode(os.urandom(16)).decode() + "\r\nAuthorization: Bearer " + token + "\r\n\r\n")
                        connection.sendall(request.encode())
                        assert b" 101 " in connection.recv(2048).split(b"\r\n",1)[0], "WSS upgrade failed"
            handshake()
            install(release, first)
            assert (first / "device-ca.crt").read_bytes() == trust
            assert (first / "initial-owner-password").read_text().strip() == password
            assert api("/api/v2/admin/session")["role"] == "OWNER", "Reinstall invalidated account/session"
            handshake()
            api("/api/v2/admin/ops", {"maintenance":True}, method="PUT")
            move = root / "move.tgz"
            command(["bash", str(first / "export.sh"), str(move)])
            assert move.stat().st_mode & 0o777 == 0o600
            assert not compose(first, "ps", "--status", "running", "-q").strip(), "Exporter restarted old instance"
            compose(first, "down")
            active = None
            second.mkdir()
            with tarfile.open(move) as archive:
                archive.extractall(second, filter="fully_trusted")
            install(second, second)
            assert (second / "device-ca.crt").read_bytes() == trust, "Migration replaced the trusted CA"
            assert api("/api/v2/admin/session")["role"] == "OWNER", "Migration lost session"
            assert api("/api/v2/admin/ops")["maintenance"] is True
            assert any(item["id"] == device["id"] for item in api("/api/v2/admin/devices")["items"])
            handshake()
            print("PASS: automatic certificates without input, TLS readiness, Secure login, WSS, reinstall, migration, CA/account/session/device/token preservation")
        finally:
            if active and (active / "compose.yaml").exists():
                compose(active, "down")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle")
    smoke(parser.parse_args().bundle)
