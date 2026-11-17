import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createLuaFixture } from "./helpers/rex-lua-fixture.mjs";
import { luaLiteral } from "./helpers/lua-config.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const probe = "tests/helpers/rex-config-probe.lua";
const settings = (path, exclude = '{ "node_modules" }') =>
  `return { projects = { roots = { {path=${luaLiteral(path)}, depth=1} }, exclude=${exclude} } }`;

function fixture(t) {
  const f = createLuaFixture(t);
  const directory = join(f.home, "code ' café");
  mkdirSync(join(directory, "chosen"), { recursive: true });
  const path = join(f.home, "config/rex/navigation-config.lua");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, settings(directory));
  writeFileSync(join(f.home, "fake-bin/fzf"), '#!/bin/sh\n/bin/cat | /usr/bin/tee "$TEST_HOME/project-records"\n', { mode: 0o755 });
  const env = { ...f.env, TEST_PURE_API: "1", REX_SESSION: "session:a" };
  const cli = (args = [], command) => spawnSync("/bin/sh", command || [join(root, "bin/rex-project-picker"), "--client", "client:mac", ...args], {
    env, cwd: "/", encoding: "utf8", timeout: 10000,
  });
  return { ...f, directory, path, cli };
}

test("shared Lua defaults load roots and preserve an explicitly empty exclusion list", (t) => {
  const f = fixture(t);
  writeFileSync(f.path, settings(f.directory, "{}"));
  const result = f.run(probe);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(JSON.parse(result.stdout).encoded), { projects: { roots: [{ path: f.directory, depth: 1 }], exclude: [] } });
});

test("alternate quoted config paths and inline project overrides have explicit precedence", (t) => {
  const f = fixture(t);
  const path = join(f.home, "custom ' settings.lua");
  writeFileSync(path, settings("/custom"));
  let result = f.run(probe, { options: { config: path } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(JSON.parse(result.stdout).encoded).projects.roots[0].path, "/custom");
  result = f.run(probe, { options: { config: "/missing/not-loaded.lua", projects: { roots: [{ path: "~/override", depth: 2 }], exclude: [] } } });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(JSON.parse(result.stdout).encoded).projects, { roots: [{ path: "~/override", depth: 2 }], exclude: [] });
});

for (const [name, source, error] of [
  ["missing", null, /navigation-config\.lua/],
  ["syntax", "return { broken", /configuration/],
  ["non-table", "return true", /return a table/],
  ["missing projects", "return {}", /projects/],
  ["empty roots", "return {projects={roots={}}}", /nonempty roots/],
  ["sparse roots", 'return {projects={roots={[2]={path="/code",depth=1}}}}', /roots/],
  ["bad excludes", 'return {projects={roots={{path="/code",depth=1}},exclude=false}}', /exclude/],
]) {
  test(`invalid shared Lua config fails before project operations: ${name}`, (t) => {
    const f = fixture(t);
    if (source === null) {
      const result = f.cli(["--config", join(f.home, "missing-navigation-config.lua")]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, error);
    } else {
      writeFileSync(f.path, source);
      const result = f.cli();
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, error);
    }
    assert.equal(existsSync(join(f.home, "pure-created.json")), false);
    assert.equal(existsSync(join(f.home, "project-records")), false);
  });
}

test("default action and standalone CLI discover the same projects without projects.json", (t) => {
  const f = fixture(t);
  const action = f.run(probe, { operation: "action" });
  assert.equal(action.status, 0, action.stderr);
  const argv = JSON.parse(action.stdout);
  let result = f.cli([], argv.slice(1));
  assert.equal(result.status, 0, result.stderr);
  const expected = join(f.directory, "chosen") + "\0";
  assert.equal(readFileSync(join(f.home, "project-records"), "utf8"), expected);
  result = f.cli();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(f.home, "project-records"), "utf8"), expected);
  assert.equal(existsSync(join(f.home, "config/rex/projects.json")), false);
});

test("inline setup projects survive the action worker boundary including empty excludes", (t) => {
  const f = fixture(t);
  writeFileSync(f.path, 'error("default config must not execute")');
  const action = f.run(probe, { operation: "action", options: { projects: { roots: [{ path: f.directory, depth: 1 }], exclude: [] } } });
  assert.equal(action.status, 0, action.stderr);
  const result = f.cli([], JSON.parse(action.stdout).slice(1));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(f.home, "project-records"), "utf8"), join(f.directory, "chosen") + "\0");
});

test("project help, session actions and direct-directory opens never execute discovery config", (t) => {
  const f = fixture(t);
  writeFileSync(f.path, 'error("discovery config unexpectedly executed")');
  for (const args of [["--help"], [join(f.directory, "chosen")]]) {
    const result = f.cli(args);
    assert.equal(result.status, 0, result.stderr);
  }
  const result = spawnSync("/bin/sh", [join(root, "scripts/session-picker.sh"), "select", "--client", "client:mac", "--current", "session:a", "--session", "session:b"], {
    env: { ...f.env, TEST_PURE_API: "1" }, encoding: "utf8", timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
});
