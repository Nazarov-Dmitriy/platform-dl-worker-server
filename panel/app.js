const state = {
  csrf: "",
  role: "",
  manageSites: false,
  devices: [],
  sites: [],
};
const views = {
  overview: ["Обзор", "Состояние обработки и подключённых устройств"],
  queue: ["Очередь заданий", "Последние задания выбранного сайта"],
  devices: [
    "Устройства",
    "Подключение и управление обработчиками Mac и Windows",
  ],
  sites: ["Сайты", "Источники заданий для обработки медиа"],
  models: ["Модели", "Доступные модели для обработки медиа"],
  accounts: ["Аккаунты", "Доступ к панели и роли пользователей"],
  audit: ["Журнал", "Последние действия в диспетчере"],
  updates: ["Обновления", "Версии и установка обновлений Worker"],
  ops: ["Обслуживание", "Снимки данных и подготовка к обновлению"],
};
async function api(path, opts = {}) {
  const { mutate, ...options } = opts;
  const headers = { ...(options.headers || {}) };
  if (options.body) headers["Content-Type"] = "application/json";
  if (mutate) headers["X-CSRF-Token"] = state.csrf;
  try {
    return await request(path, { ...options, headers });
  } catch (error) {
    if (error.status === 401) location.replace("/panel/login/");
    throw error;
  }
}
function report(error) {
  $("globalError").textContent = humanError(error);
  $("globalError").hidden = false;
}
function message(id, text) {
  $(id).textContent = text;
  $(id).hidden = !text;
}
function on(id, event, fn) {
  $(id).addEventListener(event, async (e) => {
    if (event === "submit") e.preventDefault();
    const control =
      event === "submit"
        ? e.target.querySelector('button[type="submit"],button:not([type])')
        : e.currentTarget;
    $("globalError").hidden = true;
    $("feedback").hidden = true;
    if (control) control.disabled = true;
    try {
      await fn(e);
    } catch (error) {
      report(error);
    } finally {
      if (control) control.disabled = false;
      if (state.ops) {
        $("opsMaintenanceOn").disabled = !!state.ops.maintenance;
        $("opsMaintenanceOff").disabled = !state.ops.maintenance;
      }
      if (updateStatus) showUpdateStatus(updateStatus);
      if (certificateStatus) showPublicCertificate(certificateStatus);
    }
  });
}
const mobileNav = matchMedia("(max-width:850px)");
function syncSidebar() {
  $("sidebar").inert =
    mobileNav.matches && !document.body.classList.contains("nav-open");
}
function closeMenu() {
  document.body.classList.remove("nav-open");
  $("menuToggle").setAttribute("aria-expanded", "false");
  syncSidebar();
}
mobileNav.addEventListener("change", closeMenu);
function selectTab(tab) {
  if (
    !views[tab] ||
    (["accounts", "audit", "ops", "updates"].includes(tab) &&
      state.role !== "OWNER")
  )
    tab = "overview";
  document
    .querySelectorAll("[data-panel]")
    .forEach((p) => (p.hidden = p.dataset.panel !== tab));
  document
    .querySelectorAll("[data-tab]")
    .forEach((b) =>
      b.setAttribute("aria-pressed", String(b.dataset.tab === tab)),
    );
  [$("pageTitle").textContent, $("pageSubtitle").textContent] = views[tab];
  document.title = views[tab][0] + " · Worker";
  closeMenu();
  if (tab === "audit" && state.role === "OWNER" && overviewReady) void loadAudit();
  if (tab === "updates") void loadPublicCertificate();
  if (tab === "overview" && overviewReady) void refreshOverview();
}
$("nav").addEventListener("click", (e) => {
  const b = e.target.closest("[data-tab]");
  if (b) {
    location.hash = b.dataset.tab;
    selectTab(b.dataset.tab);
  }
});
document.querySelectorAll("[data-go]").forEach((b) =>
  b.addEventListener("click", () => {
    location.hash = b.dataset.go;
    selectTab(b.dataset.go);
  }),
);
window.addEventListener("hashchange", () => selectTab(location.hash.slice(1)));
$("menuToggle").addEventListener("click", () => {
  const open = document.body.classList.toggle("nav-open");
  $("menuToggle").setAttribute("aria-expanded", String(open));
  syncSidebar();
  if (open) $("nav").querySelector('button[aria-pressed="true"]').focus();
});
$("overlay").addEventListener("click", closeMenu);
document.addEventListener("keydown", (e) => {
  if (!mobileNav.matches || !document.body.classList.contains("nav-open"))
    return;
  if (e.key === "Escape") {
    closeMenu();
    $("menuToggle").focus();
  }
  if (e.key === "Tab") {
    const controls = Array.from(
      $("sidebar").querySelectorAll("a,button,select"),
    ).filter((n) => !n.hidden && n.getClientRects().length);
    const first = controls[0],
      last = controls[controls.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
});
function options(id, items, label, placeholder) {
  const select = $(id),
    previous = select.value;
  select.replaceChildren();
  if (!items.length) select.append(new Option(placeholder, ""));
  items.forEach((item) => select.append(new Option(label(item), item.id)));
  if (items.some((item) => item.id === previous)) select.value = previous;
  select.disabled = !items.length;
}
async function reload() {
  const [sites, devices, models] = await Promise.all([
    api("/api/v2/admin/sites"),
    api("/api/v2/admin/devices"),
    api("/api/v2/admin/models"),
  ]);
  state.sites = sites.items;
  state.devices = devices.items;
  options("jobSite", state.sites, (s) => s.name, "Нет доступных сайтов");
  options("overviewSite", state.sites, (s) => s.name, "Нет доступных сайтов");
  $("overviewSite").value = $("jobSite").value;
  options(
    "deviceSelect",
    state.devices,
    (d) => d.name + (d.online ? " · в сети" : " · не в сети"),
    "Нет устройств",
  );
  $("stat-siteCount").textContent = state.sites.length;
  $("stat-online").textContent = state.devices.filter((d) => d.online).length;
  renderDevices("overviewDevices", state.devices);
  renderDevices("deviceList", state.devices);
  renderModels("catalog", models.models);
  if (state.sites.length)
    table(
      "sites",
      ["Сайт", "Состояние", "Операции", "Вес", "Настройки"],
      state.sites.map((s) => [
        titleCell(s.name, s.id, "globe"),
        badge(s.enabled ? "Включён" : "Отключён", s.enabled ? "good" : ""),
        s.operations.map((o) => operations[o] || o).join(", "),
        s.weight,
        siteSettingsButton(s),
      ]),
    );
  else
    empty(
      "sites",
      "Сайтов пока нет",
      "Добавьте сайт, который будет отправлять задания.",
      "globe",
    );
  if (state.role === "OWNER") {
    const [accounts, ops] = await Promise.all([
      api("/api/v2/admin/accounts"),
      api("/api/v2/admin/ops"),
    ]);
    table(
      "accounts",
      ["Аккаунт", "Роль", "Состояние", "Управление сайтами"],
      accounts.items.map((a) => [
        titleCell(a.login, null, "user"),
        a.role === "OWNER" ? "Владелец" : "Оператор",
        badge(a.enabled ? "Активен" : "Отключён", a.enabled ? "good" : ""),
        a.manageSites ? "Разрешено" : "Нет",
      ]),
    );
    const participant = $("auditPrincipal"), previousParticipant = participant.value;
    participant.replaceChildren(new Option("Все участники", ""));
    [...state.sites, ...state.devices, ...accounts.items].forEach(item => participant.append(new Option(item.name || item.login || item.id, item.id)));
    participant.value = previousParticipant;
    await loadAudit();
    renderOps(ops);
    await loadUpdateStatus();
  }
  await Promise.all([loadJobs(), loadDevice()]);
}
let jobsVersion = 0,
  deviceVersion = 0;
async function loadJobs() {
  const version = ++jobsVersion,
    id = $("jobSite").value;
  $("cancelAll").disabled = !id;
  const page = id
    ? await api("/api/v2/admin/jobs?siteId=" + encodeURIComponent(id) + "&order=desc&limit=10")
    : { jobs: [] };
  if (version !== jobsVersion) return;
  renderJobs("jobs", page.jobs, !!id);
  renderJobs("overviewJobs", page.jobs, !!id);
}
async function loadDevice() {
  const version = ++deviceVersion,
    id = $("deviceSelect").value;
  $("deviceControls").hidden = !id;
  $("deleteDevice").hidden = !id || state.role !== "OWNER";
  $("selectedDeviceTitle").textContent = "Управление устройством";
  $("selectedDeviceHint").textContent = id
    ? ""
    : "Добавьте устройство, чтобы настроить подключение.";
  message("issued", "");
  message("commandOut", "");
  if (!id) {
    $("devicePriorityForm").hidden = true;
    $("deviceDetail").replaceChildren();
    return;
  }
  const d = state.devices.find((d) => d.id === id);
  $("devicePriorityForm").hidden = false;
  $("devicePriority").value = d.priority > 0 ? "100" : "0";
  message("devicePriorityOut", "");
  $("selectedDeviceTitle").textContent = "Устройство: " + d.name;
  $("selectedDeviceHint").textContent = "ID: " + d.id;
  $("deviceConnectionTitle").textContent = "Подключение: " + d.name;
  $("deviceSettingsTitle").textContent = "Настройки: " + d.name;
  $("tokenRecipient").textContent =
    "Токен для устройства «" + d.name + "» (" + d.id + ")";
  $("issueDeviceToken").textContent = "Выдать токен для «" + d.name + "»";
  $("issueDeviceToken").hidden = state.role !== "OWNER";
  details("deviceDetail", [
    ["Название", d.name],
    ["Подключение", d.online ? "В сети" : "Не в сети"],
    ["Последняя связь", date(d.lastSeenAt)],
  ]);
  const [settings, models] = await Promise.all([
    api("/api/v2/admin/devices/" + id + "/settings"),
    api("/api/v2/admin/devices/" + id + "/models"),
  ]);
  if (version !== deviceVersion) return;
  details("settings", [
    [
      "Система",
      [settings.os, settings.architecture].filter(Boolean).join(" ") ||
        "Ещё не подключалось",
    ],
    [
      "Настройки",
      settings.desired
        ? JSON.stringify(settings.desired) === JSON.stringify(settings.reported)
          ? "Подтверждены устройством"
          : "Ожидают подтверждения"
        : "Ещё не отправлялись",
    ],
  ]);
  const form = $("configureForm");
  form.reset();
  const values = settings.desired || settings.reported;
  if (values)
    Object.entries(values).forEach(([key, value]) => {
      const input = form.elements.namedItem(key);
      if (input) {
        if (input.type === "checkbox") input.checked = !!value;
        else input.value = value;
      }
    });
  renderModels("compat", models.models);
}
on("reloadAll", "click", reload);
on("reloadJobs", "click", loadJobs);
on("jobSite", "change", async () => {
  $("overviewSite").value = $("jobSite").value;
  await loadJobs();
});
on("overviewSite", "change", async () => {
  $("jobSite").value = $("overviewSite").value;
  await loadJobs();
});
on("deviceSelect", "change", loadDevice);
on("logout", "click", async () => {
  await api("/api/v2/admin/session", { method: "DELETE", mutate: true });
  location.replace("/panel/login/");
});
on("cancelAll", "click", async () => {
  const id = $("jobSite").value;
  if (!id || !confirm("Отменить все задания выбранного сайта?")) return;
  const result = await api("/api/v2/admin/sites/" + id + "/cancel-all", {
    method: "POST",
    mutate: true,
    body: JSON.stringify({
      protocolVersion: "2.0",
      requestId: crypto.randomUUID(),
      reason: "panel",
    }),
  });
  await loadJobs();
  message("feedback", "Отмена запрошена. Заданий: " + result.cancelled + ".");
});
on("siteForm", "submit", async (e) => {
  const fd = new FormData(e.target),
    ops = ["transcode", "transcribe", "subtitles"]
      .filter((k) => fd.get(k))
      .map((k) => "media." + k);
  await api("/api/v2/admin/sites", {
    method: "POST",
    mutate: true,
    body: JSON.stringify({
      name: fd.get("name"),
      enabled: true,
      weight: Number(fd.get("weight")),
      operations: ops,
    }),
  });
  e.target.reset();
  await reload();
  $("siteCreateForm").hidden = true;
  message("feedback", "Сайт добавлен.");
});
on("deviceForm", "submit", async (e) => {
  const name = new FormData(e.target).get("name");
  const d = await api("/api/v2/admin/devices", {
    method: "POST",
    mutate: true,
    body: JSON.stringify({ name, enabled: true }),
  });
  e.target.reset();
  await reload();
  $("deviceSelect").value = d.id;
  await loadDevice();
  message(
    "feedback",
    "Устройство добавлено. Выдайте токен для подключения обработчика.",
  );
});
on("issueDeviceToken", "click", () =>
  deviceAction(async (device) => {
    const id = device.id;
    const issued = await api("/api/v2/admin/devices/" + id + "/tokens", {
      method: "POST",
      mutate: true,
      body: JSON.stringify({ requestId: crypto.randomUUID() }),
    });
    $("issued").replaceChildren(
      node("strong", "Токен устройства «" + device.name + "»"),
      node(
        "p",
        "ID: " + device.id + ". Сохраните токен — он показывается один раз.",
        "caption",
      ),
      node("code", issued.token, "code"),
    );
    $("issued").hidden = false;
  }),
);

async function deviceAction(callback) {
  if (state.deviceActionId) return;
  const device = state.devices.find((d) => d.id === $("deviceSelect").value);
  if (!device) return;
  state.deviceActionId = device.id;
  const controls = [
    $("deviceSelect"),
    $("deleteDevice"),
    $("issueDeviceToken"),
    $("devicePriority"),
    $("saveDevicePriority"),
    $("reloadAll"),
    ...document.querySelectorAll("[data-device-select]"),
  ];
  controls.forEach((control) => (control.disabled = true));
  try {
    await callback(device);
  } finally {
    state.deviceActionId = null;
    [...controls, ...document.querySelectorAll("[data-device-select]")].forEach(
      (control) => (control.disabled = false),
    );
    $("deviceSelect").disabled = !state.devices.length;
  }
}
function selectDevice(id) {
  if (state.deviceActionId) return;
  $("deviceSelect").value = id;
  loadDevice()
    .then(() =>
      $("selectedDeviceTitle").scrollIntoView({
        behavior: "smooth",
        block: "center",
      }),
    )
    .catch(report);
}
on("devicePriorityForm", "submit", (event) => {
  event.preventDefault();
  void deviceAction(async (device) => {
    const priority = Number($("devicePriority").value);
    await api("/api/v2/admin/devices/" + device.id, {
      method: "PUT", mutate: true,
      headers: { "If-Match": JSON.stringify(String(device.revision)) },
      body: JSON.stringify({name: device.name, enabled: device.enabled, priority}),
    });
    await reload();
    message("devicePriorityOut", "Роль сохранена. Она применяется к новым заданиям.");
  }).catch(report);
});
on("deleteDevice", "click", () =>
  deviceAction(async (device) => {
    if (
      !confirm(
        "Удалить устройство «" +
          device.name +
          "»?\nID: " +
          device.id +
          "\nЕго токены перестанут работать. История заданий сохранится.",
      )
    )
      return;
    await api("/api/v2/admin/devices/" + device.id, {
      method: "DELETE",
      mutate: true,
      headers: { "If-Match": JSON.stringify(String(device.revision)) },
    });
    await reload();
    message("feedback", "Устройство «" + device.name + "» удалено.");
  }),
);

async function sendCommand(body) {
  const id = $("deviceSelect").value;
  if (!id) return;
  await api("/api/v2/admin/devices/" + id + "/commands", {
    method: "POST",
    mutate: true,
    body: JSON.stringify({ requestId: crypto.randomUUID(), ...body }),
  });
  message(
    "commandOut",
    "Команда отправлена устройству. Применение зависит от его подключения.",
  );
}
for (const [id, type] of [
  ["installModel", "MODEL_INSTALL"],
  ["activateModel", "MODEL_ACTIVATE"],
  ["deleteModel", "MODEL_DELETE"],
])
  on(id, "click", async () => {
    if (!$("modelId").value.trim() || !$("modelRev").value.trim()) {
      message("commandOut", "Укажите идентификатор и версию модели.");
      return;
    }
    if (
      type === "MODEL_DELETE" &&
      !confirm("Удалить выбранную модель с устройства?")
    )
      return;
    await sendCommand({
      type,
      modelId: $("modelId").value.trim(),
      modelRevision: $("modelRev").value.trim(),
    });
  });
on("configureForm", "submit", async (e) => {
  const fd = new FormData(e.target),
    settings = {
      paused: !!fd.get("paused"),
    };
  for (const key of [
    "maxParallel",
    "cpuThresholdPercent",
    "memoryThresholdPercent",
    "diskThresholdPercent",
  ])
    settings[key] = Number(fd.get(key));
  await sendCommand({ type: "CONFIGURE", settings });
});
function toggleAccountCreate(open) {
  $("accountCreateForm").hidden = !open;
  $("showAccountCreate").setAttribute("aria-expanded", String(open));
  if (open) $("accountForm").elements.login.focus();
  else { $("accountForm").reset(); $("showAccountCreate").focus(); }
}
on("showAccountCreate", "click", () => toggleAccountCreate($("accountCreateForm").hidden));
on("cancelAccountCreate", "click", () => toggleAccountCreate(false));
on("accountForm", "submit", async (e) => {
  const fd = new FormData(e.target);
  await api("/api/v2/admin/accounts", {
    method: "POST",
    mutate: true,
    body: JSON.stringify({
      login: fd.get("login"),
      password: fd.get("password"),
      role: fd.get("role"),
      enabled: true,
      manageSites: !!fd.get("manageSites"),
    }),
  });
  e.target.reset();
  await reload();
  toggleAccountCreate(false);
  message("feedback", "Аккаунт добавлен.");
});
async function opsAction(method, path, body, success) {
  await api(path, { method, mutate: true, body: JSON.stringify(body || {}) });
  renderOps(await api("/api/v2/admin/ops"));
  message("opsOut", success || "Состояние обновлено.");
}
on("opsMaintenanceOn", "click", () =>
  opsAction("PUT", "/api/v2/admin/ops", { maintenance: true }, "Выдача приостановлена. Новые задания остаются в очереди."),
);
on("opsMaintenanceOff", "click", () =>
  opsAction("PUT", "/api/v2/admin/ops", { maintenance: false }, "Выдача возобновлена. Задания передаются устройствам."),
);
on("opsBackup", "click", () => opsAction("POST", "/api/v2/admin/backup", {}, "Резервная копия базы сохранена на сервере."));
on("opsPrepare", "click", () =>
  opsAction("POST", "/api/v2/admin/update-prepare", {}, "Выдача приостановлена. Проверьте готовность к обновлению выше. После ручных работ нажмите «Возобновить выдачу»."),
);
async function init() {
  try {
    const session = await api("/api/v2/admin/session");
    state.csrf = session.csrfToken;
    state.role = session.role;
    state.manageSites = session.manageSites;
    ["accounts", "audit", "ops", "updates"].forEach(
      (tab) => ($(tab + "Tab").hidden = state.role !== "OWNER"),
    );
    $("siteCreate").hidden = state.role !== "OWNER" && !state.manageSites;
    $("roleLabel").textContent =
      state.role === "OWNER" ? "Владелец" : "Оператор";
    $("loading").hidden = true;
    $("app").hidden = false;
    selectTab(location.hash.slice(1));
    await reload();
    overviewReady = true;
    markOverviewUpdated();
  } catch (error) {
    if (error.status === 401) return;
    if ($("app").hidden) {
      $("loading").textContent = "Не удалось загрузить панель. ";
      const retry = node("button", "Повторить", "button");
      retry.addEventListener("click", init);
      $("loading").append(retry);
    } else report(error);
  }
}
let updateStatus = null;
const updateBusyPhases = ["checking", "downloading", "waiting", "installing"];
function showUpdateStatus(data) {
  updateStatus = data;
  const busy = updateBusyPhases.includes(data.phase);
  details("updateVersions", [
    [
      "Установленная версия",
      (data.currentVersion || "—").replace("worker-v", ""),
    ],
    ["Доступная версия", (data.latestVersion || "—").replace("worker-v", "")],
  ]);
  message("updateMessage", data.message || "Служба обновления не установлена");
  $("checkUpdate").disabled = !data.enabled || busy;
  $("installUpdate").disabled = !data.enabled || busy || !data.available;
  if (busy) $("opsMaintenanceOff").disabled = true;
}
async function loadUpdateStatus() {
  if (state.role !== "OWNER") return;
  try {
    showUpdateStatus(await api("/api/v2/admin/updates"));
  } catch (error) {
    if (error.status === 401) return;
    message(
      "updateMessage",
      updateBusyPhases.includes(updateStatus?.phase)
        ? "Перезапускаем диспетчер. Страница подключится автоматически…"
        : "Служба обновления недоступна. Повторите проверку позже.",
    );
  }
}
on("checkUpdate", "click", async () => {
  showUpdateStatus(
    await api("/api/v2/admin/updates/check", {
      method: "POST",
      mutate: true,
      body: "{}",
    }),
  );
});
on("installUpdate", "click", async () => {
  const version = updateStatus?.latestVersion;
  if (
    !version ||
    !updateStatus.available ||
    !confirm(
      "Установить Worker " +
        version.replace("worker-v", "") +
        "? Активные задания завершатся перед перезапуском.",
    )
  )
    return;
  showUpdateStatus(
    await api("/api/v2/admin/updates/install", {
      method: "POST",
      mutate: true,
      body: JSON.stringify({ version }),
    }),
  );
});
setInterval(() => {
  if (
    state.role === "OWNER" &&
    (!document.querySelector('[data-panel="updates"]').hidden ||
      updateBusyPhases.includes(updateStatus?.phase))
  ) {
    const before = updateStatus?.phase;
    loadUpdateStatus().then(() => {
      if (
        updateBusyPhases.includes(before) &&
        ["completed", "rolled_back"].includes(updateStatus?.phase)
      ) {
        // Load the assets from the newly started container, including any interface changes.
        location.reload();
      }
    });
  }
}, 3000);

let overviewReady = false;
let overviewRefreshing = false;
function markOverviewUpdated() {
  $("overviewRefresh").textContent = "Обновлено в " + new Date().toLocaleTimeString("ru-RU") + " · каждые 15 секунд";
}
async function refreshOverview() {
  if (!overviewReady || overviewRefreshing || document.hidden || document.querySelector('[data-panel="overview"]').hidden) return;
  overviewRefreshing = true;
  const siteId = $("overviewSite").value;
  try {
    const [sites, devices, jobs, ops] = await Promise.all([
      api("/api/v2/admin/sites"),
      api("/api/v2/admin/devices"),
      siteId ? api("/api/v2/admin/jobs?siteId=" + encodeURIComponent(siteId) + "&order=desc&limit=10") : Promise.resolve({jobs:[]}),
      state.role === "OWNER" ? api("/api/v2/admin/ops") : Promise.resolve(null),
    ]);
    if (document.hidden || document.querySelector('[data-panel="overview"]').hidden || siteId !== $("overviewSite").value) return;
    $("stat-siteCount").textContent = sites.items.length;
    $("stat-online").textContent = devices.items.filter(d => d.online).length;
    renderDevices("overviewDevices", devices.items);
    renderJobs("overviewJobs", jobs.jobs, !!siteId);
    if (ops) {
      $("stat-queued").textContent = ops.queued ?? "—";
      $("stat-running").textContent = ops.running ?? "—";
    }
    markOverviewUpdated();
  } catch (error) {
    if (error.status !== 401) $("overviewRefresh").textContent = "Не удалось обновить данные · повторим через 15 секунд";
  } finally { overviewRefreshing = false; }
}
setInterval(() => void refreshOverview(), 15000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) void refreshOverview(); });
window.addEventListener("focus", () => void refreshOverview());

