const { _electron } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");
const parent = path.resolve(root, "..", "tmp", "ci-tests");
fs.mkdirSync(parent, { recursive: true });
const profile = fs.mkdtempSync(path.join(parent, "desktop-profile-"));
const entry = path.join(profile, "entry.cjs");
fs.writeFileSync(entry, `
const {app}=require('electron');
app.setPath('userData', ${JSON.stringify(profile)});
app.requestSingleInstanceLock = () => true;
const {EventEmitter}=require('node:events');
const modulePath=${JSON.stringify(path.join(root, "desktop/ci-runner.cjs"))};
const api=require(modulePath);
class FixtureRunner extends EventEmitter {
  constructor(){super();this.state={phase:'stopped',connected:false,busy:false};}
  async exclusive(cb){return cb();}
  async check(input){api.validateCiSettings(input,'win32');return {ready:true,installed:true,registered:false};}
  async install(input){return this.check(input);}
  async register(input,token){if(token!=='TEST_REGISTRATION_TOKEN')throw Error('Неверный тестовый токен');return {ready:true,installed:true,registered:true};}
  async start(){this.child={};this.state={phase:'idle',connected:true,busy:false,message:'Готов принимать сборки GitHub.'};this.emit('status',this.state);return this.state;}
  async stop(){this.child=null;this.state={phase:'stopped',connected:false,busy:false,message:'Сборки остановлены.'};this.emit('status',this.state);return this.state;}
}
api.CiRunner=FixtureRunner;
require(${JSON.stringify(path.join(root, "desktop/main.cjs"))});
`);

async function main() {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ executablePath: require("electron"), args: [entry, "--smoke"], env });
  try {
    const page = await app.firstWindow();
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.waitForFunction(() => !!window.processor?.ciState);
    await page.locator("#openSettings").click();
    await page.locator("#ciTab").click();
    await page.locator("#ciSettings").waitFor({ state: "visible" });
    assert.equal(await page.locator("#settings").isVisible(), false);
    const first = page.locator(".ci-entry").first();
    await first.waitFor({ state: "visible" });
    await first.locator(".ci-check").click();
    await page.waitForFunction(() => document.querySelector('.ci-entry .ci-entry-notice').textContent.includes('Runner установлен'));
    await first.locator("[name=repository]").fill("bad/repo;echo");
    await first.locator(".ci-save").click();
    await page.waitForFunction(() => document.getElementById('ciNotice').textContent.includes('формате'));
    await first.locator("[name=repository]").fill("owner/repo");
    await first.locator("[name=registrationToken]").fill("TEST_REGISTRATION_TOKEN");
    await first.locator(".ci-register").click();
    await page.waitForFunction(() => document.querySelector('.ci-entry .ci-entry-notice').textContent.includes('зарегистрирован'));
    assert.equal(await first.locator("[name=registrationToken]").inputValue(), "");
    await page.locator("#ciEnabled").check();
    await first.locator(".ci-save").click();
    await page.waitForFunction(() => document.getElementById('ciNotice').textContent.includes('сохранены'));
    await page.waitForFunction(() => document.querySelector('.ci-entry .ci-dot').dataset.phase === 'idle');
    const saved = fs.readFileSync(path.join(profile, "ci-settings.json"), "utf8");
    assert.equal(Array.isArray(JSON.parse(saved)), true);
    assert.equal(JSON.parse(saved)[0].repository, "owner/repo");
    assert.ok(!saved.includes("TEST_REGISTRATION_TOKEN"));
    await page.locator("#ciAdd").click();
    await page.waitForFunction(() => document.querySelectorAll('.ci-entry').length === 2);
    await first.locator(".ci-stop").click();
    await page.waitForFunction(() => document.querySelector('.ci-entry .ci-dot').dataset.phase === 'stopped');
    for (const width of [1160, 620]) {
      await app.evaluate(({BrowserWindow}, width) => BrowserWindow.getAllWindows()[0].setSize(width, 820), width);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, 'Overflow at ' + width);
    }
    await page.locator("#processingTab").click();
    assert.equal(await page.locator("#ciSettings").isVisible(), false);
    assert.equal(await page.locator("#processingSettings").isVisible(), true);
    await page.locator("#connectionTab").click();
    await page.locator("#startupCard").waitFor({ state: "visible" });
    assert.equal(await page.locator("#autoConnect").isDisabled(), true, "Автоподключение недоступно без сохранённого подключения");
    assert.equal(await page.locator("#ciAutoStart").isChecked(), true);
    await page.locator("#ciAutoStart").uncheck();
    await page.waitForFunction(() => document.getElementById('ciAutoStartHint').textContent.includes('вручную'));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(profile, "settings.json"), "utf8")).launch,
      { autoConnect: false, ciAutoStart: false });
    assert.deepEqual(errors, []);
    console.log("Worker CI desktop: IPC, list, add, validation, registration, token clearing, persistence, start/stop, launch toggles and 1160/620px PASS");
  } finally { await app.close(); fs.rmSync(profile, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
