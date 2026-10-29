import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const platform = { win32: "windows", darwin: "macos", linux: "linux" }[process.platform];
if (!platform) throw new Error("Unsupported release platform: " + process.platform);
const cli = fileURLToPath(new URL("../node_modules/electron-builder/out/cli/cli.js", import.meta.url));
const result = spawnSync(process.execPath, [cli, ...process.argv.slice(2),
  "--config.directories.output=../releases/" + platform], {
  cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: "inherit", windowsHide: true,
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
