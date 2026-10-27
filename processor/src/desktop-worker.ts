import { mkdirSync } from "node:fs";
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
      paused: !!agent?.config.paused,
      message:
        lastMessage ||
        (agent?.session ? "Подключено к серверу." : "Подключаемся к серверу…"),
    },
  });
}
async function stop() {
  if (timer) clearInterval(timer);
  if (agent) await agent.close();
  unlock?.();
  process.exit(0);
}
process.on("message", async (input: any) => {
  try {
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
