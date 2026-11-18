const ERRORS_TZ = "Europe/Moscow";
const errorsState = {
  area: "sites",
  siteId: "",
  source: "",
  period: "today",
  customDraft: { from: "", to: "" },
  extra: { status: "", favorite: "", code: "", module: "", release: "", severity: "", q: "" },
  limit: 25,
  cursor: "",
  prev: [],
  next: null,
  loading: false,
  version: 0,
  page: null,
  open: new Set(),
  cards: {},
};

function errorsZonedParts(date, tz) {
  const map = {};
  new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  })
    .formatToParts(date)
    .forEach((p) => {
      if (p.type !== "literal") map[p.type] = p.value;
    });
  return {
    y: Number(map.year),
    m: Number(map.month),
    d: Number(map.day),
    h: Number(map.hour),
    min: Number(map.minute),
    s: Number(map.second),
  };
}

function errorsZonedDate(y, m, d, h, min, s, tz) {
  let guess = Date.UTC(y, m - 1, d, h, min, s);
  for (let i = 0; i < 4; i++) {
    const p = errorsZonedParts(new Date(guess), tz);
    const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s);
    const wanted = Date.UTC(y, m - 1, d, h, min, s);
    const delta = wanted - asUtc;
    if (!delta) break;
    guess += delta;
  }
  return new Date(guess);
}

