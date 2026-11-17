import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createLuaFixture } from "./helpers/rex-lua-fixture.mjs";

const probeScript = "tests/helpers/rex-process-probes.lua";

test("runtime modules load without side effects", (t) => {
  const f = createLuaFixture(t);
  const r = f.run(probeScript, { probe: "module" });
  assert.equal(r.status, 0, r.stderr || String(r.error));
  assert.deepEqual(JSON.parse(r.stdout), { loaded: true });
  assert.deepEqual(f.operations(), []);
});

test("offline Lua driver rejects live Rex operations", (t) => {
  const f = createLuaFixture(t);
  const r = f.run(probeScript, { probe: "forbidden" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Live Rex operation forbidden/);
});

test("Rex stream callbacks do not retain another output copy", (t) => {
  const f = createLuaFixture(t);
  const r = f.run(probeScript, { probe: "stream" });
  assert.equal(r.status, 0, r.stderr || String(r.error));
  const observed = JSON.parse(r.stdout);
  assert.equal(observed.stdout_bytes, 65536);
  assert.equal(observed.stderr_bytes, 65536);
  assert.equal(observed.retained_stdout, 0, "Rex must not retain an unbounded copy behind the callback");
  assert.equal(observed.retained_stderr, 0, "Rex must not retain an unbounded stderr copy");
});

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

test("Rex timers defer while a timed wait blocks (characterization)", (t) => {
  const f = createLuaFixture(t);
  const start = performance.now();
  const r = f.run(probeScript, { probe: "escalation" });
  assert.equal(r.status, 0, r.stderr || String(r.error));
  assert.deepEqual(JSON.parse(r.stdout), { completed: false, term_sent: false, kill_sent: false });
  assert.ok(performance.now() - start < 1800);
  const pid = Number(readFileSync(join(f.home, "worker.pid"), "utf8"));
  assert.equal(alive(pid), false, "stubborn child must be reaped");
});

test("timed waits can escalate a stubborn child after 100ms", (t) => {
  const f = createLuaFixture(t);
  const start = performance.now();
  const r = f.run(probeScript, { probe: "wait-escalation" });
  assert.equal(r.status, 0, r.stderr || String(r.error));
  assert.deepEqual(JSON.parse(r.stdout), { completed: true, signal: "SIGKILL" });
  assert.ok(performance.now() - start < 800);
  assert.equal(alive(Number(readFileSync(join(f.home, "worker.pid"), "utf8"))), false);
});

for (const signal of ["SIGTERM", "SIGKILL"]) {
  const probe = "worker-lock";
  test(`Rex ${probe} (${signal}) cannot leave an unlocked live mutator`, async (t) => {
    const f = createLuaFixture(t);
    const child = f.spawn(probeScript, { probe });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const finished = new Promise((resolve) => child.once("exit", resolve));
    const ownedPids = [];
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      for (const pid of ownedPids) {
        try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ }
      }
    });
    for (let attempt = 0; attempt < 100 && !existsSync(join(f.home, "worker.pid")); attempt++) await delay(10);
    assert.ok(existsSync(join(f.home, "worker.pid")), stderr || "scratch worker must start");
    const worker = Number(readFileSync(join(f.home, "worker.pid"), "utf8"));
    const holder = Number(readFileSync(join(f.home, "holder.pid"), "utf8"));
    ownedPids.push(worker, holder);
    child.kill(signal);
    await finished;
    await delay(150);
    const contender = spawnSync("/usr/bin/lockf", ["-k", "-s", "-t", "0", join(f.home, "scratch.lock"), "/usr/bin/true"]);
    const observation = { workerAlive: alive(worker), holderAlive: alive(holder), contenderStatus: contender.status };
    t.diagnostic(JSON.stringify(observation));
    assert.ok(!observation.workerAlive || contender.status === 75,
      `a live mutator must retain its lock after ${signal}: ${JSON.stringify(observation)}`);
  });
}

for (const signal of ["SIGTERM", "SIGKILL"]) {
  const probe = "runtime-cancel";
test(`Rex ${probe} ${signal} cancellation must reap a subprocess's descendants`, async (t) => {
  const f = createLuaFixture(t);
  const child = f.spawn(probeScript, { probe });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const finished = new Promise((resolve) => child.once("exit", resolve));
  const owned = [];
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    for (const pid of owned) {
      try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ }
    }
  });
  for (let attempt = 0; attempt < 100 && !existsSync(join(f.home, "grandchild.pid")); attempt++) await delay(10);
  assert.ok(existsSync(join(f.home, "grandchild.pid")), stderr || "scratch grandchild must start");
  const worker = Number(readFileSync(join(f.home, "worker.pid"), "utf8"));
  const grandchild = Number(readFileSync(join(f.home, "grandchild.pid"), "utf8"));
  owned.push(worker, grandchild);
  child.kill(signal);
  await finished;
  await delay(200);
  const observation = {
    workerAlive: alive(worker), grandchildAlive: alive(grandchild),
    workerSawTerm: existsSync(join(f.home, "term-seen")),
  };
  t.diagnostic(JSON.stringify(observation));
  if (probe === "runtime-cancel" && observation.grandchildAlive) {
    t.diagnostic(spawnSync("/bin/ps", ["-o", "pid=,ppid=,pgid=,stat=,command=", "-p", `${worker},${grandchild}`], { encoding: "utf8" }).stdout);
    await delay(1800);
    t.diagnostic(JSON.stringify({ afterTwoSeconds: { workerAlive: alive(worker), grandchildAlive: alive(grandchild) } }));
  }
  assert.equal(observation.grandchildAlive, false,
    `obsolete preview subprocess must not survive cancellation: ${JSON.stringify(observation)}`);
});
}

