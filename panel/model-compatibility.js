// Shared by the website and desktop app (copied by processor's build).
(function (root) {
  function assess(model, env) {
    const unknown = (reason) => ({ level: "unknown", label: "Нужно проверить", reason });
    if (!env) return unknown("Выберите устройство, чтобы проверить совместимость.");
    if (env.online === false) return unknown("Устройство не в сети. Ресурсы могут измениться.");
    if (!env.os || !env.architecture || !env.memoryBytes)
      return unknown("Обновите воркер: он ещё не передал сведения об оборудовании.");
    if (model.os?.length && !model.os.includes(env.os))
      return { level: "no", label: "Не подходит", reason: "Эта ОС не поддерживается моделью." };
    if (model.architectures?.length && !model.architectures.includes(env.architecture))
      return { level: "no", label: "Не подходит", reason: "Архитектура процессора не поддерживается." };
    const estimated = model.memoryRequirementsVerified === false;
    const no = (reason) => ({ level: estimated ? "unknown" : "no", label: estimated ? "Ниже ориентира" : "Не подходит", reason });
    if (model.minimumRamBytes > env.memoryBytes)
      return no("Объём RAM меньше " + (estimated ? "предварительного ориентира" : "требования") + " модели.");
    const cpu = model.accelerators?.includes("cpu");
    const accelerated = model.accelerators?.includes(env.accelerator);
    if (!cpu && !accelerated)
      return unknown("Поддерживаемое ускорение не обнаружено. Нужна проверка движка и видеокарты.");
    const unified = env.os === "darwin" && env.architecture === "arm64";
    if (!cpu && !unified && model.minimumVramBytes > 0) {
      if (!(env.vramTotalBytes > 0)) return unknown("Объём VRAM неизвестен.");
      if (model.minimumVramBytes > env.vramTotalBytes) return no("Объём VRAM меньше " + (estimated ? "предварительного ориентира" : "требования") + " модели.");
    }
    if ((env.freeMemoryBytes != null && env.freeMemoryBytes < model.minimumRamBytes) ||
        (!cpu && !unified && env.freeVramBytes != null && env.freeVramBytes < model.minimumVramBytes))
      return { level: "wait", label: "Память сейчас занята", reason: "Сейчас свободной памяти меньше ориентира запуска. Установка возможна при наличии места на диске." };
    if (estimated) return unknown("По предварительным требованиям памяти подходит; запуск на этом оборудовании ещё не проверен.");
    return { level: "ok", label: "Подходит по ресурсам", reason: "ОС, архитектура и объём памяти подходят. Готовность движка проверяется отдельно при активации." };
  }
  function environment(usage, online = true) {
    if (!usage) return null;
    return { online, os: usage.deviceOS, architecture: usage.deviceArchitecture,
      memoryBytes: usage.memoryTotalBytes, freeMemoryBytes: usage.freeMemoryBytes,
      accelerator: usage.accelerator, gpuName: usage.gpuName,
      vramTotalBytes: usage.vramTotalBytes, freeVramBytes: usage.freeVramBytes,
      freeDiskBytes: usage.freeDiskBytes, diskReady: usage.workDiskAvailable };
  }
  const api = { assess, environment };
  root.ModelCompatibility = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
