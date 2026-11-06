// Exercise the real website/desktop HTML against local fixtures, without a live account.
const { chromium } = require("@playwright/test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const root = path.resolve(__dirname, "../..");
const GiB = 1024 ** 3;
const catalog = JSON.parse(fs.readFileSync(path.join(root, "contracts/generation-catalog.json"), "utf8"));
const usage = { cpuPercent: 25, memoryUsedPercent: 30, memoryTotalBytes: 32 * GiB,
  freeMemoryBytes: 24 * GiB, vramTotalBytes: 16 * GiB, vramUsedBytes: 2 * GiB,
  freeVramBytes: 14 * GiB, freeDiskBytes: 200 * GiB, workDiskAvailable: true,
  gpuName: "NVIDIA GeForce RTX 5060 Ti", deviceOS: "windows", deviceArchitecture: "amd64", accelerator: "cuda" };
const devices = [
  { id: "windows-test", name: "Windows", online: true, enabled: true, priority: 100, usage },
  { id: "mac-test", name: "Mac", online: true, enabled: true, priority: 0,
    usage: { ...usage, deviceOS: "darwin", deviceArchitecture: "arm64", accelerator: "metal", gpuName: "Apple Silicon GPU", vramTotalBytes: null, freeVramBytes: null } },
];
const environment = { memoryBytes: usage.memoryTotalBytes, freeMemoryBytes: usage.freeMemoryBytes,
  os: "windows", architecture: "amd64", accelerator: "cuda", gpuName: usage.gpuName,
  vramTotalBytes: usage.vramTotalBytes, freeVramBytes: usage.freeVramBytes,
  freeDiskBytes: usage.freeDiskBytes, diskReady: true, cpuCores: 16, workDir: "G:\\Worker" };
const status = { phase: "connected", connected: true, running: 0, paused: false,
  models: { environment, catalog, installed: [] }, jobs: [] };
async function main() {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = path.resolve(root, "." + (pathname.endsWith("/") ? pathname + "index.html" : pathname));
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    try {
      res.setHeader("Content-Type", ({ ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".png": "image/png" })[path.extname(file)] || "text/plain");
      res.end(fs.readFileSync(file));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ headless: true });
  const origin = "http://127.0.0.1:" + server.address().port;
  const assets = path.join(root, "docs/testing/assets");
  fs.mkdirSync(assets, { recursive: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem("worker.theme", "dark"));
    let installs = 0;
    let configuration;
    const siteFixture = { id: "site-test", name: "Test site", revision: 1, enabled: true, weight: 1, operations: ["media.transcode"] };
    await page.route("**/api/**", route => {
      const url = route.request().url();
      let body = { items: [], nextCursor: null };
      if (url.endsWith("/session")) body = { role: "OWNER", csrfToken: "fixture", manageSites: true };
      else if (url.endsWith("/devices")) body = { items: devices };
      else if (url.endsWith("/sites")) body = { items: [siteFixture] };
      else if (url.endsWith("/sites/site-test")) { Object.assign(siteFixture, route.request().postDataJSON()); body = siteFixture; }
      else if (url.includes("/jobs")) body = { jobs: [], nextCursor: null };
      else if (url.endsWith("/models")) body = { models: catalog, placements: [] };
      else if (url.endsWith("/commands")) { const input = route.request().postDataJSON(); if (input.type === "CONFIGURE") configuration = input.settings; else installs++; body = { requestId: "fixture-command", status: "PENDING" }; }
      else if (url.includes("/commands/")) body = { status: "RUNNING", progress: 0.25 };
      else if (url.endsWith("/settings")) body = { os: "windows", architecture: "amd64" };
      else if (url.endsWith("/ops")) body = { queued: 0, running: 0 };
      else if (url.includes("/updates")) body = { enabled: false, phase: "idle" };
      else if (url.includes("/audit")) body = { items: [], events: [], nextCursor: null };
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    });
    await page.goto(origin + "/panel/#models");
    await page.locator("#catalog tbody tr").first().waitFor();
    await page.selectOption("#modelDeviceSelect", "windows-test");
    assert.match(await page.locator("#modelDeviceResources").innerText(), /RTX 5060 Ti/);
    assert.match(await page.locator("#catalog").innerText(), /Лёгкая/);
    assert.match(await page.locator("#catalog").innerText(), /Можно установить/);
    await page.locator("#catalog button").filter({ hasText: /^Установить$/ }).first().click();
    await page.waitForFunction(() => document.querySelector("#catalog").textContent.includes("Установка запрошена"));
    assert.equal(installs, 1);
    await page.screenshot({ path: path.join(assets, "model-selection-site.png"), fullPage: true });
    await page.selectOption("#modelDeviceSelect", "mac-test");
    assert.match(await page.locator("#modelDeviceResources").innerText(), /Общая с RAM/);
    await page.locator('[data-tab="devices"]').click();
    assert.equal(await page.locator("#deviceList th").count(), 5);
    assert.equal(await page.locator("#deviceList th").nth(2).textContent(), "CPU / RAM / VRAM");
    assert.equal(await page.locator("#deviceList .resources-cell").first().locator(":scope > *").count(), 3);
    await page.locator('[name="vramThresholdPercent"]').fill("70");
    await page.locator('#configureForm button').click();
    await page.waitForFunction(() => document.getElementById("commandOut").textContent.includes("Команда отправлена"));
    assert.equal(configuration.vramThresholdPercent, 70);
    const role = await page.locator("#devicePriority").boundingBox();
    const hint = await page.locator("#devicePriorityHint").boundingBox();
    assert.ok(hint.y >= role.y + role.height, "role description must appear below its select");
    await page.screenshot({ path: path.join(assets, "device-vram-settings.png"), fullPage: true });
    await page.screenshot({ path: path.join(assets, "model-resources-column.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(origin + "/panel/#models");
    await page.locator("#catalog tbody tr").first().waitFor();
    await page.selectOption("#modelDeviceSelect", "windows-test");
    await page.screenshot({ path: path.join(assets, "model-selection-mobile.png"), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(origin + "/panel/#sites");
    await page.locator("#sites .site-settings-button").first().click();
    await page.locator('#siteOpsForm [name="generate"]').check();
    await page.locator('#siteOpsForm button[type="submit"],#siteOpsForm .form-actions button').first().click();
    await page.locator("#siteOpsOut").filter({ hasText: "Операции сохранены" }).waitFor();
    assert.ok(siteFixture.operations.includes("media.generate"));
    await page.screenshot({ path: path.join(assets, "site-generation-permission.png"), fullPage: true });

    const desktop = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
    desktop.on("pageerror", error => errors.push(error.message));
    await desktop.addInitScript(({ status }) => {
      window.processor = {
        state: async () => ({ settings: { tokenSet: true, modelTasks: ["generation"], readiness: { video: { ok: true }, speech: { ok: true } } }, status }),
        onStatus: callback => { window.sendTestStatus = callback; }, onCiStatus: () => {}, ciState: async () => ({ repos: [] }),
        processing: async input => input,
        readiness: async capability => capability === "generation"
          ? { ok: false, supported: true, version: "test-pinned", label: "Windows · NVIDIA CUDA", downloadBytes: 900000000, message: "Установите движок генерации." }
          : { ok: true },
        install: async capability => {
          if (capability !== "generation") throw Error("unexpected capability");
          window.testEngineInstalled = true;
          return { ok: true, supported: true, message: "Движок запускается. Генерация с моделью ещё не проверена." };
        },
        model: async () => {},
      };
    }, { status });
    await desktop.goto(origin + "/processor/desktop/index.html");
    await desktop.locator("#openModels").click();
    await desktop.locator("#modelGroups .model-row").first().waitFor();
    assert.equal(await desktop.locator("#modelGroups .model-row").count(), 5);
    assert.match(await desktop.locator("#envGrid").innerText(), /RTX 5060 Ti/);
    assert.match(await desktop.locator("#envGrid").innerText(), /2,0\/16,0 ГБ/);
    assert.match(await desktop.locator("#envGrid").innerText(), /8,0\/32,0 ГБ/);
    assert.equal(await desktop.locator('#modelGroups input[type="radio"]:enabled').count(), 0);
    assert.equal(await desktop.locator("#installGeneration").isDisabled(), true);
    assert.match(await desktop.locator("#generationInstallReason").innerText(), /сначала остановите обработчик/);
    assert.equal(await desktop.locator("#generationInstallReason").isVisible(), true);
    await desktop.screenshot({ path: path.join(assets, "model-selection-desktop.png"), fullPage: true });
    await desktop.evaluate(() => window.sendTestStatus({ ...current, connected: true, paused: true }));
    assert.equal(await desktop.locator("#modelGroups .side button").first().isEnabled(), true);
    await desktop.evaluate(() => window.sendTestStatus({ ...current, phase: "connecting", connected: false }));
    assert.match(await desktop.locator("#modelConnectionNotice").innerText(), /каталог может быть устаревшим/);
    assert.equal(await desktop.locator("#modelGroups .side button").first().isDisabled(), true);
    await desktop.evaluate(() => window.sendTestStatus({ phase: "stopped", connected: false, running: 0, paused: false }));
    assert.equal(await desktop.locator("#modelGroups .model-row").count(), 5);
    assert.equal(await desktop.locator("#modelGroups .side button").first().isDisabled(), true);
    assert.match(await desktop.locator("#modelGroups").innerText(), /подключите обработчик к серверу/);
    await desktop.screenshot({ path: path.join(assets, "model-selection-disconnected.png"), fullPage: true });
    assert.equal(await desktop.locator("#generationInstallReason").isVisible(), false);
    await desktop.locator("#installGeneration").click();
    await desktop.waitForFunction(() => window.testEngineInstalled === true);
    await desktop.locator("#generationEngineStatus").filter({ hasText: "Движок запускается" }).waitFor();
    assert.deepEqual(errors, []);
    console.log("PASS: website, desktop, mobile, install request, Mac memory and compact resource column.");
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
