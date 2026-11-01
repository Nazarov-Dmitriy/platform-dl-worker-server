const { contextBridge, ipcRenderer } = require("electron");
const invoke = async (channel, ...args) => {
  const result = await ipcRenderer.invoke(channel, ...args);
  if (!result.ok) throw Error(result.error);
  return result.value;
};
contextBridge.exposeInMainWorld("processor", {
  ciState: () => invoke("processor:ci-state"),
  ciSave: settings => invoke("processor:ci-save", settings),
  ciCheck: settings => invoke("processor:ci-check", settings),
  ciInstall: settings => invoke("processor:ci-install", settings),
  ciRegister: (settings, token) => invoke("processor:ci-register", settings, token),
  ciStart: () => invoke("processor:ci-start"),
  ciStop: () => invoke("processor:ci-stop"),
  onCiStatus: callback => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on("processor:ci-status", listener);
    return () => ipcRenderer.removeListener("processor:ci-status", listener);
  },
  state: () => invoke("processor:state"),
  directory: () => invoke("processor:directory"),
  certificate: () => invoke("processor:certificate"),
  save: (settings) => invoke("processor:save", settings),
  processing: (settings) => invoke("processor:processing", settings),
  readiness: (capability) => invoke("processor:readiness", capability),
  install: (capability) => invoke("processor:install", capability),
  start: () => invoke("processor:start"),
  stop: () => invoke("processor:stop"),
  pause: (paused) => invoke("processor:pause", paused),
  hide: () => invoke("processor:hide"),
  quit: () => invoke("processor:quit"),
  autostart: (enabled) => invoke("processor:autostart", enabled),
  onStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on("processor:status", listener);
    return () => ipcRenderer.removeListener("processor:status", listener);
  },
});
