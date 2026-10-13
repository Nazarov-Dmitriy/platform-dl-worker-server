import { loadConfig } from "./config.js";
import { Journal } from "./journal.js";
import { lockInstance } from "./instance.js";
import { Agent } from "./agent.js";
import { Resources } from "./resources.js";
import { doctor } from "./doctor.js";
async function main() {
  const path = process.argv[2];
  if (path === "--doctor" || (process.argv.includes("--doctor") && !path)) {
    const report = doctor(process.argv[3]);
    console.log(JSON.stringify(report));
    if (!report.ok) process.exitCode = 1;
    return;
  }
  if (!path)
    throw new Error(
      "Usage: npm start -- <config.json> | npm start -- --doctor [config.json]",
    );
  if (process.argv[3] === "--doctor") {
    const report = doctor(path);
    console.log(JSON.stringify(report));
    if (!report.ok) process.exitCode = 1;
    return;
  }
  const config = loadConfig(path);
  const bind = process.argv[3] === "--bind-work-volume";
  if (process.argv[3] && !bind) throw new Error("UNKNOWN_ARGUMENT");
  const token = process.env.PROCESSOR_TOKEN;
  if (!bind && (!token || /\s/.test(token)))
    throw new Error("PROCESSOR_TOKEN_REQUIRED");
  if (
    !["win32", "darwin", "linux"].includes(process.platform) ||
    !["x64", "arm64"].includes(process.arch)
  )
    throw new Error("UNSUPPORTED_PLATFORM");
  // Acquire exclusive writer ownership before reading or changing the journal.
  const { mkdirSync } = await import("node:fs");
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  const unlock = await lockInstance(config.stateDir);
  let agent: Agent;
  try {
    const journal = new Journal(config.stateDir);
    if (bind) {
      if (journal.state.attempts.length || journal.state.outbox.length)
        throw new Error("UNSETTLED_ATTEMPTS_REQUIRE_RECONCILIATION");
      delete journal.state.workVolume;
      new Resources(config, journal);
      console.log("WORK_VOLUME_BOUND");
      unlock();
      return;
    }
    agent = new Agent(config, token!, journal);
  } catch (e) {
    unlock();
    throw e;
  }
  const stop = async () => {
    await agent.close();
    unlock();
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
  try {
    agent.start();
  } catch (e) {
    await agent.close();
    unlock();
    throw e;
  }
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : "PROCESSOR_START_FAILED");
  process.exitCode = 1;
});
