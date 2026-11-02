delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  Tray,
  Menu,
  nativeImage,
  safeStorage,
} = require("electron");
const { fork, execFileSync, execFile } = require("node:child_process");
const {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  createWriteStream,
  readdirSync,
  statSync,
  cpSync,
  rmSync,
  mkdtempSync,
} = require("node:fs");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const { pipeline } = require("node:stream/promises");
const https = require("node:https");
const { validateProcessing } = require("./processing.cjs");
const { availableParallelism, tmpdir } = require("node:os");
const { validateSettings } = require("./settings.cjs");
const { createLoginController, NAME } = require("./login.cjs");
const {
  videoReadiness,
  speechReadiness,
  commandAvailable,
  detectGpu,
} = require("./readiness.cjs");
const { CiRunner, validateCiSettings } = require("./ci-runner.cjs");
let ciRepos = [{ id: "worker-build", repository: "Nazarov-Dmitriy/dream-breasts-server", distribution: "Worker-CI", directory: "/home/worker/worker-ci-runner", name: "worker-build", enabled: true }];
const ciRunners = new Map();
function ciRunnerFor(id) {
  if (!ciRunners.has(id)) {
    const runner = new CiRunner();
    runner.on("status", status => {
      if (window && !window.isDestroyed()) window.webContents.send("processor:ci-status", { key: id, status });
    });
    ciRunners.set(id, runner);
  }
  return ciRunners.get(id);
}
function validateCiRepos(input) {
  if (!Array.isArray(input) || input.length === 0) throw Error("Добавьте хотя бы один репозиторий.");
  const ids = new Set(), dirs = new Set(), names = new Set();
  return input.map((item, index) => {
    const entry = validateCiSettings(item || {});
    const id = String(item.id || entry.name || "repo-" + (index + 1)).trim();
    if (ids.has(id)) throw Error("Повторяющаяся запись: " + id + ".");
    if (dirs.has(entry.directory)) throw Error("Папка " + entry.directory + " уже занята другой записью.");
    if (names.has(entry.name)) throw Error("Имя runner " + entry.name + " уже занято другой записью.");
    ids.add(id); dirs.add(entry.directory); names.add(entry.name);
    return { ...entry, id };
  });
}
const launchDefaults = { autoConnect: false, ciAutoStart: true };
let launch = { ...launchDefaults };
function validateLaunch(input) {
  if (!input || typeof input !== "object") throw Error("Некорректные настройки запуска.");
  const result = {};
  for (const key of Object.keys(launchDefaults)) {
    const value = input[key] ?? launchDefaults[key];
    if (typeof value !== "boolean")
      throw Error("Настройки запуска принимают только «включено» или «выключено».");
    result[key] = value;
  }
  return result;
}
app.setName("Worker Processor");
if (process.platform === "win32")
  app.setAppUserModelId("ru.difat.workerprocessor");
const loginController = createLoginController(app);
const backgroundLaunch = process.argv.includes("--background");
let window,
  tray,
  child,
  quitting = false,
  saved = {},
  snapshot = { phase: "stopped", connected: false, running: 0, paused: false };
