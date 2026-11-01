const $ = (id) => document.getElementById(id),
  form = $("settings"),
  processingForm = $("processingSettings");
let current = { phase: "stopped", running: 0, connected: false, paused: false },
  caPath = "",
  busy = false;
let autostart = { supported: false, enabled: false, configured: false };
let pendingAutostart;
let configured = false;
let savedReadiness = {};
let whisperBuild = undefined;
function screen(settings) {
  $("dashboard").hidden = settings;
  $("settingsScreen").hidden = !settings;
  window.scrollTo(0, 0);
}
function settingsTab(processing) {
  $("ciSettings").hidden = true;
  $("ciTab").setAttribute("aria-pressed", "false");
  form.hidden = processing;
  processingForm.hidden = !processing;
  $("startupCard").hidden = processing;
  $("connectionTab").setAttribute("aria-pressed", String(!processing));
  $("processingTab").setAttribute("aria-pressed", String(processing));
}
$("connectionTab").onclick = () => settingsTab(false);
$("processingTab").onclick = () => settingsTab(true);
function processingInput() {
  return { maxParallel: Number(processingForm.elements.maxParallel.value),
    cpuThreads: Number(processingForm.elements.cpuThreads.value),
    videoMode: processingForm.elements.videoMode.value,
    audioMode: processingForm.elements.audioMode.value,
    workDir: processingForm.elements.workDir.value };
}
function fillProcessing(settings) {
  for (const name of ["workDir", "maxParallel", "cpuThreads", "videoMode", "audioMode"])
    if (settings[name] != null) processingForm.elements[name].value = settings[name];
  if (settings.cpuCount) {
    processingForm.elements.cpuThreads.max = settings.cpuCount;
    $("cpuHint").textContent = "Доступно логических CPU-потоков: " + settings.cpuCount + ".";
  }
  savedReadiness = settings.readiness || {};
  whisperBuild = settings.whisperBuild;
  refreshSpeechBuild();
  drawReadiness();
}
function drawCapabilityReadiness(key, entry) {
  const choices = $(key + "ModeChoices");
  const box = $(key + "Readiness");
  const message = $(key + "ReadinessMessage");
  const install = $(key === "video" ? "installVideo" : "installSpeech");
  const label = key === "video" ? "видео" : "распознавания речи";
  if (entry && entry.ok) {
    choices.hidden = false;
    box.hidden = true;
    return;
  }
  choices.hidden = true;
  box.hidden = false;
  if (!entry) {
    message.textContent = "Сначала проверьте готовность к " + label + ".";
    install.hidden = true;
  } else {
    message.textContent =
      "Не хватает зависимостей: " + entry.missing.join(", ") + ".";
    install.hidden = false;
  }
}
function paintDot(id, phase) {
  const dot = $(id);
  if (dot) dot.dataset.phase = phase;
}
function readinessPhase(entry) {
  if (!entry) return "stopped";
  return entry.ok ? "idle" : "error";
}
function drawReadiness() {
  drawCapabilityReadiness("video", savedReadiness.video);
  drawCapabilityReadiness("speech", savedReadiness.speech);
  paintDot("chipVideo", readinessPhase(savedReadiness.video));
  paintDot("chipSpeech", readinessPhase(savedReadiness.speech));
}
function refreshSpeechBuild() {
  const hint = $("speechModeHint");
  if (!hint) return;
  if (whisperBuild === "cuda")
    hint.textContent =
      "Установлен движок с CUDA. «Авто» использует видеокарту NVIDIA, «Процессор» работает на CPU.";
  else if (whisperBuild === "cpu")
    hint.textContent =
      "Установлен CPU-движок. Ускорение на видеокарте недоступно — используйте «Авто» или «Процессор».";
}
function setCapabilityReadiness(key, entry) {
  savedReadiness[key] = entry;
  if (key === "speech" && entry.build) {
    whisperBuild = entry.build;
    refreshSpeechBuild();
  }
  drawReadiness();
}
processingForm.onsubmit = event => {
  event.preventDefault();
  void action(async () => {
    const settings = await window.processor.processing(processingInput());
    fillProcessing(settings);
    $("processingNotice").textContent = "Сохранено. Параллельность обновлена; режимы и потоки применятся к новым заданиям.";
    $("processingNotice").hidden = false;
  });
};
$("openSettings").onclick = () => screen(true);
$("back").onclick = () => screen(false);
$("start").onclick = () => configured
  ? action(() => window.processor.start())
  : screen(true);
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
const stages = {
  WAITING_SOURCE: "Ожидаем доступ к исходному файлу", DOWNLOADING: "Скачивание исходного файла",
  TRANSCODING: "Обработка видео", TRANSCRIBING: "Распознавание речи",
  TRANSLATING: "Перевод", UPLOADING: "Загрузка результата",
  WAITING_UPLOAD: "Ожидаем разрешение на загрузку",
  WAITING_PUBLICATION: "Подтверждение результата",
};
function drawJobs(jobs = []) {
  const rows = jobs.map(job => {
    const row = document.createElement("tr");
    const name = document.createElement("td");
    const title = document.createElement("strong");
    title.textContent = ({ "media.transcode": "Обработка видео", "media.transcribe": "Распознавание речи", "media.subtitles": "Субтитры" })[job.type] || "Обработка медиа";
    const id = document.createElement("small"); id.textContent = job.id;
    name.append(title, id);
    const stage = document.createElement("td"); stage.textContent = stages[job.stage] || "Подготовка";
    if (job.stage === "TRANSCODING" && job.encoder) {
      const engine = document.createElement("small");
      engine.textContent = job.encoder === "h264_nvenc" ? "NVIDIA NVENC" : job.encoder === "copy" ? "Без перекодирования" : "Процессор";
      stage.append(engine);
    }
    const cell = document.createElement("td");
    if (job.stage === "DOWNLOADING" && job.download?.total > 0) {
      const bytes = document.createElement("small");
      bytes.textContent = (job.download.bytes / 1048576).toFixed(1) + " / " + (job.download.total / 1048576).toFixed(1) + " МБ";
      stage.append(bytes);
    }
    const wrap = document.createElement("div"); wrap.className = "job-progress";
    const bar = document.createElement("progress"); bar.max = 100;
    const label = document.createElement("span");
    if (job.stage === "WAITING_SOURCE") {
      label.textContent = "Ждём ссылку";
    } else if (job.stage === "DOWNLOADING" && job.download?.total > 0) {
      const percent = Math.min(100, Math.max(0, Math.floor(job.download.bytes / job.download.total * 100)));
      bar.value = percent; label.textContent = percent + "% скачано";
    } else if (typeof job.progress === "number" && Number.isFinite(job.progress)) {
      const percent = Math.min(99, Math.max(0, Math.floor(job.progress * 100)));
      bar.value = percent; label.textContent = percent + "%";
    } else label.textContent = "Подготовка…";
    bar.setAttribute("aria-label", "Прогресс задания " + job.id);
    wrap.append(bar, label); cell.append(wrap); row.append(name, stage, cell); return row;
  });
  $("jobsBody").replaceChildren(...rows);
  $("jobsEmpty").hidden = rows.length > 0;
}
function draw(status) {
  current = status;
  drawJobs(status.jobs);
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
  paintDot("chipSite", status.phase === "error" ? "error" : status.paused ? "stopped" : status.connected ? "idle" : status.phase === "connecting" ? "connecting" : "stopped");
  $("detail").textContent = status.message || "";
  $("workState").textContent = status.phase === "stopping"
    ? "Завершаем обработку"
    : status.running > 0
      ? (status.paused ? "Текущие задания завершаются · новые на паузе" : "Выполняем задания")
      : status.paused ? "Приём заданий на паузе"
      : status.connected ? "Ожидаем задания от сервера"
      : status.phase === "connecting" ? "Подключаемся к серверу"
      : "Обработчик не запущен";
  $("start").disabled = active || busy;
  $("start").textContent = configured ? "Подключиться" : "Настроить подключение";
  form
    .querySelectorAll("input,button")
    .forEach((input) => (input.disabled = active || busy));
  $("connect").disabled = active || busy;
  processingForm.querySelectorAll("input,button").forEach(input => input.disabled = busy);
  const audioGpu = processingForm.querySelector('input[name="audioMode"][value="gpu"]');
  if (audioGpu) audioGpu.disabled = busy || (whisperBuild && whisperBuild !== "cuda");
  processingForm.elements.workDir.disabled = active || busy;
  $("chooseDirectory").disabled = active || busy;

  $("pause").disabled = !active || busy;
  $("stop").disabled = !active || busy;
  $("pause").textContent = status.paused ? "Продолжить" : "Пауза";
}
async function action(callback, spinner) {
  if (busy) return;
  busy = true;
  if (spinner) spinner.hidden = false;
  notice("");
  draw(current);
  try {
    await callback();
  } catch (error) {
    notice(error.message);
  } finally {
    busy = false;
    if (spinner) spinner.hidden = true;
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
    if (chosen) processingForm.elements.workDir.value = chosen;
  });
