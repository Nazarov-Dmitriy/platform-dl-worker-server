const { contextBridge, ipcRenderer } = require("electron");
const invoke = async (channel, ...args) => {
  const result = await ipcRenderer.invoke(channel, ...args);
  if (!result.ok) throw Error(result.error);
  return result.value;
};
contextBridge.exposeInMainWorld("processor", {
  ciState: () => invoke("processor:ci-state"),
  ciSave: repos => invoke("processor:ci-save", repos),
  ciCheck: entry => invoke("processor:ci-check", entry),
  ciInstall: entry => invoke("processor:ci-install", entry),
  ciRegister: (entry, token) => invoke("processor:ci-register", entry, token),
  ciStart: id => invoke("processor:ci-start", id),
  ciStop: id => invoke("processor:ci-stop", id),
  onCiStatus: callback => {
    const listener = (_event, payload) => callback(payload);
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
  model: (action, id, revision) =>
    invoke("processor:model", { action, id, revision }),
  hide: () => invoke("processor:hide"),
  quit: () => invoke("processor:quit"),
  autostart: (enabled) => invoke("processor:autostart", enabled),
  launch: (preferences) => invoke("processor:launch", preferences),
  onStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on("processor:status", listener);
    return () => ipcRenderer.removeListener("processor:status", listener);
  },
});
