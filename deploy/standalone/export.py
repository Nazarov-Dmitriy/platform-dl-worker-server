#!/usr/bin/env python3
"""Create a complete migration archive, leaving the old dispatcher stopped."""
import argparse
import fcntl
import gzip
import io
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile

from setup import read_env, run
from fingerprint import image_fingerprint


def export(output):
    root = Path(__file__).resolve().parent
    if os.geteuid() != 0:
        raise ValueError("Run with sudo; the archive contains credentials and a private key")
    output = Path(output).resolve()
    if output.is_relative_to(root) or output.exists():
        raise ValueError("Choose a new archive path outside the installation directory")
    settings = read_env(root / ".env")
    image = settings["DISPATCHER_IMAGE"]
    environment = dict(os.environ, **settings)
    compose = ["docker", "compose", "--project-name", "worker-dispatcher",
               "--project-directory", str(root), "--env-file", str(root / ".env"),
               "-f", str(root / "compose.yaml")]
    with (root / ".install.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        # Check queue in read-only mode before interrupting a device execution.
        import sqlite3
        with sqlite3.connect((root / "data" / "dispatcher.db").as_uri() + "?mode=ro", uri=True) as db:
            running = db.execute("SELECT count(*) FROM assignments WHERE state IN ('OFFERED','RUNNING','CANCELLING','RELEASING')").fetchone()[0]
            maintenance = db.execute("SELECT value FROM metadata WHERE key='maintenance'").fetchone()
            if running or not maintenance or maintenance[0] != "1":
                raise ValueError("Enable maintenance in the panel and wait for active assignments to finish before migration")
        run(compose + ["stop"], env=environment)
        # Do not restart the old host automatically: two dispatchers must not own the same state.
        with tempfile.TemporaryDirectory(prefix="worker-export-") as temporary:
            temporary = Path(temporary)
            images = temporary / "dispatcher-image.tar.gz"
            with images.open("wb") as raw, gzip.GzipFile(fileobj=raw, mode="wb") as compressed:
                process = subprocess.Popen(["docker", "image", "save", image, "nginx:1.28.0-alpine"], stdout=subprocess.PIPE)
                import shutil
                shutil.copyfileobj(process.stdout, compressed)
                process.stdout.close()
                if process.wait() != 0:
                    raise RuntimeError("Cannot save runtime images; the old instance is left stopped")
            release = ("DISPATCHER_IMAGE=" + image + "\nDISPATCHER_IMAGE_FINGERPRINT=" +
                       image_fingerprint(image) + "\nTLS_IMAGE_FINGERPRINT=" + image_fingerprint("nginx:1.28.0-alpine") + "\n")
            fd = os.open(output, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            try:
                with os.fdopen(fd, "wb") as stream, tarfile.open(fileobj=stream, mode="w:gz") as archive:
                    for name in ("compose.yaml", "nginx.conf", "install.sh", "setup.py", "fingerprint.py", "export.sh", "export.py", "README.md", ".env", "data", "tls", "initial-owner-password"):
                        path = root / name
                        if path.exists():
                            archive.add(path, arcname=name)
                    archive.add(images, arcname=images.name)
                    info = tarfile.TarInfo("release.env")
                    info.size = len(release.encode())
                    info.mode = 0o600
                    archive.addfile(info, io.BytesIO(release.encode()))
            except BaseException:
                output.unlink(missing_ok=True)
                raise
        print("Migration archive: " + str(output))
        print("The old instance is STOPPED. Transfer the archive privately; never run both copies.")
        print("If migration is cancelled: cd " + str(root) + " && docker compose up -d")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", help="New .tgz outside the installation directory")
    try:
        export(parser.parse_args().output)
    except (ValueError, RuntimeError, OSError) as error:
        parser.exit(1, "Export failed: " + str(error) + "\n")
