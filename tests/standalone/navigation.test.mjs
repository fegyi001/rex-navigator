import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import test from "node:test";
import { runLua } from "../helpers/standalone-lua.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function check(source) {
  const result = runLua(source);
  assert.equal(result.status, 0, result.stderr || String(result.error));
}

test("project validation preserves empty exclusions and supplies defaults", () => check(`
local config = require("lua.navigation.config")
local projects = config.validate_projects({ roots = {{ path = "~/code", depth = 2 }} })
assert(projects.roots[1].path == "~/code" and projects.roots[1].depth == 2)
assert(table.concat(projects.exclude, ",") == "node_modules,vendor,__pycache__")
assert(#config.validate_projects({ roots = {{ path = "/code", depth = 1 }}, exclude = {} }).exclude == 0)
`));

for (const [name, value] of [
  ["empty roots", "{ roots = {} }"],
  ["sparse roots", '{ roots = { [2] = { path = "/code", depth = 1 }} }'],
  ["relative root", '{ roots = {{ path = "code", depth = 1 }} }'],
  ["fractional depth", '{ roots = {{ path = "/code", depth = 1.5 }} }'],
  ["infinite depth", '{ roots = {{ path = "/code", depth = math.huge }} }'],
  ["invalid exclusions", '{ roots = {{ path = "/code", depth = 1 }}, exclude = false }'],
]) {
  test(`project validation rejects ${name}`, () => check(`
local ok = pcall(require("lua.navigation.config").validate_projects, ${value})
assert(not ok, "Invalid projects were accepted")
`));
}

test("text preserves whole Unicode characters at byte limits", () => check(`
local text = require("lua.navigation.text")
assert(text.truncate_utf8("éé", 3) == "é")
assert(text.truncate_utf8("😀x", 4) == "😀")
assert(text.truncate_utf8("😀", 3) == "")
assert(text.project_base(string.rep("é", 60)) == string.rep("é", 50))
assert(text.project_base("-demo") == "project--demo")
`));

test("text removes control sequences without losing safe output", () => check(`
local text = require("lua.navigation.text")
assert(text.session_label("a\\nb\\t") == "a b ")
assert(text.preview("\\27]52;c;secret\\7safe") == "safe")
assert(text.preview("\\27[31mred\\27[0m\\r\\ntext\\r") == "red\\ntext\\n")
assert(text.preview("before\\27]unterminated secret") == "before")
`));

for (const [name, clients, current, available, expected] of [
  ["empty history", "{}", "a", "{ a = true, b = true }", "nil"],
  ["shared pair", '{ shared = { current = "b", previous = "a" }}', "b", "{ a = true, b = true }", '"a"'],
  ["native switch", '{ shared = { current = "b", previous = "a" }}', "c", "{ a = true, b = true, c = true }", '"b"'],
  ["authoritative stale shared pair", '{ shared = { current = "closed", previous = "a" }, old = { current = "a", previous = "b" }}', "a", "{ a = true, b = true }", '"closed"'],
  ["unique legacy pair", '{ old = { current = "a", previous = "b" }}', "a", "{ a = true, b = true }", '"b"'],
  ["reversed legacy duplicates", '{ x = { current = "a", previous = "b" }, y = { current = "b", previous = "a" }}', "a", "{ a = true, b = true }", '"b"'],
  ["stale legacy pair", '{ old = { current = "a", previous = "closed" }}', "a", "{ a = true }", "nil"],
]) {
  test(`history selection handles ${name} without contacting Rex`, () => check(`
local sessions = require("lua.navigation.sessions").new({})
assert(sessions:last_used(${clients}, "${current}", ${available}) == ${expected})
`));
}

test("conflicting legacy history refuses to guess a destination", () => check(`
local sessions = require("lua.navigation.sessions").new({})
local ok, err = pcall(sessions.last_used, sessions, {
  x = { current = "a", previous = "b" }, y = { current = "a", previous = "c" },
}, "a", { a = true, b = true, c = true })
assert(not ok and tostring(err):find("ambiguous", 1, true))
`));

test("standalone launcher works from a quoted checkout with only Lua in PATH", async (t) => {
  const lookup = spawnSync("/bin/sh", ["-c", "command -v lua"], { encoding: "utf8" });
  assert.equal(lookup.status, 0, lookup.stderr);
  mkdirSync(join(tmpdir(), "opencode"), { recursive: true });
  const home = realpathSync(mkdtempSync(join(tmpdir(), "opencode/rex-standalone-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const checkout = join(home, "quoted ' café\ncheckout");
  const bin = join(home, "bin");
  mkdirSync(join(checkout, "tests/helpers"), { recursive: true });
  mkdirSync(bin);
  symlinkSync(lookup.stdout.trim(), join(bin, "lua"));
  cpSync(join(root, "lua"), join(checkout, "lua"), { recursive: true });
  cpSync(join(root, "tests/helpers/standalone-lua.mjs"), join(checkout, "tests/helpers/standalone-lua.mjs"));
  writeFileSync(join(home, "marker"), "outside checkout");
  const { runLua: relocated } = await import(pathToFileURL(join(checkout, "tests/helpers/standalone-lua.mjs")).href);
  const result = relocated(`
assert(rex == nil, "Standalone tests must not supply a fake Rex runtime")
assert(arg[1] == os.getenv("EXPECTED_ROOT"), arg[1] .. " != " .. os.getenv("EXPECTED_ROOT"))
local marker = assert(io.open("marker")); assert(marker:read("*a") == "outside checkout"); marker:close()
assert(require("lua.navigation.config").validate_window({}).width == 0.7)
`, { cwd: home, env: { PATH: bin, EXPECTED_ROOT: checkout, REX_SERVER: "must-not-connect" } });
  assert.equal(result.status, 0, result.stderr || String(result.error));
});
