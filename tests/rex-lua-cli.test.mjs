import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createLuaFixture } from "./helpers/rex-lua-fixture.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function cliFixture(t) {
  const f = createLuaFixture(t);
  const config = join(f.home, "config/rex");
  mkdirSync(config, { recursive: true });
  symlinkSync(join(root, "scripts"), join(config, "scripts"));
  symlinkSync(join(root, "lua"), join(config, "lua"));
  const nodeTrap = join(f.home, "node-trap.cjs");
  writeFileSync(nodeTrap, 'require("node:fs").appendFileSync(process.env.TEST_HOME+"/forbidden-executables","node\\n");process.exit(99);');
  const luaTrap = join(f.home, "lua-trap.lua");
  writeFileSync(luaTrap, 'local f=assert(io.open(os.getenv("TEST_HOME").."/forbidden-executables","a"));f:write("lua\\n");f:close();error("standalone Lua forbidden")');
  const env = { ...f.env, PATH: `${join(f.home, "fake-bin")}:/usr/bin:/bin`, TEST_PURE_API: "1", REX_SESSION: "session:a",
    NODE_OPTIONS: `--require=${nodeTrap}`, LUA_INIT: `@${luaTrap}`, LUA_INIT_5_4: `@${luaTrap}` };
  const launcher = join(root, "scripts/navigation.sh");
  const run = (kind, args, options = {}) => {
    const result = spawnSync("/bin/sh", [launcher, kind, ...args], {
      env: { ...env, ...options.env }, cwd: options.cwd || f.home, input: options.input, encoding: "utf8", timeout: 10000,
    });
    assert.equal(existsSync(join(f.home, "forbidden-executables")), false, "production invoked Node or standalone Lua");
    return result;
  };
  return { ...f, env, config, run };
}

test("session worker launcher selects and toggles using embedded Lua with Node poisoned", (t) => {
  const f = cliFixture(t);
  for (const [command, current, target] of [["select", "session:a", "session:b"], ["toggle", "session:b"]]) {
    const r = f.run("session", [command, "--client", "client:mac", "--current", current, ...(target ? ["--session", target] : [])]);
    assert.equal(r.status, 0, r.stderr);
  }
  assert.deepEqual(readFileSync(join(f.home, "selected.jsonl"), "utf8").trim().split("\n").map(JSON.parse), [
    { client: "client:mac", target: "session:b" }, { client: "client:mac", target: "session:a" },
  ]);
});

for (const name of ["123", "true", "quote'\nline", "-dash"]) {
  test(`project worker launcher preserves a relative path without Node: ${JSON.stringify(name)}`, (t) => {
    const f = cliFixture(t);
    mkdirSync(join(f.home, name));
    const r = f.run("project", ["--client=client:mac", "--", name]);
    assert.equal(r.status, 0, r.stderr);
    const registry = JSON.parse(readFileSync(join(f.home, "state/rex/project-sessions.json"), "utf8"));
    assert.equal(registry["host:local|instance:pure"][join(f.home, name)], "session:new1");
  });
}

test("worker launcher help names its real entrypoint and validates malformed flags before operations", (t) => {
  const f = cliFixture(t);
  for (const kind of ["session", "project"]) {
    const help = f.run(kind, ["--help"]);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, new RegExp(`Usage: navigation\\.sh ${kind} `));
  }
  for (const args of [["select", "--client", "client:mac", "--current", "session:a"], ["toggle", "--unknown"], ["pick", "--client"]]) {
    const r = f.run("session", args);
    assert.notEqual(r.status, 0);
  }
  assert.equal(existsSync(join(f.home, "selected.jsonl")), false);
});

test("canceling a session picker leaves state untouched and displays no ID suffix", (t) => {
  const f = cliFixture(t);
  writeFileSync(join(f.home, "fake-bin/fzf"), '#!/bin/sh\n/bin/cat > "$TEST_HOME/picker-records"\nexit 130\n', { mode: 0o755 });
  const result = f.run("session", ["pick", "--client", "client:mac", "--current", "session:a"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(f.home, "picker-records"), "utf8"), "session:b\tBeta\0");
  assert.equal(existsSync(join(f.home, "plugin/state/session-history.json")), false);
});

test("floating picker errors remain visible until Enter", (t) => {
  const f = cliFixture(t);
  const result = f.run("session", ["select", "--client", "client:mac", "--current", "session:a", "--session", "session:closed", "--picker-tab"], { input: "\n" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /session was closed/);
  assert.match(result.stdout, /Press Enter to close the picker/);
});

test("a relocated quoted/newline code root remains independent of cwd and Node", (t) => {
  const f = cliFixture(t);
  const plugin = join(f.home, "plugin ' quoted\nroot");
  cpSync(join(root, "scripts"), join(plugin, "scripts"), { recursive: true });
  cpSync(join(root, "lua/navigation"), join(plugin, "lua/navigation"), { recursive: true });
  const result = spawnSync("/bin/sh", [join(plugin, "scripts/navigation.sh"), "session", "select", "--client", "client:mac", "--current", "session:a", "--session", "session:b"], { env: f.env, cwd: "/", encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(f.home, "forbidden-executables")), false);
  assert.equal(existsSync(join(f.home, "config/rex/state")), false, "history must not recreate host state");
  assert.equal(JSON.parse(readFileSync(join(plugin, "state/session-history.json"), "utf8"))["host:local"].shared.current, "session:b");
});

test("an explicitly empty project directory opens cwd rather than starting discovery", (t) => {
  const f = cliFixture(t);
  const result = f.run("project", ["", "--client", "client:mac"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(readFileSync(join(f.home, "state/rex/project-sessions.json"), "utf8"))["host:local|instance:pure"][f.home], "session:new1");
});

test("an option missing its value cannot consume another flag and open an unintended project", (t) => {
  const f = cliFixture(t);
  const directory = join(f.home, "must-not-open");
  mkdirSync(directory);
  const result = f.run("project", ["--config", "--client", directory]);
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(join(f.home, "selected.jsonl")), false);
  assert.equal(existsSync(join(f.home, "pure-created.json")), false);
});

test("session options can precede the operation without changing the selected target", (t) => {
  const f = cliFixture(t);
  const result = f.run("session", ["--client", "client:mac", "--current", "session:a", "--session", "session:b", "select"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(f.home, "selected.jsonl"), "utf8")), { client: "client:mac", target: "session:b" });
});

test("session help works after options without performing an operation", (t) => {
  const f = cliFixture(t);
  const result = f.run("session", ["--client", "client:mac", "--current", "session:a", "--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage:/);
  assert.equal(existsSync(join(f.home, "selected.jsonl")), false);
});

test("session CLI rejects missing and duplicate operations before switching", (t) => {
  const f = cliFixture(t);
  for (const operations of [[], ["pick", "toggle"]]) {
    const result = f.run("session", ["--client", "client:mac", "--current", "session:a", ...operations]);
    assert.notEqual(result.status, 0);
  }
  assert.equal(existsSync(join(f.home, "selected.jsonl")), false);
});
