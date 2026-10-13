import { readFileSync } from "node:fs";
import { resolve } from "node:path";
export type Config = {
  url: string;
  deviceId: string;
  stateDir: string;
  workDir: string;
  maxParallel: number;
  reserveMemoryBytes: number;
  taskMemoryBytes: number;
  reserveDiskBytes: number;
  threshold: number;
  paused: boolean;
  testExecutor: boolean;
  testDurationMs: number;
};
export function loadConfig(path: string): Config {
  const v = JSON.parse(readFileSync(path, "utf8"));
  const allowed = [
    "url",
    "deviceId",
    "stateDir",
    "workDir",
    "maxParallel",
    "reserveMemoryBytes",
    "taskMemoryBytes",
    "reserveDiskBytes",
    "threshold",
    "paused",
    "testExecutor",
    "testDurationMs",
  ];
  if (Object.keys(v).some((k) => !allowed.includes(k)))
    throw new Error("UNKNOWN_CONFIG_FIELD");
  const url = new URL(v.url);
  if (
    url.protocol !== "wss:" &&
    !(
      url.protocol === "ws:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    )
  )
    throw new Error("WSS_REQUIRED");
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/api/v2/device/connect"
  )
    throw new Error("INVALID_DEVICE_URL");
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      v.deviceId,
    )
  )
    throw new Error("INVALID_DEVICE_ID");
  if (typeof v.stateDir !== "string" || typeof v.workDir !== "string")
    throw new Error("DIRECTORIES_REQUIRED");
  const c: Config = {
    url: url.href,
    deviceId: v.deviceId,
    stateDir: resolve(v.stateDir),
    workDir: resolve(v.workDir),
    maxParallel: v.maxParallel ?? 2,
    reserveMemoryBytes: v.reserveMemoryBytes ?? 2 * 1024 ** 3,
    taskMemoryBytes: v.taskMemoryBytes ?? 1024 ** 3,
    reserveDiskBytes: v.reserveDiskBytes ?? 2 * 1024 ** 3,
    threshold: v.threshold ?? 80,
    paused: v.paused ?? false,
    testExecutor: v.testExecutor ?? false,
    testDurationMs: v.testDurationMs ?? 3000,
  };
  for (const k of [
    "maxParallel",
    "reserveMemoryBytes",
    "taskMemoryBytes",
    "reserveDiskBytes",
    "threshold",
    "testDurationMs",
  ] as const) {
    if (!Number.isSafeInteger(c[k]) || c[k] < 0)
      throw new Error("INVALID_RESOURCE_CONFIG");
  }
  if (
    c.maxParallel < 1 ||
    c.maxParallel > 64 ||
    c.taskMemoryBytes < 1 ||
    c.threshold < 1 ||
    c.threshold > 80 ||
    c.testDurationMs < 100 ||
    c.testDurationMs > 3600000 ||
    typeof c.paused !== "boolean" ||
    typeof c.testExecutor !== "boolean"
  )
    throw new Error("INVALID_RESOURCE_CONFIG");
  return c;
}
