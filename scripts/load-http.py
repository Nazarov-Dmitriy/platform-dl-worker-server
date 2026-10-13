"""Ephemeral stage-2 Docker load client. Tokens come from environment, never output."""
import argparse
import copy
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.error
import urllib.request
import uuid


def docker(*args):
    return subprocess.check_output(["docker", *args], text=True).strip()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    parser.add_argument("--container", required=True)
    parser.add_argument("--jobs", type=int, default=2000)
    args = parser.parse_args()
    # Local benchmark traffic must bypass workstation HTTP proxies.
    client = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    seed = json.loads(os.environ["DISPATCHER_LOAD_SEED"])
    job = json.loads((Path(__file__).resolve().parents[1] / "contracts/fixtures/valid/job-video.json").read_text(encoding="utf-8"))["value"]

    def request(path, site=None, payload=None):
        headers = {"Content-Type": "application/json"}
        if site:
            headers["Authorization"] = "Bearer " + site["token"]
        data = json.dumps(payload).encode() if payload is not None else None
        req = urllib.request.Request(args.url + path, data=data, headers=headers)
        with client.open(req, timeout=10) as response:
            return response.status, json.load(response)

    def ready():
        deadline = time.monotonic() + 20
        last_error = None
        while time.monotonic() < deadline:
            try:
                if request("/healthz")[0] == 200:
                    return
            except (OSError, urllib.error.URLError) as error:
                last_error = error
                time.sleep(0.2)
        raise RuntimeError(f"test dispatcher did not become ready: {last_error}")

    def cpu_usec():
        rows = docker("exec", args.container, "cat", "/sys/fs/cgroup/cpu.stat").splitlines()
        return int(next(row.split()[1] for row in rows if row.startswith("usage_usec ")))

    ready()
    idle_stats = json.loads(docker("stats", "--no-stream", "--format", "{{json .}}", args.container))
    started_cpu = cpu_usec()
    started = time.monotonic()
    first = None
    for index in range(args.jobs):
        payload = copy.deepcopy(job)
        payload["id"] = str(uuid.uuid4())
        site = seed[index % len(seed)]
        status, view = request("/api/v2/site/jobs", site, payload)
        assert status == 202 and view["status"] == "QUEUED"
        if first is None:
            first = (site, payload)
    wall = time.monotonic() - started
    used_cpu = (cpu_usec() - started_cpu) / 1e6
    peak = int(docker("exec", args.container, "cat", "/sys/fs/cgroup/memory.peak"))
    loaded_stats = json.loads(docker("stats", "--no-stream", "--format", "{{json .}}", args.container))
    assert first is not None
    site, payload = first
    assert request("/api/v2/site/jobs", site, payload)[0] == 200
    docker("restart", args.container)
    # An ephemeral published port may change when Docker recreates its forwarding.
    args.url = "http://" + docker("port", args.container, "8090/tcp").splitlines()[0]
    ready()
    status, view = request("/api/v2/site/jobs", site, payload)
    assert status == 200 and view["status"] == "QUEUED", "restart lost deduplication"
    total = 0
    for site in seed:
        cursor = None
        while True:
            path = "/api/v2/site/jobs?limit=100"
            if cursor:
                path += "&cursor=" + cursor
            _, page = request(path, site)
            total += len(page["jobs"])
            cursor = page["nextCursor"]
            if cursor is None:
                break
    assert total == args.jobs, "restart changed job count"
    print(json.dumps({"jobs": total, "sites": len(seed), "registeredOfflineDevices": 20,
        "wallSecondsSubmission": round(wall, 3), "cpuSecondsSubmission": round(used_cpu, 3),
        "submissionsPerSecond": round(args.jobs / wall, 2),
        "cgroupPeakMiBIncludingCache": round(peak / 2**20, 2),
        "dockerIdleMemory": idle_stats["MemUsage"], "dockerLoadedMemory": loaded_stats["MemUsage"],
        "restartAndDeduplication": "passed"}, indent=2))


if __name__ == "__main__":
    main()
