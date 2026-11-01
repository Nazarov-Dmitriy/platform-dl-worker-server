#!/usr/bin/env bash
set -euo pipefail
test "$(id -u)" = 0 || { echo 'Run as root inside the dedicated Worker-CI distro.' >&2; exit 1; }
test "${WSL_DISTRO_NAME:-}" = Worker-CI || { echo 'This setup script is only for the dedicated Worker-CI WSL distro.' >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl git openjdk-21-jdk-headless docker.io docker-buildx docker-compose-v2 shellcheck gh python3 util-linux systemd-sysv dbus dbus-user-session libicu74 libkrb5-3 zlib1g libssl3t64
if ! id worker >/dev/null 2>&1; then useradd --create-home --shell /bin/bash worker; fi
usermod -aG docker worker
install -d -m 700 -o worker -g worker /home/worker/worker-ci-runner
cat >/etc/wsl.conf <<'CONF'
[boot]
systemd=true
[user]
default=worker
[automount]
enabled=false
[interop]
enabled=false
appendWindowsPath=false
CONF
install -d /etc/docker
cat >/etc/docker/daemon.json <<'CONF'
{
  "cgroup-parent": "worker-ci-build.slice",
  "log-driver": "local"
}
CONF
cat >/etc/systemd/system/worker-ci-build.slice <<'CONF'
[Unit]
Description=Worker CI Docker build budget
[Slice]
CPUQuota=400%
MemoryMax=6G
CONF
worker_uid=$(id -u worker)
install -d "/etc/systemd/system/user-$worker_uid.slice.d"
cat >"/etc/systemd/system/user-$worker_uid.slice.d/ci-budget.conf" <<'CONF'
[Slice]
CPUQuota=400%
MemoryMax=6G
CONF
systemctl enable docker.service
rm -f /.dockerenv
printf 'WORKER_CI_SETUP_COMPLETE\n'
