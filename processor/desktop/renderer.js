const $ = (id) => document.getElementById(id),
  form = $("settings"),
  processingForm = $("processingSettings");
let current = { phase: "stopped", running: 0, connected: false, paused: false },
  caPath = "",
  busy = false;
let autostart = { supported: false, enabled: false, configured: false };
let launch = { autoConnect: false, ciAutoStart: true };
let pendingAutostart;
let pendingLaunch = {};
let configured = false;
let savedReadiness = {};
let whisperBuild = undefined;
// Three screens now, so the switch names one instead of toggling a flag.
function screen(name) {
  const which = name === true ? "settings" : name === false ? "dashboard" : name;
  $("dashboard").hidden = which !== "dashboard";
  $("settingsScreen").hidden = which !== "settings";
  $("modelsScreen").hidden = which !== "models";
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
    workDir: processingForm.elements.workDir.value,
    modelTasks: chosenTasks() };
}
function fillProcessing(settings) {
  for (const name of ["workDir", "maxParallel", "cpuThreads", "videoMode", "audioMode"])
    if (settings[name] != null) processingForm.elements[name].value = settings[name];
  if (Array.isArray(settings.modelTasks)) {
    $("taskSpeech").checked = settings.modelTasks.includes("speech");
    $("taskSubs").checked = settings.modelTasks.includes("subs");
    $("taskGeneration").checked = settings.modelTasks.includes("generation");
  }
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
  drawGenerationReadiness();
}
function drawGenerationReadiness() {
  const entry = savedReadiness.generation;
  const progress = current.generationInstall;
  const installing = progress && ["downloading", "extracting", "checking"].includes(progress.phase);
  $("generationEngineStatus").textContent = installing
    ? ({ downloading: "Скачиваем движок — " + Math.round((progress.progress || 0) * 100) + "%", extracting: "Распаковываем движок…", checking: "Проверяем запуск движка…" })[progress.phase]
    : entry?.message || "Проверьте готовность движка.";
  $("installGeneration").hidden = !entry || entry.ok || entry.supported === false;
  $("installGeneration").disabled = busy || installing || current.phase === "connected" || current.phase === "connecting" || current.phase === "stopping";
  $("installGeneration").title = $("installGeneration").disabled && !installing ? "Перед установкой остановите обработчик." : "";
  $("checkGeneration").disabled = busy || installing;
  $("generationSpinner").hidden = !installing;
  $("generationEngineHint").textContent = entry
    ? [entry.label, entry.version, entry.downloadBytes ? "Загрузка движка: " + bytes(entry.downloadBytes) : ""].filter(Boolean).join(" · ") + ". После установки движка потребуется модель; запуск генерации заданий ещё не реализован."
    : "Движок выбирается для Windows/NVIDIA или Apple Silicon/Metal. Модели устанавливаются отдельно.";
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
$("openSettings").onclick = () => screen("settings");
$("back").onclick = () => screen("dashboard");
$("openModels").onclick = () => screen("models");
$("modelsBack").onclick = () => screen("dashboard");
function persistModelTasks() {
  drawModels(current.models);
  void window.processor
    .processing(processingInput())
    .catch((error) => notice(error.message));
}
$("taskSpeech").onchange = persistModelTasks;
$("taskSubs").onchange = persistModelTasks;
$("taskGeneration").onchange = persistModelTasks;
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
function drawLaunch(value) {
  if (value) launch = value;
  for (const key of ["autoConnect", "ciAutoStart"]) {
    $(key).checked = pendingLaunch[key] ?? launch[key];
    $(key).disabled = busy;
  }
  $("autoConnect").disabled = busy || !autostart.configured;
  $("autoConnectHint").textContent = pendingLaunch.autoConnect !== undefined
    ? "Сохраняем настройку…"
    : !autostart.configured
      ? "Сначала сохраните подключение."
      : launch.autoConnect
        ? "Включено. Worker подключается к серверу сразу после открытия."
        : "Выключено. Подключение запускается кнопкой «Подключиться».";
  $("ciAutoStartHint").textContent = pendingLaunch.ciAutoStart !== undefined
    ? "Сохраняем настройку…"
    : launch.ciAutoStart
      ? "Включено. Runner разрешённых репозиториев стартует вместе с Worker."
      : "Выключено. Сборки запускаются вручную на вкладке «Сборки GitHub».";
}
function changeLaunch(key) {
  pendingLaunch[key] = $(key).checked;
  void action(async () => {
    try {
      drawLaunch((await window.processor.launch({ [key]: pendingLaunch[key] })).launch);
    } finally {
      delete pendingLaunch[key];
    }
  });
}
$("autoConnect").onchange = () => changeLaunch("autoConnect");
$("ciAutoStart").onchange = () => changeLaunch("ciAutoStart");
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
  drawLaunch(status.launch);
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
  drawModels(status.models);
  drawGenerationReadiness();
  warnAboutModels(status.models);
}

