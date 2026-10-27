import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
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
        stage: r.stage, progress: r.progress, encoder: r.encoder,
      })) : [],
      paused: !!agent?.config.paused,
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
process.on("disconnect", () => void stop());
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
