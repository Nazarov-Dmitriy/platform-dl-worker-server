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
function renderModels(target, models) {
  if (!models.length)
    return empty(
      target,
      "Нет доступных моделей",
      "Каталог появится после настройки моделей на диспетчере.",
    );
  table(
    target,
    ["Модель", "Версия", "Назначение"],
    models.map((m) => [
      titleCell(m.id, null, "box"),
      m.revision,
      operations[m.purpose] || m.purpose,
    ]),
  );
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
