const test = require("node:test");
const assert = require("node:assert/strict");
const { join } = require("node:path");
const { parseLxss, findDiskFolder, inspectWslDisk, retargetWslDisk, validateWindowsDiskFolder } = require("../desktop/ci-wsl.cjs");

const registry = `HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\{guid}
    DistributionName    REG_SZ    Worker-CI
    BasePath    REG_SZ    G:\\old\\titunki\\worker-server\\data\\ci-wsl
    VhdFileName    REG_SZ    ext4.vhdx
`;
const moved = "G:\\now\\worker-server\\data\\ci-wsl";
const exists = path => path.replaceAll("/", "\\").toLowerCase() === join(moved, "ext4.vhdx").toLowerCase();

test("registry parser keeps the distro name and Windows disk folder", () => {
  const [entry] = parseLxss(registry);
  assert.equal(entry.DistributionName, "Worker-CI");
  assert.equal(entry.BasePath, "G:\\old\\titunki\\worker-server\\data\\ci-wsl");
  assert.match(entry.key, /\\\\\{guid\}$|\\{guid}$/);
});

test("disk search uses the moved project folder and does not follow the stale registry path", () => {
  assert.equal(findDiskFolder({
    registeredPath: "G:\\old\\titunki\\worker-server\\data\\ci-wsl",
    roots: ["G:\\now\\worker-server"],
    exists,
  }), moved);
});

test("inspect tells the user to retarget instead of reinstalling the runner", () => {
  const disk = inspectWslDisk("Worker-CI", { platform: "win32", query: () => registry, exists, roots: ["G:\\now\\worker-server"] });
  assert.equal(disk.needsRetarget, true);
  assert.equal(disk.suggestedPath, moved);
  assert.match(disk.message, /Пути не совпадают/);
  assert.doesNotMatch(disk.message, /ставить заново|Установите/);
  const ok = inspectWslDisk("Worker-CI", {
    platform: "win32",
    query: () => registry.replace("G:\\old\\titunki\\worker-server\\data\\ci-wsl", moved),
    exists,
    roots: ["G:\\now\\worker-server"],
  });
  assert.equal(ok.needsRetarget, false);
  assert.equal(ok.message, "");
});

test("retarget rewrites BasePath only and leaves the runner in place", () => {
  const writes = [];
  const result = retargetWslDisk("Worker-CI", {
    platform: "win32",
    query: () => registry,
    exists,
    roots: ["G:\\now\\worker-server"],
    terminate: () => writes.push("terminate"),
    writeBasePath: (key, folder) => writes.push(key, folder),
  });
  assert.equal(result.updated, true);
  assert.equal(writes[0], "terminate");
  assert.equal(writes[2], moved);
  assert.match(result.message, /не нужно ставить/);
});

test("a reachable disk is left alone", () => {
  const here = "G:\\now\\worker-server\\data\\ci-wsl";
  const ok = path => path.replaceAll("/", "\\").toLowerCase() === join(here, "ext4.vhdx").toLowerCase();
  const result = retargetWslDisk("Worker-CI", {
    platform: "win32",
    query: () => registry.replace("G:\\old\\titunki\\worker-server\\data\\ci-wsl", here),
    exists: ok,
    roots: ["G:\\now\\worker-server"],
    writeBasePath: () => { throw Error("should not write"); },
  });
  assert.equal(result.updated, false);
});

test("running builds block a path change", () => {
  assert.throws(() => retargetWslDisk("Worker-CI", {
    platform: "win32", query: () => registry, exists, roots: ["G:\\now\\worker-server"], busy: true,
  }), /Остановите сборки/);
});

test("docker-desktop and missing vhdx are rejected", () => {
  assert.throws(() => inspectWslDisk("docker-desktop", { platform: "win32" }), /отдельный дистрибутив/);
  assert.throws(() => validateWindowsDiskFolder("C:\\no-disk", () => false), /ext4\.vhdx/);
});
