#!/usr/bin/env python3
"""Root-owned updater; the dispatcher can only check/install published releases over a Unix socket."""
import argparse
import fcntl
import hashlib
import http.server
import json
import logging
import os
from pathlib import Path
import re
import shutil
import socketserver
import sqlite3
import subprocess
import tarfile
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

from fingerprint import image_fingerprint
from manage import read_env, ready, write

REPOSITORY = "Nazarov-Dmitriy/platform-dl-worker-server"
VERSION = re.compile(r"worker-v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\Z")
FILES = {"worker", "manage.py", "update.py", "compose.yaml", "fingerprint.py", "README.md", "release.env", "VERSION", "dispatcher-image.tar.gz", "SHA256SUMS"}


def version(value):
    match = VERSION.fullmatch(value or "")
    if not match:
        raise ValueError("Неверный номер версии")
    return tuple(map(int, match.groups()))


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if urllib.parse.urlparse(newurl).scheme != "https":
            raise ValueError("Небезопасное перенаправление")
        redirected = super().redirect_request(req, fp, code, msg, headers, newurl)
        if urllib.parse.urlparse(newurl).netloc != urllib.parse.urlparse(req.full_url).netloc:
            redirected.remove_header("Authorization")
        return redirected


class GitHub:
    def __init__(self, token=""):
        self.token = token
        self.opener = urllib.request.build_opener(SafeRedirect())

    def request(self, path, binary=False):
        # No URL/image/command from the browser is used here.
        headers = {"User-Agent": "worker-updater/1", "Accept": "application/octet-stream" if binary else "application/vnd.github+json"}
        if self.token:
            headers["Authorization"] = "Bearer " + self.token
        return self.opener.open(urllib.request.Request("https://api.github.com/repos/" + REPOSITORY + path, headers=headers), timeout=60)

    def release(self, tag=None):
        if tag:
            version(tag)
        with self.request("/releases/tags/" + tag if tag else "/releases/latest") as response:
            raw = response.read(1024 * 1024 + 1)
        if len(raw) > 1024 * 1024:
            raise ValueError("Слишком большой ответ GitHub")
        release = json.loads(raw)
        version(release.get("tag_name"))
        if release.get("draft") or release.get("prerelease"):
            raise ValueError("Версия ещё не выпущена")
        return release

    def asset(self, release, name, destination=None):
        assets = [a for a in release["assets"] if a["name"] == name]
        if len(assets) != 1 or not isinstance(assets[0].get("id"), int):
            raise ValueError("В выпуске нет полного пакета обновления")
        limit = 512 * 1024 * 1024 if destination else 1024 * 1024
        with self.request("/releases/assets/" + str(assets[0]["id"]), binary=True) as response:
            if destination:
                count = 0
                with Path(destination).open("wb") as out:
                    while chunk := response.read(1024 * 1024):
                        count += len(chunk)
                        if count > limit:
                            raise ValueError("Пакет превышает допустимый размер")
                        out.write(chunk)
                return
            raw = response.read(limit + 1)
            if len(raw) > limit:
                raise ValueError("Манифест превышает допустимый размер")
            return json.loads(raw)


def validate_manifest(manifest, tag):
    version(tag)
    if manifest.get("protocol") != 1 or manifest.get("version") != tag:
        raise ValueError("Версия требует нового установщика")
    if manifest.get("asset") != "worker-server-linux-amd64-" + tag + ".tgz":
        raise ValueError("Неверное имя пакета")
    if not re.fullmatch(r"[0-9a-f]{64}", manifest.get("sha256", "")):
        raise ValueError("В выпуске нет контрольной суммы")
    return manifest


def unpack(bundle, destination):
    with tarfile.open(bundle, "r:gz") as archive:
        seen = set()
        total = 0
        for member in archive:
            name = member.name.removeprefix("./")
            if member.isdir() and name in ("", "."):
                continue
            if name not in FILES or name in seen or not member.isfile():
                raise ValueError("Недопустимое содержимое пакета")
            total += member.size
            if total > 768 * 1024 * 1024:
                raise ValueError("Распакованный пакет слишком большой")
            seen.add(name)
            with archive.extractfile(member) as source, (destination / name).open("wb") as out:
                shutil.copyfileobj(source, out)
        if seen != FILES:
            raise ValueError("Неполный пакет")


