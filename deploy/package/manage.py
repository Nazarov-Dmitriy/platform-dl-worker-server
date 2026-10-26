#!/usr/bin/env python3
"""worker install/start/stop/status/logs/where/export. All state stays in ./instance."""
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
    context = ssl.create_default_context(cafile=str(target / "data/device-ca.crt"))
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
    with sqlite3.connect((target / "data/dispatcher.db").as_uri() + "?mode=ro", uri=True) as db:
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
                for name in ("manage.py", "compose.yaml", "fingerprint.py", "README.md"):
                    archive.add(SOURCE / name, arcname=name)
                archive.add(ROOT / "worker", arcname="worker")
                archive.add(target, arcname="instance", filter=lambda info: None if info.name.endswith(".install.lock") else info)
                archive.add(images, arcname=images.name)
                info = tarfile.TarInfo("release.env")
                info.size = len(release)
                archive.addfile(info, io.BytesIO(release))
        except BaseException:
            output.unlink(missing_ok=True)
            raise
    print("Архив переезда: " + str(output) + "\nСтарый экземпляр остановлен. Запускайте только одну копию.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["install", "start", "stop", "status", "logs", "where", "export"], nargs="?", default="install")
    parser.add_argument("output", nargs="?")
    parser.add_argument("--dir", default=str(ROOT / "instance"))
    parser.add_argument("--host")
    parser.add_argument("--port", type=int)
    parser.add_argument("--listen-ip")
    parser.add_argument("--login")
    parser.add_argument("--password-stdin", action="store_true")
    parser.add_argument("--image")
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
        if args.action == "export":
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