const html = join(__dirname, "index.html");
const pageURL = pathToFileURL(html).href;
let directory;
function atomic(name, value) {
  const file = join(directory, name),
    temp = file + ".tmp";
  writeFileSync(temp, value, { mode: 0o600 });
  renameSync(temp, file);
}
function emit(values) {
  snapshot = { ...snapshot, ...values };
  if (backgroundLaunch && values.phase === "error" && window) show();
  if (window && !window.isDestroyed())
    window.webContents.send("processor:status", snapshot);
  if (tray)
    tray.setToolTip(
      "Worker — " +
        (snapshot.connected
          ? "подключён"
          : snapshot.phase === "stopped"
            ? "остановлен"
            : "подключение"),
    );
}
function autostartState() {
  return {
    ...loginController.state(),
    configured:
      existsSync(join(directory, "config.json")) &&
      existsSync(join(directory, "credential.bin")),
  };
}
function saveAutostartPreference() {
  const actual = loginController.state();
  if (actual.supported)
    atomic("autostart.json", JSON.stringify({ enabled: actual.enabled, executable: process.execPath }));
}
function restoreDesktopAutostart() {
  if (process.platform !== "win32" || !app.isPackaged || process.argv.includes("--smoke")) return;
  let previousExecutable;
  // Read only our named Run entry, including releases made before autostart.json existed.
  try {
    const output = execFileSync(join(process.env.SystemRoot || String.raw`C:\Windows`, "System32", "reg.exe"),
      ["query", String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, "/v", NAME],
      { encoding: "utf8", windowsHide: true, timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
    previousExecutable = output.match(/REG_SZ\s+"([^"]+)"\s+--background\s*$/m)?.[1];
  } catch {}
  if (!previousExecutable) {
    try {
      const preference = JSON.parse(readFileSync(join(directory, "autostart.json"), "utf8"));
      if (preference.enabled === true && typeof preference.executable === "string")
        previousExecutable = preference.executable;
    } catch {}
  }
  try {
    loginController.restore(previousExecutable);
    saveAutostartPreference();
  } catch {
    snapshot.message = "Не удалось восстановить автозапуск. Проверьте настройку в приложении.";
  }
}
function setDesktopAutostart(enabled) {
  if (enabled && !autostartState().configured)
    throw Error("Сначала сохраните подключение к серверу.");
  const actual = loginController.set(enabled);
  saveAutostartPreference();
  emit({ autostart: autostartState() });
  if (child?.connected)
    child.send({ type: "autostart-state", enabled: actual.enabled });
  return autostartState();
}
function publicSettings() {
  return { ...validateProcessing(saved), ...saved, launch, cpuCount: availableParallelism(), tokenSet: existsSync(join(directory, "credential.bin")) };
}
function currentWhisperCpp() {
  if (saved.whisperCpp) return saved.whisperCpp;
  const configPath = join(directory, "config.json");
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      if (typeof config.whisperCpp === "string") return config.whisperCpp;
    } catch {}
  }
  return undefined;
}
function checkReadiness(capability) {
  if (capability !== "video" && capability !== "speech")
    throw Error("Неизвестная проверка готовности.");
  const result =
    capability === "video"
      ? videoReadiness()
      : speechReadiness(currentWhisperCpp());
  const entry = { ok: result.ok, missing: result.missing, checkedAt: Date.now() };
  if (capability === "speech" && saved.whisperBuild)
    entry.build = saved.whisperBuild;
  saved.readiness = { ...(saved.readiness || {}), [capability]: entry };
  atomic("settings.json", JSON.stringify(saved, null, 2));
  return { capability, ...entry };
}
function refreshWindowsPath() {
  if (process.platform !== "win32") return;
  try {
    const raw = execFileSync(
      join(process.env.SystemRoot || String.raw`C:\Windows`, "System32", "reg.exe"),
      ["query", String.raw`HKCU\Environment`, "/v", "Path"],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    const match = /REG_(?:EXPAND_)?SZ\s+([^\r\n]+)/i.exec(raw);
    if (!match) return;
    const parts = new Set((process.env.PATH || "").split(";").filter(Boolean));
    for (const entry of match[1].split(";")) {
      const expanded = entry
        .trim()
        .replace(/%([^%]+)%/g, (_m, name) => process.env[name] || "%" + name + "%");
      if (expanded) parts.add(expanded);
    }
    process.env.PATH = [...parts].join(";");
  } catch {}
}
function run(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr || error.message || "").trim();
          reject(new Error(detail || "Не удалось выполнить установку."));
        } else resolve(String(stdout || "").trim());
      },
    );
  });
}
async function installVideo() {
  if (process.platform !== "win32")
    throw Error("Установка зависимостей доступна только на Windows.");
  if (!commandAvailable("winget", ["--version"]))
    throw Error(
      "Не найден winget. Установите FFmpeg вручную: winget install Gyan.FFmpeg",
    );
  await run(
    "winget",
    [
      "install",
      "--id",
      "Gyan.FFmpeg",
      "--accept-source-agreements",
      "--accept-package-agreements",
      "--disable-interactivity",
      "--silent",
    ],
    30 * 60 * 1000,
  );
  refreshWindowsPath();
  return checkReadiness("video");
}
const whisperCpuZipUrl =
  "https://github.com/ggml-org/whisper.cpp/releases/download/v1.7.6/whisper-bin-x64.zip";
