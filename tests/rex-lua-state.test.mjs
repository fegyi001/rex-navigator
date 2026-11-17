import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { spawnSync } from "node:child_process";
import { createLuaFixture } from "./helpers/rex-lua-fixture.mjs";

const script = "tests/helpers/rex-state-probes.lua";

test("strict JSON preserves nulls and object/array identity and rejects malformed input", (t) => {
  const f = createLuaFixture(t);
  const r = f.run(script, { probe: "json" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { valid: true });
});

test("state writes preserve JSON meaning and restrict replacement permissions", (t) => {
  const f = createLuaFixture(t);
  const r = f.run(script, { probe: "save" });
  assert.equal(r.status, 0, r.stderr);
  const path = join(f.home, "data/state.json");
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { new: [null, {}] });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(join(f.home, "data")).mode & 0o777, 0o700);
  assert.deepEqual(readdirSync(join(f.home, "data")), ["state.json"]);
});

for (const fail of ["write", "fsync", "rename"]) {
  test(`failed ${fail} keeps original state and cleans only its own temporary file`, (t) => {
    const f = createLuaFixture(t);
    const dir = join(f.home, "data");
    mkdirSync(dir);
    const original = '{ "old": true }\n';
    writeFileSync(join(dir, "state.json"), original);
    writeFileSync(join(dir, ".someone-elses-temp"), "preserve me");
    const r = f.run(script, { probe: "save", fail });
    assert.equal(r.status, 1);
    assert.match(r.stderr, new RegExp(`synthetic ${fail} failure`));
    assert.equal(readFileSync(join(dir, "state.json"), "utf8"), original);
    assert.deepEqual(readdirSync(dir).sort(), [".someone-elses-temp", "state.json"]);
  });
}

for (const source of ["{broken", ""]) {
test(`malformed persisted JSON is reported without changing bytes: ${JSON.stringify(source)}`, (t) => {
  const f = createLuaFixture(t);
  mkdirSync(join(f.home, "data"));
  writeFileSync(join(f.home, "data/state.json"), source);
  const r = f.run(script, { probe: "decode-invalid-file" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Invalid JSON/);
  assert.equal(readFileSync(join(f.home, "data/state.json"), "utf8"), source);
});
}

test("locked Lua transactions retain their inode and release after success or error", (t) => {
  const f = createLuaFixture(t);
  const run = (request = {}) => f.run(script, { probe: "transaction", request }, { TEST_TRANSACTION_BODY: "1" });
  let r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).count, 1);
  const lock = join(f.home, "config/rex/state/session-history.lock");
  const inode = statSync(lock).ino;
  r = run({ fail: true });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /synthetic transaction failure/);
  r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).count, 2);
  assert.equal(statSync(lock).ino, inode);
  assert.equal(statSync(lock).mode & 0o777, 0o600);
});

test("a competing toggle fails busy and the lock is free after its Lua worker exits", async (t) => {
  const f = createLuaFixture(t);
  const first = f.spawn(script, { probe: "transaction", request: { hold: 0.6 } }, { TEST_TRANSACTION_BODY: "1" });
  let stderr = "";
  first.stderr.on("data", chunk => { stderr += chunk; });
  const ended = new Promise(resolve => first.once("exit", resolve));
  for (let i = 0; i < 100 && !existsSync(join(f.home, "transaction-started")); i++) await delay(10);
  assert.ok(existsSync(join(f.home, "transaction-started")), stderr);
  const busy = f.run(script, { probe: "transaction" }, { TEST_TRANSACTION_BODY: "1" });
  assert.equal(busy.status, 1);
  assert.match(busy.stderr, /already in progress/);
  await ended;
  assert.equal(first.exitCode, 0, stderr);
  const retry = f.run(script, { probe: "transaction" }, { TEST_TRANSACTION_BODY: "1" });
  assert.equal(retry.status, 0, retry.stderr);
  assert.equal(JSON.parse(retry.stdout).count, 2);
});

test("an unmarked transaction worker cannot mutate state", (t) => {
  const f = createLuaFixture(t);
  const r = f.run("scripts/transaction.lua", { kind: "session", request: {} }, { TEST_TRANSACTION_BODY: "1", REX_PICKER_LOCKED: "" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /must hold/);
  assert.equal(existsSync(join(f.home, "counter.json")), false);
});

test("explicit transaction lock waits are capped at twenty seconds", (t) => {
  const f = createLuaFixture(t);
  const r = f.run(script, { probe: "lock-arguments" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { wait: "20", lock: join(f.home, "config/rex/state/session-history.lock") });
});

test("empty XDG variables use home defaults instead of absolute root paths", (t) => {
  const f = createLuaFixture(t);
  const r = f.run(script, { probe: "empty-xdg" }, { XDG_CONFIG_HOME: "", XDG_STATE_HOME: "" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {
    history: join(f.home, ".config/rex/state/session-history.json"), registry: join(f.home, ".local/state/rex/project-sessions.json"),
    lock: join(f.home, ".config/rex/state/session-history.lock"),
  });
});

for (const signal of ["SIGTERM", "SIGKILL"]) {
  test(`a killed coordinator (${signal}) cannot unlock its surviving embedded-Lua worker`, async (t) => {
    const f = createLuaFixture(t);
    const child = f.spawn(script, { probe: "transaction", request: { hold: 8 } }, { TEST_TRANSACTION_BODY: "1" });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk; });
    const ended = new Promise(resolve => child.once("exit", resolve));
    let worker;
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      if (worker) { try { process.kill(worker, "SIGKILL"); } catch { /* Already gone. */ } }
    });
    for (let i = 0; i < 100 && !existsSync(join(f.home, "transaction-started")); i++) await delay(10);
    assert.ok(existsSync(join(f.home, "transaction-started")), stderr);
    worker = Number(readFileSync(join(f.home, "transaction-started"), "utf8"));
    child.kill(signal);
    await ended;
    await delay(200);
    let alive;
    try { process.kill(worker, 0); alive = true; } catch { alive = false; }
    const contender = spawnSync("/usr/bin/lockf", ["-k", "-s", "-t", "0", join(f.home, "config/rex/state/session-history.lock"), "/usr/bin/true"]);
    assert.ok(!alive || contender.status === 75, `workerAlive=${alive}; contender=${contender.status}`);
  });
}