test("runtime passes exact UTF-8 bytes and stdin through its process adapter", (t) => {
  const f = createLuaFixture(t);
  const r = f.run(probeScript, { probe: "run", argv: ["/bin/cat"], options: { stdin: "é\n", max_stdout: 3 } });
  assert.equal(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout);
  assert.equal(got.stdout, "é\n");
  assert.equal(got.stderr, "");
  assert.equal(got.ok, true);
});

for (const stream of ["stdout", "stderr"]) {
  test(`runtime stops ${stream} at its configured byte limit`, (t) => {
    const f = createLuaFixture(t);
    const script = stream === "stdout" ? "printf 12345" : "printf 12345 >&2";
    const r = f.run(probeScript, { probe: "run", argv: ["/bin/sh", "-c", script], options: { [`max_${stream}`]: 4 } });
    assert.equal(r.status, 1);
    assert.match(r.stderr, new RegExp(`${stream} exceeded`));
  });
}

test("runtime enforces a short deadline and cleans a stubborn process group", (t) => {
  const f = createLuaFixture(t);
  const start = performance.now();
  const r = f.run(probeScript, { probe: "run", argv: ["/bin/sh", "-c", 'trap "" TERM; exec /bin/sleep 20'], options: { timeout: 0.1 } });
  assert.equal(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout);
  assert.equal(got.ok, false);
  assert.equal(got.timed_out, true);
  assert.ok(performance.now() - start < 800);
});

test("runtime preserves explicit RPC/block context and string-valued script arguments", (t) => {
  const f = createLuaFixture(t);
  const r = f.run(probeScript, { probe: "interfaces" });
  assert.equal(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout);
  assert.deepEqual(got.call, { method: "session.list", args: { key: "value" } });
  assert.deepEqual(got.block, { creator: "com.superlogical.terminal", method: "format", args: { format: "text", session_id: "session:a", block_id: "block:b" } });
  assert.deepEqual(got.argv.slice(1, 3), ["--autostart=false", "do"]);
  assert.equal(got.argv[4], "--args");
  assert.deepEqual(JSON.parse(got.argv[5]), { directory: "123", label: "quote'\n" });
});

test("runtime targets the chosen client and confirms its action before returning", (t) => {
  const f = createLuaFixture(t);
  const bin = join(f.home, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "rex"), '#!/bin/sh\nprintf "%s\\0" "$@" > "$TEST_HOME/client-argv"\n', { mode: 0o755 });
  const r = f.run(probeScript, { probe: "select-client" }, { PATH: `${bin}:/usr/bin:/bin` });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readFileSync(join(f.home, "client-argv"), "utf8").split("\0"), [
    "--autostart=false", "-C", "client:mac", "do", "session.select", "session_id=session:target", "",
  ]);
});

test("recursive Lua workers still reject live Rex operations", (t) => {
  const f = createLuaFixture(t);
  const r = f.run(probeScript, { probe: "recursive" });
  assert.equal(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout);
  assert.equal(got.ok, false);
  assert.match(got.stderr, /Live Rex operation forbidden/);
});

test("canceled waits do not immediately KILL the cleanup supervisor", (t) => {
  const f = createLuaFixture(t);
  const r = f.run(probeScript, { probe: "cancelled-wait" });
  assert.equal(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout);
  assert.deepEqual(got.signals, ["SIGTERM"]);
  assert.match(got.error, /context canceled/);
});

test("runtime children cannot reintroduce a remote Rex server override", (t) => {
  const f = createLuaFixture(t);
  const r = f.run(probeScript, { probe: "run", argv: ["/bin/sh", "-c", 'printf "%s" "${REX_SERVER-}"'], options: { env: { REX_SERVER: "must-not-be-used" } } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).stdout, "");
});

test("completed leaf commands do not pay a cancellation grace delay", (t) => {
  const f = createLuaFixture(t);
  let started = performance.now();
  let result = f.run(probeScript, { probe: "leaf-latency", native: true });
  const baseline = performance.now() - started;
  assert.equal(result.status, 0, result.stderr);
  started = performance.now();
  result = f.run(probeScript, { probe: "leaf-latency" });
  const supervised = performance.now() - started;
  assert.equal(result.status, 0, result.stderr);
  t.diagnostic(JSON.stringify({ native_ms: Math.round(baseline), supervised_ms: Math.round(supervised) }));
  // Account for process-start scheduling under the parallel suite. The former
  // fixed 50ms-per-command delay still exceeds this measured-startup budget.
  assert.ok(supervised < baseline * 2 + 200, "normal exits must not sleep for the cancellation grace period on every call");
});