const whisperCudaZipUrl =
  "https://github.com/ggml-org/whisper.cpp/releases/download/v1.7.6/whisper-cublas-12.4.0-bin-x64.zip";
function download(url, dest) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, (response) => {
      const redirect = [301, 302, 303, 307, 308].includes(response.statusCode);
      if (redirect) {
        response.resume();
        const location = response.headers.location;
        if (!location) return reject(new Error("Перенаправление без адреса."));
        return download(new URL(location, url).href, dest).then(resolve, reject);
      }
      if (response.statusCode !== 200) {
        response.resume();
        return reject(
          new Error("Не удалось скачать whisper.cpp (HTTP " + response.statusCode + ")."),
        );
      }
      pipeline(response, createWriteStream(dest, { flags: "wx", mode: 0o600 })).then(
        resolve,
        reject,
      );
    });
    request.on("error", reject);
    request.setTimeout(180000, () =>
      request.destroy(new Error("Тайм-аут скачивания whisper.cpp.")),
    );
  });
}
function findWhisperCli(root) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) stack.push(full);
      else if (/^whisper-cli(\.exe)?$/i.test(name)) return full;
    }
  }
  return undefined;
}
async function installSpeech() {
  if (process.platform !== "win32")
    throw Error("Установка зависимостей доступна только на Windows.");
  const gpu = detectGpu();
  const useCuda = gpu.cuda === true;
  const kind = useCuda ? "cuda" : "cpu";
  const url = useCuda ? whisperCudaZipUrl : whisperCpuZipUrl;
  const toolsDir = join(directory, "tools");
  mkdirSync(toolsDir, { recursive: true, mode: 0o700 });
  const destDir = join(toolsDir, "whisper-" + kind);
  const staging = mkdtempSync(join(tmpdir(), "worker-whisper-"));
  const zip = join(staging, "whisper.zip");
  const extracted = join(staging, "extracted");
  mkdirSync(extracted, { recursive: true, mode: 0o700 });
  try {
    await download(url, zip);
    await run(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "Expand-Archive -Path '" +
          zip.replace(/'/g, "''") +
          "' -DestinationPath '" +
          extracted.replace(/'/g, "''") +
          "' -Force",
      ],
      10 * 60 * 1000,
    );
    const found = findWhisperCli(extracted);
    if (!found) throw Error("В архиве whisper.cpp не найден whisper-cli.exe.");
    rmSync(destDir, { recursive: true, force: true });
    cpSync(extracted, destDir, { recursive: true });
    const target = findWhisperCli(destDir);
    if (!target) throw Error("Не удалось разместить whisper-cli.exe.");
    saved.whisperCpp = target;
    saved.whisperBuild = kind;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  atomic("settings.json", JSON.stringify(saved, null, 2));
  const configPath = join(directory, "config.json");
  if (existsSync(configPath)) {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    atomic(
      "config.json",
      JSON.stringify({ ...config, whisperCpp: saved.whisperCpp }, null, 2),
    );
  }
  return checkReadiness("speech");
}
async function stop() {
  if (!child) return;
  const current = child;
  if (current.connected) current.send({ type: "stop" });
  await new Promise((resolve) => {
    let timer = setTimeout(() => {
      emit({
        phase: "stopping",
        message: "Обработчик ещё завершает задания. Дождитесь остановки.",
      });
      resolve();
    }, 20000);
    current.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
async function start() {
  if (child) throw Error("Обработчик уже запущен.");
  if (
    !existsSync(join(directory, "config.json")) ||
    !existsSync(join(directory, "credential.bin"))
  )
    throw Error("Сначала сохраните подключение.");
  if (!safeStorage.isEncryptionAvailable())
    throw Error("Защищённое хранилище ОС недоступно.");
  const token = safeStorage.decryptString(
    readFileSync(join(directory, "credential.bin")),
  );
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  delete env.PROCESSOR_TOKEN;
  delete env.NODE_TLS_REJECT_UNAUTHORIZED;
  const processChild = fork(join(__dirname, "../dist/desktop-worker.js"), [], {
    execPath: process.execPath,
    cwd: directory,
    env,
    windowsHide: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  child = processChild;
  emit({ phase: "connecting", message: "Подключаемся к серверу…" });
  processChild.on("message", (message) => {
    if (message && message.type === "status") emit(message.status);
    else if (
      message?.type === "autostart-request" &&
      typeof message.enabled === "boolean" &&
      typeof message.requestId === "string" &&
      message.requestId.length <= 64
    ) {
      let result;
      try {
        setDesktopAutostart(message.enabled);
        result = { ok: true };
      } catch {
        result = { ok: false };
      }
      if (processChild.connected)
        processChild.send({
          type: "autostart-result",
          requestId: message.requestId,
          ...result,
        });
    }
  });
  processChild.on("error", () =>
    emit({ phase: "error", message: "Не удалось запустить обработчик." }),
  );
  processChild.on("exit", () => {
    if (child === processChild) child = undefined;
    const failed = snapshot.phase === "error";
    emit({
      phase: failed ? "error" : "stopped",
      connected: false,
      running: 0,
      message: failed ? snapshot.message : "Обработчик остановлен.",
    });
  });
  processChild.send({
    type: "start",
    config: join(directory, "config.json"),
    token,
    autostartEnabled: autostartState().enabled,
  });
  return snapshot;
}
function show() {
  window.show();
  window.focus();
}
function handle(channel, callback) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (
      !window ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      event.senderFrame.url !== pageURL
    )
      throw Error("Недопустимый источник запроса.");
    try {
      return { ok: true, value: await callback(...args) };
    } catch (error) {
      return {
        ok: false,
        error: error.message || "Не удалось выполнить действие.",
      };
    }
  });
}
async function quit() {
  if (quitting) return;
  for (const runner of ciRunners.values()) {
    try { await runner.stop(); }
    catch (error) { emit({ message: error.message }); show(); return; }
  }
  await stop();
  if (child) {
    show();
    return;
  }
  quitting = true;
  app.quit();
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", (_event, argv) => {
    if (window && !argv.includes("--background")) show();
  });
  app.whenReady().then(() => {
    directory = app.getPath("userData");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (existsSync(join(directory, "settings.json"))) {
      try {
        saved = JSON.parse(
          readFileSync(join(directory, "settings.json"), "utf8"),
        );
      } catch {}
    }
    try { launch = validateLaunch(saved.launch || {}); } catch { launch = { ...launchDefaults }; }
    // Migrate previous releases once so the visible preferences match the runtime config.
    const processingConfig = join(directory, "config.json");
    if (existsSync(processingConfig)) {
      try {
        const config = JSON.parse(readFileSync(processingConfig, "utf8"));
        const preferences = validateProcessing({ ...config, ...saved });
        saved = { ...saved, ...preferences };
        atomic("settings.json", JSON.stringify(saved, null, 2));
        atomic("config.json", JSON.stringify({ ...config, ...preferences, localSettings: true }, null, 2));
      } catch { snapshot.message = "Проверьте настройки обработки перед запуском."; }
    }
    try {
      if (existsSync(join(directory, "ci-settings.json"))) {
        const raw = JSON.parse(readFileSync(join(directory, "ci-settings.json"), "utf8"));
        ciRepos = validateCiRepos(Array.isArray(raw) ? raw : [raw]);
      }
    } catch { /* остаёмся на записи по умолчанию */ }
    restoreDesktopAutostart();
    window = new BrowserWindow({
      width: 1160,
      height: 820,
      minWidth: 620,
      minHeight: 620,
      show: !backgroundLaunch && !process.argv.includes("--smoke"),
      backgroundColor: "#10171e",
      title: "Worker Processor",
      icon: join(__dirname, "icon.png"),
      webPreferences: {
        preload: join(__dirname, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    snapshot.autostart = autostartState();
    snapshot.launch = launch;
    window.on("focus", () => emit({ autostart: autostartState() }));
    window.removeMenu();
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event, url) => {
      if (url !== pageURL) event.preventDefault();
    });
    window.webContents.session.setPermissionRequestHandler(
      (_contents, _permission, callback) => callback(false),
    );
    window.on("close", (event) => {
      if (!quitting) {
        event.preventDefault();
        window.hide();
      }
    });
    const icon = nativeImage.createFromPath(
      join(
        __dirname,
        process.platform === "darwin" ? "trayTemplate.png" : "icon.png",
      ),
    );
    if (process.platform === "darwin") icon.setTemplateImage(true);
    tray = new Tray(icon);
    tray.setToolTip("Worker Processor");
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Открыть Worker", click: show },
        {
          label: "Пауза",
          click: () => {
            if (child?.connected) child.send({ type: "pause", paused: true });
          },
        },
        {
          label: "Продолжить",
          click: () => {
            if (child?.connected) child.send({ type: "pause", paused: false });
          },
        },
        { type: "separator" },
        { label: "Выйти", click: () => void quit() },
      ]),
    );
    tray.on("double-click", show);
    tray.on("click", show);
    handle("processor:ci-state", () => ({ repos: ciRepos.map(entry => ({ ...entry, status: ciRunners.get(entry.id)?.state || { phase: "stopped", connected: false, busy: false } })) }));
    handle("processor:ci-save", async input => {
      const next = validateCiRepos(input);
      for (const entry of ciRepos) {
        const runner = ciRunners.get(entry.id);
        if (!runner || !runner.child) continue;
        const target = next.find(item => item.id === entry.id);
        if (!target) throw Error("Остановите сборки перед удалением репозитория.");
        if (target.repository !== entry.repository || target.directory !== entry.directory || target.distribution !== entry.distribution || target.name !== entry.name)
          throw Error("Остановите сборки перед изменением подключения runner.");
        if (!target.enabled) await runner.stop();
      }
      ciRepos = next;
      atomic("ci-settings.json", JSON.stringify(ciRepos, null, 2));
      for (const entry of ciRepos) {
        if (!entry.enabled) continue;
        const runner = ciRunnerFor(entry.id);
        try { await runner.start(entry); }
        catch (error) { runner.update({ phase: "error", connected: false, busy: false, message: error.message }); }
      }
      return { repos: ciRepos.map(entry => ({ ...entry, status: ciRunners.get(entry.id)?.state || { phase: "stopped", connected: false, busy: false } })) };
    });
    handle("processor:ci-check", input => ciRunnerFor(input.id).check(input));
    handle("processor:ci-install", input => ciRunnerFor(input.id).install(input));
    handle("processor:ci-register", (input, token) => ciRunnerFor(input.id).register(input, token));
    handle("processor:ci-start", id => {
      const entry = ciRepos.find(item => item.id === id);
      if (!entry) throw Error("Репозиторий не найден.");
      return ciRunnerFor(id).start(entry);
    });
    handle("processor:ci-stop", id => ciRunnerFor(id).stop());
    handle("processor:launch", (input) => {
      launch = validateLaunch({ ...launch, ...input });
      saved = { ...saved, launch };
      atomic("settings.json", JSON.stringify(saved, null, 2));
      emit({ launch });
      return publicSettings();
    });
    handle("processor:autostart", setDesktopAutostart);
    handle("processor:readiness", (capability) => checkReadiness(capability));
    handle("processor:install", async (capability) => {
      if (child) throw Error("Остановите обработчик перед установкой зависимостей.");
      if (capability === "video") return installVideo();
      if (capability === "speech") return installSpeech();
      throw Error("Неизвестная зависимость.");
    });
    handle("processor:state", () => ({
      settings: publicSettings(),
      status: snapshot,
    }));
    handle("processor:directory", async () => {
      const result = await dialog.showOpenDialog(window, {
        properties: ["openDirectory", "createDirectory"],
        title: "Рабочая папка обработки",
      });
      return result.canceled ? null : result.filePaths[0];
    });
    handle("processor:certificate", async () => {
      const result = await dialog.showOpenDialog(window, {
        properties: ["openFile"],
        filters: [{ name: "Публичный сертификат", extensions: ["crt", "pem"] }],
        title: "Сертификат Worker",
      });
      return result.canceled ? null : result.filePaths[0];
    });
    handle("processor:save", async (input) => {
      if (child)
        throw Error("Остановите обработчик перед изменением подключения.");
      const previousCa = join(directory, "device-ca.crt");
      const settings = validateSettings({
        ...input,
        caPath: input.caPath || (existsSync(previousCa) ? previousCa : ""),
      });
      if (!safeStorage.isEncryptionAvailable())
        throw Error("Защищённое хранилище ОС недоступно.");
      if (!settings.token && !existsSync(join(directory, "credential.bin")))
        throw Error("Введите DEVICE-токен из панели.");
      if (
        !settings.token &&
        saved.deviceId &&
        (saved.deviceId !== settings.deviceId ||
          saved.server !== settings.server)
      )
        throw Error("При смене сервера или устройства нужен его токен.");
      if (settings.token)
        atomic("credential.bin", safeStorage.encryptString(settings.token));
      if (settings.ca) atomic("device-ca.crt", settings.ca);
      saved = {
        server: settings.server,
        deviceId: settings.deviceId,
        workDir: settings.workDir,
        ...validateProcessing({ ...saved, ...input }),
        fingerprint: settings.fingerprint,
        launch,
      };
      atomic(
        "config.json",
        JSON.stringify(
          {
            url:
              settings.server.replace("https:", "wss:") +
              "/api/v2/device/connect",
            deviceId: settings.deviceId,
            tlsCaFile: settings.ca ? previousCa : undefined,
            stateDir: join(directory, "state"),
            workDir: settings.workDir,
            ...validateProcessing({ ...saved, ...input }),
            ...(saved.whisperCpp ? { whisperCpp: saved.whisperCpp } : {}),
            paused: false,
            localSettings: true,
          },
          null,
          2,
        ),
      );
      atomic("settings.json", JSON.stringify(saved, null, 2));
      emit({ autostart: autostartState() });
      return publicSettings();
    });
    handle("processor:processing", async (input) => {
      const next = validateProcessing(input);
      let workDir = saved.workDir;
      if (input.workDir && input.workDir !== saved.workDir && saved.server && saved.deviceId) {
        if (child) throw Error("Остановите обработчик перед сменой рабочей папки.");
        workDir = validateSettings({ ...saved, ...input }).workDir;
        const journalPath = join(directory, "state", "journal.json");
        if (existsSync(journalPath)) {
          const journal = JSON.parse(readFileSync(journalPath, "utf8"));
          if (journal.attempts?.length) throw Error("Сначала завершите незавершённые задания перед сменой папки.");
          delete journal.workVolume;
          writeFileSync(journalPath, JSON.stringify(journal), { mode: 0o600 });
        }
      }
      const configPath = join(directory, "config.json");
      if (existsSync(configPath)) {
        const config = JSON.parse(readFileSync(configPath, "utf8"));
        atomic("config.json", JSON.stringify({ ...config, ...next, workDir, localSettings: true }, null, 2));
      }
      saved = { ...saved, ...next, workDir };
      atomic("settings.json", JSON.stringify(saved, null, 2));
      if (child?.connected) child.send({ type: "processing", settings: next });
      return publicSettings();
    });
    handle("processor:start", start);
    handle("processor:stop", async () => {
      await stop();
      return snapshot;
    });
    handle("processor:pause", (paused) => {
      if (typeof paused !== "boolean" || !child?.connected)
        throw Error("Обработчик не запущен.");
      child.send({ type: "pause", paused });
      return snapshot;
    });
    handle("processor:hide", () => {
      window.hide();
      return true;
    });
    handle("processor:quit", () => {
      void quit();
      return true;
    });
    window.loadFile(html).then(async () => {
      if (process.argv.includes("--smoke")) return;
      if (launch.ciAutoStart) {
        for (const entry of ciRepos) {
          if (entry.enabled === false) continue;
          const runner = ciRunnerFor(entry.id);
          try { await runner.start(entry); }
          // An error here is the usual reason builds stay stopped: show it instead of a silent "stopped".
          catch (error) { runner.update({ phase: "error", connected: false, busy: false, message: error.message }); }
        }
      }
      if (!backgroundLaunch && !(launch.autoConnect && autostartState().configured)) return;
      try {
        await start();
      } catch (error) {
        emit({
          phase: "error",
          message: error.message || "Не удалось восстановить подключение.",
        });
        show();
      }
    });
  });
  app.on("activate", () => {
    if (window) show();
  });
  app.on("window-all-closed", () => {});
  app.on("before-quit", (event) => {
    if (!quitting) {
      event.preventDefault();
      void quit();
    }
  });
}