$("checkVideo").onclick = () =>
  action(
    async () => setCapabilityReadiness("video", await window.processor.readiness("video")),
    $("videoSpinner"),
  );
$("installVideo").onclick = () =>
  action(
    async () => setCapabilityReadiness("video", await window.processor.install("video")),
    $("videoSpinner"),
  );
$("checkSpeech").onclick = () =>
  action(
    async () => setCapabilityReadiness("speech", await window.processor.readiness("speech")),
    $("speechSpinner"),
  );
$("installSpeech").onclick = () =>
  action(
    async () => setCapabilityReadiness("speech", await window.processor.install("speech")),
    $("speechSpinner"),
  );
form.onsubmit = (event) => {
  event.preventDefault();
  void action(async () => {
    const settings = await window.processor.save({
      server: form.elements.server.value,
      deviceId: form.elements.deviceId.value,
      token: form.elements.token.value,
      caPath,
      ...processingInput(),
    });
    form.elements.token.value = "";
    $("tokenHint").textContent =
      "Токен сохранён. Оставьте поле пустым, чтобы использовать его снова.";
    $("fingerprint").textContent = "Отпечаток CA: " + settings.fingerprint;
    $("fingerprint").hidden = false;
    configured = true;
    await window.processor.start();
    screen(false);
  });
};
$("pause").onclick = () =>
  action(() => window.processor.pause(!current.paused));