init();

function siteSettingsButton(site) {
  const button = node("button", null, "button quiet site-settings-button");
  button.innerHTML = icon("settings");
  button.type = "button";
  button.hidden = state.role !== "OWNER" && !state.manageSites;
  button.setAttribute("aria-label", "Настройки сайта «" + site.name + "»");
  button.title = "Настройки сайта «" + site.name + "»";
  button.onclick = () => {
    state.selectedSite = site;
    $("siteSettingsTitle").textContent = "Настройки сайта «" + site.name + "»";
    $("siteSettingsId").textContent = "ID: " + site.id;
    $("siteIssued").hidden = true;
    $("siteSettings").hidden = false;
    $("siteSettings").scrollIntoView({block:"nearest"});
  };
  return button;
}
on("showSiteCreate", "click", () => {
  $("siteCreateForm").hidden = !$("siteCreateForm").hidden;
  if (!$("siteCreateForm").hidden) $("siteForm").elements.name.focus();
});
on("cancelSiteCreate", "click", () => { $("siteCreateForm").hidden = true; });
on("closeSiteSettings", "click", () => { $("siteSettings").hidden = true; $("siteIssued").hidden = true; });
async function siteAction(kind) {
  const site = state.selectedSite;
  if (!site || state.siteActionId) return;
  if (kind === "delete" && !confirm("Удалить сайт «" + site.name + "»?\nID: " + site.id + "\nТокены перестанут работать. История заданий сохранится.")) return;
  state.siteActionId = site.id;
  const controls = [...$("siteSettings").querySelectorAll("button"), ...$("sites").querySelectorAll("button")];
  controls.forEach(b => b.disabled = true);
  $("siteIssued").hidden = true;
  try {
    if (kind === "token") {
      const issued = await api("/api/v2/admin/sites/" + site.id + "/tokens", {
        method:"POST", mutate:true, body:JSON.stringify({requestId:crypto.randomUUID()})
      });
      $("siteIssued").replaceChildren(
        node("strong", "Новый токен сайта «" + site.name + "»"),
        node("p", "Вставьте его в настройки сервиса обработки на сайте. Токен показывается один раз. Ранее выданные токены продолжают работать.", "caption"),
        node("code", issued.token, "code")
      );
      $("siteIssued").hidden = false;
    } else {
      await api("/api/v2/admin/sites/" + site.id, {method:"DELETE",mutate:true,headers:{"If-Match":JSON.stringify(String(site.revision))}});
      $("siteSettings").hidden = true;
      state.selectedSite = null;
      await reload();
      message("feedback", "Сайт «" + site.name + "» удалён.");
    }
  } finally { state.siteActionId = null; controls.forEach(b => b.disabled = false); }
}
on("issueSiteToken", "click", () => siteAction("token"));
on("deleteSite", "click", () => siteAction("delete"));

