#!/usr/bin/env python3
"""Stable image identity across classic Docker and containerd image stores."""
import hashlib
import json
import subprocess
import sys


def image_fingerprint(image):
    value = json.loads(subprocess.check_output(["docker", "image", "inspect", image]))[0]
    config = value["Config"]
    identity = {"architecture":value["Architecture"], "os":value["Os"],
                "layers":value["RootFS"]["Layers"],
                "entrypoint":config.get("Entrypoint") or [], "command":config.get("Cmd") or [],
                "user":config.get("User") or "", "env":config.get("Env") or [],
                "workingDir":config.get("WorkingDir") or ""}
    return hashlib.sha256(json.dumps(identity, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


if __name__ == "__main__":
    print(image_fingerprint(sys.argv[1]))