class Updater:
    def __init__(self, root, target, project, github=None):
        self.root, self.target, self.project = Path(root).resolve(), Path(target).resolve(), project
        self.source = self.root / "deploy/package" if (self.root / "deploy/package/manage.py").exists() else self.root
        self.github = github or GitHub(os.environ.get("GH_TOKEN", ""))
        self.lock = threading.Lock()
        self.guard = threading.RLock()
        self.state_path = self.target / "updater-state.json"
        self.journal = self.target / "updater-journal.json"
        self.state = {"enabled": True, "phase": "idle", "currentVersion": self.current(), "latestVersion": "", "available": False, "message": "Проверьте наличие новой версии"}
        self.interrupted = False
        self.resume = False
        self.draining = False
        if self.state_path.exists():
            self.state.update(json.loads(self.state_path.read_text()))
            self.state["currentVersion"] = self.current()
            if self.state["phase"] not in ("idle", "completed", "failed", "rolled_back"):
                self.interrupted = self.state["phase"] in ("waiting", "installing")
                self.state.update(phase="failed", message="Предыдущая операция прервана. Проверьте состояние сервиса.")

    def current(self):
        path = self.root / "VERSION"
        value = path.read_text().strip() if path.exists() else "worker-v0.0.0"
        return value if VERSION.fullmatch(value) else "worker-v0.0.0"

    def publish(self, **values):
        with self.guard:
            self.state.update(values)
            write(self.state_path, json.dumps(self.state, ensure_ascii=False))

    def status(self):
        with self.guard:
            return dict(self.state)

    def command(self, operation, tag=None):
        if operation == "install":
            if self.journal.exists():
                raise ValueError("Сначала восстановите предыдущую операцию")
            version(tag)
            if version(tag) <= version(self.current()):
                raise ValueError("Эта версия уже установлена или старее текущей")
        elif operation != "check":
            raise ValueError("Неизвестное действие")
        if not self.lock.acquire(blocking=False):
            raise ValueError("Дождитесь завершения текущей операции")
        self.publish(phase="checking" if operation == "check" else "downloading", message="Проверяем выпуск" if operation == "check" else "Скачиваем обновление")
        self.resume = False
        self.draining = False
        threading.Thread(target=self.perform, args=(operation, tag), daemon=True).start()
        return self.status()

    def perform(self, operation, tag):
        try:
            if operation == "check":
                release = self.github.release()
                manifest = validate_manifest(self.github.asset(release, "worker-update.json"), release["tag_name"])
                available = version(manifest["version"]) > version(self.current())
                self.publish(phase="idle", latestVersion=manifest["version"], available=available, checkedAt=int(time.time()), message="Доступно обновление" if available else "Установлена актуальная версия")
            else:
                with (self.target / ".install.lock").open("a") as lock:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    self.install(tag)
        except Exception:
            logging.exception("Worker release operation failed")
            # Do not leak HTTP headers, tokens, subprocess output or host paths to the panel.
            if self.status()["phase"] not in ("rolled_back", "rollback_failed"):
                self.publish(phase="failed", message="Не удалось выполнить обновление. Проверьте доступ к GitHub и журнал службы обновления.")
            if self.draining and self.resume and not self.journal.exists():
                self.maintenance(False)
        finally:
            self.lock.release()

    def compose(self, *args):
        environment = dict(os.environ, **read_env(self.target / ".env"))
        self.run(["docker", "compose", "--project-name", self.project, "--project-directory", str(self.target), "--env-file", str(self.target / ".env"), "-f", str(self.target / "compose.yaml"), *args], env=environment)

    def run(self, args, **kwargs):
        result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=240, **kwargs)
        if result.returncode:
            raise RuntimeError("Command failed: " + args[0])
        return result.stdout

    def maintenance(self, enabled):
        with sqlite3.connect(self.target / "data/dispatcher.db", timeout=10) as db:
            db.execute("INSERT INTO metadata(key,value) VALUES('maintenance',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", ("1" if enabled else "0",))

    def active(self):
        with sqlite3.connect((self.target / "data/dispatcher.db").as_uri() + "?mode=ro", uri=True) as db:
            return db.execute("SELECT count(*) FROM assignments WHERE state IN ('OFFERED','RUNNING','CANCELLING','RELEASING')").fetchone()[0]

    def wait_idle(self):
        with sqlite3.connect(self.target / "data/dispatcher.db", timeout=10) as db:
            previous = db.execute("SELECT value FROM metadata WHERE key='maintenance'").fetchone()
            self.resume = not previous or previous[0] != "1"
        self.draining = True
        self.publish(phase="waiting", resumeAfterUpdate=self.resume, message="Ждём завершения активных заданий")
        self.maintenance(True)
        deadline = time.monotonic() + 1800
        while self.active():
            if time.monotonic() > deadline:
                raise ValueError("Задания ещё выполняются")
            time.sleep(2)

    def health(self):
        self.compose("up", "-d", "--wait", "--wait-timeout", "120")
        settings = read_env(self.target / ".env")
        ready(self.target, settings["DISPATCHER_HOST"], int(settings.get("PUBLIC_PORT", "8090")), settings.get("LISTEN_IP", "0.0.0.0"))

    def backup(self):
        parent = self.target / "updates-backups"
        parent.mkdir(mode=0o700, exist_ok=True)
        backup = Path(tempfile.mkdtemp(prefix="before-", dir=parent))
        data = self.target / "data"
        if any(p.is_symlink() for p in data.rglob("*")):
            raise ValueError("Символические ссылки в данных не поддерживаются")
        with tarfile.open(backup / "data.tgz", "w:gz") as archive:
            archive.add(data, arcname="data")
        write(backup / "previous.env", (self.target / ".env").read_bytes())
        if (self.root / "release.env").exists():
            write(backup / "release.env", (self.root / "release.env").read_bytes())
        return backup

    def rollback(self, journal):
        backup = Path(journal["backup"])
        if backup.parent != self.target / "updates-backups" or not (backup / "data.tgz").is_file():
            raise ValueError("Не найдена резервная копия")
        self.compose("stop")
        data = self.target / "data"
        failed = backup / ("failed-data-" + str(time.time_ns()))
        if data.exists():
            data.rename(failed)
        with tarfile.open(backup / "data.tgz", "r:gz") as archive:
            # Archive was produced locally after the dispatcher was stopped; never a downloaded archive.
            archive.extractall(self.target, numeric_owner=True, filter="fully_trusted")
        write(self.target / ".env", (backup / "previous.env").read_bytes())
        if (backup / "release.env").exists():
            write(self.root / "release.env", (backup / "release.env").read_bytes(), 0o644)
        write(self.root / "VERSION", journal["previousVersion"] + "\n", 0o644)
        self.health()
        if journal["resume"]:
            self.maintenance(False)
        self.journal.unlink()
        self.publish(phase="rolled_back", currentVersion=journal["previousVersion"], message="Обновление не запустилось. Прежняя версия восстановлена.")

    def recover(self):
        if self.journal.exists():
            with (self.target / ".install.lock").open("a") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                self.rollback(json.loads(self.journal.read_text()))
        elif self.interrupted:
            self.health()
            if self.state.get("resumeAfterUpdate"):
                self.maintenance(False)
            self.publish(phase="failed", message="Обновление было прервано. Работа сервиса восстановлена; повторите проверку.")

    def install(self, tag):
        release = self.github.release(tag)
        manifest = validate_manifest(self.github.asset(release, "worker-update.json"), tag)
        with tempfile.TemporaryDirectory(prefix="worker-update-") as temporary:
            stage = Path(temporary)
            bundle = stage / "bundle.tgz"
            self.github.asset(release, manifest["asset"], bundle)
            with bundle.open("rb") as stream:
                checksum = hashlib.file_digest(stream, "sha256").hexdigest()
            if checksum != manifest["sha256"]:
                raise ValueError("Контрольная сумма пакета не совпадает")
            unpack(bundle, stage)
            settings = read_env(stage / "release.env")
            if settings.get("DISPATCHER_IMAGE") != "worker-dispatcher:" + tag or (stage / "VERSION").read_text().strip() != tag:
                raise ValueError("Образ не соответствует версии")
            self.run(["docker", "load", "-i", str(stage / "dispatcher-image.tar.gz")])
            if image_fingerprint(settings["DISPATCHER_IMAGE"]) != settings.get("DISPATCHER_IMAGE_FINGERPRINT"):
                raise ValueError("Образ не соответствует пакету")
            data_size = sum(p.stat().st_size for p in (self.target / "data").rglob("*") if p.is_file())
            if shutil.disk_usage(self.target).free < data_size + 64 * 1024 * 1024:
                raise ValueError("Недостаточно места для резервной копии")
            self.wait_idle()
            self.publish(phase="installing", message="Сохраняем данные и запускаем новую версию")
            self.compose("stop")
            try:
                backup = self.backup()
            except BaseException:
                self.health()
                raise
            journal = {"backup": str(backup), "previousVersion": self.current(), "resume": self.resume}
            write(self.journal, json.dumps(journal))
            try:
                environment = read_env(self.target / ".env")
                environment["DISPATCHER_IMAGE"] = settings["DISPATCHER_IMAGE"]
                write(self.target / ".env", "".join(k+"="+v+"\n" for k,v in environment.items()))
                self.health()
                write(self.root / "VERSION", tag+"\n", 0o644)
                if self.resume:
                    self.maintenance(False)
                # Installer metadata follows the running image; host updater protocol stays v1.
                write(self.root / "release.env", (stage / "release.env").read_bytes(), 0o644)
                self.journal.unlink()
                self.publish(phase="completed", currentVersion=tag, available=False, message="Обновление установлено")
            except BaseException:
                try:
                    self.rollback(journal)
                except BaseException:
                    self.publish(phase="rollback_failed", message="Автоматический возврат не завершён. Требуется проверка сервера; резервная копия сохранена.")
                raise


class LocalServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


class API(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send(self, status, data):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self.send(200, self.server.updater.status()) if self.path == "/status" else self.send(404, {})

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length < 0 or length > 2048 or self.headers.get("Transfer-Encoding"):
                raise ValueError()
            body = json.loads(self.rfile.read(length) or b"{}")
            if self.path not in ("/check", "/install") or not isinstance(body, dict):
                raise ValueError()
            if set(body) - ({"version"} if self.path == "/install" else set()):
                raise ValueError()
            self.send(202, self.server.updater.command(self.path[1:], body.get("version")))
        except (ValueError, TypeError):
            self.send(409, {"code": "UPDATE_REJECTED"})


def install_service(root, target, project):
    directory = target / "updater"
    directory.mkdir(mode=0o750, exist_ok=True)
    os.chown(directory, 0, 10001)
    os.chmod(directory, 0o750)
    if os.environ.get("WORKER_UPDATER_SERVICE") == "0" or not Path("/run/systemd/system").is_dir():
        return False
    source = root / "deploy/package" if (root / "deploy/package/update.py").exists() else root
    for path in [target, *target.parents]:
        details = path.stat()
        if details.st_uid != 0 or details.st_mode & 0o022:
            raise ValueError("Папка сервиса и её родительские папки должны принадлежать root без права записи для других пользователей")
    library = Path("/usr/local/lib/worker-updater") / project
    library.mkdir(parents=True, exist_ok=True, mode=0o755)
    for name in ("update.py", "manage.py", "fingerprint.py"):
        write(library / name, (source / name).read_bytes(), 0o644)
    config_dir = Path("/etc/worker-updater")
    config_dir.mkdir(exist_ok=True, mode=0o700)
    config = config_dir / (project + ".json")
    write(config, json.dumps({"root": str(root), "target": str(target), "project": project}))
    unit_name = "worker-updater-" + project + ".service"
    unit = '[Unit]\nDescription=Worker release updater\nAfter=docker.service network-online.target\nRequires=docker.service\n\n[Service]\nType=simple\nExecStart=/usr/bin/python3 "'+str(library / "update.py")+'" --config "'+str(config)+'"\nRestart=on-failure\nRestartSec=5\nUMask=0077\nNoNewPrivileges=true\nPrivateTmp=true\n\n[Install]\nWantedBy=multi-user.target\n'
    write(Path("/etc/systemd/system") / unit_name, unit, 0o644)
    subprocess.run(["systemctl", "daemon-reload"], check=True)
    subprocess.run(["systemctl", "enable", "--now", unit_name], check=True, stdout=subprocess.DEVNULL)
    return True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    settings = json.loads(Path(args.config).read_text())
    updater = Updater(**settings)
    updater.recover()
    path = updater.target / "updater/update.sock"
    path.unlink(missing_ok=True)
    with LocalServer(str(path), API) as server:
        os.chown(path, 0, 10001)
        os.chmod(path, 0o660)
        server.updater = updater
        server.serve_forever()


if __name__ == "__main__":
    main()
