import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createLuaFixture } from "./helpers/rex-lua-fixture.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const probe = "tests/helpers/rex-config-probe.lua";
const inlineInstruction = /Configure project discovery with setup\(\{ projects = \.\.\. \}\)/;

function fixture(t) {
  const f = createLuaFixture(t);
  const directory = join(f.home, "code ' café\nroot");
  mkdirSync(join(directory, "chosen"), { recursive: true });
  const projects = { roots: [{ path: directory, depth: 1 }] };
  const path = join(f.home, "config/rex/navigation-config.lua");
  mkdirSync(dirname(path), { recursive: true });
  const legacySource = 'local f = assert(io.open(os.getenv("TEST_HOME") .. "/config-executed", "w")); f:write("loaded"); f:close(); return { projects = { roots = {{ path = os.getenv("TEST_HOME"), depth = 1 }} } }';
  writeFileSync(join(f.home, "fake-bin/fzf"), '#!/bin/sh\n/bin/cat | /usr/bin/tee "$TEST_HOME/project-records"\n', { mode: 0o755 });
  const env = { ...f.env, TEST_PURE_API: "1", REX_SESSION: "session:a" };
  const cli = (args = [], command) => spawnSync("/bin/sh", command || [join(root, "scripts/navigation.sh"), "project", "--client", "client:mac", ...args], {
    env, cwd: "/", encoding: "utf8", timeout: 10000,
  });
  return { ...f, directory, projects, path, legacySource, cli };
}

for (const exclude of [undefined, []]) {
  test(`inline project validation ${exclude ? "preserves empty exclusions" : "applies default exclusions"}`, (t) => {
    const f = fixture(t);
    const result = f.run(probe, { options: { projects: { ...f.projects, ...(exclude ? { exclude } : {}) } } });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(JSON.parse(result.stdout).encoded).projects, {
      ...f.projects, exclude: exclude || ["node_modules", "vendor", "__pycache__"],
    });
  });
}

for (const withProjects of [false, true]) {
  test(`setup rejects file configuration before registering actions${withProjects ? " even alongside inline projects" : ""}`, (t) => {
    const f = fixture(t);
    writeFileSync(f.path, f.legacySource);
    const result = f.run(probe, {
      operation: "setup", options: { config: f.path, ...(withProjects ? { projects: f.projects } : {}) },
    });
    assert.equal(result.status, 0, result.stderr);
    const setup = JSON.parse(result.stdout);
    assert.equal(setup.ok, false);
    assert.match(setup.error, /File-based configuration is not supported; use setup\(\{ projects = \.\.\. \}\)/);
    assert.equal(setup.actions, 0);
    assert.equal(existsSync(join(f.home, "config-executed")), false);
  });
}

for (const legacyFile of [false, true]) {
  test(`unconfigured discovery fails without side effects${legacyFile ? " and does not execute a legacy default file" : ""}`, (t) => {
    const f = fixture(t);
    if (legacyFile) writeFileSync(f.path, f.legacySource);
    const action = f.run(probe, { operation: "action" });
    assert.equal(action.status, 0, action.stderr);
    const result = f.cli([], JSON.parse(action.stdout).slice(1));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, inlineInstruction);
    for (const name of ["config-executed", "project-records", "pure-created.json", "selected.jsonl", "plugin/state", "state/rex"]) {
      assert.equal(existsSync(join(f.home, name)), false, name);
    }
  });
}

for (const [name, projects, sparse, error] of [
  ["non-table projects", true, false, /projects must be a table/],
  ["empty roots", { roots: [] }, false, /nonempty roots/],
  ["sparse roots", { roots: [{ path: "/code", depth: 1 }] }, true, /roots/],
  ["bad excludes", { roots: [{ path: "/code", depth: 1 }], exclude: false }, false, /exclude/],
]) {
  test(`invalid inline settings fail validation: ${name}`, (t) => {
    const f = fixture(t);
    const result = f.run(probe, { options: { projects }, sparse_roots: sparse });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, error);
    assert.equal(existsSync(join(f.home, "pure-created.json")), false);
  });
}

test("inline setup projects survive the action worker boundary including empty excludes", (t) => {
  const f = fixture(t);
  writeFileSync(f.path, f.legacySource);
  const action = f.run(probe, { operation: "action", options: { projects: { ...f.projects, exclude: [] } } });
  assert.equal(action.status, 0, action.stderr);
  const result = f.cli([], JSON.parse(action.stdout).slice(1));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(f.home, "project-records"), "utf8"), join(f.directory, "chosen") + "\0");
  assert.equal(existsSync(join(f.home, "config-executed")), false);
});

test("worker rejects removed --config flags without executing files or opening projects", (t) => {
  const f = fixture(t);
  writeFileSync(f.path, f.legacySource);
  for (const args of [["--config", f.path], [`--config=${f.path}`]]) {
    const result = f.cli(args);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unknown option --config/);
  }
  assert.equal(existsSync(join(f.home, "config-executed")), false);
  assert.equal(existsSync(join(f.home, "project-records")), false);
  assert.equal(existsSync(join(f.home, "pure-created.json")), false);
});

test("project help, session actions and direct-directory opens do not need discovery settings", (t) => {
  const f = fixture(t);
  writeFileSync(f.path, f.legacySource);
  for (const args of [["--help"], [join(f.directory, "chosen")]]) {
    const result = f.cli(args);
    assert.equal(result.status, 0, result.stderr);
  }
  const setup = f.run(probe, { operation: "setup" });
  assert.equal(setup.status, 0, setup.stderr);
  assert.equal(JSON.parse(setup.stdout).ok, true);
  const result = spawnSync("/bin/sh", [join(root, "scripts/navigation.sh"), "session", "select", "--client", "client:mac", "--current", "session:a", "--session", "session:b"], {
    env: { ...f.env, TEST_PURE_API: "1" }, encoding: "utf8", timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(f.home, "config-executed")), false);
});
