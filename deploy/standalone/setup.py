#!/usr/bin/env python3
"""Install the self-contained Linux dispatcher bundle. Does not change host nginx."""
import argparse
import fcntl
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import ssl
import subprocess
import tempfile
import time
from fingerprint import image_fingerprint

SOURCE = Path(__file__).resolve().parent


def run(args, *, data=None, env=None):
    result = subprocess.run(args, input=data, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, env=env, check=False)
    if result.returncode:
        raise RuntimeError(result.stderr.decode(errors="replace").strip() or "Command failed: " + args[0])
    return result.stdout


def read_env(path):
    if not path.exists():
        return {}
    return dict(line.split("=", 1) for line in path.read_text().splitlines()
                if line and not line.startswith("#") and "=" in line)


def write_file(path, content, mode=0o600, uid=None, gid=None):
    """Atomic replacement retains the owner of an existing configuration file."""
    if path.is_symlink():
        raise ValueError("Refusing symlink: " + str(path))
    previous = path.stat() if path.exists() else None
    fd, name = tempfile.mkstemp(prefix=".install-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(content if isinstance(content, bytes) else content.encode())
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(name, mode)
        if uid is not None or previous:
            os.chown(name, uid if uid is not None else previous.st_uid,
                     gid if gid is not None else previous.st_gid)
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def validate_host(host):
    try:
        return str(ipaddress.ip_address(host))
    except ValueError:
        if len(host) > 253 or not all(re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?", label)
                                      for label in host.split(".")):
            raise ValueError("Host must be an IP address or DNS name, without scheme or port")
        return host.lower()


def validate_certificate(host, cert, key):
    run(["openssl", "x509", "-in", str(cert), "-noout", "-checkend", "0"])
    try:
        ipaddress.ip_address(host)
        check = "-checkip"
    except ValueError:
        check = "-checkhost"
    output = run(["openssl", "x509", "-in", str(cert), "-noout", check, host])
    # Some OpenSSL releases return zero even when the name does not match.
    if b"does NOT match" in output:
        raise ValueError("Certificate does not match the requested host")
    cert_public = run(["openssl", "x509", "-in", str(cert), "-pubkey", "-noout"])
    key_public = run(["openssl", "pkey", "-in", str(key), "-passin", "pass:", "-pubout"])
    if cert_public != key_public:
        raise ValueError("Certificate and private key do not match")


def automatic_tls(host, target):
    """Keep the installation CA across renewals and provider/IP changes."""
    tls = target / "tls"
    authority = tls / "authority"
    for directory in (tls, authority):
        if directory.is_symlink():
            raise ValueError("Refusing certificate directory symlink")
        directory.mkdir(exist_ok=True, mode=0o700)
    os.chmod(authority, 0o700)
    root_cert, root_key = authority / "ca.crt", authority / "ca.key"
    if root_cert.exists() != root_key.exists():
        raise ValueError("Incomplete installation CA; restore its certificate and key from the migration archive")
    with tempfile.TemporaryDirectory(prefix=".certificate-", dir=authority) as temporary:
        temporary = Path(temporary)
        if not root_cert.exists():
            cert, key = temporary / "ca.crt", temporary / "ca.key"
            run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "3650",
                 "-subj", "/CN=Worker installation " + secrets.token_hex(8),
                 "-addext", "basicConstraints=critical,CA:TRUE,pathlen:0",
                 "-addext", "keyUsage=critical,keyCertSign,cRLSign", "-keyout", str(key), "-out", str(cert)])
            write_file(root_key, key.read_bytes(), 0o600)
            write_file(root_cert, cert.read_bytes(), 0o644)
        run(["openssl", "x509", "-in", str(root_cert), "-noout", "-checkend", "2592000"])
        validate_certificate_from_key = run(["openssl", "x509", "-in", str(root_cert), "-pubkey", "-noout"])
        if validate_certificate_from_key != run(["openssl", "pkey", "-in", str(root_key), "-passin", "pass:", "-pubout"]):
            raise ValueError("Installation CA key does not match its certificate")
        cert, key = tls / "fullchain.pem", tls / "privkey.pem"
        valid = False
        if cert.is_file() and key.is_file():
            try:
                validate_certificate(host, cert, key)
                run(["openssl", "x509", "-in", str(cert), "-noout", "-checkend", "2592000"])
                run(["openssl", "verify", "-CAfile", str(root_cert), str(cert)])
                valid = True
            except (RuntimeError, ValueError):
                pass
        if not valid:
            leaf, leaf_key, csr, extensions = (temporary / name for name in ("leaf.pem", "leaf.key", "leaf.csr", "leaf.ext"))
            try:
                ipaddress.ip_address(host)
                san = "IP:" + host
            except ValueError:
                san = "DNS:" + host
            extensions.write_text("basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=" + san + "\n")
            run(["openssl", "req", "-new", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=Worker dispatcher",
                 "-keyout", str(leaf_key), "-out", str(csr)])
            run(["openssl", "x509", "-req", "-in", str(csr), "-CA", str(root_cert), "-CAkey", str(root_key),
                 "-set_serial", "0x" + secrets.token_hex(16), "-days", "397", "-sha256", "-extfile", str(extensions), "-out", str(leaf)])
            write_file(key, leaf_key.read_bytes(), 0o640, 0, 10001)
            write_file(cert, leaf.read_bytes() + root_cert.read_bytes(), 0o640, 0, 10001)
    write_file(target / "device-ca.crt", root_cert.read_bytes(), 0o644)
    return cert, key, target / "device-ca.crt", not valid


