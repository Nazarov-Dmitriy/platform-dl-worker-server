import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { Agent } from "../agent.js";
import { Journal } from "../journal.js";
import type { Config } from "../config.js";
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean | Promise<boolean>, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await delay(50);
  }
  throw new Error("Integration condition timed out");
}
async function freePort() {
  const server = net.createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}
const executable = process.env.E2E_DISPATCHER;
test(
  "two Node processors against real Go dispatcher: reconnect, cancel and lease loss",
  { skip: !executable, timeout: 45000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), "processor-e2e-"));
    const db = join(root, "dispatcher.db");
    const cli = (...args: string[]) =>
      JSON.parse(
        execFileSync(executable!, [...args, "-db", db], {
          encoding: "utf8",
          windowsHide: true,
        }),
      );
    const site = cli("site-create", "-name", "test");
    const siteToken = cli(
      "token-issue",
      "-purpose",
      "SITE",
      "-id",
      site.id,
    ).token;
    const devices = [0, 1].map((i) => {
      const d = cli("device-create", "-name", "test" + i);
      return {
        ...d,
        token: cli("token-issue", "-purpose", "DEVICE", "-id", d.id).token,
      };
    });
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const server = spawn(
      executable!,
      [
        "serve",
        "-db",
        db,
        "-listen",
        `127.0.0.1:${port}`,
        "-lease",
        "10s",
        "-heartbeat",
        "1s",
        "-stop-safety",
        "1s",
        "-admission-stable",
        "0s",
      ],
      { stdio: "ignore", windowsHide: true },
    );
    const agents: Agent[] = [];
    t.after(async () => {
      await Promise.all(agents.map((a) => a.close()));
      server.kill();
      await delay(300);
      rmSync(root, { recursive: true, force: true });
    });
    await until(async () => {
      try {
        return (await fetch(base + "/healthz")).ok;
      } catch {
        return false;
      }
    });
    const usage = {
      cpuPercent: 10,
      memoryUsedPercent: 20,
      memoryPressure: "NORMAL",
      diskUsedPercent: 10,
      freeMemoryBytes: 8 * 1024 ** 3,
      freeDiskBytes: 100 * 1024 ** 3,
      freeVramBytes: null,
      encoderBusyPercent: null,
      availableSlots: 1,
      paused: false,
      workDiskAvailable: true,
    };
    for (const d of devices) {
      const work = join(root, d.id);
      mkdirSync(work);
      const config: Config = {
        url: base.replace("http:", "ws:") + "/api/v2/device/connect",
        deviceId: d.id,
        stateDir: join(work, "state"),
        workDir: work,
        maxParallel: 1,
        reserveMemoryBytes: 0,
        taskMemoryBytes: 1,
        reserveDiskBytes: 0,
        threshold: 80,
        paused: false,
        testExecutor: true,
        testDurationMs: 60000,
      };
      const agent = new Agent(
        config,
        d.token,
        new Journal(config.stateDir),
        () => {},
      );
      agent.resources.sample = () => ({ ...usage });
      agents.push(agent);
      agent.start();
    }
    await until(() => agents.every((a) => a.session));
    const headers = {
      Authorization: `Bearer ${siteToken}`,
      "Content-Type": "application/json",
    };
    const fixture = JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL(
            "../../../contracts/fixtures/valid/job-video.json",
            import.meta.url,
          ),
        ),
        "utf8",
      ),
    ).value;
    const submit = async () => {
      const job = { ...fixture, id: randomUUID() };
      const resp = await fetch(base + "/api/v2/site/jobs", {
        method: "POST",
        headers,
        body: JSON.stringify(job),
      });
      assert.equal(resp.status, 202);
      return job.id;
    };
    const view = async (id: string) =>
      (
        await fetch(base + "/api/v2/site/jobs/" + id, { headers })
      ).json() as Promise<any>;
    const first = await submit(),
      second = await submit();
    await until(() =>
      agents.every((a) => [...a.running.values()].some((r) => r.executor)),
    );
    assert.equal(
      agents.reduce((n, a) => n + a.running.size, 0),
      2,
    );
    const owner = agents.find((a) =>
      [...a.running.values()].some((r) => r.attempt.jobId === first),
    )!;
    const original = [...owner.running.values()].find(
      (r) => r.attempt.jobId === first,
    )!;
    const pid = original.executor!.child.pid;
    const oldSocket = owner.socket;
    owner.socket!.terminate();
    await until(
      () =>
        owner.socket !== oldSocket &&
        owner.session &&
        owner.socket?.readyState === 1,
    );
    await delay(300);
    assert.equal(
      [...owner.running.values()].find((r) => r.attempt.jobId === first)!
        .executor!.child.pid,
      pid,
      "Reconnect restarted the executor",
    );
    const cancel = await fetch(base + `/api/v2/site/jobs/${first}/cancel`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        protocolVersion: "2.0",
        requestId: randomUUID(),
        reason: "test",
      }),
    });
    assert.ok(cancel.ok);
    await until(async () => (await view(first)).status === "CANCELLED");
    assert.equal(owner.running.size, 0);
    // Complete the second isolated test and return a clear permanent error, never READY.
    const other = agents.find((a) =>
      [...a.running.values()].some((r) => r.attempt.jobId === second),
    )!;
    const running = [...other.running.values()][0];
    await other.finish(running, "TEST_EXECUTOR_ONLY");
    await until(async () => (await view(second)).status === "FAILED");
    assert.equal((await view(second)).error.code, "TEST_EXECUTOR_ONLY");
    const third = await submit();
    await until(() =>
      agents.some((a) => [...a.running.values()].some((r) => r.executor)),
    );
    const active = agents
      .flatMap((a) => [...a.running.values()])
      .find((r) => r.attempt.jobId === third)!;
    const executor = active.executor!;
    server.kill();
    await until(() => agents.every((a) => !a.session));
    await until(
      () =>
        executor.child.exitCode !== null || executor.child.signalCode !== null,
      12000,
    );
    await until(() => agents.every((a) => a.running.size === 0));
    assert.ok(
      agents.some((a) =>
        a.journal.state.outbox.some((f) => f.type === "job.failed"),
      ),
      "Disconnected failure was not persisted",
    );
  },
);
