#!/usr/bin/env python3
"""worker install/start/stop/status/logs/where/export. All state stays in ./instance."""
from contextlib import closing
import argparse
import fcntl
import getpass
import gzip
import io
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import sqlite3
import ssl
import subprocess
import sys
import tarfile
import tempfile
import time
from fingerprint import image_fingerprint

SOURCE = Path(__file__).resolve().parent
ROOT = Path(os.environ.get("WORKER_PACKAGE_ROOT", SOURCE)).resolve()
PROJECT = os.environ.get("WORKER_PROJECT_NAME", "worker-dispatcher")


def run(args, *, data=None, env=None):
    result = subprocess.run(args, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
    if result.returncode:
        raise RuntimeError(result.stderr.decode(errors="replace").strip() or "Не удалось выполнить: " + args[0])
    return result.stdout


def read_env(path):
    if not path.exists():
        return {}
    return dict(line.split("=", 1) for line in path.read_text().splitlines() if line and not line.startswith("#") and "=" in line)


def write(path, value, mode=0o600, owner=None):
    if path.is_symlink():
        raise ValueError("Символическая ссылка вместо файла: " + str(path))
    previous = path.stat() if path.exists() else None
    fd, name = tempfile.mkstemp(prefix=".worker-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(value if isinstance(value, bytes) else value.encode())
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(name, mode)
        if owner is not None:
            os.chown(name, owner, owner)
        elif previous:
            os.chown(name, previous.st_uid, previous.st_gid)
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def valid_host(host):
    try:
        ipaddress.ip_address(host)
        return True
    except ValueError:
        return bool(host) and len(host) <= 253 and all(re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?", part) for part in host.split("."))


def ready(target, host, port, interface):
    context = ssl.create_default_context()
    context.load_verify_locations(cafile=str(target / "data/device-ca.crt"))
    address = "127.0.0.1" if interface == "0.0.0.0" else interface
    with socket.create_connection((address, port), timeout=10) as raw:
        with context.wrap_socket(raw, server_hostname=host) as connection:
            connection.sendall(("GET /readyz HTTP/1.1\r\nHost: " + host + "\r\nConnection: close\r\n\r\n").encode())
            if b" 200 " not in connection.recv(1024).split(b"\r\n", 1)[0]:
                raise RuntimeError("Сервис ещё не готов")


def exported(root, target, compose, environment, output):
    output = Path(output).resolve()
    if output.exists() or output.is_relative_to(root) or output.is_relative_to(target):
        raise ValueError("Укажите новый архив за пределами папки пакета и данных")
    with closing(sqlite3.connect((target / "data/dispatcher.db").as_uri() + "?mode=ro", uri=True)) as db:
        active = db.execute("SELECT count(*) FROM assignments WHERE state IN ('OFFERED','RUNNING','CANCELLING','RELEASING')").fetchone()[0]
        maintenance = db.execute("SELECT value FROM metadata WHERE key='maintenance'").fetchone()
        if active or not maintenance or maintenance[0] != "1":
            raise ValueError("Включите обслуживание в панели и дождитесь завершения работ")
    run(compose + ["stop"], env=environment)
    image = environment["DISPATCHER_IMAGE"]
    with tempfile.TemporaryDirectory(prefix="worker-move-") as stage:
        images = Path(stage) / "dispatcher-image.tar.gz"
        with images.open("wb") as raw, gzip.GzipFile(fileobj=raw, mode="wb") as compressed:
            process = subprocess.Popen(["docker", "image", "save", image], stdout=subprocess.PIPE)
            shutil.copyfileobj(process.stdout, compressed)
            process.stdout.close()
            if process.wait():
                raise RuntimeError("Не удалось сохранить образ; старый экземпляр оставлен остановленным")
        release = ("DISPATCHER_IMAGE=" + image + "\nDISPATCHER_IMAGE_FINGERPRINT=" + image_fingerprint(image) + "\n").encode()
        fd = os.open(output, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        try:
            with os.fdopen(fd, "wb") as stream, tarfile.open(fileobj=stream, mode="w:gz") as archive:
                for name in ("manage.py", "compose.yaml", "fingerprint.py", "update.py", "README.md"):
                    archive.add(SOURCE / name, arcname=name)
                archive.add(ROOT / "worker", arcname="worker")
                if (ROOT / "VERSION").exists():
                    archive.add(ROOT / "VERSION", arcname="VERSION")
                archive.add(target, arcname="instance", filter=lambda info: None if info.name.endswith(".install.lock") else info)
                archive.add(images, arcname=images.name)
                info = tarfile.TarInfo("release.env")
                info.size = len(release)
                archive.addfile(info, io.BytesIO(release))
        except BaseException:
            output.unlink(missing_ok=True)
            raise
    print("Архив переезда: " + str(output) + "\nСтарый экземпляр остановлен. Запускайте только одну копию.")



class PublicCertificate:
    """Fixed Certbot image and root-owned paths; no commands/paths supplied by the panel."""
    IMAGE = "certbot/certbot:v5.4.0"

    def __init__(self, target, project):
        if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,62}", project):
            raise ValueError("Invalid project")
        self.target, self.project = Path(target), project
        self.path = self.target / "public-certificate-state.json"
        if self.path.exists() and self.state().get("busy"):
            self.publish(busy=False, message="Проверка сертификата была прервана; повторите проверку")

    def state(self):
        value = json.loads(self.path.read_text()) if self.path.exists() else {}
        return dict(enabled=False, busy=False, message="Публичный сертификат пока не включён") | value

    def publish(self, **values):
        value = self.state() | values
        write(self.path, json.dumps(value, ensure_ascii=False))
        return value

    def host(self):
        data = self.target / "data/connection.json"
        host = json.loads(data.read_text())["host"] if data.exists() else read_env(self.target / ".env")["DISPATCHER_HOST"]
        address = ipaddress.ip_address(host)
        if address.version != 4 or not address.is_global:
            raise ValueError("Для Let’s Encrypt нужен публичный IPv4-адрес сервера")
        return str(address)

    def challenge(self, host):
        if shutil.which("nginx"):
            webroot = Path("/var/lib/worker-acme") / self.project
            webroot.mkdir(parents=True, exist_ok=True, mode=0o755)
            os.chmod(webroot.parent, 0o755)
            os.chmod(webroot, 0o755)
            config = Path("/etc/nginx/conf.d") / ("worker-acme-" + self.project + ".conf")
            # An explicit IP Host routes only validation requests; other virtual hosts are unchanged.
            content = "server {\n listen 80;\n server_name " + host + ";\n location ^~ /.well-known/acme-challenge/ { root " + str(webroot) + "; default_type text/plain; }\n location / { return 404; }\n}\n"
            previous = config.read_bytes() if config.exists() else None
            try:
                write(config, content, 0o644)
                run(["nginx", "-t"])
                run(["systemctl", "reload", "nginx"])
            except BaseException:
                if previous is None: config.unlink(missing_ok=True)
                else: write(config, previous, 0o644)
                raise
            return ["-v", str(webroot) + ":/webroot", self.IMAGE], ["--webroot", "--webroot-path", "/webroot"]
        with socket.socket() as probe:
            probe.bind(("0.0.0.0", 80))
        return ["-p", "80:80", self.IMAGE], ["--standalone"]

    def install_bundle(self, bundle):
        # The application owns data/tls: use directory descriptors to prevent symlink/race writes as root.
        data = os.open(self.target / "data", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            tls = os.open("tls", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=data)
            try:
                name = ".public-" + secrets.token_hex(12)
                fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=tls)
                try:
                    os.fchown(fd, 10001, 10001)
                    with os.fdopen(fd, "wb") as stream:
                        stream.write(json.dumps(bundle).encode())
                        stream.flush()
                        os.fsync(stream.fileno())
                    os.replace(name, "public.json", src_dir_fd=tls, dst_dir_fd=tls)
                    os.fsync(tls)
                finally:
                    try: os.unlink(name, dir_fd=tls)
                    except FileNotFoundError: pass
            finally: os.close(tls)
        finally: os.close(data)

    def run(self, enable=False, staging=False):
        previous = self.state()
        if not enable and not previous.get("enabled"):
            return previous
        host = self.host()
        if previous.get("host") and host != previous["host"]:
            raise ValueError("IP изменился: сначала настройте сертификат для нового сервера")
        self.publish(busy=True, lastAttempt=int(time.time()), message="Проверяем сертификат Let’s Encrypt…")
        try:
            with (self.target / ".install.lock").open("a") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                base = self.target / ("acme-staging" if staging else "acme")
                base.mkdir(mode=0o700, exist_ok=True)
                image, challenge = self.challenge(host)
                command = ["docker", "run", "--rm", "--cap-drop=ALL", "--security-opt=no-new-privileges:true",
                           "-v", str(base) + ":/etc/letsencrypt", *image,
                           "certonly", "--non-interactive", "--agree-tos", "--register-unsafely-without-email",
                           "--preferred-profile", "shortlived", "--ip-address", host,
                           "--cert-name", "worker-ip", "--keep-until-expiring",
                           "--logs-dir", "/etc/letsencrypt/logs", "--work-dir", "/etc/letsencrypt/work", *challenge]
                if staging: command.append("--staging")
                result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=300)
                if result.returncode:
                    raise RuntimeError("Let’s Encrypt не выдал сертификат. Проверьте доступ к TCP 80; журнал: " + str(base / "logs"))
                live = base / "live/worker-ip"
                if staging:
                    return self.publish(busy=False, message="Тест Let’s Encrypt staging завершён; рабочий сертификат не изменён")
                # Validate the full chain and IP before publishing any private key to the dispatcher.
                run(["openssl", "verify", "-verify_ip", host, "-untrusted", str(live / "chain.pem"), str(live / "cert.pem")])
                decoded = ssl._ssl._test_decode_cert(str(live / "cert.pem"))
                expires = int(ssl.cert_time_to_seconds(decoded["notAfter"]))
                if expires <= time.time() + 3600:
                    raise ValueError("Срок нового сертификата слишком мал")
                bundle = {"host": host, "certificate": (live / "fullchain.pem").read_text(),
                          "privateKey": (live / "privkey.pem").read_text()}
                self.install_bundle(bundle)
                return self.publish(enabled=True, busy=False, host=host, expiresAt=expires,
                                    lastSuccess=int(time.time()), message="Let’s Encrypt включён. Проверка продления каждые 12 часов.")
        except BaseException:
            self.publish(busy=False, message="Не удалось обновить сертификат. Прежний сертификат сохранён; проверьте TCP 80 и журнал службы.")
            raise

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["install", "start", "stop", "status", "logs", "where", "export", "certificate"], nargs="?", default="install")
    parser.add_argument("output", nargs="?")
    parser.add_argument("--dir", default=str(ROOT / "instance"))
    parser.add_argument("--host")
    parser.add_argument("--port", type=int)
    parser.add_argument("--listen-ip")
    parser.add_argument("--login")
    parser.add_argument("--password-stdin", action="store_true")
    parser.add_argument("--image")
    parser.add_argument("--staging", action="store_true", help="Test ACME without changing the active certificate")
    args = parser.parse_args()
    target = Path(args.dir).expanduser().resolve()
    print("Папка сервиса: " + str(target), flush=True)
    if args.action == "where":
        return
    if os.geteuid() != 0:
        raise ValueError("Запустите команду с sudo")
    if target == Path("/") or len(target.parts) < 3:
        raise ValueError("Укажите отдельную папку данных")
    run(["docker", "compose", "version"])
    previous = read_env(target / ".env")
    environment = dict(os.environ, **previous)
    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,62}", PROJECT):
        raise ValueError("Недопустимое имя экземпляра")
    compose = ["docker", "compose", "--project-name", PROJECT, "--project-directory", str(target), "--env-file", str(target / ".env"), "-f", str(target / "compose.yaml")]
    if args.action != "install":
        if not previous:
            raise ValueError("Сначала выполните worker install")
        if args.action == "certificate":
            print(PublicCertificate(target, PROJECT).run(enable=True, staging=args.staging)["message"])
        elif args.action == "export":
            if not args.output:
                raise ValueError("Укажите путь архива: worker export /root/worker-move.tgz")
            with (target / ".install.lock").open("a") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                exported(ROOT, target, compose, environment, args.output)
        else:
            operation = {"start":["up", "-d", "--wait"], "stop":["stop"], "status":["ps"], "logs":["logs", "--tail=50"]}[args.action]
            print(run(compose + operation, env=environment).decode(), end="")
        return
    saved = {}
    if (target / "data/connection.json").exists():
        saved = json.loads((target / "data/connection.json").read_text())
    host = args.host or saved.get("host") or previous.get("DISPATCHER_HOST")
    if not host and sys.stdin.isatty():
        host = input("IP или домен этого сервера: ").strip()
    if not valid_host(host or ""):
        raise ValueError("Укажите IP или домен: worker install --host АДРЕС")
    port = args.port or int(previous.get("PUBLIC_PORT", "8090"))
    interface = args.listen_ip or previous.get("LISTEN_IP", "0.0.0.0")
    ipaddress.IPv4Address(interface)
    if not 1024 <= port <= 65535:
        raise ValueError("Порт должен быть от 1024 до 65535")
    first = not (target / "data/dispatcher.db").exists()
    login = args.login or previous.get("DISPATCHER_OWNER") or "owner"
    password = None
    if first:
        if not args.login and sys.stdin.isatty():
            login = input("Логин владельца [owner]: ").strip() or "owner"
        if args.password_stdin:
            password = sys.stdin.readline(4097).rstrip("\r\n")
        elif sys.stdin.isatty():
            password = getpass.getpass("Задайте пароль владельца (от 12 символов): ")
            if password != getpass.getpass("Повторите пароль: "):
                raise ValueError("Пароли не совпадают")
        else:
            raise ValueError("Для первой установки запустите интерактивно или передайте пароль через --password-stdin")
        if len(password) < 12 or len(password) > 4096 or any(c in password for c in "\r\n\0"):
            raise ValueError("Пароль должен содержать от 12 до 4096 символов в одной строке")
    if not re.fullmatch(r"[A-Za-z0-9_.@-]{1,64}", login):
        raise ValueError("Неверный логин")
    release = read_env(ROOT / "release.env")
    image = args.image or release.get("DISPATCHER_IMAGE") or previous.get("DISPATCHER_IMAGE")
    if image and (not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/@:+-]+", image) or image.endswith(":latest")):
        raise ValueError("Укажите версионированный образ вместо latest")
    target.mkdir(parents=True, exist_ok=True, mode=0o750)
    with (target / ".install.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        containers = run(["docker", "ps", "-aq", "--filter", "label=com.docker.compose.project=" + PROJECT]).decode().split()
        for container in containers:
            labels = json.loads(run(["docker", "inspect", container]))[0]["Config"]["Labels"]
            if Path(labels.get("com.docker.compose.project.working_dir", "")).resolve() != target:
                raise ValueError("Экземпляр уже установлен в " + labels.get("com.docker.compose.project.working_dir", "другой папке") + ". Его нужно перенести с сохранением данных.")
        if not image:
            revision = run(["git", "-C", str(ROOT), "rev-parse", "--short=12", "HEAD"]).decode().strip()
            image = "worker-dispatcher:" + revision
            print("Подготавливаю Docker-образ из проекта. Сборка выполняется автоматически…", flush=True)
            run(["docker", "build", "-t", image, str(ROOT)])
        elif (ROOT / "dispatcher-image.tar.gz").exists() and not args.image:
            print("Загружаю готовый образ из пакета…", flush=True)
            run(["docker", "load", "-i", str(ROOT / "dispatcher-image.tar.gz")])
            if image_fingerprint(image) != release.get("DISPATCHER_IMAGE_FINGERPRINT"):
                raise ValueError("Образ не соответствует пакету")
        elif args.image or not previous:
            run(["docker", "pull", image])
        else:
            run(["docker", "image", "inspect", image])
        if previous and previous["DISPATCHER_IMAGE"] != image:
            raise ValueError("Обновление версии требует обслуживания и резервной копии")
        from update import install_service
        install_service(ROOT, target, PROJECT)
        data = target / "data"
        if data.is_symlink():
            raise ValueError("Недопустимая символическая ссылка data")
        data.mkdir(exist_ok=True, mode=0o700)
        os.chown(data, 10001, 10001)
        os.chmod(data, 0o700)
        if password is not None:
            write(data / ".bootstrap-password", password + "\n", owner=10001)
        if args.host and saved:
            saved["host"] = host
            write(data / "connection.json", json.dumps(saved), owner=10001)
        settings = {"DISPATCHER_IMAGE":image, "DISPATCHER_HOST":host, "DISPATCHER_OWNER":login, "PUBLIC_PORT":str(port), "LISTEN_IP":interface}
        environment.update(settings)
        write(target / "compose.yaml", (SOURCE / "compose.yaml").read_bytes(), 0o644)
        write(target / ".env", "".join(k+"="+v+"\n" for k,v in settings.items()))
        run(compose + ["config", "-q"], env=environment)
        print("Запускаю сервис…", flush=True)
        run(compose + ["up", "-d", "--wait", "--wait-timeout", "120"], env=environment)
        ready(target, host, port, interface)
        print("Готово. Панель: https://" + ("[" + host + "]" if ":" in host else host) + ":" + str(port) + "/panel/")
        print("Логин: " + login + ". Пароль — тот, который вы задали при установке.")
        print("Сертификат для Mac/Windows скачивается кнопкой в панели. Данные и настройки: " + str(target))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError, OSError, KeyError) as error:
        sys.exit("Ошибка: " + str(error))