let certificateRequestBusy = false;
let certificateStatus = null;
function showPublicCertificate(value) {
  certificateStatus = value;
  const expires = value.expiresAt ? " Действует до " + new Date(value.expiresAt * 1000).toLocaleString("ru-RU") + "." : "";
  message("publicCertificateStatus", value.message + expires);
  $("enablePublicCertificate").disabled = !!value.busy || certificateRequestBusy;
  $("enablePublicCertificate").textContent = value.busy ? "Получаем сертификат…" : value.enabled ? "Проверить продление" : "Включить Let’s Encrypt";
}
async function loadPublicCertificate() {
  if (state.role !== "OWNER") return;
  try { showPublicCertificate(await api("/api/v2/admin/connection/public-certificate")); }
  catch { message("publicCertificateStatus", "Служба сертификатов недоступна. Требуется обновление службы Worker на сервере."); }
}
on("enablePublicCertificate", "click", async () => {
  if (certificateRequestBusy || !confirm("Получить сертификат Let’s Encrypt для IP сервера? Требуется доступный TCP 80. Вы принимаете условия Let’s Encrypt (https://letsencrypt.org/repository/). Windows-приложение должно быть обновлено для доверия публичным сертификатам.")) return;
  certificateRequestBusy = true;
  try { showPublicCertificate(await api("/api/v2/admin/connection/public-certificate", {method:"POST",mutate:true,body:"{}"})); }
  finally { certificateRequestBusy = false; }
});
setInterval(() => { if (!document.hidden && !document.querySelector('[data-panel="updates"]').hidden) void loadPublicCertificate(); }, 5000);

