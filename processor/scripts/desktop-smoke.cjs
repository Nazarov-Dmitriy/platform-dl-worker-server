// Developer acceptance harness. Fixture must refer to an isolated local dispatcher, never production.
const { _electron } = require("@playwright/test");
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os"),
  assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");
async function main() {
  if (!process.env.DESKTOP_FIXTURE)
    throw Error(
      "Set DESKTOP_FIXTURE to local test JSON: url, deviceId, token, caPath.",
    );
  const fixture = JSON.parse(
    fs.readFileSync(process.env.DESKTOP_FIXTURE, "utf8"),
  );
  const url = new URL(fixture.url);
  if (
    url.protocol !== "https:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  )
    throw Error("Desktop smoke accepts localhost fixtures only.");
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "worker-desktop-smoke-"),
  );
  const profile = path.join(temporary, "profile"),
    work = path.join(temporary, "work");
  fs.mkdirSync(profile);
  fs.mkdirSync(work);
  const entry = path.join(temporary, "entry.cjs");
  fs.writeFileSync(
    entry,
    `const {app}=require('electron');app.setPath('userData',${JSON.stringify(profile)});require(${JSON.stringify(path.join(root, "desktop/main.cjs"))});`,
  );
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  let application;
  async function launch() {
    const packaged = !!process.env.DESKTOP_EXECUTABLE;
    application = await _electron.launch({
      executablePath: process.env.DESKTOP_EXECUTABLE || require("electron"),
      args: packaged
        ? ["--smoke", "--user-data-dir=" + profile]
        : [entry, "--smoke"],
      env,
    });
    const page = await application.firstWindow();
    await page.waitForFunction(() => !!window.processor);
    assert.equal(
      path.resolve(
        await application.evaluate(({ app }) => app.getPath("userData")),
      ),
      profile,
    );
    return page;
  }
  async function quit(page) {
    const closed = application.waitForEvent("close");
    await page
      .evaluate(() => window.processor.quit())
      .catch((error) => {
        if (!error.message.includes("closed")) throw error;
      });
    await closed;
    application = undefined;
  }
  try {
    const page = await launch(),
      errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    assert.equal(await page.evaluate(() => typeof require), "undefined");
    await application.evaluate(
      ({ dialog }, paths) => {
        dialog.showOpenDialog = async (_window, options) => ({
          canceled: false,
          filePaths: [
            options.properties.includes("openDirectory")
              ? paths.work
              : paths.ca,
          ],
        });
      },
      { work, ca: path.resolve(fixture.caPath) },
    );
    await page.locator("[name=server]").fill("http://invalid.example");
    await page.locator("[name=deviceId]").fill(fixture.deviceId);
    await page.locator("#chooseDirectory").click();
    await page.locator("#chooseCertificate").click();
    await page.locator("[name=token]").fill(fixture.token);
    await page.locator("#connect").click();
    await page.locator("#notice").filter({ hasText: "HTTPS" }).waitFor();
    await page.locator("[name=server]").fill(fixture.url);
    if (fixture.wrongCaPath) {
      await application.evaluate(({ dialog }, ca) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [ca],
        });
      }, path.resolve(fixture.wrongCaPath));
      await page.locator("#chooseCertificate").click();
      await page.locator("#connect").click();
      await page
        .locator("#detail")
        .filter({ hasText: "Не удалось подключиться" })
        .waitFor();
      assert.notEqual(
        await page.locator("#connection").textContent(),
        "Подключён",
      );
      await page.locator("#stop").click();
      await page.waitForFunction(
        () =>
          document.getElementById("connection").textContent === "Не запущен",
      );
      await application.evaluate(({ dialog }, ca) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [ca],
        });
      }, path.resolve(fixture.caPath));
      await page.locator("#chooseCertificate").click();
    }
    await page.locator("#connect").click();
    await page.waitForFunction(
      () => document.getElementById("connection").textContent === "Подключён",
    );
    assert.equal(await page.locator("[name=token]").inputValue(), "");
    assert(
      !fs
        .readFileSync(path.join(profile, "credential.bin"))
        .includes(Buffer.from(fixture.token)),
    );
    assert(
      !fs
        .readFileSync(path.join(profile, "config.json"), "utf8")
        .includes(fixture.token),
    );
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].close(),
    );
    assert.equal(
      await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].isVisible(),
      ),
      false,
    );
    assert.equal(
      (await page.evaluate(() => window.processor.state())).status.connected,
      true,
    );
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].show(),
    );
    await page.locator("#pause").click();
    await page.waitForFunction(
      () => document.getElementById("connection").textContent === "На паузе",
    );
    await page.locator("#pause").click();
    await page.locator("#stop").click();
    await page.waitForFunction(
      () => document.getElementById("connection").textContent === "Не запущен",
    );
    if (process.env.DESKTOP_SCREENSHOT)
      await page.screenshot({
        path: process.env.DESKTOP_SCREENSHOT,
        fullPage: true,
      });
    assert.deepEqual(errors, []);
    await quit(page);
    const reopened = await launch();
    await reopened.waitForFunction(
      () => document.querySelector("[name=server]").value.length > 0,
    );
    assert.equal(
      await reopened.locator("[name=deviceId]").inputValue(),
      fixture.deviceId,
    );
    assert.equal(await reopened.locator("[name=token]").inputValue(), "");
    await reopened.locator("#connect").click();
    await reopened.waitForFunction(
      () => document.getElementById("connection").textContent === "Подключён",
    );
    await quit(reopened);
    console.log(
      "PASS: native app, real verified WSS, encrypted token, close to background, pause/resume, stop, saved reconnect.",
    );
  } finally {
    if (application) await application.close().catch(() => {});
    const resolved = path.resolve(temporary),
      parent = path.resolve(os.tmpdir()) + path.sep;
    if (
      !resolved.startsWith(parent) ||
      !path.basename(resolved).startsWith("worker-desktop-smoke-")
    )
      throw Error("Unexpected cleanup target");
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
