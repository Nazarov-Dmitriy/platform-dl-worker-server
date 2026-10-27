const { X509Certificate } = require("node:crypto");
const { statSync, readFileSync } = require("node:fs");
const { isAbsolute } = require("node:path");
function validateSettings(input) {
  if (!input || typeof input !== "object")
    throw Error("Заполните настройки подключения.");
  let server;
  try {
    server = new URL(String(input.server).trim());
  } catch {
    throw Error("Укажите адрес сервера, например https://194.5.79.198:8090.");
  }
  if (
    server.protocol !== "https:" ||
    server.username ||
    server.password ||
    server.search ||
    server.hash ||
    !["", "/"].includes(server.pathname)
  )
    throw Error("Нужен HTTPS-адрес сервера без пути, логина и пароля.");
  const deviceId = String(input.deviceId || "").trim();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      deviceId,
    )
  )
    throw Error("Скопируйте ID устройства из панели Worker.");
  const workDir = String(input.workDir || "");
  if (!isAbsolute(workDir) || !statSync(workDir).isDirectory())
    throw Error("Выберите существующую рабочую папку.");
  const caPath = String(input.caPath || "");
  let ca = "",
    fingerprint = "";
  if (caPath) {
    if (!isAbsolute(caPath) || statSync(caPath).size > 65536)
      throw Error("Выберите публичный сертификат device-ca.crt.");
    ca = readFileSync(caPath, "utf8");
    if (ca.includes("PRIVATE KEY"))
      throw Error("Нужен публичный сертификат, а не приватный ключ.");
    let certificate;
    try {
      certificate = new X509Certificate(ca);
    } catch {
      throw Error("Файл не является сертификатом.");
    }
    if (
      !certificate.ca ||
      Date.parse(certificate.validTo) < Date.now() ||
      Date.parse(certificate.validFrom) > Date.now()
    )
      throw Error(
        "Сертификат CA недействителен. Скачайте его из панели сервера.",
      );
    fingerprint = certificate.fingerprint256;
  }
  const maxParallel = Number(input.maxParallel || 1);
  if (!Number.isSafeInteger(maxParallel) || maxParallel < 1 || maxParallel > 64)
    throw Error("Число параллельных заданий должно быть от 1 до 64.");
  const token = String(input.token || "").trim();
  if (token && (/\s/.test(token) || token.length > 4096))
    throw Error("Проверьте токен устройства.");
  return {
    server: server.origin,
    deviceId,
    workDir,
    ca,
    maxParallel,
    token,
    fingerprint,
  };
}
module.exports = { validateSettings };
