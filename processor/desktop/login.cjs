const NAME = "Worker Processor";
const ARGS = ["--background"];

function createLoginController(app, options = {}) {
  const platform = options.platform || process.platform;
  const executable = options.executable || process.execPath;
  const name = options.name || NAME;
  function state() {
    const supported = platform === "win32" && app.isPackaged;
    if (!supported)
      return { supported: false, enabled: false, registered: false };
    const native = app.getLoginItemSettings({ path: executable, args: ARGS });
    // Electron 45 may report empty args/openAtLogin=false for paths containing spaces.
    // The named launch item and Windows startup approval are reliable; registration writes the fixed background flag.
    const own = native.launchItems?.find((item) => item.name === name);
    return {
      supported: true,
      registered: !!own,
      enabled: !!own?.enabled && !!native.executableWillLaunchAtLogin,
    };
  }
  function set(enabled) {
    if (typeof enabled !== "boolean")
      throw Error("Некорректная настройка автозапуска.");
    if (platform !== "win32" || !app.isPackaged)
      throw Error("Автозапуск пока доступен в собранном приложении Windows.");
    app.setLoginItemSettings({
      name,
      path: executable,
      args: ARGS,
      openAtLogin: enabled,
      ...(enabled ? { enabled: true } : {}),
    });
    const actual = state();
    if (actual.enabled !== enabled || (!enabled && actual.registered))
      throw Error(
        "Windows не применила настройку автозапуска. Проверьте раздел «Автозагрузка» в Windows.",
      );
    return actual;
  }
  return { state, set };
}
module.exports = { createLoginController, NAME, ARGS };