function errorsAddDays(y, m, d, delta) {
  const dt = new Date(Date.UTC(y, m - 1, d + delta));
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

function errorsFormatDay(y, m, d) {
  return String(d).padStart(2, "0") + "." + String(m).padStart(2, "0") + "." + y;
}

function errorsAppliedRange(now) {
  const wall = errorsZonedParts(now, ERRORS_TZ);
  const today = { y: wall.y, m: wall.m, d: wall.d };
  if (errorsState.period === "all") return { from: null, to: null, label: "Все сохранившиеся данные · " + ERRORS_TZ + " · TTL и выбранные примеры" };
  let startDay = today;
  let endDay = errorsAddDays(today.y, today.m, today.d, 1);
  let title = "Сегодня";
  if (errorsState.period === "yesterday") {
    startDay = errorsAddDays(today.y, today.m, today.d, -1);
    endDay = today;
    title = "Вчера";
  } else if (errorsState.period === "week") {
    startDay = errorsAddDays(today.y, today.m, today.d, -6);
    title = "За неделю";
  } else if (errorsState.period === "custom") {
    const [fy, fm, fd] = errorsState.customDraft.from.split("-").map(Number);
    const [ty, tm, td] = errorsState.customDraft.to.split("-").map(Number);
    startDay = { y: fy, m: fm, d: fd };
    endDay = errorsAddDays(ty, tm, td, 1);
    title = "Свой период";
  }
  const from = errorsZonedDate(startDay.y, startDay.m, startDay.d, 0, 0, 0, ERRORS_TZ);
  const to = errorsZonedDate(endDay.y, endDay.m, endDay.d, 0, 0, 0, ERRORS_TZ);
  const endInclusive = errorsAddDays(endDay.y, endDay.m, endDay.d, -1);
  return {
    from,
    to,
    label:
      title +
      ": " +
      errorsFormatDay(startDay.y, startDay.m, startDay.d) +
      ", 00:00 – " +
      errorsFormatDay(endInclusive.y, endInclusive.m, endInclusive.d) +
      ", конец дня · " +
      ERRORS_TZ +
      " · UTC [" +
      from.toISOString() +
      ", " +
      to.toISOString() +
      ")",
  };
}

function errorsSiteName(id) {
  return state.sites.find((s) => s.id === id)?.name || id || "все сайты";
}

function errorsSourceLabel(source) {
  return { front: "Фронтенд", back: "Бэкенд", worker: "Worker", "": "Фронтенд и бэкенд" }[source] || source;
}

function errorsStatusLabel(status) {
  return { NEW: "Новая", IN_PROGRESS: "В разборе", RESOLVED: "Исправлено", IGNORED: "Игнорировать" }[status] || status;
}

function errorsStatusTone(status) {
  return { NEW: "notice", IN_PROGRESS: "info", RESOLVED: "good", IGNORED: "" }[status] || "";
}

function errorsQuery(extra = {}) {
  const range = errorsAppliedRange(new Date());
  const q = new URLSearchParams({ area: errorsState.area, limit: String(errorsState.limit) });
  if (range.from) q.set("from", range.from.toISOString());
  if (range.to) q.set("to", range.to.toISOString());
  if (errorsState.area === "sites") {
    if (errorsState.siteId) q.set("siteId", errorsState.siteId);
    if (errorsState.source) q.set("source", errorsState.source);
  }
  const extraF = errorsState.extra;
  if (extraF.status) q.set("status", extraF.status);
  if (extraF.favorite) q.set("favorite", extraF.favorite);
  if (extraF.code) q.set("code", extraF.code);
  if (extraF.module) q.set("module", extraF.module);
  if (extraF.release) q.set("release", extraF.release);
  if (extraF.severity) q.set("severity", extraF.severity);
  if (extraF.q) q.set("q", extraF.q);
  if (extra.cursor) q.set("cursor", extra.cursor);
  return q;
}

function errorsResetPages() {
  errorsState.cursor = "";
  errorsState.prev = [];
  errorsState.next = null;
}

function errorsSetBusy(busy) {
  errorsState.loading = busy;
  ["errorsPrev", "errorsNext", "errorsLimit", "errorsSite", "errorsSource"].forEach((id) => {
    if ($(id)) $(id).disabled = busy;
  });
}

function errorsFillSites() {
  const select = $("errorsSite");
  const previous = select.value;
  select.replaceChildren(new Option("Все сайты", ""));
  state.sites.forEach((s) => select.append(new Option(s.name, s.id)));
  select.value = state.sites.some((s) => s.id === previous) ? previous : "";
  errorsState.siteId = select.value;
}

function errorsSyncChrome() {
  $("errorsAreaSites").setAttribute("aria-pressed", String(errorsState.area === "sites"));
  $("errorsAreaWorker").setAttribute("aria-pressed", String(errorsState.area === "worker"));
  $("errorsSiteFilters").hidden = errorsState.area !== "sites";
  document.querySelectorAll("[data-errors-period]").forEach((b) =>
    b.setAttribute("aria-pressed", String(b.dataset.errorsPeriod === errorsState.period)),
  );
  $("errorsCustom").hidden = errorsState.period !== "custom";
  $("errorsPeriodLabel").textContent = errorsAppliedRange(new Date()).label;
}

function errorsEventText(ev) {
  if (!ev) return "—";
  const lines = [
    ["Сообщение", ev.message],
    ["Причина", ev.cause || "нет"],
    ["Код", ev.code],
    ["Модуль / стадия", [ev.module, ev.operation, ev.stage].filter(Boolean).join(" · ") || "—"],
    ["Severity", ev.severity || "—"],
    ["Environment / release", [ev.environment, ev.release].filter(Boolean).join(" · ") || "—"],
    ["occurredAt", ev.occurredAt],
    ["receivedAt", ev.receivedAt],
    ["eventId", ev.eventId],
    ["requestId", ev.requestId || "—"],
    ["operationId", ev.operationId || "—"],
    ["resourceId", ev.resourceId || "—"],
    ["jobId", ev.jobId || "—"],
    ["deviceId", ev.deviceId || "—"],
  ];
  const block = node("div", null, "detail-list");
  lines.forEach(([label, value]) => {
    const item = node("div");
    item.append(node("p", label, "detail-label"), node("p", value ?? "—", "detail-value"));
    block.append(item);
  });
  const stack = node("pre", ev.stack ? ev.stack : "Стек отсутствует");
  const ctx = node("pre", ev.context || "Контекст пуст");
  const crumbs = Array.isArray(ev.breadcrumbs) && ev.breadcrumbs.length
    ? node(
        "pre",
        ev.breadcrumbs
          .map((c) => (c.at || "") + " " + (c.category || "") + " " + (c.message || "") + (c.data ? " " + c.data : ""))
          .join("\n"),
      )
    : node("p", "Breadcrumbs отсутствуют", "caption");
  const wrap = node("div", null, "errors-detail-event");
  wrap.append(block, node("p", "Стек", "detail-label"), stack, node("p", "Контекст", "detail-label"), ctx, node("p", "Breadcrumbs", "detail-label"), crumbs);
  return wrap;
}

function errorsMiniEvent(ev, groupId) {
  const row = node("div", null, "errors-inline");
  row.append(
    node("span", (ev.source || "") + " · " + (ev.message || ev.eventId), "caption"),
  );
  if (!ev.pinned) {
    const pin = node("button", "Сохранить пример", "button quiet");
    pin.type = "button";
    pin.onclick = () => errorsPin(groupId, ev.seq, true).catch(report);
    row.append(pin);
  } else {
    const unpin = node("button", "Убрать пример", "button quiet");
    unpin.type = "button";
    unpin.onclick = () => errorsPin(groupId, ev.seq, false).catch(report);
    row.append(unpin);
  }
  return row;
}

async function errorsLoadCard(id) {
  const card = await api("/api/v2/admin/diagnostics/groups/" + encodeURIComponent(id) + "?" + errorsQuery());
  errorsState.cards[id] = card;
  return card;
}

function errorsRenderDetail(group, host) {
  const card = errorsState.cards[group.id];
  host.replaceChildren();
  if (!card) {
    host.append(node("p", "Загружаем подробности…", "caption"));
    return;
  }
  const latest = card.latest || {};
  host.append(errorsEventText(latest));
  host.append(
    node(
      "p",
      "Случаев за период: " +
        card.periodCount +
        " · всего по карточке: " +
        card.lifetimeCount +
        " · защищённых примеров: " +
        card.protectedExamples +
        ". Lifetime не равен числу случаев периода.",
      "caption",
    ),
  );
  host.append(node("p", "Контекст для ручного разбора. Воспроизведение не обещается. Тела сообщений и токены не сохраняются.", "caption"));
  const actions = node("div", null, "errors-inline");
  const fav = node("button", card.favorite ? "Убрать из избранного" : "В избранное", "button");
  fav.type = "button";
  fav.onclick = () => errorsFavorite(group.id, !card.favorite).catch(report);
  const progress = node("button", "В разбор", "button");
  progress.type = "button";
  progress.onclick = () => errorsStatus(group.id, "IN_PROGRESS").catch(report);
  const resolved = node("button", "Исправлено", "button");
  resolved.type = "button";
  resolved.onclick = () => errorsStatus(group.id, "RESOLVED").catch(report);
  const ignored = node("button", "Игнорировать", "button");
  ignored.type = "button";
  ignored.onclick = () => errorsStatus(group.id, "IGNORED").catch(report);
  const copy = node("button", "Скопировать ошибку полностью", "button primary");
  copy.type = "button";
  copy.onclick = () => errorsCopyText(card.report || "", "errorsOut").catch(report);
  const json = node("button", "Скачать JSON", "button quiet");
  json.type = "button";
  json.onclick = () => {
    saveErrorsBlob(new Blob([JSON.stringify(card, null, 2)], { type: "application/json" }), "error-" + group.id + ".json");
    message("errorsOut", "JSON группы сохранён.");
  };
  actions.append(fav, progress, resolved, ignored, copy, json);
  host.append(actions);
  const noteForm = node("form", null, "errors-inline");
  const note = node("input");
  note.type = "text";
  note.maxLength = 4000;
  note.required = true;
  note.placeholder = "Заметка";
  note.setAttribute("aria-label", "Заметка");
  const noteBtn = node("button", "Добавить заметку", "button");
  noteBtn.type = "submit";
  noteForm.append(note, noteBtn);
  noteForm.onsubmit = (e) => {
    e.preventDefault();
    errorsAddNote(group.id, note.value).catch(report);
  };
  host.append(noteForm);
  const examples = node("div");
  examples.append(node("p", "Выбранные примеры", "detail-label"));
  (card.examples || []).forEach((ev) => examples.append(errorsMiniEvent(ev, group.id), errorsEventText(ev)));
  if (!(card.examples || []).length) examples.append(node("p", "Нет сохранённых примеров", "caption"));
  const repeats = node("div");
  repeats.append(node("p", "Свежие повторы периода", "detail-label"));
  (card.repeats || []).forEach((ev) => repeats.append(errorsMiniEvent(ev, group.id)));
  if (!(card.repeats || []).length) repeats.append(node("p", "Нет повторов периода", "caption"));
  const related = node("div");
  related.append(node("p", "Связанные события по requestId/operationId", "detail-label"));
  (card.related || []).forEach((ev) =>
    related.append(node("p", (ev.source || "") + " · " + (ev.message || ev.eventId) + " · " + (ev.eventId || ""), "caption")),
  );
  if (!(card.related || []).length) related.append(node("p", "Связанных событий нет", "caption"));
  const notes = node("div");
  notes.append(node("p", "Заметки", "detail-label"));
  (card.notes || []).forEach((n) => notes.append(node("p", date(n.at) + " · " + n.author + ": " + n.text, "caption")));
  const history = node("div");
  history.append(node("p", "История разбора", "detail-label"));
  (card.history || []).forEach((n) => history.append(node("p", date(n.at) + " · " + (n.author || "") + " · " + n.change, "caption")));
  host.append(examples, repeats, related, notes, history);
}

function errorsRenderList() {
  const page = errorsState.page;
  const box = $("errorsList");
  if (!page) return;
  const items = page.items || [];
  if (!items.length) {
    empty("errorsList", "Ошибок за период нет", "Измените сайт, источник или даты. Удалённые TTL события не восстанавливаются.", "alert");
    return;
  }
  box.replaceChildren();
  items.forEach((g) => {
    const wrap = node("div", null, "errors-group");
    const row = node("button", null, "errors-row");
    row.type = "button";
    const open = errorsState.open.has(g.id);
    row.setAttribute("aria-expanded", String(open));
    const title = node("div");
    title.append(node("div", g.title || g.code || "Ошибка", "errors-row-title"));
    const tags = node("div", null, "errors-tags");
    const site = g.area === "worker" ? "Worker" : errorsSiteName(g.siteId);
    tags.append(node("span", site, "model-tag"), node("span", errorsSourceLabel(g.source), "model-tag"));
    if (g.code) tags.append(node("span", g.code, "model-tag"));
    if (g.favorite) tags.append(node("span", "Избранное", "model-tag"));
    title.append(tags);
    row.append(
      title,
      node("span", g.periodCount + " за период", "errors-count"),
      node("span", date(g.lastSeenAt), "errors-when"),
      badge(errorsStatusLabel(g.status), errorsStatusTone(g.status)),
    );
    const detail = node("div", null, "errors-detail");
    detail.hidden = !open;
    row.addEventListener("click", () => errorsToggle(g, detail, row));
    wrap.append(row, detail);
    if (open) errorsRenderDetail(g, detail);
    box.append(wrap);
  });
}

async function errorsToggle(group, detail, row) {
  if (errorsState.open.has(group.id)) {
    errorsState.open.delete(group.id);
    row.setAttribute("aria-expanded", "false");
    detail.hidden = true;
    return;
  }
  errorsState.open.add(group.id);
  row.setAttribute("aria-expanded", "true");
  detail.hidden = false;
  errorsRenderDetail(group, detail);
  try {
    await errorsLoadCard(group.id);
    if (errorsState.open.has(group.id)) errorsRenderDetail(group, detail);
  } catch (error) {
    detail.replaceChildren(node("p", humanError(error), "caption"));
    const retry = node("button", "Повторить", "button");
    retry.type = "button";
    retry.onclick = () => {
      errorsState.open.delete(group.id);
      void errorsToggle(group, detail, row);
    };
    detail.append(retry);
  }
}

async function loadErrors(action) {
  if (state.role !== "OWNER") return;
  if (action === "next") {
    if (!errorsState.next) return;
    errorsState.prev.push(errorsState.cursor);
    errorsState.cursor = String(errorsState.next);
  } else if (action === "prev") {
    if (!errorsState.prev.length) return;
    errorsState.cursor = errorsState.prev.pop();
  } else if (action) {
    errorsResetPages();
  }
  const version = ++errorsState.version;
  errorsSetBusy(true);
  errorsSyncChrome();
  $("errorsOut").hidden = true;
  try {
    const q = errorsQuery({ cursor: errorsState.cursor });
    const page = await api("/api/v2/admin/diagnostics/groups?" + q);
    if (version !== errorsState.version) return;
    errorsState.page = page;
    errorsState.next = page.nextCursor || null;
    const sum = page.summary || {};
    $("errorsStatCases").textContent = sum.cases ?? "—";
    $("errorsStatGroups").textContent = sum.groups ?? "—";
    $("errorsStatNew").textContent = sum.newGroups ?? "—";
    $("errorsDiskWarning").hidden = !page.diskWarning;
    $("errorsDiskWarning").textContent = page.diskWarning
      ? "Диск журнала заполняется. Избранное и разбор не удаляются скрытно. Ограничьте приём или снимите лишнюю защиту."
      : "";
    const total = Number(sum.groups || 0);
    const start = errorsState.prev.length * errorsState.limit + (page.items?.length ? 1 : 0);
    const end = errorsState.prev.length * errorsState.limit + (page.items?.length || 0);
    $("errorsPageLabel").textContent = total
      ? start + "–" + end + " из " + total
      : "0 из 0";
    const stillOpen = new Set((page.items || []).filter((g) => errorsState.open.has(g.id)).map((g) => g.id));
    errorsState.open = stillOpen;
    errorsRenderList();
    await Promise.all(
      [...stillOpen].map(async (id) => {
        try {
          await errorsLoadCard(id);
        } catch {
          delete errorsState.cards[id];
        }
      }),
    );
    if (version !== errorsState.version) return;
    errorsRenderList();
  } catch (error) {
    if (error.status === 401) return;
    const retry = node("button", "Повторить", "button");
    retry.type = "button";
    retry.onclick = () => void loadErrors();
    const wrap = node("div", null, "empty");
    wrap.append(node("strong", "Не удалось загрузить журнал"), node("p", humanError(error)), retry);
    $("errorsList").replaceChildren(wrap);
  } finally {
    if (version === errorsState.version) {
      errorsSetBusy(false);
      $("errorsPrev").disabled = !errorsState.prev.length;
      $("errorsNext").disabled = !errorsState.next;
    }
  }
}

async function errorsCopyText(text, statusId) {
  try {
    await copyText(text);
    $("errorsCopyFallback").hidden = true;
    message(statusId, "Скопировано.");
  } catch {
    $("errorsCopyText").value = text;
    $("errorsCopyFallback").hidden = false;
    message(statusId, "Буфер обмена недоступен. Текст открыт ниже для ручного копирования.");
  }
}

function saveErrorsBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function errorsMeta() {
  const range = errorsAppliedRange(new Date());
  return {
    areaLabel: errorsState.area === "worker" ? "Worker" : "Сайты",
    siteLabel: errorsState.area === "worker" ? "система Worker" : errorsSiteName(errorsState.siteId),
    sourceLabel: errorsState.area === "worker" ? "Worker" : errorsSourceLabel(errorsState.source),
    periodLabel: range.label,
  };
}

function errorsFormatExport(payload) {
  const meta = errorsMeta();
  const summary = payload.page?.summary || {};
  const events = payload.events || [];
  const groups = new Map();
  events.forEach((ev) => {
    if (!groups.has(ev.groupId)) groups.set(ev.groupId, []);
    groups.get(ev.groupId).push(ev);
  });
  let text =
    "Отчёт журнала ошибок\nОбласть: " +
    meta.areaLabel +
    "\nСайт/система: " +
    meta.siteLabel +
    "\nИсточники: " +
    meta.sourceLabel +
    "\nПериод: " +
    meta.periodLabel +
    "\nЗона: " +
    ERRORS_TZ +
    "\nСформировано: " +
    (payload.generatedAt || "") +
    "\nГрупп: " +
    (summary.groups ?? groups.size) +
    ", случаев: " +
    (summary.cases ?? events.length) +
    "\ngroupCount — счётчик группы, не суммировать со строками событий.\n";
  groups.forEach((evs, id) => {
    const first = evs[0];
    text +=
      "\n---\nГруппа " +
      id +
      "\nКод: " +
      (first.code || "") +
      "\nСтатус: " +
      first.status +
      "\ngroupCount: " +
      first.groupCount +
      "\n";
    evs.forEach((ev) => {
      text +=
        "\nСобытие " +
        ev.eventId +
        "\n" +
        ev.message +
        "\nСтек:\n" +
        (ev.stack || "отсутствует") +
        "\nКонтекст: " +
        (ev.context || "") +
        "\n";
    });
  });
  return text;
}

async function errorsExport(kind) {
  const q = errorsQuery();
  q.set("format", kind === "csv" ? "csv" : "json");
  const response = await fetch("/api/v2/admin/diagnostics/export?" + q, { credentials: "same-origin" });
  if (response.status === 401) location.replace("/panel/login/");
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const error = new Error(data?.code || String(response.status));
    error.status = response.status;
    error.code = data?.code;
    error.detail = data?.message;
    throw error;
  }
  if (kind === "csv") {
    saveErrorsBlob(await response.blob(), "errors.csv");
    message("errorsOut", "CSV сохранён. Разделитель «;», UTF-8 с BOM. Откройте в Excel.");
    return;
  }
  const payload = await response.json();
  if (kind === "copy") {
    await errorsCopyText(errorsFormatExport(payload), "errorsOut");
    return;
  }
  saveErrorsBlob(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }), "errors.json");
  message("errorsOut", "JSON выгрузки сохранён. Это все страницы фильтра, не только текущая.");
}