$("stop").onclick = () => action(() => window.processor.stop());
$("hide").onclick = () => action(() => window.processor.hide());
$("quit").onclick = () => action(() => window.processor.quit());
window.processor.onStatus(draw);
window.processor
  .state()
  .then(({ settings, status }) => {
    configured = !!settings.tokenSet;
    fillProcessing(settings);
    for (const name of ["server", "deviceId"])
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

const ciForm = $("ciSettings");
let ciBusy = false;
function ciInput() {
  const result = {};
  for (const key of ["repository", "distribution", "directory", "name"]) result[key] = ciForm.elements[key].value;
  result.enabled = ciForm.elements.enabled.checked;
  return result;
}
function ciFill(settings) {
  for (const key of ["repository", "distribution", "directory", "name"]) ciForm.elements[key].value = settings[key] || "";
  ciForm.elements.enabled.checked = settings.enabled;
}
function ciDraw(status) {
  const phase = ["idle", "busy", "error", "connecting", "stopped"].includes(status.phase) ? status.phase : "stopped";
  const label = { idle: "Принимает сборки", busy: "Идёт сборка", error: "Ошибка", connecting: "Подключение", stopped: "Не запущены" }[phase];
  const dot = $("ciStatus");
  dot.dataset.phase = phase;
  dot.setAttribute("aria-label", label);
  const text = $("ciStatusText");
  text.hidden = phase !== "error";
  text.textContent = phase === "error" ? (status.message || "Runner завершился с ошибкой.") : "";
  if (phase === "stopped" && status.message && status.message !== "Сборки остановлены." && !$("ciSetupNotice").textContent)
    $("ciSetupNotice").textContent = status.message;
  paintDot("chipCi", phase);
  paintDot("dashCiDot", phase);
  $("dashCiSummary").textContent = phase === "busy" && status.step ? status.step : label;
  $("dashCiLine").textContent = status.message || label;
  $("dashCiStop").disabled = phase === "stopped";
  if (phase === "busy") $("ciDash").open = true;
}
async function ciAction(notice, callback) {
  if (ciBusy) return;
  ciBusy = true;
  ciForm.querySelectorAll("button,input").forEach(input => input.disabled = true);
  notice.textContent = "Выполняем действие…";
  try { await callback(); }
  catch (error) { notice.textContent = error.message; }
  finally { ciBusy = false; ciForm.querySelectorAll("button,input").forEach(input => input.disabled = false); }
}
function ciReadiness(value) {
  $("ciSetupNotice").textContent = value.registered ? "Окружение готово, runner зарегистрирован." : value.installed ? "Runner установлен. Введите временный токен и зарегистрируйте его." : "Окружение готово. Можно установить runner.";
}
$("ciTab").onclick = () => {
  form.hidden = true;
  processingForm.hidden = true;
  $("startupCard").hidden = true;
  ciForm.hidden = false;
  $("connectionTab").setAttribute("aria-pressed", "false");
  $("processingTab").setAttribute("aria-pressed", "false");
  $("ciTab").setAttribute("aria-pressed", "true");
};
const ciSetupNotice = $("ciSetupNotice");
const ciNotice = $("ciNotice");
ciForm.onsubmit = event => { event.preventDefault(); void ciAction(ciNotice, async () => {
  const result = await window.processor.ciSave(ciInput()); ciFill(result.settings); ciDraw(result.status);
  ciNotice.textContent = "Настройки сборок сохранены.";
}); };
$("ciCheck").onclick = () => ciAction(ciSetupNotice, async () => ciReadiness(await window.processor.ciCheck(ciInput())));
$("ciInstall").onclick = () => ciAction(ciSetupNotice, async () => ciReadiness(await window.processor.ciInstall(ciInput())));
$("ciRegister").onclick = () => ciAction(ciSetupNotice, async () => {
  const token = ciForm.elements.registrationToken.value;
  ciForm.elements.registrationToken.value = "";
  ciReadiness(await window.processor.ciRegister(ciInput(), token));
});
$("ciStart").onclick = () => ciAction(ciNotice, async () => { ciDraw(await window.processor.ciStart()); ciNotice.textContent = "Запуск по сохранённым настройкам."; });
$("ciStop").onclick = () => ciAction(ciNotice, async () => { ciDraw(await window.processor.ciStop()); ciNotice.textContent = "Runner остановлен до следующего запуска."; });
$("dashCiStop").onclick = () => {
  if (ciBusy) return;
  ciBusy = true;
  $("dashCiStop").disabled = true;
  $("dashCiLine").textContent = "Останавливаем сборки…";
  window.processor.ciStop()
    .then(status => ciDraw(status))
    .catch(error => { $("dashCiLine").textContent = error.message; $("dashCiStop").disabled = false; })
    .finally(() => { ciBusy = false; });
};
window.processor.onCiStatus(ciDraw);
window.processor.ciState().then(({ settings, status }) => { ciFill(settings); ciDraw(status); }).catch(error => { $("ciNotice").textContent = error.message; });