// Without an active recognition model the server simply never sends speech or
// subtitle work here, and nothing on this screen would say why.
function warnAboutModels(view) {
  const warn = $("modelsWarn");
  if (!view) {
    warn.hidden = true;
    return;
  }
  const active = (purpose) =>
    view.installed.some((m) => m.state === "ACTIVE" && m.purpose === purpose);
  const missing = [];
  if (!active("RECOGNITION")) missing.push("распознавание речи");
  if (!active("TRANSLATION")) missing.push("перевод");
  warn.hidden = missing.length === 0;
  warn.textContent = missing.length
    ? "Сервер не пришлёт сюда " + missing.join(" и ") +
      ": нет рабочей модели. Откройте «Модели»."
    : "";
}

// ---- Модели -------------------------------------------------------------
// The site decides what may be installed; this screen decides nothing, it only
// shows what the worker reported and asks it to act.
const modelGroups = [
  { purpose: "GENERATION", title: "Генерация изображений", tasks: ["generation"], hint: "Выберите по ресурсам компьютера. Доступна загрузка; запуск генерации появится отдельно." },
  { purpose: "RECOGNITION", title: "Распознавание речи", tasks: ["speech", "subs"],
    hint: "Нужна одна. Выберите, какой работать." },
  { purpose: "TRANSLATION", title: "Перевод", tasks: ["subs"],
    hint: "Нужна одна. Без неё субтитры не соберутся." },
];
function bytes(n) {
  if (!Number.isFinite(n) || n <= 0) return "—";
  const gb = n / 1024 ** 3;
  return gb >= 1
    ? gb.toFixed(1).replace(".", ",") + " ГБ"
    : Math.round(n / 1024 ** 2) + " МБ";
}
function memoryRatio(total, free) {
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(free)) return "—";
  const used = Math.max(0, total - free);
  return (used / 1024 ** 3).toFixed(1).replace(".", ",") + "/" + (total / 1024 ** 3).toFixed(1).replace(".", ",") + " ГБ";
}
function chosenTasks() {
  const out = [];
  if ($("taskSpeech").checked) out.push("speech");
  if ($("taskSubs").checked) out.push("subs");
  if ($("taskGeneration").checked) out.push("generation");
  return out;
}
function modelRow(entry, view, group) {
  const installed = view.installed.find(
    (m) => m.id === entry.id && m.revision === entry.revision,
  );
  const active = installed?.state === "ACTIVE";
  const compatibility = ModelCompatibility.assess(entry, view.environment);
  const fits = compatibility.level !== "no";
  const generation = entry.purpose === "GENERATION";
  const diskFits = view.environment.diskReady && view.environment.freeDiskBytes >= entry.downloadBytes + 8 * 1024 ** 2;
  const fetching =
    view.fetching &&
    view.fetching.id === entry.id &&
    view.fetching.revision === entry.revision;

  const row = document.createElement("div");
  row.className = "model-row" + (active ? " chosen" : "");

  if (group && !generation) {
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "use-" + group.purpose;
    radio.checked = active;
    radio.disabled = generation || !installed || !fits || busy;
    radio.setAttribute("aria-label", "Работать моделью " + entry.id);
    radio.onclick = () =>
      action(() => window.processor.model("activate", entry.id, entry.revision));
    row.append(radio);
  } else row.append(document.createElement("span"));

  const who = document.createElement("div");
  who.className = "who";
  const name = document.createElement("span");
  name.className = "nm";
  name.textContent = entry.id;
  const meta = document.createElement("span");
  meta.className = "meta";
  meta.textContent = generation
    ? "Загрузка " + bytes(entry.downloadBytes) + " · " + (entry.executor === "stable-diffusion.cpp" ? "Q4 · предложенная модель" : "полный пакет")
    : bytes(entry.downloadBytes) +
    (entry.memoryRequirementsVerified === false ? " · ориентир RAM " : " · ОЗУ от ") + bytes(entry.minimumRamBytes) +
    (entry.minimumVramBytes ? " · VRAM от " + bytes(entry.minimumVramBytes) : "") +
    " · версия " + entry.revision;
  meta.title = "Ревизия: " + entry.revision;
  who.append(name, meta);
  const info = document.createElement("span");
  info.className = "meta";
  info.textContent = [({ SMALL: "Лёгкая", MEDIUM: "Средняя", LARGE: "Тяжёлая" })[entry.sizeTier], entry.description].filter(Boolean).join(" · ");
  const fit = document.createElement("span");
  fit.className = "meta";
  fit.textContent = compatibility.label + ": " + compatibility.reason;
  who.append(info, fit);
  if (generation) {
    const runtime = document.createElement("span"); runtime.className = "meta";
    runtime.textContent = "В комплект входят веса, текстовый кодировщик и VAE. Можно установить; генерация ещё не проверена.";
    who.append(runtime);
  }
  if (!fits) {
    const stop = document.createElement("span");
    stop.className = "meta";
    stop.textContent =
      "Не хватит ОЗУ: нужно " + bytes(entry.minimumRamBytes) +
      ", на этом компьютере " + bytes(view.environment.memoryBytes);
    who.append(stop);
  }
  row.append(who);

  const side = document.createElement("div");
  side.className = "side";
  const tag = document.createElement("span");
  tag.className = "model-tag";
  if (fetching) tag.textContent = "Скачивается";
  else if (!fits) { tag.className += " no"; tag.textContent = "Не встанет"; }
  else if (active) { tag.className += " ok"; tag.textContent = "Работает"; }
  else if (installed) { tag.className += " ok"; tag.textContent = "Установлена"; }
  else tag.textContent = "Не установлена";
  side.append(tag);

  if (!installed && fits && !fetching) {
    const install = document.createElement("button");
    install.type = "button";
    install.textContent = "Установить — " + bytes(entry.downloadBytes);
    install.disabled = busy || !!view.fetching || !diskFits;
    if (!diskFits) install.title = "Недостаточно места в рабочей папке или папка недоступна.";
    install.onclick = () =>
      action(() => window.processor.model("install", entry.id, entry.revision));
    side.append(install);
  }
  if (installed) {
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Удалить";
    remove.disabled = busy;
    remove.onclick = () =>
      action(() => window.processor.model("delete", entry.id, entry.revision));
    side.append(remove);
  }
  row.append(side);

  if (fetching) {
    const bar = document.createElement("div");
    bar.className = "model-bar";
    const fill = document.createElement("i");
    fill.style.width = Math.round((view.fetching.progress || 0) * 100) + "%";
    bar.append(fill);
    row.append(bar);
  }
  return row;
}
function drawModels(view) {
  const host = $("modelGroups");
  const done = $("modelsInstalled");
  if (!view) {
    $("envGrid").replaceChildren();
    $("envHint").hidden = false;
    host.replaceChildren();
    done.replaceChildren();
    $("modelPlan").textContent = "";
    return;
  }
  $("envHint").hidden = true;
  const env = view.environment;
  $("envGrid").replaceChildren();
  [["Система", [env.os, env.architecture].filter(Boolean).join(" · ") || "—"],
   ["Видеокарта", env.gpuName || "Не определена"],
   ["Ускорение GPU", ({ cuda: "CUDA", metal: "Metal", unknown: "Не проверено", cpu: "CPU" })[env.accelerator] || "Не проверено"],
   ["VRAM", env.accelerator === "metal" ? "Общая с RAM" : memoryRatio(env.vramTotalBytes, env.freeVramBytes)],
   ["RAM", memoryRatio(env.memoryBytes, env.freeMemoryBytes)],
   ["Ядер процессора", String(env.cpuCores)],
   ["Свободно в рабочей папке", env.diskReady ? bytes(env.freeDiskBytes) : "папка недоступна"],
   ["Рабочая папка", env.workDir || "—"],
  ].forEach(([k, v]) => {
    const cell = document.createElement("div");
    const key = document.createElement("span");
    key.className = "k";
    key.textContent = k;
    const val = document.createElement("span");
    val.className = "v";
    val.textContent = v;
    cell.append(key, val);
    $("envGrid").append(cell);
  });

  const tasks = chosenTasks();
  host.replaceChildren();
  let shown = 0;
  modelGroups
    .filter((g) => g.tasks.some((task) => tasks.includes(task)))
    .forEach((g) => {
      const entries = view.catalog.filter((m) => m.purpose === g.purpose).sort((a, b) =>
        Number(b.executor === "stable-diffusion.cpp") - Number(a.executor === "stable-diffusion.cpp") || a.downloadBytes - b.downloadBytes);
      const box = document.createElement("div");
      box.className = "model-group";
      const title = document.createElement("h3");
      title.textContent = g.title;
      const hint = document.createElement("p");
      hint.className = "hint";
      hint.textContent = entries.length
        ? g.hint
        : "Сервер не прислал ни одной подходящей модели. Добавьте её в каталог на сайте.";
      box.append(title, hint);
      entries.forEach((m) => box.append(modelRow(m, view, g)));
      shown += entries.length;
      host.append(box);
    });
  if (!tasks.length) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "Отметьте задачу выше, чтобы увидеть подходящие модели.";
    host.append(empty);
  }

  done.replaceChildren();
  if (!view.installed.length) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "Пока ничего не установлено.";
    done.append(empty);
  } else
    view.installed.forEach((m) => {
      const entry =
        view.catalog.find((c) => c.id === m.id && c.revision === m.revision) || {
          id: m.id, revision: m.revision, downloadBytes: 0,
          minimumRamBytes: m.minimumRamBytes, purpose: m.purpose,
        };
      done.append(modelRow(entry, view, null));
    });

  const missing = view.catalog.filter(
    (m) =>
      shown &&
      !view.installed.some((i) => i.id === m.id && i.revision === m.revision),
  );
  $("modelPlan").textContent = view.error || (view.fetching
    ? "Скачиваем «" + view.fetching.id + "» — " +
      Math.round((view.fetching.progress || 0) * 100) + "%"
    : missing.length
      ? "Не установлено моделей: " + missing.length +
        ". Модели генерации можно скачать заранее. Модели речи после установки выберите рабочими."
      : "");
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
$("checkGeneration").onclick = () => action(async () => setCapabilityReadiness("generation", await window.processor.readiness("generation")));
$("installGeneration").onclick = () => action(async () => setCapabilityReadiness("generation", await window.processor.install("generation")));
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
    if (settings.launch) launch = settings.launch;
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
    void window.processor.readiness("generation").then(entry => setCapabilityReadiness("generation", entry)).catch(error => notice(error.message));
    // Auto-check readiness if it was never run, so the install button is visible.
    if (!savedReadiness.video) {
      void action(
        async () => setCapabilityReadiness("video", await window.processor.readiness("video")),
        $("videoSpinner"),
      );
    }
    if (!savedReadiness.speech) {
      void action(
        async () => setCapabilityReadiness("speech", await window.processor.readiness("speech")),
        $("speechSpinner"),
      );
    }
  })
  .catch((error) => notice(error.message));

