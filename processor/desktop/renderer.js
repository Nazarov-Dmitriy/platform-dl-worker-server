const $ = (id) => document.getElementById(id),
  form = $("settings");
let current = { phase: "stopped", running: 0, connected: false, paused: false },
  caPath = "",
  busy = false;
let autostart = { supported: false, enabled: false, configured: false };
let pendingAutostart;
function notice(message) {
  $("notice").textContent = message || "";
  $("notice").hidden = !message;
}
function drawAutostart(value) {
  if (value) autostart = value;
  $("autostart").checked = pendingAutostart ?? autostart.enabled;
  $("autostart").disabled =
    busy ||
    !autostart.supported ||
    (!autostart.configured && !autostart.enabled);
  $("autostartHint").textContent =
    pendingAutostart !== undefined
      ? "Сохраняем настройку…"
      : !autostart.supported
        ? "Доступно в собранном приложении Windows."
        : !autostart.configured
          ? "Сначала сохраните подключение."
          : autostart.enabled
            ? "Включено. После входа в Windows обработчик подключится сам. Папку приложения не перемещайте."
            : "Выключено. Приложение запускается вручную.";
}
$("autostart").onchange = () => {
  const enabled = $("autostart").checked;
  pendingAutostart = enabled;
  void action(async () => {
    try {
      drawAutostart(await window.processor.autostart(enabled));
    } finally {
      pendingAutostart = undefined;
    }
  });
};
function draw(status) {
  current = status;
  drawAutostart(status.autostart);
  const active = !["stopped", "error"].includes(status.phase);
  $("connection").textContent = status.paused
    ? "На паузе"
    : status.connected
      ? "Подключён"
      : status.phase === "connecting"
        ? "Подключение…"
        : status.phase === "stopping"
          ? "Завершение…"
          : status.phase === "error"
            ? "Ошибка"
            : "Не запущен";
  $("connection").classList.toggle(
    "online",
    status.connected && !status.paused,
  );
  $("activity").textContent = "Заданий в работе: " + status.running;
  $("detail").textContent = status.message || "";
  form
    .querySelectorAll("input,button")
    .forEach((input) => (input.disabled = active || busy));
  $("connect").disabled = active || busy;
  $("pause").disabled = !active || busy;
  $("stop").disabled = !active || busy;
  $("pause").textContent = status.paused ? "Продолжить" : "Пауза";
}
async function action(callback) {
  if (busy) return;
  busy = true;
  notice("");
  draw(current);
  try {
    await callback();
  } catch (error) {
    notice(error.message);
  } finally {
    busy = false;
    draw(current);
  }
}
$("chooseCertificate").onclick = () =>
  action(async () => {
    const chosen = await window.processor.certificate();
    if (chosen) {
      caPath = chosen;
      $("certificate").value = chosen;
    }
  });
$("chooseDirectory").onclick = () =>
  action(async () => {
    const chosen = await window.processor.directory();
    if (chosen) form.elements.workDir.value = chosen;
  });
form.onsubmit = (event) => {
  event.preventDefault();
  void action(async () => {
    const settings = await window.processor.save({
      server: form.elements.server.value,
      deviceId: form.elements.deviceId.value,
      token: form.elements.token.value,
      caPath,
      workDir: form.elements.workDir.value,
      maxParallel: Number(form.elements.maxParallel.value),
    });
    form.elements.token.value = "";
    $("tokenHint").textContent =
      "Токен сохранён. Оставьте поле пустым, чтобы использовать его снова.";
    $("fingerprint").textContent = "Отпечаток CA: " + settings.fingerprint;
    $("fingerprint").hidden = false;
    await window.processor.start();
  });
};
$("pause").onclick = () =>
  action(() => window.processor.pause(!current.paused));
$("stop").onclick = () => action(() => window.processor.stop());
window.processor.onStatus(draw);
window.processor
  .state()
  .then(({ settings, status }) => {
    for (const name of ["server", "deviceId", "workDir", "maxParallel"])
      if (settings[name] != null) form.elements[name].value = settings[name];
    if (settings.tokenSet)
      $("tokenHint").textContent =
        "Токен уже сохранён. Оставьте поле пустым для повторного подключения.";
    if (settings.fingerprint) {
      $("certificate").value = "Сертификат сохранён";
      $("fingerprint").textContent = "Отпечаток CA: " + settings.fingerprint;
      $("fingerprint").hidden = false;
    }
    draw(status);
  })
  .catch((error) => notice(error.message));
