const { spawnSync } = require("node:child_process");
const path = require("node:path");
const assert = require("node:assert/strict");
const { RUN_PROCESS: RUN, STOP } = require("../desktop/ci-runner.cjs");
const result = spawnSync("docker", ["run", "--rm", "-i", "--network", "none", "--mount",
  "type=bind,source=" + __dirname + ",target=/tests,readonly", "python:3.12-slim", "python", "/tests/ci-linux-process.py"],
  { input: JSON.stringify({ RUN, STOP }), encoding: "utf8", windowsHide: true, timeout: 30000 });
assert.equal(result.status, 0, result.stderr || result.error?.message);
process.stdout.write(result.stdout);
