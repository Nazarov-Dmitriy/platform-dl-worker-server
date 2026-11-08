const { execFileSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const { join, resolve } = require("node:path");

const LXSS = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss";
const DISK_NAME = "ext4.vhdx";

function defaultRoots() {
  return [
    process.cwd(),
    join(process.cwd(), ".."),
    join(process.cwd(), "..", ".."),
    join(process.cwd(), "..", "..", ".."),
    join(__dirname, "..", ".."),
    join(__dirname, "..", "..", ".."),
  ];
}

function decodeReg(output) {
  if (Buffer.isBuffer(output)) {
    if (output.length >= 2 && output[1] === 0) return output.toString("utf16le").replace(/^\uFEFF/, "");
    return output.toString("utf8");
  }
  return String(output);
}

function parseLxss(text) {
  const entries = [];
  let current = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    if (/^HKEY_/i.test(line)) {
      if (current.DistributionName) entries.push(current);
      current = { key: line.trim() };
      continue;
    }
    const match = line.match(/^\s+(DistributionName|BasePath|VhdFileName)\s+REG_\w+\s+(.*)$/);
    if (match) current[match[1]] = match[2].trim();
  }
  if (current.DistributionName) entries.push(current);
  return entries;
}

function queryLxss(run = execFileSync) {
  return decodeReg(run("reg.exe", ["query", LXSS, "/s"], { windowsHide: true, encoding: "buffer" }));
}

function diskFolder(folder) {
  return folder ? join(resolve(folder), DISK_NAME) : "";
}

function hasDisk(folder, exists = existsSync) {
  return Boolean(folder) && exists(diskFolder(folder));
}

function findDiskFolder({ registeredPath = "", roots = defaultRoots(), exists = existsSync } = {}) {
  if (hasDisk(registeredPath, exists)) return resolve(registeredPath);
  const seen = new Set();
  for (const root of roots) {
    if (!root) continue;
    const folder = resolve(join(root, "data", "ci-wsl"));
    if (seen.has(folder.toLowerCase())) continue;
    seen.add(folder.toLowerCase());
    if (hasDisk(folder, exists)) return folder;
  }
  return "";
}

function validateWindowsDiskFolder(folder, exists = existsSync) {
  const resolved = resolve(String(folder || ""));
  if (!/^[A-Za-z]:[\\/]/.test(resolved) || /[\r\n\0]/.test(resolved))
    throw Error("Укажите обычную папку Windows с диском WSL.");
  if (!hasDisk(resolved, exists))
    throw Error("В этой папке нет диска WSL (ext4.vhdx). Переносить нужно data/ci-wsl целиком; runner внутри Linux уже установлен.");
  return resolved;
}

function inspectWslDisk(distribution, options = {}) {
  const name = String(distribution || "").trim();
  const empty = {
    supported: options.platform ? options.platform === "win32" : process.platform === "win32",
    distribution: name,
    registeredPath: "",
    suggestedPath: "",
    reachable: false,
    needsRetarget: false,
    message: "",
  };
  if (!empty.supported) {
    return { ...empty, message: "Смена пути диска нужна только Windows WSL." };
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name) || name === "docker-desktop")
    throw Error("Выберите отдельный дистрибутив Linux, например Worker-CI.");
  let entries = [];
  try { entries = parseLxss((options.query || queryLxss)()); }
  catch { return { ...empty, message: "Не удалось прочитать список WSL. Проверьте, что WSL установлен." }; }
  const entry = entries.find(item => item.DistributionName === name);
  if (!entry) {
    return { ...empty, message: "Дистрибутив " + name + " не зарегистрирован в WSL. Это не установка runner: сначала нужна среда Worker-CI." };
  }
  const registeredPath = entry.BasePath || "";
  const suggestedPath = findDiskFolder({ registeredPath, roots: options.roots || defaultRoots(), exists: options.exists });
  const reachable = hasDisk(registeredPath, options.exists);
  const needsRetarget = !reachable && Boolean(suggestedPath);
  let message = "";
  if (needsRetarget)
    message = "Пути не совпадают: диск WSL смотрит в старую папку. Runner уже установлен — обновите путь.";
  else if (!reachable)
    message = "Диск " + name + " не найден. Нужна папка data/ci-wsl с файлом ext4.vhdx, без повторной установки runner.";
  return {
    supported: true,
    distribution: name,
    registryKey: entry.key,
    registeredPath,
    suggestedPath,
    reachable,
    needsRetarget,
    message,
  };
}

function terminateDistro(name, run = execFileSync) {
  try {
    run(join(process.env.SystemRoot || "C:\\Windows", "System32", "wsl.exe"), ["--terminate", name], { windowsHide: true, encoding: "buffer" });
  } catch { /* already stopped or path still missing */ }
}

function writeBasePath(key, folder, run = execFileSync) {
  run("reg.exe", ["add", key, "/v", "BasePath", "/t", "REG_SZ", "/d", folder, "/f"], { windowsHide: true, encoding: "buffer" });
}

function retargetWslDisk(distribution, options = {}) {
  const disk = inspectWslDisk(distribution, options);
  if (!disk.supported) throw Error(disk.message);
  if (options.busy) throw Error("Остановите сборки перед сменой пути диска.");
  if (!disk.registryKey) throw Error(disk.message);
  if (disk.reachable && disk.suggestedPath && resolve(disk.registeredPath) === resolve(disk.suggestedPath))
    return { ...disk, updated: false, message: "Путь Linux-диска уже верный. Runner переустанавливать не нужно." };
  if (!disk.suggestedPath) throw Error(disk.message);
  const folder = validateWindowsDiskFolder(disk.suggestedPath, options.exists);
  (options.terminate || terminateDistro)(disk.distribution);
  (options.writeBasePath || writeBasePath)(disk.registryKey, folder);
  return {
    ...disk,
    registeredPath: folder,
    suggestedPath: folder,
    reachable: true,
    needsRetarget: false,
    updated: true,
    message: "Путь Linux-диска обновлён. Runner в системе сохранён, его не нужно ставить заново.",
  };
}

module.exports = {
  DISK_NAME,
  parseLxss,
  findDiskFolder,
  inspectWslDisk,
  retargetWslDisk,
  validateWindowsDiskFolder,
  defaultRoots,
};
