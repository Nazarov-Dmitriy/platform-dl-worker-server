import { mkdirSync } from "node:fs";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { installModel, activateModel, deleteModel } from "./models.js";
import { loadConfig } from "./config.js";
import { Agent } from "./agent.js";
import { Journal } from "./journal.js";
import { lockInstance } from "./instance.js";
delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
let agent: Agent | undefined,
  unlock: (() => void) | undefined,
  timer: NodeJS.Timeout | undefined,
  starting = false,
  lastMessage = "";
// One model is fetched at a time. A second request while one is running would
// race for the same work directory and the same disk budget.
let fetching: { id: string; revision: string; progress: number } | undefined;

// What the Models screen needs: this machine, what the site allows, and what
// is already here. The screen never computes a path or a URL of its own.
function modelsView() {
  if (!agent) return undefined;
  const usage = agent.usage();
  const installed = agent.journal.state.models;
  return {
    environment: {
      memoryBytes: os.totalmem(),
      cpuCores: os.cpus().length,
      freeDiskBytes: usage.freeDiskBytes,
      workDir: agent.config.workDir,
      diskReady: usage.workDiskAvailable,
    },
    catalog: agent.journal.state.catalog.map((m) => ({
      id: m.id,
      revision: m.revision,
      purpose: m.purpose,
      operations: m.operations ?? [],
      downloadBytes: m.downloadBytes,
      minimumRamBytes: m.minimumRamBytes,
      languages: m.recognitionLanguages?.length ?? 0,
      directions: m.translationDirections?.length ?? 0,
    })),
    installed: installed.map((m) => ({
      id: m.id,
      revision: m.revision,
      state: m.state,
      purpose: m.purpose,
      minimumRamBytes: m.minimumRamBytes,
    })),
    fetching,
  };
}
function status(message?: string) {
  if (message) lastMessage = message;
  if (agent?.session) lastMessage = "";
  process.send?.({
    type: "status",
    status: {
      phase: agent?.session ? "connected" : agent ? "connecting" : "stopped",
      connected: !!agent?.session,
      running: agent?.running.size || 0,
      processing: agent ? { maxParallel: agent.config.maxParallel, cpuThreads: agent.config.cpuThreads,
        videoMode: agent.config.videoMode, audioMode: agent.config.audioMode } : undefined,
      jobs: agent ? [...agent.running.values()].map(r => ({
        id: r.attempt.jobId, type: r.job?.type || "media.transcode",
        stage: r.stage, progress: r.progress, encoder: r.encoder, download: r.download,
      })) : [],
      paused: !!agent?.config.paused,
      models: modelsView(),
      message:
        lastMessage ||
        (agent?.session ? "Подключено к серверу." : "Подключаемся к серверу…"),
    },
  });
}
const startupRequests = new Map<
  string,
  { resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
>();
let nativeAutostart: boolean | undefined;
function updateAutostartState(enabled: boolean) {
  nativeAutostart = enabled;
  if (!agent) return;
  agent.journal.state.autostart = enabled;
  if (agent.journal.state.appliedSettings)
    agent.journal.state.appliedSettings.autostart = enabled;
  agent.journal.save();
}
async function stop() {
  if (timer) clearInterval(timer);
  if (agent) await agent.close();
  unlock?.();
  process.exit(0);
}
process.on("message", async (input: any) => {
  try {
    if (input?.type === "autostart-result") {
      const pending = startupRequests.get(input.requestId);
      if (pending) {
        clearTimeout(pending.timer);
        startupRequests.delete(input.requestId);
        if (input.ok === true) pending.resolve();
        else pending.reject(new Error("AUTOSTART_INSTALL_FAILED"));
      }
      return;
    }
    if (
      input?.type === "autostart-state" &&
      typeof input.enabled === "boolean"
    ) {
      updateAutostartState(input.enabled);
      return;
    }
    if (input?.type === "start") {
      if (agent || starting) throw Error("ALREADY_RUNNING");
      starting = true;
      if (
        typeof input.token !== "string" ||
        !input.token ||
        /\s/.test(input.token)
      )
        throw Error("TOKEN_REQUIRED");
      const config = loadConfig(input.config);
      config.desktopAutostart = (enabled) =>
        new Promise<void>((resolve, reject) => {
          const requestId = randomUUID();
          const timer = setTimeout(() => {
            startupRequests.delete(requestId);
            reject(new Error("AUTOSTART_INSTALL_FAILED"));
          }, 10000);
          startupRequests.set(requestId, { resolve, reject, timer });
          process.send?.({ type: "autostart-request", requestId, enabled });
        });
      mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
      unlock = await lockInstance(config.stateDir);
      const journal = new Journal(config.stateDir);
      agent = new Agent(config, input.token, journal, (event) => {
        if (event === "CONNECTION_ERROR")
          status(
            "Не удалось подключиться. Проверьте адрес, сертификат и доступ к серверу.",
          );
        else if (event.startsWith("DISPATCHER_"))
          status("Сервер отклонил запрос. Проверьте ID и токен устройства.");
        else if (event === "CONNECTED") status();
      });
      if (nativeAutostart !== undefined) updateAutostartState(nativeAutostart);
      else if (typeof input.autostartEnabled === "boolean")
        updateAutostartState(input.autostartEnabled);
      agent.start();
      status();
      timer = setInterval(() => status(), 1000);
    } else if (
      input?.type === "pause" &&
      agent &&
      typeof input.paused === "boolean"
    ) {
      agent.config.paused = input.paused;
      if (agent.journal.state.appliedSettings)
        agent.journal.state.appliedSettings.paused = input.paused;
      agent.journal.save();
      status();
    } else if (input?.type === "processing" && agent) {
      const s = input.settings;
      if (!Number.isInteger(s?.maxParallel) || s.maxParallel < 1 || s.maxParallel > 64 ||
          !Number.isInteger(s.cpuThreads) || s.cpuThreads < 1 || s.cpuThreads > 1024 ||
          !["auto", "cpu", "gpu"].includes(s.videoMode) || !["auto", "cpu", "gpu"].includes(s.audioMode))
        throw Error("INVALID_RESOURCE_CONFIG");
      Object.assign(agent.config, s, { localSettings: true });
      agent.nextHeartbeat = 0;
      status("Настройки обработки применены. Текущие задания продолжаются; режимы и потоки применятся к новым.");
    } else if (input?.type === "model" && agent) {
      await runModel(input);
    } else if (input?.type === "stop") await stop();
  } catch {
    process.send?.({
      type: "status",
      status: {
        phase: "error",
        connected: false,
        running: 0,
        paused: false,
        message:
          "Не удалось запустить обработчик. Проверьте настройки, рабочую папку и отсутствие второго экземпляра.",
      },
    });
    if (!agent) {
      unlock?.();
      process.exitCode = 1;
      setTimeout(() => process.exit(1), 100);
    }
  }
});
// Installing, switching and removing a model, asked for by the person at the
// keyboard rather than by the dispatcher. The dispatcher's own MODEL_* commands
// still arrive over the session and run through the same functions.
async function runModel(input: any) {
  if (!agent) throw Error("NOT_RUNNING");
  const id = String(input.id || ""),
    revision = String(input.revision || "");
  const entry = agent.journal.state.catalog.find(
    (m) => m.id === id && m.revision === revision,
  );
  if (input.action === "delete") {
    deleteModel(
      agent.config.workDir,
      agent.journal,
      id,
      revision,
      agent.running.size > 0,
    );
    agent.nextHeartbeat = 0;
    status("Модель удалена.");
    return;
  }
  if (input.action === "activate") {
    agent.readiness.clear();
    activateModel(
      agent.journal,
      id,
      revision,
      agent.config.whisperCpp,
      agent.config.ffmpeg,
    );
    agent.nextHeartbeat = 0;
    status("Модель выбрана рабочей.");
    return;
  }
  if (input.action !== "install") throw Error("UNKNOWN_MODEL_ACTION");
  if (fetching) throw Error("MODEL_FETCH_BUSY");
  if (!entry) throw Error("MODEL_NOT_IN_CATALOG");
  const usage = agent.usage();
  if (!usage.workDiskAvailable) throw Error("WORK_DISK_UNAVAILABLE");
  if (entry.minimumRamBytes > os.totalmem()) throw Error("INSUFFICIENT_MEMORY");
  fetching = { id, revision, progress: 0 };
  status("Скачиваем «" + id + "»…");
  try {
    await installModel(
      agent.config.workDir,
      agent.journal,
      agent.journal.state.catalog,
      id,
      revision,
      usage.freeDiskBytes,
      (n) => {
        if (fetching) fetching.progress = n;
        status();
      },
    );
    agent.nextHeartbeat = 0;
    status("«" + id + "» установлена.");
  } finally {
    fetching = undefined;
  }
}

process.on("disconnect", () => void stop());
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
