const test = require("node:test"),
  assert = require("node:assert/strict");
const { createLoginController, NAME, ARGS } = require("../desktop/login.cjs");
function fixture() {
  let registered = false,
    approved = true;
  const calls = [];
  const app = {
    isPackaged: true,
    getLoginItemSettings(options) {
      assert.deepEqual(options, {
        path: "C:/Program Files/Worker/Worker Processor.exe",
        args: ARGS,
      });
      return {
        openAtLogin: registered,
        executableWillLaunchAtLogin: registered && approved,
        launchItems: registered
          ? [{ name: NAME, args: ARGS, enabled: approved }]
          : [],
      };
    },
    setLoginItemSettings(options) {
      calls.push(options);
      registered = options.openAtLogin;
      if (options.enabled === true) approved = true;
    },
  };
  return {
    app,
    calls,
    block: () => {
      approved = false;
    },
  };
}
test("registration uses only executable and background flag, can be disabled", () => {
  const f = fixture(),
    control = createLoginController(f.app, {
      platform: "win32",
      executable: "C:/Program Files/Worker/Worker Processor.exe",
    });
  assert.equal(control.state().enabled, false);
  assert.equal(control.set(true).enabled, true);
  assert.deepEqual(f.calls[0], {
    name: NAME,
    path: "C:/Program Files/Worker/Worker Processor.exe",
    args: ["--background"],
    openAtLogin: true,
    enabled: true,
  });
  assert.equal(control.set(false).registered, false);
});
test("Windows startup approval is respected and explicitly reenabled", () => {
  const f = fixture(),
    control = createLoginController(f.app, {
      platform: "win32",
      executable: "C:/Program Files/Worker/Worker Processor.exe",
    });
  control.set(true);
  f.block();
  assert.equal(control.state().enabled, false);
  assert.equal(control.state().registered, true);
  assert.equal(control.set(true).enabled, true);
});
test("unsupported/development apps and malformed IPC values cannot register", () => {
  for (const options of [
    { platform: "darwin" },
    { platform: "win32", dev: true },
  ]) {
    const f = fixture();
    if (options.dev) f.app.isPackaged = false;
    const control = createLoginController(f.app, options);
    assert.equal(control.state().supported, false);
    assert.throws(() => control.set(true));
    assert.equal(f.calls.length, 0);
  }
  const f = fixture(),
    control = createLoginController(f.app, { platform: "win32" });
  assert.throws(() => control.set("true"));
  assert.equal(f.calls.length, 0);
});
test("failed native registration is not reported as success", () => {
  const f = fixture();
  f.app.setLoginItemSettings = () => {};
  const control = createLoginController(f.app, {
    platform: "win32",
    executable: "C:/Program Files/Worker/Worker Processor.exe",
  });
  assert.throws(() => control.set(true), /Windows/);
});

test("Windows path with spaces remains enabled when Electron drops returned arguments", () => {
  const f = fixture();
  const get = f.app.getLoginItemSettings;
  f.app.getLoginItemSettings = (options) => {
    const value = get(options);
    return {
      ...value,
      openAtLogin: false,
      launchItems: value.launchItems.map((item) => ({ ...item, args: [] })),
    };
  };
  const control = createLoginController(f.app, {
    platform: "win32",
    executable: "C:/Program Files/Worker/Worker Processor.exe",
  });
  assert.equal(control.set(true).enabled, true);
  f.block();
  assert.equal(control.state().enabled, false);
});