const ciForm = $("ciSettings");
const ciList = $("ciList");
const ciTemplate = $("ciEntryTemplate");
const ciNotice = $("ciNotice");
let ciRepos = [];
let ciBusy = false;
function ciEntryInput(root) {
  const result = { id: root.dataset.id };
  for (const key of ["repository", "distribution", "directory", "name"]) result[key] = root.querySelector(`[name="${key}"]`).value;
  result.enabled = $("ciEnabled").checked;
  return result;
}
function ciPhase(status) {
  return ["idle", "busy", "error", "connecting", "stopped"].includes(status?.phase) ? status.phase : "stopped";
}
function ciEntryTitle(root) {
  return root.querySelector('[name="name"]').value || root.querySelector('[name="repository"]').value || "Новый репозиторий";
}
function ciEntryDraw(root, status) {
  const phase = ciPhase(status);
  root.querySelector(".ci-dot").setAttribute("data-phase", phase);
  root.querySelector(".ci-entry-title").textContent = ciEntryTitle(root);
  root.querySelector(".ci-entry-status").textContent = status?.message || ({ stopped: "Сборки остановлены.", connecting: "Подключение к GitHub…", idle: "Готов принимать сборки.", busy: "Выполняется сборка.", error: "Ошибка runner." })[phase] || "Состояние неизвестно.";
}
function ciRepoLine(repo) {
  const phase = ciPhase(repo.status);
  const status = repo.status || {};
  const name = repo.repository || repo.name || "Репозиторий";
  if (phase === "busy") return { phase, name, text: status.step || status.job || "Идёт сборка" };
  const text = { idle: "Ждёт задание", connecting: "Подключение", stopped: "Не запущен", error: status.message || "Ошибка" }[phase] || "Не запущен";
  return { phase, name, text };
}
function ciDrawDashboard() {
  const phases = ciRepos.map(repo => ciPhase(repo.status));
  let phase = "stopped";
  if (phases.includes("busy")) phase = "busy";
  else if (phases.includes("error")) phase = "error";
  else if (phases.includes("connecting")) phase = "connecting";
  else if (phases.includes("idle")) phase = "idle";
  const label = { idle: "Ждут задания", busy: "Идёт сборка", error: "Ошибка", connecting: "Подключение", stopped: "Не запущены" }[phase];
  paintDot("chipCi", phase);
  paintDot("dashCiDot", phase);
  const busyNames = ciRepos.filter(repo => ciPhase(repo.status) === "busy").map(repo => repo.repository || repo.name);
  $("dashCiSummary").textContent = busyNames.length ? busyNames.join(", ") : label;
  const rows = $("dashCiRows");
  rows.replaceChildren(...ciRepos.map(repo => {
    const line = ciRepoLine(repo);
    const row = document.createElement("div");
    row.className = "ci-dash-row";
    const dot = document.createElement("span");
    dot.className = "ci-dot";
    dot.dataset.phase = line.phase;
    const title = document.createElement("b");
    title.textContent = line.name;
    const detail = document.createElement("span");
    detail.textContent = line.text;
    row.append(dot, title, detail);
    return row;
  }));
  const active = ciRepos.filter(repo => ["idle", "busy", "connecting"].includes(ciPhase(repo.status))).length;
  $("dashCiStop").disabled = active === 0;
  // A failed autostart must be readable without unfolding the card.
  const failed = ciRepos.find(repo => ciPhase(repo.status) === "error");
  $("dashCiLine").textContent = failed ? (failed.repository || failed.name) + ": " + (failed.status.message || "Ошибка runner.") : "";
  if (phase === "busy" || phase === "error") $("ciDash").open = true;
}
function ciRootFor(id) { return ciList.querySelector(`.ci-entry[data-id="${id}"]`); }
function renderCiList() {
  ciList.replaceChildren();
  for (const repo of ciRepos) {
    const node = ciTemplate.content.firstElementChild.cloneNode(true);
    node.dataset.id = repo.id;
    for (const key of ["repository", "distribution", "directory", "name"]) node.querySelector(`[name="${key}"]`).value = repo[key] || "";
    node.open = true;
    ciEntryDraw(node, repo.status);
    ciList.appendChild(node);
  }
  ciDrawDashboard();
}
async function ciAction(notice, callback) {
  if (ciBusy) return;
  ciBusy = true;
  ciList.querySelectorAll("button,input").forEach(input => input.disabled = true);
  $("ciAdd").disabled = true;
  $("ciEnabled").disabled = true;
  notice.textContent = "Выполняем действие…";
  try { await callback(); }
  catch (error) { notice.textContent = error.message; }
  finally { ciBusy = false; ciList.querySelectorAll("button,input").forEach(input => input.disabled = false); $("ciAdd").disabled = false; $("ciEnabled").disabled = false; }
}
function ciCollect() {
  return ciRepos.map(repo => ciEntryInput(ciRootFor(repo.id)));
}
function ciReadinessNotice(root, value) {
  root.querySelector(".ci-entry-notice").textContent = value.registered ? "Окружение готово, runner зарегистрирован." : value.installed ? "Runner установлен. Введите токен и зарегистрируйте." : "Окружение готово. Можно установить runner.";
}
// A status push can be missed while the page is still loading: pull the live state as well,
// otherwise running builds keep showing as stopped.
async function ciSync() {
  if (ciBusy) return;
  const { repos } = await window.processor.ciState();
  if (ciBusy) return;
  const known = new Set(ciRepos.map(repo => repo.id));
  if (repos.some(repo => !known.has(repo.id))) {
    ciRepos = repos;
    renderCiList();
    return;
  }
  for (const repo of repos) {
    const local = ciRepos.find(item => item.id === repo.id);
    if (!local) continue;
    local.status = repo.status;
    local.enabled = repo.enabled;
    const root = ciRootFor(repo.id);
    if (root) ciEntryDraw(root, repo.status);
  }
  ciDrawDashboard();
}
$("ciTab").onclick = () => {
  void ciSync().catch(() => {});
  form.hidden = true;
  processingForm.hidden = true;
  $("startupCard").hidden = true;
  ciForm.hidden = false;
  $("connectionTab").setAttribute("aria-pressed", "false");
  $("processingTab").setAttribute("aria-pressed", "false");
  $("ciTab").setAttribute("aria-pressed", "true");
};
$("ciAdd").onclick = () => {
  const id = "repo-" + Math.random().toString(36).slice(2, 8);
  ciRepos.push({ id, repository: "", distribution: "Worker-CI", directory: "", name: "", enabled: true, status: { phase: "stopped", connected: false, busy: false } });
  renderCiList();
  const node = ciRootFor(id);
  if (node) { node.open = true; node.querySelector('[name="repository"]').focus(); }
};
ciList.addEventListener("click", event => {
  const root = event.target.closest(".ci-entry");
  if (!root) return;
  const btn = event.target.closest("button");
  if (!btn) return;
  const id = root.dataset.id;
  const entry = () => ciEntryInput(root);
  const notice = root.querySelector(".ci-entry-notice");
  if (btn.classList.contains("ci-check")) return ciAction(notice, async () => ciReadinessNotice(root, await window.processor.ciCheck(entry())));
  if (btn.classList.contains("ci-install")) return ciAction(notice, async () => ciReadinessNotice(root, await window.processor.ciInstall(entry())));
  if (btn.classList.contains("ci-register")) return ciAction(notice, async () => {
    const token = root.querySelector('[name="registrationToken"]').value;
    root.querySelector('[name="registrationToken"]').value = "";
    ciReadinessNotice(root, await window.processor.ciRegister(entry(), token));
  });
  if (btn.classList.contains("ci-save")) return ciAction(ciNotice, async () => {
    const result = await window.processor.ciSave(ciCollect());
    ciRepos = result.repos;
    renderCiList();
    ciNotice.textContent = "Настройки сборок сохранены.";
  });
  if (btn.classList.contains("ci-start")) return ciAction(ciNotice, async () => { await window.processor.ciStart(id); });
  if (btn.classList.contains("ci-stop")) return ciAction(ciNotice, async () => { await window.processor.ciStop(id); });
  if (btn.classList.contains("ci-remove")) {
    if (ciBusy) return;
    ciRepos = ciRepos.filter(item => item.id !== id);
    renderCiList();
  }
});
$("dashCiStop").onclick = () => {
  if (ciBusy) return;
  ciBusy = true;
  $("dashCiStop").disabled = true;
  $("dashCiLine").textContent = "Останавливаем сборки…";
  Promise.all(ciRepos.map(repo => window.processor.ciStop(repo.id)))
    .then(() => { $("dashCiLine").textContent = "Сборки остановлены."; })
    .catch(error => { $("dashCiLine").textContent = error.message; })
    .finally(() => { ciBusy = false; });
};
window.processor.onCiStatus(payload => {
  const repo = ciRepos.find(item => item.id === payload.key);
  if (!repo) return;
  repo.status = payload.status;
  const root = ciRootFor(payload.key);
  if (root) ciEntryDraw(root, payload.status);
  ciDrawDashboard();
});
window.processor.ciState().then(({ repos }) => { ciRepos = repos; $("ciEnabled").checked = repos.some(repo => repo.enabled !== false); renderCiList(); }).catch(error => { ciNotice.textContent = error.message; });
setInterval(() => void ciSync().catch(() => {}), 5000);
