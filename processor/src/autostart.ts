import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import type { Config } from "./config.js";
export async function setAutostart(
  config: Config,
  enabled: boolean,
  token: string,
) {
  if (!config.configFile) {
    if (enabled) throw new Error("AUTOSTART_CONFIG_PATH_REQUIRED");
    return;
  }
  const tokenFile =
    config.tokenFile ||
    fileURLToPath(new URL("../data/processor.token", import.meta.url));
  if (enabled) {
    if (!existsSync(tokenFile))
      throw new Error("PROCESSOR_TOKEN_FILE_REQUIRED");
    const line = readFileSync(tokenFile, "utf8")
      .split(/\r?\n/)
      .find((l) => l.startsWith("PROCESSOR_TOKEN="));
    if (!line || line.slice(16).trim() !== token)
      throw new Error("PROCESSOR_TOKEN_FILE_INVALID");
  }
  const windows = process.platform === "win32";
  const script = fileURLToPath(
    new URL(
      windows ? "../packaging/install.ps1" : "../packaging/install.sh",
      import.meta.url,
    ),
  );
  const exe = windows ? "powershell.exe" : "/bin/sh";
  const args = windows
    ? [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        script,
        "-Config",
        resolve(config.configFile),
        "-TokenFile",
        tokenFile,
        ...(!enabled ? ["-Disable"] : []),
      ]
    : [script, ...(!enabled ? ["--disable"] : [])];
  await new Promise<void>((accept, reject) =>
    execFile(
      exe,
      args,
      {
        windowsHide: true,
        timeout: 30000,
        env: {
          ...process.env,
          PROCESSOR_TOKEN: undefined,
          CONFIG: resolve(config.configFile!),
          TOKEN_FILE: tokenFile,
          NODE_BIN: process.execPath,
        },
      },
      (error) =>
        error ? reject(new Error("AUTOSTART_INSTALL_FAILED")) : accept(),
    ),
  );
}
