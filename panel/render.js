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
    ["Задание", "Статус", "Прогресс", "Обновлено"],
    jobs.map((j) => [
      titleCell(operations[j.type] || j.type, j.id, "file"),
      badge(...(statuses[j.status] || [j.status, ""])),
      meter(j.progress == null ? null : j.progress * 100),
      date(j.updatedAt),
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