let auditCursor = "", auditNextCursor = null, auditPrevious = [], auditLoading = false, appliedAuditQuery = null;
Object.entries(auditLabels).sort((a,b)=>a[1].localeCompare(b[1],"ru")).forEach(([kind,label])=>$("auditKind").append(new Option(label,kind)));
async function loadAudit(action = "refresh") {
 if(auditLoading || state.role !== "OWNER") return;
 if(action === "reset") {auditCursor="";auditPrevious=[];auditNextCursor=null;appliedAuditQuery=null;}
 if(action === "next") {if(!auditNextCursor)return;auditPrevious.push(auditCursor);auditCursor=String(auditNextCursor);}
 if(action === "prev") {if(!auditPrevious.length)return;auditCursor=auditPrevious.pop();}
 auditLoading=true;$("auditPrev").disabled=true;$("auditNext").disabled=true;
 try{
  const query=new URLSearchParams({limit:"20"});
  if(!appliedAuditQuery) {
  for(const [id,key] of [["auditKind","kind"],["auditPrincipal","principalId"],["auditJob","jobId"]])if($(id).value.trim())query.set(key,$(id).value.trim());
  for(const [id,key] of [["auditFrom","from"],["auditTo","to"]])if($(id).value)query.set(key,new Date($(id).value).toISOString());
  if($("auditErrors").checked)query.set("errorsOnly","true");
  appliedAuditQuery=query.toString();
  }
  const requestQuery=new URLSearchParams(appliedAuditQuery);
  if(auditCursor)requestQuery.set("cursor",auditCursor);
  const page=await api("/api/v2/admin/audit?"+requestQuery);auditNextCursor=page.nextCursor;
  renderAudit(page.items);$("auditPageLabel").textContent="Страница "+(auditPrevious.length+1)+" · записей: "+page.items.length;
 }catch(error){report(error)}finally{auditLoading=false;$("auditPrev").disabled=!auditPrevious.length;$("auditNext").disabled=!auditNextCursor;}
}
$("auditFilters").addEventListener("submit",event=>{event.preventDefault();void loadAudit("reset")});
$("auditReset").onclick=()=>{$("auditFilters").reset();void loadAudit("reset")};
$("auditPrev").onclick=()=>void loadAudit("prev");$("auditNext").onclick=()=>void loadAudit("next");
