delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { join } = require("node:path");
const { inspectWslDisk } = require("./ci-wsl.cjs");

function validateCiSettings(input = {}, platform = process.platform) {
  const repository = String(input.repository || "").trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || repository.includes(".."))
    throw Error("Укажите репозиторий в формате владелец/репозиторий.");
  const distribution = String(input.distribution || "Worker-CI").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(distribution) || distribution === "docker-desktop")
    throw Error("Выберите отдельный дистрибутив Linux, например Ubuntu.");
  const directory = String(input.directory || "/home/worker/worker-ci-runner").trim();
  if (!/^\/(?:home|opt)\/[A-Za-z0-9_./ -]+$/.test(directory) || directory.split("/").includes("..") || directory.endsWith("/") || directory.split("/").length < 4)
    throw Error("Укажите отдельную абсолютную папку runner внутри Linux, например /home/worker/worker-ci-runner.");
  const name = String(input.name || "worker-build").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name)) throw Error("Имя runner: латиница, цифры, точка, дефис или подчёркивание.");
  if (!["win32", "linux"].includes(platform)) throw Error("Этот этап сборок поддерживает Windows с WSL и Linux.");
  return { repository, distribution, directory, name, enabled: input.enabled !== false };
}

function command(settings, script, args = [], platform = process.platform) {
  const executable = platform === "win32"
    ? join(process.env.SystemRoot || "C:\\Windows", "System32", "wsl.exe") : "/bin/bash";
  return { executable, args: [...(platform === "win32" ? ["--distribution", settings.distribution, "--exec", "bash"] : []), "-c", script, "worker-ci", settings.directory, ...args] };
}

function execute(spec, { input = "", timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(spec.executable, spec.args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let output = "", done = false;
    const finish = (error, code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (error) reject(Error("Не удалось запустить Linux-окружение. Проверьте дистрибутив WSL и зависимости."));
      else resolve({ code, output });
    };
    const timer = setTimeout(() => { child.kill(); finish(true); }, timeout);
    child.stdout.on("data", chunk => { output = (output + chunk.toString()).slice(-16384); });
    // Raw runner output may contain credentials. Never expose stderr in IPC or logs.
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.once("error", () => finish(true));
    child.once("close", code => finish(false, code));
    child.stdin.end(input);
  });
}

const CHECK = `set -eu
test "$(uname -s)" = Linux && test "$(uname -m)" = x86_64 || exit 41
test "$(id -u)" != 0 || exit 42
for tool in bash git curl tar sha256sum flock setsid python3 java docker shellcheck gh systemd-run systemctl; do
  command -v "$tool" >/dev/null 2>&1 || { printf 'missing:%s\\n' "$tool"; exit 43; }
done
java -version 2>&1 | head -1 | grep -Eq 'version "21[.\"]' || exit 44
docker info --format '{{.OSType}}' 2>/dev/null | grep -qx linux || exit 45
docker compose version >/dev/null 2>&1 && docker buildx version >/dev/null 2>&1 || exit 46
systemctl --user is-active default.target >/dev/null 2>&1 || exit 47
if test -f "$1/.runner"; then
  printf 'registered\\n'
  python3 -c 'import json,sys; print("repository:"+str(json.load(open(sys.argv[1], encoding="utf-8-sig")).get("gitHubUrl", "")))' "$1/.runner"
fi
if test -f "$1/config.sh" && test -f "$1/run.sh"; then printf 'installed\\n'; fi
if test -f "$1/.worker-ci.lock" && ! flock -n "$1/.worker-ci.lock" -c true; then printf 'running\\n'; fi
self=$$
for pid in /proc/[0-9]*; do
  id=\${pid##*/}
  test "\$id" = "\$self" && continue
  if tr $'\\0' ' ' < "\$pid/cmdline" 2>/dev/null | grep -F -q -- "\$1/bin/Runner.Listener run"; then
    printf 'running\\n'
    break
  fi
done
`;

