// API values are inserted as text; only the bundled SVG icon set uses HTML.
function node(tag, text, cls) {
  const n = document.createElement(tag);
  if (text != null) n.textContent = String(text);
  if (cls) n.className = cls;
  return n;
}
function badge(text, tone = "") {
  const n = node("span", null, "badge " + tone);
  n.append(node("span", null, "dot"), document.createTextNode(text));
  return n;
}
function empty(target, title, description, glyph = "box") {
  const n = node("div", null, "empty");
  const i = node("span");
  i.innerHTML = icon(glyph);
  n.append(i, node("strong", title), node("p", description));
  $(target).replaceChildren(n);
}
function table(target, headers, rows) {
  const wrapper = node("div", null, "table-scroll"),
    t = node("table"),
    head = node("thead"),
    hr = node("tr"),
    body = node("tbody");
  headers.forEach((h) => hr.append(node("th", h)));
  head.append(hr);
  rows.forEach((cells) => {
    const tr = node("tr");
    cells.forEach((value) => {
      const td = node("td");
      td.append(
        value instanceof Node
          ? value
          : document.createTextNode(
              value == null || value === "" ? "—" : String(value),
            ),
      );
      tr.append(td);
    });
    body.append(tr);
  });
  t.append(head, body);
  wrapper.append(t);
  $(target).replaceChildren(wrapper);
}
function titleCell(title, subtitle, glyph) {
  const n = node("div", null, "cell-title");
  if (glyph) {
    const i = node("span");
    i.dataset.icon = glyph;
    i.innerHTML = icon(glyph);
    n.append(i);
  }
  const text = node("div", title);
  if (subtitle) text.append(node("div", subtitle, "cell-meta"));
  n.append(text);
  return n;
}
function meter(value) {
  if (typeof value !== "number" || !Number.isFinite(value))
    return node("span", "—", "muted");
  const percent = Math.round(Math.max(0, Math.min(100, value))),
    n = node("div", null, "meter"),
    track = node("div", null, "meter-track"),
    fill = node("div", null, "meter-fill");
  fill.style.width = percent + "%";
  track.append(fill);
  n.append(track, node("span", percent + "%"));
  return n;
}
function date(value) {
  const d = new Date(value);
  return value && !Number.isNaN(d.valueOf())
    ? d.toLocaleString("ru-RU", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";
}
const statuses = {
  QUEUED: ["В очереди", "notice"],
  ACCEPTED: ["Принято", "info"],
  RUNNING: ["Обработка", "info"],
  AWAITING_PUBLICATION: ["Ожидает публикации", "notice"],
  ASSIGNED: ["Назначено", "info"],
  PUBLISHING: ["Публикация", "info"],
  SUCCEEDED: ["Готово", "good"],
  PARTIAL: ["Частично готово", "notice"],
  FAILED: ["Ошибка", "danger"],
  REJECTED: ["Отклонено", "danger"],
  CANCELLED: ["Отменено", ""],
  CANCELLING: ["Отмена", "notice"],
  RELEASING: ["Возврат", "notice"],
  RELEASED: ["Передано в резерв", ""],
};
const operations = {
  "media.transcode": "Обработка видео",
  "media.transcribe": "Распознавание речи",
  "media.subtitles": "Субтитры",
};
function renderJobs(target, jobs, hasSite) {
  if (!jobs.length)
    return empty(
      target,
      hasSite ? "Заданий пока нет" : "Сначала подключите сайт",
      hasSite
        ? "Здесь появятся задания выбранного сайта."
        : "Добавьте сайт в разделе «Сайты», чтобы отправлять задания.",
      "list",
    );
  table(
    target,
    ["Задание", "Статус", "Прогресс", "Обновлено", "Подробности"],
    jobs.map((j) => [
      titleCell(operations[j.type] || j.type, j.id, "file"),
      badge(...(statuses[j.status] || [j.status, ""])),
      meter(j.progress == null ? null : j.progress * 100),
      date(j.updatedAt),
      j.error ? errorDetails(j.error, j.id) : "—",
    ]),
  );
}
function renderDevices(target, devices) {
  if (!devices.length)
    return empty(
      target,
      "Нет подключённых устройств",
      "Добавьте Mac или Windows, чтобы выполнять обработку медиа.",
      "monitor",
    );
  const manage = target === "deviceList";
  table(
    target,
    [
      "Устройство",
      "Подключение",
      "CPU",
      "RAM",
      "Роль",
      ...(manage ? ["Действие"] : []),
    ],
    devices.map((d) => [
      titleCell(d.name, d.id, "monitor"),
      badge(
        !d.enabled ? "Отключено" : d.online ? "В сети" : "Не в сети",
        !d.enabled ? "" : d.online ? "good" : "",
      ),
      meter(d.online ? d.usage?.cpuPercent : null),
      meter(d.online ? d.usage?.memoryUsedPercent : null),
      d.priority > 0 ? "Основной" : "Помощник",
      ...(manage ? [deviceManageButton(d)] : []),
    ]),
  );
}
function deviceManageButton(device) {
  const button = node("button", "Управлять", "button quiet");
  button.type = "button";
  button.dataset.deviceSelect = device.id;
  button.setAttribute(
    "aria-label",
    "Управлять устройством «" + device.name + "»",
  );
  button.disabled = !!state.deviceActionId;
  button.addEventListener("click", () => selectDevice(device.id));
  return button;
}
const purposes = {
  RECOGNITION: "Распознавание речи",
  TRANSLATION: "Перевод",
};
function byteSize(bytes) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0)
    return "—";
  const gb = bytes / 1024 ** 3;
  return gb >= 1
    ? gb.toFixed(1).replace(".", ",") + " ГБ"
    : Math.round(bytes / 1024 ** 2) + " МБ";
}
// Every catalog entry is a file on huggingface.co; the repository page is the
// model card, which is what an operator needs in order to read about it.
function modelCard(model) {
  const source = model.downloadUrl || model.files?.[0]?.url;
  if (!source) return null;
  try {
    const parts = new URL(source).pathname.split("/").filter(Boolean);
    const cut = parts.indexOf("resolve");
    const repo = (cut > 0 ? parts.slice(0, cut) : parts.slice(0, 2)).join("/");
    return repo ? new URL("/" + repo, source).href : null;
  } catch {
    return null;
  }
}
// What the model asks of a device, in the operator's terms rather than the
// raw catalog fields.
function modelNeeds(model) {
  const parts = [byteSize(model.downloadBytes)];
  if (model.minimumRamBytes)
    parts.push("ОЗУ от " + byteSize(model.minimumRamBytes));
  if (model.purpose === "RECOGNITION" && model.recognitionLanguages?.length)
    parts.push(model.recognitionLanguages.length + " языков");
  // A pairwise model lists its few directions; a multilingual one holds
  // thousands, so it gets a count instead.
  const directions = model.translationDirections || [];
  if (model.purpose === "TRANSLATION" && directions.length)
    parts.push(
      directions.length <= 4
        ? directions.map((d) => d.source + " → " + d.target).join(", ")
        : directions.length + " направлений перевода",
    );
  return parts.join(" · ");
}
const placementStates = {
  ACTIVE: ["Активна", "good"],
  INSTALLED: ["Установлена", "info"],
};
function modelActionButton(label, tone, model, device, type, confirmText) {
  const button = node("button", label, "button " + tone);
  button.type = "button";
  button.disabled = !!state.modelActionKey;
  button.addEventListener("click", () =>
    sendModelCommand(model, device, type, confirmText),
  );
  return button;
}
function modelDeviceRow(model, device, placement) {
  const row = node("div", null, "model-device");
  const title = node("div", null, "model-device-name");
  title.append(
    node("span", device.name),
    node(
      "span",
      device.online ? "в сети" : "не в сети",
      "cell-meta" + (device.online ? "" : " muted"),
    ),
  );
  const status = placement
    ? badge(...placementStates[placement.state])
    : node("span", "Не установлена", "muted");
  const actions = node("div", null, "actions");
  if (!placement)
    actions.append(
      modelActionButton("Установить", "", model, device, "MODEL_INSTALL"),
    );
  else {
    if (placement.state !== "ACTIVE")
      actions.append(
        modelActionButton("Активировать", "", model, device, "MODEL_ACTIVATE"),
      );
    actions.append(
      modelActionButton(
        "Удалить",
        "danger",
        model,
        device,
        "MODEL_DELETE",
        "Удалить модель «" + model.id + "» с устройства «" + device.name + "»?",
      ),
    );
  }
  row.append(title, status, actions);
  return row;
}
// A device that has never connected reports no platform; it stays listed
// rather than being hidden on a guess.
function modelRuns(model, device) {
  if (device.os && model.os?.length && !model.os.includes(device.os))
    return false;
  return !(
    device.architecture &&
    model.architectures?.length &&
    !model.architectures.includes(device.architecture)
  );
}
function modelBlock(model, allPlacements, allDevices) {
  const devices = allDevices.filter((d) => modelRuns(model, d));
  const mine = allPlacements.filter(
    (p) => p.modelId === model.id && p.revision === model.revision,
  );
  const block = node("details", null, "model-block");
  if (state.openModels.has(model.id + "@" + model.revision)) block.open = true;
  block.addEventListener("toggle", () => {
    const key = model.id + "@" + model.revision;
    if (block.open) state.openModels.add(key);
    else state.openModels.delete(key);
  });
  const summary = node("summary", null, "model-summary");
  const heading = node("div", null, "model-heading");
  heading.append(
    titleCell(model.id, model.revision, "box"),
    node("span", purposes[model.purpose] || model.purpose, "cell-meta"),
    node("span", modelNeeds(model), "cell-meta"),
  );
  const active = mine.filter((p) => p.state === "ACTIVE").length;
  summary.append(
    heading,
    mine.length
      ? badge(
          active
            ? "Активна на " + active + " из " + devices.length
            : "Установлена на " + mine.length + " из " + devices.length,
          active ? "good" : "info",
        )
      : node("span", "Ни на одном устройстве", "muted"),
  );
  const body = node("div", null, "model-body");
  const card = modelCard(model);
  if (card) {
    const link = node("a", "Открыть карточку модели на huggingface.co");
    link.href = card;
    link.target = "_blank";
    link.rel = "noreferrer noopener";
    body.append(link);
  }
  if (!devices.length)
    body.append(
      node(
        "p",
        allDevices.length
          ? "Ни одно устройство не подходит этой модели по системе или архитектуре."
          : "Подключите устройство, чтобы устанавливать модели.",
        "muted",
      ),
    );
  devices.forEach((d) =>
    body.append(
      modelDeviceRow(
        model,
        d,
        mine.find((p) => p.deviceId === d.id),
      ),
    ),
  );
  block.append(summary, body);
  return block;
}
function renderModels(target, models, placements, devices) {
  if (!models.length)
    return empty(
      target,
      "Нет доступных моделей",
      "Каталог появится после настройки моделей на диспетчере.",
    );
  const list = node("div", null, "model-list");
  models.forEach((m) => list.append(modelBlock(m, placements, devices)));
  $(target).replaceChildren(list);
}
function details(target, pairs) {
  const list = node("div", null, "detail-list");
  pairs.forEach(([label, value]) => {
    const item = node("div");
    item.append(
      node("p", label, "detail-label"),
      node("p", value ?? "—", "detail-value"),
    );
    list.append(item);
  });
  $(target).replaceChildren(list);
}
function renderOps(data) {
  state.ops = data;
  details("ops", [
    ["Режим", data.maintenance ? "Выдача заданий приостановлена" : "Выдача заданий включена"],
    ["В очереди", data.queued],
    ["Назначается", data.offered],
    ["В работе", data.running],
    ["Готовность к обновлению", data.updateReady ? "Готов" : "Не подготовлен"],
  ]);
  $("stat-queued").textContent = data.queued ?? "—";
  $("stat-running").textContent = data.running ?? "—";
  $("opsMaintenanceOn").disabled = !!data.maintenance;
  $("opsMaintenanceOff").disabled = !data.maintenance;
}