async function errorsConfirming(run) {
  try {
    return await run(false);
  } catch (error) {
    if (error.code !== "CONFIRM_UNPROTECT") throw error;
    if (!confirm(error.detail || errorCopy.CONFIRM_UNPROTECT)) return null;
    return run(true);
  }
}

async function errorsFavorite(id, favorite) {
  const result = await errorsConfirming((confirmUnprotect) =>
    api("/api/v2/admin/diagnostics/groups/" + encodeURIComponent(id) + "/favorite", {
      method: "PUT",
      mutate: true,
      body: JSON.stringify({ favorite, confirmUnprotect }),
    }),
  );
  if (!result) return;
  if (result.warning) message("errorsOut", result.warning);
  else message("errorsOut", favorite ? "Группа в избранном, первый пример сохранён." : "Избранное снято.");
  await errorsLoadCard(id);
  await loadErrors();
}

async function errorsStatus(id, status) {
  const result = await errorsConfirming((confirmUnprotect) =>
    api("/api/v2/admin/diagnostics/groups/" + encodeURIComponent(id) + "/status", {
      method: "PUT",
      mutate: true,
      body: JSON.stringify({ status, confirmUnprotect }),
    }),
  );
  if (!result) return;
  if (result.warning) message("errorsOut", result.warning);
  else message("errorsOut", "Статус: " + errorsStatusLabel(status) + ".");
  await errorsLoadCard(id);
  await loadErrors();
}

