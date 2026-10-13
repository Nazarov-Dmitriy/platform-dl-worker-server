const state = { csrf: "", role: "", manageSites: false, devices: [] };
function $(id) { return document.getElementById(id); }
async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  if (opts.mutate) headers["X-CSRF-Token"] = state.csrf;
  const res = await fetch(path, { credentials: "same-origin", ...opts, headers });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.code || data.message || res.status);
  return data;
}
function showApp() {
  $("login").hidden = true;
  $("app").hidden = false;
  $("nav").hidden = false;
  $("accountsTab").hidden = state.role !== "OWNER";
  $("auditTab").hidden = state.role !== "OWNER";
}
$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("loginError").textContent = "";
  const fd = new FormData(e.target);
  try {
    const s = await api("/api/v2/admin/session", {
      method: "POST",
      body: JSON.stringify({ login: fd.get("login"), password: fd.get("password") }),
    });
    state.csrf = s.csrfToken;
    state.role = s.role;
    state.manageSites = s.manageSites;
    showApp();
    await reload();
  } catch (err) {
    $("loginError").textContent = err.message;
  }
});
$("logout").addEventListener("click", async () => {
  await api("/api/v2/admin/session", { method: "DELETE", mutate: true });
  location.reload();
});
document.getElementById("nav").addEventListener("click", (e) => {
  const tab = e.target.dataset.tab;
  if (!tab) return;
  document.querySelectorAll("[data-panel]").forEach((p) => {
    p.hidden = p.dataset.panel !== tab;
  });
});
async function reload() {
  const sites = await api("/api/v2/admin/sites");
  $("sites").textContent = JSON.stringify(sites.items, null, 2);
  $("jobSite").innerHTML = sites.items.map((s) => `<option value="${s.id}">${s.name}</option>`).join("");
  const devices = await api("/api/v2/admin/devices");
  state.devices = devices.items;
  $("deviceSelect").innerHTML = devices.items.map((d) => `<option value="${d.id}">${d.name} ${d.online ? "(online)" : "(offline)"}</option>`).join("");
  $("catalog").textContent = JSON.stringify((await api("/api/v2/admin/models")).models.map((m) => ({ id: m.id, revision: m.revision, purpose: m.purpose })), null, 2);
  if (state.role === "OWNER") {
    $("accounts").textContent = JSON.stringify((await api("/api/v2/admin/accounts")).items, null, 2);
    $("audit").textContent = JSON.stringify((await api("/api/v2/admin/audit")).items, null, 2);
  }
  await loadJobs();
  await loadDevice();
}
$("reloadJobs").addEventListener("click", loadJobs);
async function loadJobs() {
  const siteId = $("jobSite").value;
  if (!siteId) { $("jobs").textContent = ""; return; }
  const page = await api("/api/v2/admin/jobs?siteId=" + siteId);
  $("jobs").textContent = JSON.stringify(page.jobs, null, 2);
}
$("cancelAll").addEventListener("click", async () => {
  const siteId = $("jobSite").value;
  if (!siteId) return;
  await api("/api/v2/admin/sites/" + siteId + "/cancel-all", {
    method: "POST",
    mutate: true,
    body: JSON.stringify({ protocolVersion: "2.0", requestId: crypto.randomUUID(), reason: "panel" }),
  });
  await loadJobs();
});
$("siteForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const operations = [];
  if (fd.get("transcode")) operations.push("media.transcode");
  if (fd.get("transcribe")) operations.push("media.transcribe");
  if (fd.get("subtitles")) operations.push("media.subtitles");
  await api("/api/v2/admin/sites", {
    method: "POST",
    mutate: true,
    body: JSON.stringify({
      name: fd.get("name"),
      enabled: true,
      weight: Number(fd.get("weight")),
      operations,
    }),
  });
  await reload();
});
$("deviceForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  await api("/api/v2/admin/devices", {
    method: "POST",
    mutate: true,
    body: JSON.stringify({ name: fd.get("name"), enabled: true }),
  });
  await reload();
});
$("deviceSelect").addEventListener("change", loadDevice);
async function loadDevice() {
  const id = $("deviceSelect").value;
  if (!id) return;
  const d = state.devices.find((x) => x.id === id);
  $("deviceDetail").textContent = JSON.stringify(d, null, 2);
  const settings = await api("/api/v2/admin/devices/" + id + "/settings");
  $("settings").textContent = JSON.stringify(settings, null, 2);
  const models = await api("/api/v2/admin/devices/" + id + "/models");
  $("compat").textContent = JSON.stringify(models.models.map((m) => ({ id: m.id, revision: m.revision, purpose: m.purpose })), null, 2);
}
$("issueDeviceToken").addEventListener("click", async () => {
  const id = $("deviceSelect").value;
  const issued = await api("/api/v2/admin/devices/" + id + "/tokens", {
    method: "POST",
    mutate: true,
    body: JSON.stringify({ requestId: crypto.randomUUID() }),
  });
  $("issued").textContent = JSON.stringify(issued, null, 2);
});
async function command(type) {
  const id = $("deviceSelect").value;
  const view = await api("/api/v2/admin/devices/" + id + "/commands", {
    method: "POST",
    mutate: true,
    body: JSON.stringify({
      requestId: crypto.randomUUID(),
      type,
      modelId: $("modelId").value,
      modelRevision: $("modelRev").value,
    }),
  });
  $("commandOut").textContent = JSON.stringify(view, null, 2);
}
$("installModel").addEventListener("click", () => command("MODEL_INSTALL"));
$("activateModel").addEventListener("click", () => command("MODEL_ACTIVATE"));
$("deleteModel").addEventListener("click", () => command("MODEL_DELETE"));
$("configureForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const id = $("deviceSelect").value;
  const view = await api("/api/v2/admin/devices/" + id + "/commands", {
    method: "POST",
    mutate: true,
    body: JSON.stringify({
      requestId: crypto.randomUUID(),
      type: "CONFIGURE",
      settings: {
        workDirectory: fd.get("workDirectory"),
        paused: Boolean(fd.get("paused")),
        autostart: Boolean(fd.get("autostart")),
        maxParallel: Number(fd.get("maxParallel")),
        cpuThresholdPercent: Number(fd.get("cpuThresholdPercent")),
        memoryThresholdPercent: Number(fd.get("memoryThresholdPercent")),
        diskThresholdPercent: Number(fd.get("diskThresholdPercent")),
      },
    }),
  });
  $("commandOut").textContent = JSON.stringify(view, null, 2);
  await loadDevice();
});
$("accountForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  await api("/api/v2/admin/accounts", {
    method: "POST",
    mutate: true,
    body: JSON.stringify({
      login: fd.get("login"),
      password: fd.get("password"),
      role: fd.get("role"),
      enabled: true,
      manageSites: Boolean(fd.get("manageSites")),
    }),
  });
  await reload();
});
api("/api/v2/admin/session").then((s) => {
  state.csrf = s.csrfToken;
  state.role = s.role;
  state.manageSites = s.manageSites;
  showApp();
  return reload();
}).catch(() => {});