def renew_tls(target):
    settings = read_env(target / ".env")
    if settings.get("TLS_MODE") != "auto":
        return
    with (target / ".install.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        _, _, _, changed = automatic_tls(settings["PUBLIC_HOST"], target)
        if changed:
            environment = dict(os.environ, **settings)
            compose = ["docker", "compose", "--project-directory", str(target), "--env-file", str(target / ".env"), "-f", str(target / "compose.yaml")]
            run(compose + ["exec", "-T", "tls", "nginx", "-t"], env=environment)
            run(compose + ["exec", "-T", "tls", "nginx", "-s", "reload"], env=environment)
            print("TLS certificate renewed; installation CA unchanged")


def install_renew_timer(target):
    if not shutil.which("systemctl") or not Path("/run/systemd/system").is_dir():
        print("Automatic TLS renewal: systemd is unavailable; run install.sh again or setup.py --renew-tls before certificate expiry")
        return
    def quoted(value):
        return '"' + str(value).replace("\\", "\\\\").replace('"', '\\"').replace("%", "%%").replace("$", "$$") + '"'
    unit = ("[Unit]\nDescription=Renew worker dispatcher TLS certificate\nAfter=docker.service\nRequires=docker.service\n"
            "[Service]\nType=oneshot\nExecStart=/usr/bin/python3 " + quoted(target / "setup.py") + " --renew-tls --dir " + quoted(target) + "\n")
    write_file(Path("/etc/systemd/system/worker-dispatcher-cert-renew.service"), unit, 0o644)
    write_file(Path("/etc/systemd/system/worker-dispatcher-cert-renew.timer"),
               "[Unit]\nDescription=Daily worker dispatcher TLS renewal check\n[Timer]\nOnCalendar=daily\nPersistent=true\nRandomizedDelaySec=1h\n[Install]\nWantedBy=timers.target\n", 0o644)
    run(["systemctl", "daemon-reload"])
    run(["systemctl", "enable", "--now", "worker-dispatcher-cert-renew.timer"])


def tls_ready(host, port, listen_ip, ca, timeout=90):
    context = ssl.create_default_context(cafile=str(ca) if ca else None)
    address = "127.0.0.1" if listen_ip == "0.0.0.0" else listen_ip
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with socket.create_connection((address, port), timeout=3) as raw:
                with context.wrap_socket(raw, server_hostname=host) as connection:
                    connection.sendall(("GET /readyz HTTP/1.1\r\nHost: " + host + "\r\nConnection: close\r\n\r\n").encode())
                    if b" 200 " in connection.recv(1024).split(b"\r\n", 1)[0]:
                        return
        except ssl.SSLCertVerificationError:
            raise ValueError("TLS certificate is not trusted or invalid; use --ca for your private CA") from None
        except (OSError, ssl.SSLError):
            pass
        time.sleep(2)
    raise RuntimeError("TLS /readyz did not become ready; run docker compose logs in the installation directory")


def install(args):
    if os.geteuid() != 0:
        raise ValueError("Run with sudo (creates isolated data and certificate directories)")
    host = validate_host(args.host)
    if not 1024 <= args.port <= 65535:
        raise ValueError("Port must be between 1024 and 65535")
    ipaddress.IPv4Address(args.listen_ip)
    target = Path(args.dir).expanduser().resolve()
    if len(target.parts) < 3 or (target == SOURCE and not (target / ".env").exists()):
        raise ValueError("Use a dedicated installation directory, for example /opt/worker-server")
    for tool in ("docker", "openssl"):
        if not shutil.which(tool):
            raise ValueError("Required command not installed: " + tool)
    run(["docker", "compose", "version"])
    run(["docker", "info", "--format", "{{.ServerVersion}}"])
    if bool(args.cert) != bool(args.key):
        raise ValueError("Pass both --cert and --key, or neither for automatic certificates")
    cert, key = (Path(args.cert).resolve(), Path(args.key).resolve()) if args.cert else (None, None)
    if cert:
        validate_certificate(host, cert, key)
    elif args.ca:
        raise ValueError("--ca is only needed with your own --cert and --key")
    ca = Path(args.ca).resolve() if args.ca else None
    if ca:
        ssl.create_default_context(cafile=str(ca))
    release = read_env(SOURCE / "release.env")
    previous = read_env(target / ".env")
    image = args.image or release.get("DISPATCHER_IMAGE") or previous.get("DISPATCHER_IMAGE")
    if not image or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._/@:+-]+", image) or image.endswith(":latest"):
        raise ValueError("A versioned image is required (--image or release.env from the ready bundle)")
    if previous and previous.get("DISPATCHER_IMAGE") != image:
        raise ValueError("Image change requires a planned update and SQLite snapshot; use the installed version for a repeat installation")
    target.mkdir(parents=True, exist_ok=True, mode=0o750)
    # Serialize installs of the same instance.
    with (target / ".install.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        environment = dict(os.environ)
        settings = {"DISPATCHER_IMAGE": image, "PUBLIC_HOST": host,
                    "PUBLIC_PORT": str(args.port), "LISTEN_IP": args.listen_ip,
                    "TLS_MODE": "manual" if cert else "auto",
                    "OWNER_LOGIN": previous.get("OWNER_LOGIN", args.owner_login)}
        if not re.fullmatch(r"[a-zA-Z0-9_.@-]{1,64}", settings["OWNER_LOGIN"]):
            raise ValueError("Invalid owner login")
        environment.update(settings)
        compose = ["docker", "compose", "--project-name", "worker-dispatcher",
                   "--project-directory", str(target), "--env-file", str(target / ".env"),
                   "-f", str(target / "compose.yaml")]
        # Refuse to collide with another installation using the same Compose name.
        running = run(["docker", "ps", "-aq", "--filter", "label=com.docker.compose.project=worker-dispatcher"]).decode().split()
        for container in running:
            labels = json.loads(run(["docker", "inspect", container]))[0]["Config"]["Labels"]
            if Path(labels.get("com.docker.compose.project.working_dir", "")).resolve() != target:
                raise ValueError("Another worker-dispatcher installation exists; use its directory")
        archive = SOURCE / "dispatcher-image.tar.gz"
        if archive.is_file() and not args.image:
            run(["docker", "load", "-i", str(archive)])
            expected = release.get("DISPATCHER_IMAGE_FINGERPRINT")
            actual = image_fingerprint(image)
            if not expected or expected != actual:
                raise ValueError("Loaded image does not match release.env")
        else:
            if not previous or args.image:
                run(["docker", "pull", image])
            else:
                run(["docker", "image", "inspect", image])
        # Download dependencies before changing an existing installation.
        if archive.is_file() and not args.image:
            actual_tls = image_fingerprint("nginx:1.28.0-alpine")
            if release.get("TLS_IMAGE_FINGERPRINT") != actual_tls:
                raise ValueError("TLS image does not match release.env")
        elif not previous:
            run(["docker", "pull", "nginx:1.28.0-alpine"])
        first = not (target / "data" / "dispatcher.db").exists()
        if not first and not previous:
            raise ValueError("Existing database without installation .env; restore the complete migration archive")
        for directory in (target / "tls", target / "data"):
            if directory.is_symlink():
                raise ValueError("Refusing data/certificate symlink")
            directory.mkdir(exist_ok=True, mode=0o750)
            os.chown(directory, 10001 if directory.name == "data" else 0, 10001)
            os.chmod(directory, 0o750)
        if not cert:
            cert, key, ca, _ = automatic_tls(host, target)
        # These files belong exclusively to this installation. No backend .env is touched.
        for name in ("compose.yaml", "nginx.conf", "install.sh", "setup.py", "fingerprint.py", "export.sh", "export.py", "README.md"):
            write_file(target / name, (SOURCE / name).read_bytes(), 0o755 if name.endswith(".sh") else 0o644)
        write_file(target / "tls" / "fullchain.pem", cert.read_bytes(), 0o640, 0, 10001)
        write_file(target / "tls" / "privkey.pem", key.read_bytes(), 0o640, 0, 10001)
        if ca:
            write_file(target / "tls" / "ca.pem", ca.read_bytes(), 0o640, 0, 10001)
        write_file(target / ".env", "".join(k + "=" + v + "\n" for k, v in settings.items()))
        run(compose + ["config", "-q"], env=environment)
        run(compose + ["run", "--rm", "--no-deps", "tls", "-t"], env=environment)
        # Only initialize a stopped/new instance. Repeated installs never reset an account.
        active = run(compose + ["ps", "--status", "running", "-q", "dispatcher"], env=environment).strip()
        if not active:
            password_path = target / "initial-owner-password"
            created_password = not password_path.exists()
            password = password_path.read_text().rstrip("\r\n") if not created_password else secrets.token_hex(24)
            if created_password:
                write_file(password_path, password + "\n")
            result = json.loads(run(compose + ["run", "--rm", "--no-deps", "-T", "dispatcher",
                "owner-bootstrap", "-db", "/data/dispatcher.db", "-login", settings["OWNER_LOGIN"],
                "-password-stdin", "-if-needed"], data=(password + "\n").encode(), env=environment))
            if result.get("status") == "owner-exists" and created_password:
                password_path.unlink()  # A generated but unused password must not look valid.
        run(compose + ["up", "-d", "--wait", "--wait-timeout", "90", "dispatcher"], env=environment)
        run(compose + ["up", "-d", "--no-deps", "--force-recreate", "tls"], env=environment)
        tls_ready(host, args.port, args.listen_ip, ca)
        if settings["TLS_MODE"] == "auto":
            if not args.no_renew_timer:
                install_renew_timer(target)
            print("Mac/Windows trust file (public certificate only): " + str(target / "device-ca.crt"))
        print("Ready: https://" + ("[" + host + "]" if ":" in host else host) + ":" + str(args.port) + "/panel/")
        print("Owner login: " + settings["OWNER_LOGIN"] + "; initial password file: " + str(target / "initial-owner-password"))
        print("Allow inbound TCP " + str(args.port) + " in the VPS/provider firewall. No firewall rules or host nginx were changed.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dir", default="/opt/worker-server")
    parser.add_argument("--host")
    parser.add_argument("--cert", help="Optional existing PEM full certificate chain")
    parser.add_argument("--key", help="Optional existing unencrypted PEM private key")
    parser.add_argument("--ca", help="Optional private CA trusted for the readiness check")
    parser.add_argument("--port", type=int, default=8090)
    parser.add_argument("--listen-ip", default="0.0.0.0")
    parser.add_argument("--owner-login", default="owner")
    parser.add_argument("--image", help="Versioned image; normally supplied by the release bundle")
    parser.add_argument("--renew-tls", action="store_true", help="Renew the automatically issued certificate if needed")
    parser.add_argument("--no-renew-timer", action="store_true", help="Do not register the systemd renewal timer (isolated tests)")
    args = parser.parse_args()
    try:
        if args.renew_tls:
            if os.geteuid() != 0:
                raise ValueError("Run renewal with sudo")
            renew_tls(Path(args.dir).resolve())
        elif not args.host:
            parser.error("--host is required for installation")
        else:
            install(args)
    except (ValueError, RuntimeError, OSError) as error:
        parser.exit(1, "Installation failed: " + str(error) + "\n")


if __name__ == "__main__":
    main()