const INSTALL = `set -eu
umask 077
dest=$1; url=$2; checksum=$3
test ! -e "$dest" || { test -d "$dest" && test -z "$(ls -A "$dest")"; } || exit 51
mkdir -p -- "$(dirname "$dest")"
stage=$(mktemp -d "$(dirname "$dest")/.worker-ci-install.XXXXXX")
trap 'rm -rf -- "$stage"' EXIT
curl -fsSL --proto '=https' --tlsv1.2 --connect-timeout 15 --max-time 300 "$url" -o "$stage/runner.tgz"
printf '%s  %s\\n' "$checksum" "$stage/runner.tgz" | sha256sum -c - >/dev/null
mkdir "$stage/unpacked"
tar -xzf "$stage/runner.tgz" -C "$stage/unpacked"
test -f "$stage/unpacked/config.sh" && test -f "$stage/unpacked/run.sh"
mkdir -p -- "$dest"
cp -a "$stage/unpacked/." "$dest/"
`;

const REGISTER = `set -eu
umask 077
cd -- "$1"
test ! -f .runner || exit 52
IFS= read -r token
./config.sh --unattended --url "$2" --token "$token" --name "$3" --labels worker-build --work _work >/dev/null 2>&1
`;

const RUN_PROCESS = String.raw`set -eu
cd -- "$1"
exec setsid bash -c '
  exec 9>.worker-ci.lock
  flock -n 9 || exit 73
  printf "%s\n" "$$" > .worker-ci.pid
  trap "rm -f .worker-ci.pid" EXIT
  ./run.sh & listener=$!
  stopping=0
  trap '\''stopping=1; kill -TERM "$listener" 2>/dev/null || true; wait "$listener" || true'\'' TERM
  result=0
  wait "$listener" || result=$?
  test "$stopping" = 1 && exit 0
  exit "$result"
'`;

const RUN = `set -eu
name=$2
script=$3
case "$name" in *[!A-Za-z0-9_.-]*|"") exit 74;; esac
exec systemd-run --user --scope --quiet --unit="worker-ci-$name" --slice=app-worker-ci.slice --property=CPUQuota=400% --property=MemoryMax=6G bash -c "$script" worker-ci "$1"
`;

const STEP = `set -eu
dir=$1
diag=$dir/_diag
runner=$(ls -1t "$diag"/Runner_*.log 2>/dev/null | head -1 || true)
worker=$(ls -1t "$diag"/Worker_*.log 2>/dev/null | head -1 || true)
event=
step=
if test -n "$runner"; then event=$(grep -E 'Running job: |Job .+ completed with result: |Listening for Jobs' "$runner" | tail -1 || true); fi
if test -n "$worker"; then step=$(grep "Processing step: DisplayName=" "$worker" | tail -1 || true); fi
printf '%s\\n' "$event"
printf '%s\\n' "$step"
`;

function cleanActivity(value) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 120);
}
function parseRunnerActivity(output) {
  let mode = "idle", job = "", step = "", completed = false;
  for (const raw of String(output || "").split(/\r?\n/)) {
    const line = raw.trim();
    const running = line.match(/Running job:\s*(.*)$/);
    const done = line.match(/Job\s+(.+?)\s+completed with result:/);
    const stepName = line.match(/DisplayName='([^']*)'/);
    if (running) { mode = "busy"; completed = false; job = cleanActivity(running[1]); }
    else if (done) { mode = "idle"; completed = true; job = cleanActivity(done[1]); }
    else if (line.includes("Listening for Jobs")) { mode = "idle"; completed = false; }
    if (stepName) step = cleanActivity(stepName[1]);
  }
  if (mode !== "busy") step = "";
  return { mode, job, step, completed };
}
function activityMessage(activity) {
  if (activity.mode !== "busy") return "Готов принимать сборки.";
  if (activity.job && activity.step) return "Задание: " + activity.job + "\nЭтап: " + activity.step;
  if (activity.job) return "Задание: " + activity.job;
  return "Выполняется сборка.";
}