async function errorsPin(id, seq, on) {
  const path = "/api/v2/admin/diagnostics/groups/" + encodeURIComponent(id) + "/examples" + (on ? "" : "/" + seq);
  const opts = { method: on ? "POST" : "DELETE", mutate: true };
  if (on) opts.body = JSON.stringify({ seq });
  await api(path, opts);
  message("errorsOut", on ? "Пример сохранён." : "Пример убран и снова подчиняется TTL.");
  await errorsLoadCard(id);
  errorsRenderList();
}

async function errorsAddNote(id, text) {
  await api("/api/v2/admin/diagnostics/groups/" + encodeURIComponent(id) + "/notes", {
    method: "POST",
    mutate: true,
    body: JSON.stringify({ text: String(text || "").trim() }),
  });
  message("errorsOut", "Заметка сохранена.");
  await errorsLoadCard(id);
  errorsRenderList();
}

async function errorsSaveRetention() {
  const days = Number($("errorsRetention").value);
  if (days < 7 || days > 21) {
    message("errorsOut", "Срок хранения — от 7 до 21 дня.");
    return;
  }
  if (
    errorsState.settings &&
    days < errorsState.settings.retentionDays &&
    !confirm("Уменьшение срока удалит незащищённые события при следующей очистке. Избранное сохранится.")
  )
    return;
  const view = await api("/api/v2/admin/diagnostics/settings", {
    method: "PUT",
    mutate: true,
    body: JSON.stringify({ retentionDays: days }),
  });
  errorsState.settings = view;
  $("errorsRetentionHint").textContent = view.warning || "TTL применяется при следующей очистке.";
  message("errorsOut", "Срок хранения: " + view.retentionDays + " дней.");
}

