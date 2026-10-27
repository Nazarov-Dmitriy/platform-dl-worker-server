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
const { fork } = require("node:child_process");
const {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
} = require("node:fs");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const { validateSettings } = require("./settings.cjs");
const { createLoginController } = require("./login.cjs");
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
function setDesktopAutostart(enabled) {
  if (enabled && !autostartState().configured)
    throw Error("Сначала сохраните подключение к серверу.");
  const actual = loginController.set(enabled);
  emit({ autostart: autostartState() });
  if (child?.connected)
    child.send({ type: "autostart-state", enabled: actual.enabled });
  return autostartState();
}
function publicSettings() {
  return { ...saved, tokenSet: existsSync(join(directory, "credential.bin")) };
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
    window = new BrowserWindow({
      width: 960,
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
    handle("processor:autostart", setDesktopAutostart);
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
      atomic("device-ca.crt", settings.ca);
      saved = {
        server: settings.server,
        deviceId: settings.deviceId,
        workDir: settings.workDir,
        maxParallel: settings.maxParallel,
        fingerprint: settings.fingerprint,
      };
      atomic(
        "config.json",
        JSON.stringify(
          {
            url:
              settings.server.replace("https:", "wss:") +
              "/api/v2/device/connect",
            deviceId: settings.deviceId,
            tlsCaFile: previousCa,
            stateDir: join(directory, "state"),
            workDir: settings.workDir,
            maxParallel: settings.maxParallel,
            paused: false,
          },
          null,
          2,
        ),
      );
      atomic("settings.json", JSON.stringify(saved, null, 2));
      emit({ autostart: autostartState() });
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
    handle("processor:quit", () => {
      void quit();
      return true;
    });
    window.loadFile(html).then(async () => {
      if (!backgroundLaunch) return;
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
