const { contextBridge, ipcRenderer } = require("electron");
const invoke = async (channel, ...args) => {
  const result = await ipcRenderer.invoke(channel, ...args);
  if (!result.ok) throw Error(result.error);
  return result.value;
};
contextBridge.exposeInMainWorld("processor", {
  state: () => invoke("processor:state"),
  directory: () => invoke("processor:directory"),
  certificate: () => invoke("processor:certificate"),
  save: (settings) => invoke("processor:save", settings),
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