async function errorsLoadSettings() {
  try {
    const view = await api("/api/v2/admin/diagnostics/settings");
    errorsState.settings = view;
    $("errorsRetention").value = view.retentionDays;
    $("errorsRetentionHint").textContent = view.warning || $("errorsRetentionHint").textContent;
  } catch {
    /* settings stay at defaults */
  }
}

function errorsReadExtra() {
  errorsState.extra = {
    status: $("errorsStatus").value,
    favorite: $("errorsFavorite").value,
    code: $("errorsCode").value.trim(),
    module: $("errorsModule").value.trim(),
    release: $("errorsRelease").value.trim(),
    severity: $("errorsSeverity").value,
    q: $("errorsQ").value.trim(),
  };
}

$("errorsAreaSites").addEventListener("click", () => {
  errorsState.area = "sites";
  void loadErrors("reset");
});
$("errorsAreaWorker").addEventListener("click", () => {
  errorsState.area = "worker";
  void loadErrors("reset");
});
$("errorsSite").addEventListener("change", () => {
  errorsState.siteId = $("errorsSite").value;
  void loadErrors("reset");
});
$("errorsSource").addEventListener("change", () => {
  errorsState.source = $("errorsSource").value;
  void loadErrors("reset");
});
document.querySelectorAll("[data-errors-period]").forEach((b) =>
  b.addEventListener("click", () => {
    const next = b.dataset.errorsPeriod;
    if (next === "custom") {
      $("errorsCustom").hidden = false;
      if (!errorsState.customDraft.from) {
        const w = errorsZonedParts(new Date(), ERRORS_TZ);
        const ymd = w.y + "-" + String(w.m).padStart(2, "0") + "-" + String(w.d).padStart(2, "0");
        $("errorsFrom").value = ymd;
        $("errorsTo").value = ymd;
      }
      return;
    }
    errorsState.period = next;
    void loadErrors("reset");
  }),
);
$("errorsCustom").addEventListener("submit", (e) => {
  e.preventDefault();
  const from = $("errorsFrom").value;
  const to = $("errorsTo").value;
  if (!from || !to || from > to) {
    message("errorsOut", "Проверьте порядок дат: начало не позже конца. Список не изменён.");
    return;
  }
  errorsState.customDraft = { from, to };
  errorsState.period = "custom";
  void loadErrors("reset");
});
$("errorsExtra").addEventListener("submit", (e) => {
  e.preventDefault();
  errorsReadExtra();
  void loadErrors("reset");
});
$("errorsExtraReset").addEventListener("click", () => {
  $("errorsExtra").reset();
  errorsReadExtra();
  void loadErrors("reset");
});
$("errorsSaveRetention").addEventListener("click", () => void errorsSaveRetention().catch(report));
$("errorsPrev").addEventListener("click", () => void loadErrors("prev"));
$("errorsNext").addEventListener("click", () => void loadErrors("next"));
$("errorsLimit").addEventListener("change", () => {
  errorsState.limit = Number($("errorsLimit").value) || 25;
  void loadErrors("reset");
});
function errorsClick(id, fn) {
  $(id).addEventListener("click", async (e) => {
    const control = e.currentTarget;
    control.disabled = true;
    $("globalError").hidden = true;
    try {
      await fn();
    } catch (error) {
      report(error);
    } finally {
      control.disabled = false;
    }
  });
}
errorsClick("errorsCopyReport", () => errorsExport("copy"));
errorsClick("errorsDownloadJson", () => errorsExport("json"));
errorsClick("errorsDownloadCsv", () => errorsExport("csv"));
$("errorsCopyFallbackClose").addEventListener("click", () => {
  $("errorsCopyFallback").hidden = true;
});
