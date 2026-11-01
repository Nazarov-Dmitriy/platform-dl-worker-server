const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { CiRunner, validateCiSettings, command, releasePackage, parseRunnerActivity, CHECK, INSTALL, REGISTER, RUN, STEP, STOP } = require("../desktop/ci-runner.cjs");
const input = { repository: "owner/repo", distribution: "Ubuntu", directory: "/home/worker/runner folder", name: "worker-build", enabled: false };
const ready = { code: 0, output: "registered\nrepository:https://github.com/owner/repo\ninstalled\n" };
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  return child;
}
test("settings reject shell injection, non Linux work directories and Docker internal distro", () => {
  assert.deepEqual(validateCiSettings(input, "win32"), input);
  for (const bad of [{ repository: "owner/repo;echo" }, { directory: "/home/x/../other" }, { directory: "/" }, { directory: "/home/x/$(id)" }, { directory: "C:\\runner" }, { distribution: "docker-desktop" }, { distribution: "Ubuntu --user root" }, { name: "a\nb" }])
    assert.throws(() => validateCiSettings({ ...input, ...bad }, "win32"));
  assert.throws(() => validateCiSettings(input, "darwin"));
});
test("Windows uses explicit WSL distro; path and values stay positional arguments", () => {
  const spec = command(input, "constant script", ["extra"], "win32");
  assert.deepEqual(spec.args, ["--distribution", "Ubuntu", "--exec", "bash", "-c", "constant script", "worker-ci", input.directory, "extra"]);
  assert.equal(command(input, "constant", [], "linux").executable, "/bin/bash");
});
test("preflight errors are actionable and never expose raw stderr or server output", async () => {
  for (const code of [41, 42, 43, 44, 45, 46, 99]) {
    const runner = new CiRunner({ platform: "win32", run: async () => ({ code, output: "secret-example" }) });
    await assert.rejects(runner.check(input), error => !error.message.includes("secret-example"));
  }
  const runner = new CiRunner({ run: async () => ({ code: 0, output: ready.output.replace("owner/repo", "other/repo") }) });
  await assert.rejects(runner.check(input), /другого репозитория/);
});
test("registration token is passed only through stdin and not retained in state or command", async () => {
  const requests = [];
  const runner = new CiRunner({ platform: "win32", run: async (spec, options) => {
    requests.push({ spec, options });
    return spec.args.includes(REGISTER) ? { code: 0, output: "" } : { code: 0, output: requests.length < 2 ? "installed\n" : ready.output };
  } });
  const token = "TEMPORARY_TEST_REGISTRATION_TOKEN";
  await runner.register(input, token);
  const request = requests.find(item => item.spec.args.includes(REGISTER));
  assert.equal(request.options.input, token + "\n");
  assert.ok(!JSON.stringify(request.spec).includes(token));
  assert.ok(!JSON.stringify(runner.state).includes(token));
  await assert.rejects(runner.register(input, token + "\n"), /временный/);
});
test("official package requires exact GitHub asset URL and SHA256", async () => {
  const filename = "actions-runner-linux-x64-2.999.0.tar.gz";
  const release = { tag_name: "v2.999.0", assets: [{ name: filename, browser_download_url: "https://github.com/actions/runner/releases/download/v2.999.0/" + filename, digest: "sha256:" + "a".repeat(64) }] };
  const fetcher = async () => ({ ok: true, json: async () => release });
  assert.equal((await releasePackage(fetcher)).checksum, "a".repeat(64));
  delete release.assets[0].digest;
  await assert.rejects(releasePackage(fetcher), /SHA-256/);
  release.body = "* " + filename + " " + "b".repeat(64);
  assert.equal((await releasePackage(fetcher)).checksum, "b".repeat(64));
  release.assets[0].browser_download_url = "https://example.invalid/runner.tgz";
  await assert.rejects(releasePackage(fetcher), /Официальный/);
});
test("runner status handles split output, duplicate start and refuses to interrupt an active build", async () => {
  const child = fakeChild(); let spawned = 0;
  const runner = new CiRunner({ platform: "win32", run: async () => ready, spawnProcess: () => { spawned++; return child; } });
  assert.equal((await runner.start(input)).phase, "connecting");
  child.stdout.write("Listening for "); child.stdout.write("Jobs\n");
  assert.equal(runner.state.phase, "idle");
  await runner.start(input); assert.equal(spawned, 1);
  child.stdout.write("Running job: example-test\n");
  assert.equal(runner.state.busy, true);
  await assert.rejects(runner.stop(), /завершения/);
  child.stdout.write("Job example-test completed with result: Failed\n");
  assert.equal(runner.state.busy, false);
  child.stdout.write("Retrying until reconnected\n");
  assert.equal(runner.state.connected, false);
  child.emit("close", 1);
  assert.equal(runner.state.phase, "error");
  assert.equal(runner.child, null);
});
test("a runner that already holds the folder lock is shown as running", async () => {
  let spawned = 0;
  const runner = new CiRunner({ platform: "win32", run: async () => ({ code: 0, output: ready.output + "running\n" }), spawnProcess: () => { spawned++; return fakeChild(); } });
  const status = await runner.start(input);
  assert.equal(spawned, 0);
  assert.equal(status.phase, "idle");
  assert.match(status.message, /уже запущен/);
  const child = fakeChild();
  const second = new CiRunner({ platform: "win32", run: async () => ready, spawnProcess: () => child });
  await second.start(input);
  child.emit("close", 73);
  assert.equal(second.state.phase, "idle");
  assert.match(second.state.message, /уже запущен/);
});
test("runner operation lock prevents simultaneous registration or installation", async () => {
  const runner = new CiRunner();
  runner.operation = true;
  await assert.rejects(runner.start(input), /предыдущего/);
  await assert.rejects(runner.install(input), /предыдущего/);
  await assert.rejects(runner.register(input, "TEST_REGISTRATION_TOKEN"), /предыдущего/);
});
test("stop targets only the owned process group and waits for confirmed exit", async () => {
  const child = fakeChild();
  const runner = new CiRunner({ platform: "win32", spawnProcess: () => child, run: async spec => {
    if (spec.args.includes(STOP)) { setImmediate(() => child.emit("close", 0)); return { code: 0 }; }
    return ready;
  } });
  await runner.start(input);
  const result = await runner.stop();
  assert.equal(result.phase, "stopped"); assert.equal(runner.child, null);
});
test("runner activity keeps only the current job and step name", () => {
  const running = parseRunnerActivity("WRITE LINE: Running job: test\nProcessing step: DisplayName='Run Java quality gate'");
  assert.equal(running.mode, "busy");
  assert.equal(running.job, "test");
  assert.equal(running.step, "Run Java quality gate");
  const done = parseRunnerActivity("WRITE LINE: Job test completed with result: Succeeded\nProcessing step: DisplayName='Post Run actions/checkout@v4'");
  assert.equal(done.mode, "idle");
  assert.equal(done.completed, true);
  assert.equal(done.step, "");
});
test("shell scripts have valid Bash syntax", () => {
  const { spawnSync } = require("node:child_process");
  const bash = process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "/bin/bash";
  for (const script of [CHECK, INSTALL, REGISTER, RUN, STEP, STOP]) {
    const result = spawnSync(bash, ["-n"], { input: script, encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
  }
});