const STOP = `set -eu
cd -- "$1"
test -f .worker-ci.pid || exit 61
pid=$(cat .worker-ci.pid)
case "$pid" in ''|*[!0-9]*) exit 62;; esac
test "$pid" -gt 1 || exit 62
test "$(readlink -f "/proc/$pid/cwd")" = "$(pwd -P)" || exit 63
flock -n .worker-ci.lock -c true && exit 64
kill -TERM -- "-$pid"
`;

async function releasePackage(fetcher = fetch) {
  const response = await fetcher("https://api.github.com/repos/actions/runner/releases/latest", {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "Worker-Processor-CI" }, signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw Error("GitHub не вернул версию runner. Попробуйте позже.");
  const release = await response.json();
  if (!/^v\d+\.\d+\.\d+$/.test(release.tag_name)) throw Error("Некорректная версия runner.");
  const filename = `actions-runner-linux-x64-${release.tag_name.slice(1)}.tar.gz`;
  const asset = release.assets?.find(item => item.name === filename);
  const expectedUrl = `https://github.com/actions/runner/releases/download/${release.tag_name}/${filename}`;
  if (!asset || asset.browser_download_url !== expectedUrl) throw Error("Официальный Linux runner не найден.");
  const checksum = /^sha256:([a-f0-9]{64})$/.exec(asset.digest || "")?.[1]
    || new RegExp(filename.replaceAll(".", "\\.") + "[\\s`]*([a-f0-9]{64})", "i").exec(release.body || "")?.[1];
  if (!checksum) throw Error("Нет SHA-256 официального пакета. Установка отменена.");
  return { url: expectedUrl, checksum: checksum.toLowerCase() };
}

class CiRunner extends EventEmitter {
  constructor({ platform = process.platform, run = execute, spawnProcess = spawn, fetcher = fetch, inspectDisk = inspectWslDisk } = {}) {
    super();
    Object.assign(this, { platform, run, spawnProcess, fetcher, inspectDisk, child: null, operation: false, stopping: false, state: { phase: "stopped", connected: false, busy: false } });
  }
  update(values) { Object.assign(this.state, values); this.emit("status", { ...this.state }); return { ...this.state }; }
  async exclusive(callback) {
    if (this.operation) throw Error("Дождитесь завершения предыдущего действия со сборками.");
    this.operation = true;
    try { return await callback(); } finally { this.operation = false; }
  }
  settings(input) { return validateCiSettings(input, this.platform); }
  diskHint(distribution) {
    if (this.platform !== "win32" || !this.inspectDisk) return "";
    try {
      const disk = this.inspectDisk(distribution, { platform: this.platform });
      return disk.needsRetarget || (!disk.reachable && disk.message) ? disk.message : "";
    } catch { return ""; }
  }
  async check(input) {
    const settings = this.settings(input);
    let result;
    try { result = await this.run(command(settings, CHECK, [], this.platform)); }
    catch (error) {
      throw Error(this.diskHint(settings.distribution) || error.message);
    }
    const messages = { 41: "Нужен Linux x64.", 42: "Runner должен работать от обычного Linux-пользователя, не root.", 43: "Не хватает зависимостей: " + (result.output.match(/missing:([a-z0-9]+)/)?.[1] || "проверьте инструкцию") + ".", 44: "Нужна Java 21.", 45: "Docker Linux недоступен текущему пользователю.", 46: "Нужны Docker Compose и Buildx.", 47: "Нужна пользовательская сессия systemd. Проверьте подготовку Worker-CI и перезапустите дистрибутив." };
    if (result.code !== 0) throw Error(messages[result.code] || this.diskHint(settings.distribution) || "Linux не готов. Установите Ubuntu в WSL и зависимости по инструкции.");
    const registered = result.output.includes("registered");
    if (registered && result.output.match(/repository:([^\r\n]+)/)?.[1]?.replace(/\/$/, "").toLowerCase() !== ("https://github.com/" + settings.repository).toLowerCase())
      throw Error("Runner в этой папке зарегистрирован для другого репозитория. Укажите другую отдельную папку.");
    return { ready: true, installed: result.output.includes("installed"), registered, running: result.output.includes("\nrunning\n") || result.output.startsWith("running\n") || result.output.endsWith("\nrunning") || result.output === "running" };
  }
  async install(input) {
    return this.exclusive(async () => {
      if (this.child) throw Error("Остановите сборки перед установкой.");
      const settings = this.settings(input);
      const readiness = await this.check(settings);
      if (readiness.installed) return readiness;
      const release = await releasePackage(this.fetcher);
      const result = await this.run(command(settings, INSTALL, [release.url, release.checksum], this.platform), { timeout: 360000 });
      if (result.code !== 0) throw Error("Установка runner не завершена. Проверьте сеть, SHA-256 и отдельную пустую папку.");
      return this.check(settings);
    });
  }
  async register(input, token) {
    return this.exclusive(async () => {
      if (this.child) throw Error("Остановите сборки перед регистрацией.");
      const settings = this.settings(input);
      if (typeof token !== "string" || !/^[A-Za-z0-9_-]{10,4096}$/.test(token)) throw Error("Введите временный registration token из GitHub → Settings → Actions → Runners.");
      const readiness = await this.check(settings);
      if (!readiness.installed) throw Error("Сначала установите runner.");
      if (readiness.registered) throw Error("В этой папке runner уже зарегистрирован.");
      const result = await this.run(command(settings, REGISTER, ["https://github.com/" + settings.repository, settings.name], this.platform), { input: token + "\n", timeout: 120000 });
      if (result.code !== 0) throw Error("Регистрация не завершена. Проверьте временный токен, репозиторий и доступ к GitHub.");
      return this.check(settings);
    });
  }
  async start(input) {
    return this.exclusive(async () => {
      if (this.child) return { ...this.state };
      const settings = this.settings(input);
      const ready = await this.check(settings);
      if (!ready.registered) throw Error("Сначала зарегистрируйте runner в GitHub.");
      this.activeSettings = settings;
      if (ready.running) {
        this.watch();
        return this.update({ phase: "idle", connected: true, busy: false, message: "Runner уже запущен и принимает сборки." });
      }
      const spec = command(settings, RUN, [settings.name, RUN_PROCESS], this.platform);
      const child = this.spawnProcess(spec.executable, spec.args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      this.child = child;
      this.update({ phase: "connecting", connected: false, busy: false, message: "Подключение к GitHub…" });
      let buffer = "";
      const consume = chunk => {
        buffer = (buffer + chunk.toString()).slice(-16384);
        const lines = buffer.split(/\r?\n/); buffer = lines.pop();
        for (const line of lines) {
          if (line.includes("Listening for Jobs")) this.update({ phase: "idle", connected: true, busy: false, message: "Готов принимать сборки GitHub." });
          else if (line.includes("Running job:")) {
            const job = line.slice(line.indexOf("Running job:") + "Running job:".length).trim();
            this.update({ phase: "busy", connected: true, busy: true, job, message: job ? "Сборка: " + job : "Выполняется сборка GitHub." });
          }
          else if (/Job .* completed/.test(line)) this.update({ phase: "idle", connected: true, busy: false, job: "", message: "Сборка завершена. Ожидаем следующую." });
          else if (/Retrying until reconnected|Failed to connect|Error connecting/.test(line)) this.update({ phase: "connecting", connected: false, message: "Связь с GitHub потеряна. Переподключаемся…" });
        }
      };
      child.stdout.on("data", consume);
      child.stderr.resume();
      this.watch();
      child.once("error", () => { if (this.child === child) { this.child = null; this.clearWatch(); this.update({ phase: "error", connected: false, busy: false, message: "Не удалось запустить runner. Проверьте Linux." }); } });
      child.once("close", code => {
        if (this.child !== child) return;
        this.child = null;
        if (code === 73) {
          this.watch();
          this.update({ phase: "idle", connected: true, busy: false, message: "Runner уже запущен и принимает сборки." });
        } else if (code === 0 && !this.stopping) {
          // RUN_PROCESS detaches through setsid, so the launcher exits 0 while the
          // listener keeps running. Ask Linux what actually happened before reporting.
          void this.confirm();
        } else {
          this.clearWatch();
          this.update({ phase: code === 0 ? "stopped" : "error", connected: false, busy: false, message: code === 0 ? "Сборки остановлены." : "Runner завершился. Проверьте окружение и повторите запуск." });
        }
      });
      return { ...this.state };
    });
  }
  async confirm() {
    if (!this.activeSettings) return;
    try {
      const state = await this.check(this.activeSettings);
      if (this.child || this.stopping) return;
      if (state.running) {
        this.watch();
        this.update({ phase: this.state.busy ? "busy" : "idle", connected: true, message: this.state.busy ? this.state.message : "Готов принимать сборки GitHub." });
      } else {
        this.clearWatch();
        this.update({ phase: "stopped", connected: false, busy: false, message: "Сборки остановлены." });
      }
    } catch (error) {
      if (this.child || this.stopping) return;
      this.clearWatch();
      this.update({ phase: "error", connected: false, busy: false, message: error.message });
    }
  }
  async stop() {
    return this.exclusive(async () => {
      if (this.state.busy) throw Error("Дождитесь завершения текущей сборки перед остановкой или выходом из Worker.");
      if (!this.child && this.state.phase !== "idle" && this.state.phase !== "connecting") return { ...this.state };
      if (!this.activeSettings) return { ...this.state };
      const child = this.child;
      // The launcher may exit on its own during a stop: keep confirm() out of the way.
      this.stopping = true;
      try {
        const result = await this.run(command(this.activeSettings, STOP, [], this.platform));
        if (!child) {
          if (result.code !== 0) throw Error("Не удалось остановить runner.");
        } else {
          if (result.code !== 0 && this.child) throw Error("Не удалось подтвердить остановку runner. Worker остаётся открытым.");
          if (this.child) await new Promise(resolve => { const timer = setTimeout(resolve, 15000); child.once("close", () => { clearTimeout(timer); resolve(); }); });
          if (this.child) throw Error("Runner ещё завершает работу. Повторите остановку позже.");
        }
      } finally { this.stopping = false; }
      this.clearWatch();
      return this.update({ phase: "stopped", connected: false, busy: false, message: "Сборки остановлены." });
    });
  }
  clearWatch() {
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.watchTimer = null;
  }
  watch() {
    if (this.watchTimer || !this.activeSettings) return;
    const tick = () => {
      if (!this.activeSettings || !["idle", "busy"].includes(this.state.phase)) return;
      this.run(command(this.activeSettings, STEP, [], this.platform), { timeout: 8000 }).then(result => {
        if (!result || result.code !== 0 || !["idle", "busy"].includes(this.state.phase)) return;
        const activity = parseRunnerActivity(result.output);
        if (activity.mode === "busy") this.update({ phase: "busy", connected: true, busy: true, job: activity.job, step: activity.step, message: activityMessage(activity) });
        else if (activity.completed && this.state.phase === "busy") this.update({ phase: "idle", connected: true, busy: false, job: "", step: "", message: "Сборка завершена. Ожидаем следующую." });
      }).catch(() => {});
    };
    this.watchTimer = setInterval(tick, 3000);
    if (typeof this.watchTimer.unref === "function") this.watchTimer.unref();
    const first = setTimeout(tick, 400);
    if (typeof first.unref === "function") first.unref();
  }
}
module.exports = { CiRunner, validateCiSettings, command, releasePackage, parseRunnerActivity, CHECK, INSTALL, REGISTER, RUN, RUN_PROCESS, STEP, STOP };