const auditLabels = {
 CATALOG_IMPORTED:"Каталог моделей обновлён", COMMAND_ENQUEUED:"Команда отправлена устройству",
 OWNER_BOOTSTRAP:"Создан аккаунт владельца", OWNER_PASSWORD_RESET:"Пароль владельца сброшен", ADMIN_LOGIN:"Вход в панель",
 SITE_CREATED:"Сайт добавлен", SITE_DELETED:"Сайт удалён", DEVICE_CREATED:"Устройство добавлено", DEVICE_DELETED:"Устройство удалено",
 TOKEN_ISSUED:"Выдан токен подключения", TOKEN_REVOKED:"Токен подключения отозван", RESTORE_SEALED:"Завершено восстановление из копии",
 JOB_QUEUED:"Задание добавлено в очередь", JOB_ASSIGNED:"Задание назначено устройству", JOB_RUNNING:"Началась обработка",
 JOB_AWAITING_PUBLICATION:"Результат загружен, ожидает публикации", PUBLICATION_CLAIMED:"Сайт начал публикацию",
 JOB_SUCCEEDED:"Задание завершено", JOB_PARTIAL:"Задание завершено частично", JOB_FAILED:"Ошибка обработки",
 JOB_REJECTED:"Задание отклонено", JOB_CANCELLED:"Задание отменено", JOB_CANCELLING:"Запрошена отмена задания",
 JOB_RELEASED:"Задание передано в резерв", JOB_RELEASING:"Запрошен возврат задания",
 DEVICE_CONNECTED:"Устройство подключилось", DEVICE_UPDATED:"Настройки устройства изменены",
 SITE_UPDATED:"Настройки сайта изменены", SITE_CANCEL_ALL:"Запрошена отмена заданий сайта",
 ACCOUNT_CREATED:"Аккаунт создан", ACCOUNT_UPDATED:"Аккаунт изменён",
 TRANSFER_SOURCE:"Устройство запросило исходный файл", ARTIFACT_PROPOSED:"Результат подготовлен",
 MAINTENANCE_ON:"Выдача заданий приостановлена", MAINTENANCE_OFF:"Выдача заданий возобновлена",
 BACKUP:"Создана резервная копия", LOGIN:"Вход в панель", LOGOUT:"Выход из панели",
};
const jobErrorLabels = {
 SOURCE_GRANT_TIMEOUT:"Сайт не выдал ссылку на исходный файл. Проверьте доступность и разрешённый адрес хранилища.",
 UPLOAD_GRANT_TIMEOUT:"Сайт не выдал разрешение на загрузку результата.",
 WAIT_TIMEOUT:"Обработчик не получил ответ за отведённое время.",
 INVALID_REQUEST:"Параметры задания не прошли проверку сервиса.",
 SOURCE_DOWNLOAD_FAILED:"Не удалось скачать исходный файл.", UPLOAD_FAILED:"Не удалось загрузить результат в хранилище.",
 GPU_UNAVAILABLE:"Аппаратное ускорение недоступно. Проверьте выбранный режим и установленный движок.",
 FFMPEG_FAILED:"Ошибка кодирования видео.", PLAYLIST_INVALID:"Результат содержит некорректный список видеофайлов.",
 LEASE_EXPIRED:"Истекло время разрешения на выполнение задания.",
};
function errorDetails(error, jobId) {
 const details = node("details", "", "error-details");
 details.append(node("summary", "Подробнее"));
 details.append(node("p", error ? (jobErrorLabels[error.code] || "Задание завершилось с ошибкой.") : "Подробности этой ошибки не сохранились."));
 if(error?.code) details.append(node("code", "Код: " + error.code));
 if(error?.message) details.append(node("p", error.message));
 if(jobId) details.append(node("code", "Задание: " + jobId));
 return details;
}
function renderAudit(items) {
 if(!items.length) return empty("audit", "События не найдены", "Измените фильтры или период.", "file");
 table("audit",["Время","Действие","Участник","Задание","Подробности"],items.map(a=>{
   const failure=/FAILED|ERROR|REJECTED/.test(a.kind);
   const job=node("div", "", "audit-job");
   if(a.jobId){job.append(node("span",a.jobId,"code"));const history=node("button","История","button quiet");history.type="button";history.onclick=()=>{$("auditFilters").reset();$("auditJob").value=a.jobId;void loadAudit("reset")};job.append(history)}else job.textContent="—";
   return [date(a.at),badge(auditLabels[a.kind] || "Событие диспетчера", failure?"danger":""),titleCell(a.principalName || a.principalId,a.principalName?a.principalId:null),job,failure?errorDetails(a.error,a.jobId):"—"];
 }));
}
